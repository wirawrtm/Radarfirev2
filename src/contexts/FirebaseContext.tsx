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
  ensureUserBootstrap,
  fetchAllFirestoreData,
  migrateNormalizedDatasetToFirestore,
  subscribeToFirestoreCollections,
} from "../services/firestoreDb";
import {
  buildNormalizedCollections,
  type NormalizedDataset,
} from "../utils/firestoreNormalization";
import { customFetch } from "../utils/api";
import { SCRIPT_URL, DEFAULT_ACCESS_RULES } from "../utils/constants";

const ACTIVE_DB_LABEL = firebaseConfig.firestoreDatabaseId || firebaseConfig.projectId || "Firestore";

interface FirebaseContextValue {
  firebaseUser: User | null;
  isAuthReady: boolean;
  isAuthorizedFirebase: boolean;
  isFirestoreConnected: boolean | null;
  authError: string | null;
  firestoreReadError: string | null;
  firestoreDataset: NormalizedDataset | null;
  firestoreAccessRules: Record<string, Record<string, boolean>> | null;
  hasFirestoreData: boolean;
  isLoadingFirestore: boolean;
  isMigrating: boolean;
  migrationStage: string | null;
  syncMode: "full" | "delta" | "cache" | null;
  liveSyncEnabled: boolean;
  setLiveSyncEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  connectGoogle: () => Promise<User>;
  disconnectGoogle: () => Promise<void>;
  migrateDatasetToFirestore: (
    dataset: NormalizedDataset,
    accessRules: Record<string, Record<string, boolean>>,
  ) => Promise<{ totalDocs: number }>;
  syncFromSourceToFirestore: () => Promise<{ totalDocs: number }>;
  reloadFromFirestore: (options?: { forceFull?: boolean }) => Promise<NormalizedDataset | null>;
  removeLocalFirestoreDocs: (colName: keyof NormalizedDataset, docIds: string[]) => void;
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
  const [liveSyncEnabled, setLiveSyncEnabled] = useState(false);
  const [listenerRetryTick, setListenerRetryTick] = useState(0);
  const autoSyncAttemptedRef = useRef(false);

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
        if (verifiedAdmin) {
          await ensureUserBootstrap(verifiedAdmin);
        }
        const data = await fetchAllFirestoreData(verifiedAdmin, options);
        setFirestoreReadError(null);
        setSyncMode(data.syncMode || "full");
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
        setFirestoreReadError(
          isPermDenied
            ? `Akses baca & edit belum aktif di Firestore Rules (${ACTIVE_DB_LABEL}). Login dengan ${BOOTSTRAPPED_ADMIN_EMAIL} atau publikasikan firestore.rules.`
            : `Gagal terhubung ke database Firebase (${ACTIVE_DB_LABEL}). Periksa koneksi internet Anda.`,
        );
        setFirestoreDataset((prev) => prev || EMPTY_DATASET);
        return null;
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

  // Smart Cache + Delta Sync on startup; optional real-time listeners only when liveSyncEnabled is true
  useEffect(() => {
    if (!isAuthReady) return;

    let unsubFirestore: (() => void) | null = null;
    let cancelled = false;
    const listenerUser = isAuthorizedFirebase && firebaseUser ? firebaseUser : null;

    (async () => {
      try {
        const loaded = await reloadFromFirestore();
        if (cancelled || !loaded) return;

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
          if (cancelled) return;
        }

        if (liveSyncEnabled) {
          unsubFirestore = subscribeToFirestoreCollections(
            listenerUser,
            (partial) => {
              if (cancelled) return;
              setFirestoreReadError(null);
              if (partial.dataset) {
                setFirestoreDataset((prev) => ({
                  employees: partial.dataset?.employees ?? prev?.employees ?? [],
                  partners: partial.dataset?.partners ?? prev?.partners ?? [],
                  hybrids: partial.dataset?.hybrids ?? prev?.hybrids ?? [],
                  lots: partial.dataset?.lots ?? prev?.lots ?? [],
                  dr_shipments: partial.dataset?.dr_shipments ?? prev?.dr_shipments ?? [],
                  opname_logs: partial.dataset?.opname_logs ?? prev?.opname_logs ?? [],
                }));
              }
              if (partial.accessRules && Object.keys(partial.accessRules).length > 0) {
                setFirestoreAccessRules(partial.accessRules);
              }
            },
            (err) => {
              if (cancelled) return;
              const errText = String((err as any)?.message || err || "");
              const isPermDenied =
                errText.toLowerCase().includes("permission") ||
                errText.toLowerCase().includes("insufficient");
              setFirestoreReadError(
                isPermDenied
                  ? `Akses baca & edit tanpa login belum aktif di Firestore Rules (${ACTIVE_DB_LABEL}). Salin & publikasikan firestore.rules terbaru di Firebase Console.`
                  : "Sinkronisasi real-time Firestore terganggu.",
              );
              setFirestoreDataset((prev) => prev || EMPTY_DATASET);
            },
          );
        }
      } catch (err) {
        console.error("Failed to initialize Firestore data:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (unsubFirestore) unsubFirestore();
    };
  }, [
    isAuthReady,
    isAuthorizedFirebase,
    firebaseUser,
    liveSyncEnabled,
    listenerRetryTick,
    reloadFromFirestore,
    syncFromSourceToFirestore,
  ]);

  const retryFirestoreSync = useCallback(() => {
    setListenerRetryTick((t) => t + 1);
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
        authError,
        firestoreReadError,
        firestoreDataset,
        firestoreAccessRules,
        hasFirestoreData,
        isLoadingFirestore,
        isMigrating,
        migrationStage,
        syncMode,
        liveSyncEnabled,
        setLiveSyncEnabled,
        connectGoogle,
        disconnectGoogle,
        migrateDatasetToFirestore,
        syncFromSourceToFirestore,
        reloadFromFirestore,
        removeLocalFirestoreDocs,
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
