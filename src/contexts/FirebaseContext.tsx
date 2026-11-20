import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  auth,
  BOOTSTRAPPED_ADMIN_EMAIL,
  isBootstrappedAdminEmail,
  signInWithGooglePopup,
  signOutFirebase,
  testConnection,
} from "../firebase";
import firebaseConfig from "../../firebase-applet-config.json";
import {
  checkHasRemoteUpdates,
  ensureUserBootstrap,
  fetchAllFirestoreData,
  fetchAllFromCacheOnly,
  getLastSyncTimestampMs,
  LAST_SYNC_STORAGE_KEY,
  migrateNormalizedDatasetToFirestore,
  saveBatchActivityToFirestore,
} from "../services/firestoreDb";
import {
  buildNormalizedCollections,
  FISCAL_MONTH_COLS,
  toIsoDateStr,
  toStrictDivision,
  toValidDocId,
  type MonthlyOpnameCell,
  type NormalizedDataset,
} from "../utils/firestoreNormalization";
import { customFetch } from "../utils/api";
import { SCRIPT_URL, DEFAULT_ACCESS_RULES } from "../utils/constants";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { cleanForMatch, extractExpFromLot } from "../utils/formatters";
import {
  getOfflineActivityQueue,
  isLikelyNetworkError,
  markOfflineActivityRetry,
  OFFLINE_QUEUE_EVENT,
  removeOfflineActivityById,
  withTimeout,
} from "../utils/offlineQueue";

const ACTIVE_DB_LABEL = firebaseConfig.firestoreDatabaseId || firebaseConfig.projectId || "Firestore";

interface FirebaseContextValue {
  firebaseUser: User | null;
  isAuthReady: boolean;
  isAuthorizedFirebase: boolean;
  isFirestoreConnected: boolean | null;
  isOnline: boolean;
  authError: string | null;
  firestoreReadError: string | null;
  firestoreDataset: NormalizedDataset | null;
  firestoreAccessRules: Record<string, Record<string, boolean>> | null;
  hasFirestoreData: boolean;
  isLoadingFirestore: boolean;
  isMigrating: boolean;
  migrationStage: string | null;
  syncMode: "full" | "delta" | "cache" | null;
  lastSyncAt: number | null;
  needsRefresh: boolean;
  refreshReason: string | null;
  pendingOfflineCount: number;
  isSyncingOfflineQueue: boolean;
  offlineSyncBanner: string | null;
  clearOfflineSyncBanner: () => void;
  connectGoogle: () => Promise<User>;
  disconnectGoogle: () => Promise<void>;
  migrateDatasetToFirestore: (
    dataset: NormalizedDataset,
    accessRules: Record<string, Record<string, boolean>>,
  ) => Promise<{ totalDocs: number }>;
  syncFromSourceToFirestore: () => Promise<{ totalDocs: number }>;
  reloadFromFirestore: (options?: { forceFull?: boolean }) => Promise<NormalizedDataset | null>;
  removeLocalFirestoreDocs: (colName: keyof NormalizedDataset, docIds: string[]) => void;
  applyLocalActivityPatch: (params: {
    kioskName: string;
    checkerName: string;
    items: any[];
  }) => void;
  syncOfflineQueueNow: () => Promise<{ synced: number; failed: number }>;
  retryFirestoreSync: () => void;
}

const EMPTY_DATASET: NormalizedDataset = {
  employees: [],
  partners: [],
  hybrids: [],
  lots: [],
  dr_shipments: [],
  opname_logs: [],
};

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

export const FirebaseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isOnline = useOnlineStatus();
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [firestoreReadError, setFirestoreReadError] = useState<string | null>(null);
  const [firestoreDataset, setFirestoreDataset] = useState<NormalizedDataset | null>(null);
  const [firestoreAccessRules, setFirestoreAccessRules] = useState<Record<
    string,
    Record<string, boolean>
  > | null>(null);
  const [isLoadingFirestore, setIsLoadingFirestore] = useState(false);
  const [isFirestoreConnected, setIsFirestoreConnected] = useState<boolean | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationStage, setMigrationStage] = useState<string | null>(null);
  const [syncMode, setSyncMode] = useState<"full" | "delta" | "cache" | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(() => getLastSyncTimestampMs());
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [refreshReason, setRefreshReason] = useState<string | null>(null);
  const [pendingOfflineCount, setPendingOfflineCount] = useState<number>(
    () => getOfflineActivityQueue().length,
  );
  const [isSyncingOfflineQueue, setIsSyncingOfflineQueue] = useState(false);
  const [offlineSyncBanner, setOfflineSyncBanner] = useState<string | null>(null);
  const [listenerRetryTick, setListenerRetryTick] = useState(0);
  const autoSyncAttemptedRef = useRef(false);
  const firestoreDatasetRef = useRef<NormalizedDataset | null>(null);
  const syncingQueueRef = useRef(false);
  const wasOfflineRef = useRef(!isOnline);
  const lastRemoteProbeAtRef = useRef(0);

  useEffect(() => {
    firestoreDatasetRef.current = firestoreDataset;
  }, [firestoreDataset]);

  useEffect(() => {
    const updateCount = () => {
      setPendingOfflineCount(getOfflineActivityQueue().length);
    };
    updateCount();
    window.addEventListener(OFFLINE_QUEUE_EVENT, updateCount);
    window.addEventListener("storage", updateCount);
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, updateCount);
      window.removeEventListener("storage", updateCount);
    };
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user && (!user.emailVerified || !isBootstrappedAdminEmail(user.email))) {
        setAuthError(
          `Akses admin ditolak untuk ${user.email || "akun ini"}. Login admin hanya untuk ${BOOTSTRAPPED_ADMIN_EMAIL}.`,
        );
        setFirebaseUser(null);
        setIsAuthReady(true);
        signOutFirebase().catch(() => {});
        return;
      }

      if (user) {
        setAuthError(null);
      }
      setFirebaseUser(user);
      setIsAuthReady(true);
    });
    return () => unsub();
  }, []);

  const isAuthorizedFirebase = Boolean(
    firebaseUser &&
      firebaseUser.emailVerified &&
      isBootstrappedAdminEmail(firebaseUser.email),
  );

  const reloadFromFirestore = useCallback(
    async (options?: { forceFull?: boolean }): Promise<NormalizedDataset | null> => {
      const current = auth.currentUser;
      const verifiedAdmin =
        current && current.emailVerified && isBootstrappedAdminEmail(current.email)
          ? current
          : null;

      setIsLoadingFirestore(true);
      try {
        const connected = await testConnection();
        setIsFirestoreConnected(connected);

        if (!connected && !options?.forceFull) {
          const cached = await fetchAllFromCacheOnly(verifiedAdmin);
          if (cached) {
            setFirestoreReadError(null);
            setSyncMode("cache");
            setFirestoreDataset(cached.dataset);
            if (Object.keys(cached.accessRules).length > 0) {
              setFirestoreAccessRules(cached.accessRules);
            }
            return cached.dataset;
          }
          if (firestoreDatasetRef.current) {
            setSyncMode("cache");
            return firestoreDatasetRef.current;
          }
        }

        if (verifiedAdmin && connected) {
          await ensureUserBootstrap(verifiedAdmin);
        }

        const data = await fetchAllFirestoreData(verifiedAdmin, options);
        setFirestoreReadError(null);
        const resolvedMode = data.syncMode || "delta";
        setSyncMode(resolvedMode);
        setLastSyncAt(getLastSyncTimestampMs());
        if (resolvedMode === "delta" || resolvedMode === "full") {
          setNeedsRefresh(false);
          setRefreshReason(null);
        }
        setFirestoreDataset(data.dataset);
        if (Object.keys(data.accessRules).length > 0) {
          setFirestoreAccessRules(data.accessRules);
        }
        return data.dataset;
      } catch (err: any) {
        const errText = String(err?.message || err || "");
        const isPermDenied =
          errText.toLowerCase().includes("permission") ||
          errText.toLowerCase().includes("insufficient");

        if (!isPermDenied && !options?.forceFull) {
          const cached = await fetchAllFromCacheOnly(verifiedAdmin);
          if (cached) {
            setFirestoreReadError(null);
            setSyncMode("cache");
            setFirestoreDataset(cached.dataset);
            if (Object.keys(cached.accessRules).length > 0) {
              setFirestoreAccessRules(cached.accessRules);
            }
            return cached.dataset;
          }
          if (firestoreDatasetRef.current) {
            setSyncMode("cache");
            setFirestoreReadError(null);
            return firestoreDatasetRef.current;
          }
        }

        if (options?.forceFull && isLikelyNetworkError(err)) {
          throw err;
        }

        setFirestoreReadError(
          isPermDenied
            ? `Akses baca & edit belum aktif di Firestore Rules (${ACTIVE_DB_LABEL}). Login dengan ${BOOTSTRAPPED_ADMIN_EMAIL} atau publikasikan firestore.rules.`
            : `Gagal terhubung ke database Firebase (${ACTIVE_DB_LABEL}). Periksa koneksi internet Anda.`,
        );
        setFirestoreDataset((prev) => prev || EMPTY_DATASET);
        return firestoreDatasetRef.current || null;
      } finally {
        setIsLoadingFirestore(false);
      }
    },
    [],
  );

  const removeLocalFirestoreDocs = useCallback(
    (colName: keyof NormalizedDataset, docIds: string[]) => {
      const idSet = new Set(docIds.map((id) => String(id || "").trim()).filter(Boolean));
      if (idSet.size === 0) return;
      setFirestoreDataset((prev) => {
        if (!prev) return prev;
        const currentList = (prev[colName] || []) as any[];
        return {
          ...prev,
          [colName]: currentList.filter((item) => !idSet.has(String(item?.doc_id || ""))),
        };
      });
    },
    [],
  );

  const applyLocalActivityPatch = useCallback(
    (params: { kioskName: string; checkerName: string; items: any[] }) => {
      setFirestoreDataset((prev) => {
        const base = prev || EMPTY_DATASET;
        const nextHybrids = [...base.hybrids];
        const nextLots = [...base.lots];
        const nextLogs = [...base.opname_logs];

        const checker = base.employees.find(
          (e) =>
            cleanForMatch(e.full_name) === cleanForMatch(params.checkerName) ||
            cleanForMatch(e.username) === cleanForMatch(params.checkerName),
        );
        const cleanKiosk = cleanForMatch(params.kioskName);
        const partner =
          (checker
            ? base.partners.find(
                (p) =>
                  cleanForMatch(p.partner_name) === cleanKiosk &&
                  p.pic_employee_id === checker.doc_id,
              )
            : undefined) ||
          base.partners.find((p) => cleanForMatch(p.partner_name) === cleanKiosk);

        const hybridByClean = new Map(
          nextHybrids.map((h) => [cleanForMatch(h.hybrid_name), h]),
        );
        const lotIds = new Set(nextLots.map((l) => toValidDocId(l.doc_id)));
        const logIndexById = new Map(
          nextLogs.map((l, idx) => [toValidDocId(l.doc_id), idx]),
        );

        for (const item of params.items || []) {
          const lotNo = toValidDocId(String(item.lot || "").toUpperCase(), "");
          if (!lotNo) continue;

          const lotUpper = String(item.lot || "").trim().toUpperCase();
          const rawHybrid = String(item.hybrid || "").trim();
          const inferredHybrid =
            rawHybrid && rawHybrid.toLowerCase() !== "unknown"
              ? rawHybrid
              : lotUpper.startsWith("PL52B") || lotUpper.startsWith("PJ52B")
                ? "MADU 59"
                : "ADV808";
          const hybName = inferredHybrid.toUpperCase();
          const hybClean = cleanForMatch(hybName);
          let hyb = hybridByClean.get(hybClean);
          if (!hyb) {
            const hybId = `HYB-LOC-${Date.now().toString(36).toUpperCase()}`;
            hyb = {
              doc_id: hybId,
              hybrid_name: hybName,
              crop_type: toStrictDivision(item.crops),
            };
            hybridByClean.set(hybClean, hyb);
            nextHybrids.push(hyb);
          }

          if (!lotIds.has(lotNo)) {
            lotIds.add(lotNo);
            nextLots.push({
              doc_id: lotNo,
              hybrid_id: hyb.doc_id,
              shipping_date: toIsoDateStr(item.drDate) || "",
              exp_date: toIsoDateStr(item.expired || extractExpFromLot(item.lot)) || "",
              initial_dr_kg: 0,
            });
          }

          const prtPart = partner ? partner.doc_id : toValidDocId(params.kioskName, "NO_PRT");
          const chkPart = checker ? checker.doc_id : toValidDocId(params.checkerName, "NO_CHK");
          const preferredLogId = toValidDocId(`${prtPart}_${lotNo}_${chkPart}_FY2026`);
          const legacyLogId = toValidDocId(`${prtPart}_${lotNo}_FY2026`);
          const existingIdx = logIndexById.has(preferredLogId)
            ? logIndexById.get(preferredLogId)!
            : logIndexById.has(legacyLogId)
              ? logIndexById.get(legacyLogId)!
              : -1;
          const existingLog = existingIdx >= 0 ? nextLogs[existingIdx] : undefined;
          const logId = existingLog ? existingLog.doc_id : preferredLogId;

          const monthPayload: Record<string, MonthlyOpnameCell | null> = {};
          let prevVal: number | null = null;
          FISCAL_MONTH_COLS.forEach(({ key }) => {
            const isEditedMonth = Boolean(item[`edited_${key}`]);
            const val = Number(item[key]);
            const hasVal =
              item[key] !== undefined &&
              item[key] !== null &&
              String(item[key]).trim() !== "" &&
              (val > 0 || isEditedMonth);
            const prevCell = existingLog?.[key];
            if (hasVal || prevCell) {
              const qty = hasVal ? Math.max(0, val) : Math.max(0, prevCell?.idle || 0);
              const inKg =
                isEditedMonth && item[`in_${key}`] !== undefined
                  ? Math.max(0, Number(item[`in_${key}`]) || 0)
                  : prevVal === null
                    ? qty
                    : qty > prevVal
                      ? qty - prevVal
                      : 0;
              const pogKg =
                isEditedMonth && item[`pog_${key}`] !== undefined
                  ? Math.max(0, Number(item[`pog_${key}`]) || 0)
                  : prevVal !== null && qty < prevVal
                    ? prevVal - qty
                    : 0;
              monthPayload[key] = { in: inKg, idle: qty, pog: pogKg };
              prevVal = qty;
            } else {
              monthPayload[key] = null;
            }
          });

          const updatedLog = {
            doc_id: logId,
            _key: logId,
            partner_id: partner ? partner.doc_id : null,
            lot_no: lotNo,
            checker_id: checker ? checker.doc_id : existingLog?.checker_id || null,
            crop_year: "FY2026",
            apr: monthPayload.apr || null,
            mei: monthPayload.mei || null,
            jun: monthPayload.jun || null,
            jul: monthPayload.jul || null,
            ags: monthPayload.ags || null,
            sep: monthPayload.sep || null,
            okt: monthPayload.okt || null,
            nov: monthPayload.nov || null,
            des: monthPayload.des || null,
            jan: monthPayload.jan || null,
            feb: monthPayload.feb || null,
            mar: monthPayload.mar || null,
          };

          if (existingIdx >= 0) {
            nextLogs[existingIdx] = updatedLog;
          } else {
            logIndexById.set(logId, nextLogs.length);
            nextLogs.push(updatedLog);
          }
        }

        return {
          ...base,
          hybrids: nextHybrids,
          lots: nextLots,
          opname_logs: nextLogs,
        };
      });
    },
    [],
  );

  const syncOfflineQueueNow = useCallback(async (): Promise<{
    synced: number;
    failed: number;
  }> => {
    const queue = getOfflineActivityQueue();
    if (queue.length === 0) return { synced: 0, failed: 0 };
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return { synced: 0, failed: queue.length };
    }
    if (syncingQueueRef.current) {
      return { synced: 0, failed: 0 };
    }

    syncingQueueRef.current = true;
    setIsSyncingOfflineQueue(true);
    let synced = 0;
    let failed = 0;

    try {
      const current = auth.currentUser;
      const dataset = firestoreDatasetRef.current || EMPTY_DATASET;

      for (const entry of queue) {
        try {
          await withTimeout(
            saveBatchActivityToFirestore(current, {
              kioskName: entry.kioskName,
              checkerName: entry.checkerName,
              items: entry.items,
              currentDataset: dataset,
            }),
            9000,
            "Koneksi terlalu lambat saat mengirim antrean offline.",
          );
          removeOfflineActivityById(entry.id);
          synced++;
        } catch (err: any) {
          failed++;
          markOfflineActivityRetry(entry.id, err?.message || "Gagal kirim ke Firestore");
          if (isLikelyNetworkError(err)) {
            break;
          }
        }
      }

      if (synced > 0) {
        await reloadFromFirestore();
        setOfflineSyncBanner(
          `${synced} aktivitas offline berhasil dikirim ke Firestore saat sinyal kembali!`,
        );
      }
      return { synced, failed };
    } finally {
      syncingQueueRef.current = false;
      setIsSyncingOfflineQueue(false);
      setPendingOfflineCount(getOfflineActivityQueue().length);
    }
  }, [reloadFromFirestore]);

  const migrateDatasetToFirestore = useCallback(
    async (
      dataset: NormalizedDataset,
      accessRules: Record<string, Record<string, boolean>>,
    ) => {
      const current = auth.currentUser;
      setIsMigrating(true);
      setMigrationStage("Menyiapkan sinkronisasi ke Firestore...");
      try {
        const res = await migrateNormalizedDatasetToFirestore(
          current,
          dataset,
          accessRules,
          (msg) => setMigrationStage(msg),
        );
        await reloadFromFirestore({ forceFull: true });
        return res;
      } finally {
        setIsMigrating(false);
        setMigrationStage(null);
      }
    },
    [reloadFromFirestore],
  );

  const syncFromSourceToFirestore = useCallback(async (): Promise<{ totalDocs: number }> => {
    setIsMigrating(true);
    setMigrationStage("Menarik database dari Google Sheets...");
    try {
      const resp = await customFetch(`${SCRIPT_URL}?action=getInitialData&user=adityahead`);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} saat menarik database sumber.`);
      }
      const json = await resp.json();
      if (json?.status !== "success" || !json?.data) {
        throw new Error(json?.message || "Respon database sumber tidak valid.");
      }

      const src = json.data;
      setMigrationStage("Menormalisasi struktur data untuk Firestore...");
      const normalized = buildNormalizedCollections({
        employees: Array.isArray(src.employees) ? src.employees : [],
        kiosks: Array.isArray(src.channels) ? src.channels : [],
        workingRows: Array.isArray(src.workingData) ? src.workingData : [],
        drSalesRows: Array.isArray(src.drSalesData) ? src.drSalesData : [],
      });

      const rules =
        src.accessRules && Object.keys(src.accessRules).length > 0
          ? src.accessRules
          : DEFAULT_ACCESS_RULES;

      const current = auth.currentUser;
      const res = await migrateNormalizedDatasetToFirestore(
        current,
        normalized,
        rules,
        (msg) => setMigrationStage(msg),
        { replaceStale: true },
      );
      await reloadFromFirestore({ forceFull: true });
      return res;
    } finally {
      setIsMigrating(false);
      setMigrationStage(null);
    }
  }, [reloadFromFirestore]);

  // Pure Delta Mode: Smart Cache + Delta Sync on startup (with offline cache fallback)
  useEffect(() => {
    if (!isAuthReady) return;
    let cancelled = false;

    (async () => {
      try {
        const loaded = await reloadFromFirestore();
        if (cancelled || !loaded) return;

        // Only attempt auto-seed from Sheets when online
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          return;
        }

        const isCompletelyEmpty =
          loaded.employees.length === 0 &&
          loaded.partners.length === 0 &&
          loaded.hybrids.length === 0 &&
          loaded.lots.length === 0 &&
          loaded.dr_shipments.length === 0 &&
          loaded.opname_logs.length === 0;

        const hasStaleLegacyFormat =
          loaded.opname_logs.length > 0 &&
          loaded.opname_logs.some(
            (l) => l.checker_id && !String(l.doc_id || "").includes(l.checker_id),
          );

        const agusEmp = loaded.employees.find(
          (e) => String(e.full_name || "").trim().toLowerCase() === "agus herdianto",
        );
        const agusDirectReports = agusEmp
          ? loaded.employees.filter((e) => e.upline_id === agusEmp.doc_id)
          : [];
        const hasCorruptedHierarchyOrLots =
          loaded.employees.length > 192 ||
          agusDirectReports.length > 6 ||
          agusDirectReports.some((e) =>
            String(e.position || "").toLowerCase().includes("sales agronomist"),
          ) ||
          loaded.employees.filter(
            (e) => String(e.full_name || "").trim().toLowerCase() === "christien yunianto",
          ).length > 1 ||
          loaded.lots.some(
            (l) =>
              (l.doc_id === "PL52B1003" || l.doc_id === "PJ52B1003") && !l.hybrid_id,
          );

        if (
          (isCompletelyEmpty || hasStaleLegacyFormat || hasCorruptedHierarchyOrLots) &&
          !autoSyncAttemptedRef.current
        ) {
          autoSyncAttemptedRef.current = true;
          try {
            await syncFromSourceToFirestore();
          } catch (syncErr) {
            console.warn("Auto-sync dari database sumber gagal:", syncErr);
          }
        }
      } catch (err) {
        console.error("Failed to initialize Firestore data:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isAuthReady,
    isAuthorizedFirebase,
    firebaseUser,
    listenerRetryTick,
    reloadFromFirestore,
    syncFromSourceToFirestore,
  ]);

  // Auto-flush queued offline submissions when internet returns
  useEffect(() => {
    if (!isAuthReady || !isOnline || !firestoreDataset) return;
    if (getOfflineActivityQueue().length === 0) return;

    const timer = setTimeout(() => {
      syncOfflineQueueNow().catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [isAuthReady, isOnline, firestoreDataset, syncOfflineQueueNow]);

  // Smart Refresh Reminder triggers (quota-safe: local checks + throttled 5m focus probe)
  useEffect(() => {
    if (!isOnline) {
      wasOfflineRef.current = true;
      return;
    }

    if (wasOfflineRef.current) {
      wasOfflineRef.current = false;
      setNeedsRefresh(true);
      setRefreshReason(
        "Sinyal internet baru tersambung kembali — klik Refresh untuk mengambil data terbaru.",
      );
      return;
    }

    if (syncMode === "cache") {
      setNeedsRefresh(true);
      setRefreshReason(
        "Data masih berasal dari cache offline — sinyal tersedia, klik Refresh untuk sinkronkan.",
      );
    }
  }, [isOnline, syncMode]);

  useEffect(() => {
    if (!isAuthReady || !isOnline) return;

    const STALE_THRESHOLD_MS = 10 * 60 * 1000;
    const PROBE_COOLDOWN_MS = 5 * 60 * 1000;

    const evaluateStaleness = () => {
      if (!lastSyncAt) return;
      if (Date.now() - lastSyncAt >= STALE_THRESHOLD_MS) {
        setNeedsRefresh(true);
        setRefreshReason(
          "Sudah lebih dari 10 menit sejak sinkronisasi terakhir — klik Refresh untuk cek pembaruan.",
        );
      }
    };

    const probeRemoteIfVisible = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (!lastSyncAt) return;
      const now = Date.now();
      if (now - lastSyncAt < 60 * 1000) return;
      if (now - lastRemoteProbeAtRef.current < PROBE_COOLDOWN_MS) return;

      lastRemoteProbeAtRef.current = now;
      const hasNew = await checkHasRemoteUpdates(lastSyncAt);
      if (hasNew) {
        setNeedsRefresh(true);
        setRefreshReason(
          "Ada pembaruan data baru dari pengguna lain — klik Refresh untuk memuat.",
        );
      }
    };

    evaluateStaleness();
    const interval = setInterval(evaluateStaleness, 60 * 1000);

    const onVisibilityOrFocus = () => {
      evaluateStaleness();
      probeRemoteIfVisible().catch(() => {});
    };

    const onStorageSync = (e: StorageEvent) => {
      if (e.key === LAST_SYNC_STORAGE_KEY && e.newValue) {
        const externalMs = Number(e.newValue);
        if (Number.isFinite(externalMs) && (!lastSyncAt || externalMs > lastSyncAt)) {
          setNeedsRefresh(true);
          setRefreshReason(
            "Ada sinkronisasi terbaru dari tab lain — klik Refresh untuk menyelaraskan tampilan.",
          );
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    window.addEventListener("focus", onVisibilityOrFocus);
    window.addEventListener("storage", onStorageSync);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityOrFocus);
      window.removeEventListener("focus", onVisibilityOrFocus);
      window.removeEventListener("storage", onStorageSync);
    };
  }, [isAuthReady, isOnline, lastSyncAt]);

  const retryFirestoreSync = useCallback(() => {
    setListenerRetryTick((t) => t + 1);
  }, []);

  const clearOfflineSyncBanner = useCallback(() => {
    setOfflineSyncBanner(null);
  }, []);

  const connectGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      const user = await signInWithGooglePopup();
      await ensureUserBootstrap(user);
      return user;
    } catch (err: any) {
      const msg =
        err?.message ||
        `Gagal autentikasi. Gunakan akun ${BOOTSTRAPPED_ADMIN_EMAIL}.`;
      setAuthError(msg);
      throw err;
    }
  }, []);

  const disconnectGoogle = useCallback(async () => {
    await signOutFirebase();
    setFirebaseUser(null);
    setAuthError(null);
  }, []);

  const hasFirestoreData = Boolean(
    firestoreDataset &&
      (firestoreDataset.employees.length > 0 ||
        firestoreDataset.partners.length > 0 ||
        firestoreDataset.opname_logs.length > 0 ||
        firestoreDataset.dr_shipments.length > 0),
  );

  return (
    <FirebaseContext.Provider
      value={{
        firebaseUser,
        isAuthReady,
        isAuthorizedFirebase,
        isFirestoreConnected,
        isOnline,
        authError,
        firestoreReadError,
        firestoreDataset,
        firestoreAccessRules,
        hasFirestoreData,
        isLoadingFirestore,
        isMigrating,
        migrationStage,
        syncMode,
        lastSyncAt,
        needsRefresh,
        refreshReason,
        pendingOfflineCount,
        isSyncingOfflineQueue,
        offlineSyncBanner,
        clearOfflineSyncBanner,
        connectGoogle,
        disconnectGoogle,
        migrateDatasetToFirestore,
        syncFromSourceToFirestore,
        reloadFromFirestore,
        removeLocalFirestoreDocs,
        applyLocalActivityPatch,
        syncOfflineQueueNow,
        retryFirestoreSync,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
};

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error("useFirebase must be used inside FirebaseProvider");
  }
  return ctx;
}
