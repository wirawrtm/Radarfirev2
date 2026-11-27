import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromCache,
  increment,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import {
  db,
  handleFirestoreError,
  isBootstrappedAdminEmail,
  OperationType,
} from "../firebase";
import {
  clampStr,
  FISCAL_MONTH_COLS,
  formatToDDMMYYYY,
  normalizeOpnameUpdatedBy,
  parseDDMMYYYYToIso,
  toIsoDateStr,
  toStrictDivision,
  toValidDocId,
  type DivisionStrict,
  type DrShipmentFsDoc,
  type EmployeeFsDoc,
  type HybridFsDoc,
  type LotFsDoc,
  type MonthlyOpnameCell,
  type NormalizedDataset,
  type OpnameLogFsDoc,
  type OpnameUpdatedBy,
  type PartnerFsDoc,
} from "../utils/firestoreNormalization";
import { cleanForMatch, extractExpFromLot, getValidCategory } from "../utils/formatters";

export interface FirestoreAllData {
  dataset: NormalizedDataset;
  accessRules: Record<string, Record<string, boolean>>;
  syncMode?: "full" | "delta" | "cache";
}

export const LAST_SYNC_STORAGE_KEY = "radar_fs_last_sync_v1";

/**
 * Generates collision-free Firestore document IDs safe for 200+ concurrent users
 * without hot-counter bottlenecks or sequential length+1 overwrites.
 * Strictly conforms to firestore.rules isValidId: ^[a-zA-Z0-9_\-]+$ (max 128 chars).
 */
export function generateUniqueFsId(prefix: string): string {
  const cleanPrefix = toValidDocId(prefix, "ID").slice(0, 16);
  const ts = Date.now().toString(36).toUpperCase();
  let rand = "";
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    rand = Array.from(bytes, (b) => b.toString(36).toUpperCase().padStart(2, "0"))
      .join("")
      .slice(0, 6);
  } else {
    rand = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "0");
  }
  return toValidDocId(`${cleanPrefix}-${ts}-${rand}`);
}

const getScopedQuery = (colName: string, _user?: User | null) => {
  return collection(db, colName);
};

const bootstrapInFlight = new Map<string, Promise<void>>();

export async function ensureUserBootstrap(user: User): Promise<void> {
  if (!user?.uid || !user.email) return;

  const existingPromise = bootstrapInFlight.get(user.uid);
  if (existingPromise) {
    return existingPromise;
  }

  const run = (async () => {
    const isAdm = isBootstrappedAdminEmail(user.email);

    // 1. Ensure /admins/{uid} if bootstrapped admin
    if (isAdm) {
      const adminPath = `admins/${user.uid}`;
      try {
        const adminRef = doc(db, "admins", user.uid);
        const snap = await getDoc(adminRef);
        if (!snap.exists()) {
          await setDoc(adminRef, {
            uid: user.uid,
            email: clampStr(user.email, 120),
            role: "admin",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, adminPath);
      }
    }

    // 2. Ensure /users/{uid} profile doc
    const userPath = `users/${user.uid}`;
    try {
      const userRef = doc(db, "users", user.uid);
      const snap = await getDoc(userRef);
      if (!snap.exists()) {
        await setDoc(userRef, {
          uid: user.uid,
          email: clampStr(user.email, 120),
          displayName: clampStr(user.displayName || user.email.split("@")[0], 120, "User"),
          divisionGroup: "All",
          roleLevel: isAdm ? 5 : 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, userPath);
    }
  })();

  bootstrapInFlight.set(user.uid, run);
  try {
    await run;
  } finally {
    bootstrapInFlight.delete(user.uid);
  }
}

export function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as any)?.code || "").toLowerCase();
  const msg = String((err as any)?.message || err || "").toLowerCase();
  return (
    code.includes("permission-denied") ||
    msg.includes("permission") ||
    msg.includes("insufficient")
  );
}

const SKU_DELIM = "__SKU__";

export function packHybridNameWithSku(hybridName: string, sku?: string | null): string {
  const baseName = String(hybridName || "")
    .split(SKU_DELIM)[0]
    .trim()
    .toUpperCase();
  const cleanSku = clampStr(String(sku || "").trim().toUpperCase(), 35);
  if (!cleanSku) {
    return clampStr(baseName, 100, "ADV808");
  }
  const clampedBase = clampStr(baseName, 55, "ADV808");
  return `${clampedBase}${SKU_DELIM}${cleanSku}`;
}

export function unpackHybridDoc(raw: any): HybridFsDoc {
  const rawName = String(raw?.hybrid_name || "");
  if (rawName.includes(SKU_DELIM)) {
    const [namePart, skuPart] = rawName.split(SKU_DELIM);
    const cleanSku = String(raw?.sku || skuPart || "").trim();
    return {
      ...raw,
      doc_id: raw.doc_id,
      hybrid_name: namePart.trim(),
      ...(cleanSku ? { sku: cleanSku } : {}),
      crop_type: toStrictDivision(raw?.crop_type),
    };
  }
  const fallbackSku = String(raw?.sku || skuMetaStore.hybrids.get(raw?.doc_id) || "").trim();
  return {
    ...raw,
    doc_id: raw.doc_id,
    hybrid_name: rawName.trim(),
    ...(fallbackSku ? { sku: fallbackSku } : {}),
    crop_type: toStrictDivision(raw?.crop_type),
  };
}

const knownSkuMetaDocIds = new Set<string>();
const skuMetaStore: {
  hybrids: Map<string, string>;
  lots: Map<string, string>;
  dr_shipments: Map<string, string>;
  opname_logs: Map<string, string>;
} = {
  hybrids: new Map(),
  lots: new Map(),
  dr_shipments: new Map(),
  opname_logs: new Map(),
};

function getSkuMetaDocId(prefix: "LOT" | "DR" | "LOG" | "HYB", targetId: string): string {
  return toValidDocId(`SKU_${prefix}_${targetId}`).slice(0, 120);
}

function buildSkuMetaOp(
  _ownerUid: string,
  prefix: "LOT" | "DR" | "LOG" | "HYB",
  targetId: string,
  skuVal: string,
): {
  type: "delete";
  colName: string;
  docId: string;
} | null {
  if (!targetId) return null;
  const metaDocId = getSkuMetaDocId(prefix, targetId);
  const targetMap =
    prefix === "LOT"
      ? skuMetaStore.lots
      : prefix === "DR"
        ? skuMetaStore.dr_shipments
        : prefix === "LOG"
          ? skuMetaStore.opname_logs
          : skuMetaStore.hybrids;

  const cleanSku = clampStr(String(skuVal || "").trim().toUpperCase(), 80);
  if (cleanSku) {
    // Store SKU directly on the entity document; stop creating SKU_* bloat in access_rules.
    targetMap.set(targetId, cleanSku);
  } else {
    targetMap.delete(targetId);
  }

  // Clean up any legacy SKU_* document in access_rules if one exists
  if (knownSkuMetaDocIds.has(metaDocId) && !cleanSku) {
    knownSkuMetaDocIds.delete(metaDocId);
    return {
      type: "delete",
      colName: "access_rules",
      docId: metaDocId,
    };
  }
  return null;
}

function parseAccessAndSkuMetaDocs(accessDocs: any[]): Record<string, Record<string, boolean>> {
  const accessRules: Record<string, Record<string, boolean>> = {};
  knownSkuMetaDocIds.clear();
  skuMetaStore.hybrids.clear();
  skuMetaStore.lots.clear();
  skuMetaStore.dr_shipments.clear();
  skuMetaStore.opname_logs.clear();

  accessDocs.forEach((docItem) => {
    const id = String(docItem?.doc_id || "");
    const posVal = String(docItem?.position || "").trim();
    if (id.startsWith("SKU_LOT_")) {
      knownSkuMetaDocIds.add(id);
      const targetId = id.slice("SKU_LOT_".length);
      if (targetId && posVal) skuMetaStore.lots.set(targetId, posVal);
      return;
    }
    if (id.startsWith("SKU_DR_")) {
      knownSkuMetaDocIds.add(id);
      const targetId = id.slice("SKU_DR_".length);
      if (targetId && posVal) skuMetaStore.dr_shipments.set(targetId, posVal);
      return;
    }
    if (id.startsWith("SKU_LOG_")) {
      knownSkuMetaDocIds.add(id);
      const targetId = id.slice("SKU_LOG_".length);
      if (targetId && posVal) skuMetaStore.opname_logs.set(targetId, posVal);
      return;
    }
    if (id.startsWith("SKU_HYB_")) {
      knownSkuMetaDocIds.add(id);
      const targetId = id.slice("SKU_HYB_".length);
      if (targetId && posVal) skuMetaStore.hybrids.set(targetId, posVal);
      return;
    }
    if (posVal) {
      accessRules[posVal] = {
        home: !!docItem.home,
        partner: !!docItem.partner,
        stock: !!docItem.stock,
        pog: !!docItem.pog,
        overview: !!docItem.overview,
        temp: !!docItem.temp,
        access: !!docItem.access,
      };
    }
  });

  return accessRules;
}

function enrichLotsWithSku(rawLots: LotFsDoc[]): LotFsDoc[] {
  return rawLots.map((l) => {
    const sku = String(l.sku || skuMetaStore.lots.get(l.doc_id) || "").trim();
    return sku ? { ...l, sku } : l;
  });
}

function enrichDrWithSku(rawDrs: DrShipmentFsDoc[]): DrShipmentFsDoc[] {
  return rawDrs.map((d) => {
    const sku = String(
      d.sku || skuMetaStore.dr_shipments.get(d.doc_id) || skuMetaStore.lots.get(d.lot_no) || "",
    ).trim();
    return sku ? { ...d, sku } : d;
  });
}

function enrichLogsWithSku(rawLogs: OpnameLogFsDoc[]): OpnameLogFsDoc[] {
  return rawLogs.map((l) => {
    const sku = String(
      l.sku || skuMetaStore.opname_logs.get(l.doc_id) || skuMetaStore.lots.get(l.lot_no) || "",
    ).trim();
    return {
      ...l,
      ...(sku ? { sku } : {}),
      _key: l.doc_id,
    };
  });
}

function readLastSyncMs(): number {
  try {
    if (typeof localStorage === "undefined") return 0;
    const raw = Number(localStorage.getItem(LAST_SYNC_STORAGE_KEY) || "0");
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  } catch {
    return 0;
  }
}

export function getLastSyncTimestampMs(): number | null {
  const ms = readLastSyncMs();
  return ms > 0 ? ms : null;
}

function writeLastSyncMs(ms: number): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LAST_SYNC_STORAGE_KEY, String(ms));
    }
  } catch {
    // ignore storage quota
  }
}

async function raceTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Quota-safe check for newer updates on the server (max 2 reads per check).
 * Should only be called sparingly (e.g., tab focus with >= 5 min cooldown).
 */
export async function checkHasRemoteUpdates(sinceMs: number): Promise<boolean> {
  if (!sinceMs || sinceMs <= 0) return false;
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;

  try {
    const sinceTs = Timestamp.fromMillis(sinceMs + 2000);
    const [opnameSnap, partnerSnap] = await raceTimeout(
      Promise.all([
        getDocs(query(collection(db, "opname_logs"), where("updatedAt", ">", sinceTs), limit(1))),
        getDocs(query(collection(db, "partners"), where("updatedAt", ">", sinceTs), limit(1))),
      ]),
      4000,
      "Timeout checking remote updates",
    );
    return !opnameSnap.empty || !partnerSnap.empty;
  } catch {
    return false;
  }
}

export async function fetchAllFromCacheOnly(
  user: User | null,
): Promise<FirestoreAllData | null> {
  const readCacheCol = async <T,>(colName: string): Promise<T[]> => {
    try {
      const snap = await getDocsFromCache(getScopedQuery(colName, user));
      return snap.docs.map((d) => ({ doc_id: d.id, ...(d.data() as any) })) as T[];
    } catch {
      return [];
    }
  };

  const [employees, partners, rawHybrids, rawLots, rawDrShipments, rawOpnameLogs, accessDocs] =
    await Promise.all([
      readCacheCol<EmployeeFsDoc>("employees"),
      readCacheCol<PartnerFsDoc>("partners"),
      readCacheCol<HybridFsDoc>("hybrids"),
      readCacheCol<LotFsDoc>("lots"),
      readCacheCol<DrShipmentFsDoc>("dr_shipments"),
      readCacheCol<OpnameLogFsDoc>("opname_logs"),
      readCacheCol<any>("access_rules"),
    ]);

  const hasAny =
    employees.length > 0 ||
    partners.length > 0 ||
    rawHybrids.length > 0 ||
    rawLots.length > 0 ||
    rawDrShipments.length > 0 ||
    rawOpnameLogs.length > 0;

  if (!hasAny) return null;

  const accessRules = parseAccessAndSkuMetaDocs(accessDocs);
  const hybrids = rawHybrids.map(unpackHybridDoc);
  const lots = enrichLotsWithSku(rawLots);
  const dr_shipments = enrichDrWithSku(rawDrShipments);
  const opname_logs = enrichLogsWithSku(rawOpnameLogs);

  return {
    dataset: {
      employees,
      partners,
      hybrids,
      lots,
      dr_shipments,
      opname_logs,
    },
    accessRules,
    syncMode: "cache",
  };
}

export async function fetchAllFirestoreData(
  user: User | null,
  options?: { forceFull?: boolean },
): Promise<FirestoreAllData> {
  const isBrowserOffline = typeof navigator !== "undefined" && !navigator.onLine;
  if (isBrowserOffline) {
    if (options?.forceFull) {
      throw new Error(
        "Perangkat sedang offline / tanpa sinyal. Gunakan Muat Ulang Penuh setelah sinyal kembali.",
      );
    }
    const cachedOnly = await fetchAllFromCacheOnly(user);
    if (cachedOnly) return cachedOnly;
  }

  const fetchColFull = async <T,>(colName: string): Promise<T[]> => {
    try {
      const snap = await raceTimeout(
        getDocs(getScopedQuery(colName, user)),
        15000,
        `Koneksi lambat / timeout saat memuat ${colName}.`,
      );
      return snap.docs.map((d) => ({ doc_id: d.id, ...(d.data() as any) })) as T[];
    } catch (err) {
      if (!user && isPermissionDeniedError(err)) {
        throw err;
      }
      handleFirestoreError(err, OperationType.LIST, colName);
    }
  };

  let usedCacheFallback = false;

  const fetchColCachePlusDelta = async <T extends { doc_id: string }>(
    colName: string,
    sinceTs: Timestamp,
  ): Promise<T[] | null> => {
    try {
      const colRef = getScopedQuery(colName, user);
      const cacheSnap = await getDocsFromCache(colRef);
      if (cacheSnap.empty && (colName === "employees" || colName === "partners" || colName === "hybrids")) {
        return null;
      }
      const merged = new Map<string, T>();
      cacheSnap.docs.forEach((d) => {
        merged.set(d.id, { doc_id: d.id, ...(d.data() as any) } as T);
      });

      try {
        const deltaSnap = await raceTimeout(
          getDocs(query(colRef, where("updatedAt", ">", sinceTs))),
          6500,
          `Delta query timeout (${colName})`,
        );
        deltaSnap.docs.forEach((d) => {
          merged.set(d.id, { doc_id: d.id, ...(d.data() as any) } as T);
        });
      } catch (deltaErr) {
        if (!user && isPermissionDeniedError(deltaErr)) {
          throw deltaErr;
        }
        // Weak signal / offline fallback: keep local IndexedDB cache if available!
        if (merged.size > 0 || cacheSnap.empty === false) {
          usedCacheFallback = true;
          return Array.from(merged.values());
        }
        return null;
      }
      return Array.from(merged.values());
    } catch (err) {
      if (!user && isPermissionDeniedError(err)) {
        throw err;
      }
      return null;
    }
  };

  const nowMs = Date.now();
  const lastSyncMs = !options?.forceFull ? readLastSyncMs() : 0;

  if (lastSyncMs > 0) {
    const sinceTs = Timestamp.fromMillis(Math.max(0, lastSyncMs - 5000));
    const [
      deltaEmployees,
      deltaPartners,
      deltaHybrids,
      deltaLots,
      deltaDrShipments,
      deltaOpnameLogs,
      deltaAccessDocs,
    ] = await Promise.all([
      fetchColCachePlusDelta<EmployeeFsDoc>("employees", sinceTs),
      fetchColCachePlusDelta<PartnerFsDoc>("partners", sinceTs),
      fetchColCachePlusDelta<HybridFsDoc>("hybrids", sinceTs),
      fetchColCachePlusDelta<LotFsDoc>("lots", sinceTs),
      fetchColCachePlusDelta<DrShipmentFsDoc>("dr_shipments", sinceTs),
      fetchColCachePlusDelta<OpnameLogFsDoc>("opname_logs", sinceTs),
      fetchColCachePlusDelta<any>("access_rules", sinceTs),
    ]);

    if (
      deltaEmployees !== null &&
      deltaPartners !== null &&
      deltaHybrids !== null &&
      deltaLots !== null &&
      deltaDrShipments !== null &&
      deltaOpnameLogs !== null &&
      deltaAccessDocs !== null
    ) {
      if (!usedCacheFallback) {
        writeLastSyncMs(nowMs);
      }
      const accessRules = parseAccessAndSkuMetaDocs(deltaAccessDocs);
      const hybrids = deltaHybrids.map(unpackHybridDoc);
      const lots = enrichLotsWithSku(deltaLots);
      const dr_shipments = enrichDrWithSku(deltaDrShipments);
      const opname_logs = enrichLogsWithSku(deltaOpnameLogs);

      return {
        dataset: {
          employees: deltaEmployees,
          partners: deltaPartners,
          hybrids,
          lots,
          dr_shipments,
          opname_logs,
        },
        accessRules,
        syncMode: usedCacheFallback ? "cache" : "delta",
      };
    }
  }

  try {
    // Preflight a single collection in public mode so unpublished Console rules fail cleanly in 1 request without 7x error spam
    let preflightAccessDocs: any[] | null = null;
    if (!user) {
      preflightAccessDocs = await fetchColFull<any>("access_rules");
    }

    const [employees, partners, rawHybrids, rawLots, rawDrShipments, rawOpnameLogs, accessDocs] =
      await Promise.all([
        fetchColFull<EmployeeFsDoc>("employees"),
        fetchColFull<PartnerFsDoc>("partners"),
        fetchColFull<HybridFsDoc>("hybrids"),
        fetchColFull<LotFsDoc>("lots"),
        fetchColFull<DrShipmentFsDoc>("dr_shipments"),
        fetchColFull<OpnameLogFsDoc>("opname_logs"),
        preflightAccessDocs !== null ? Promise.resolve(preflightAccessDocs) : fetchColFull<any>("access_rules"),
      ]);

    writeLastSyncMs(nowMs);

    const accessRules = parseAccessAndSkuMetaDocs(accessDocs);
    const hybrids = rawHybrids.map(unpackHybridDoc);
    const lots = enrichLotsWithSku(rawLots);
    const dr_shipments = enrichDrWithSku(rawDrShipments);
    const opname_logs = enrichLogsWithSku(rawOpnameLogs);

    return {
      dataset: {
        employees,
        partners,
        hybrids,
        lots,
        dr_shipments,
        opname_logs,
      },
      accessRules,
      syncMode: "full",
    };
  } catch (err) {
    if (!options?.forceFull) {
      const cachedOnly = await fetchAllFromCacheOnly(user);
      if (cachedOnly) return cachedOnly;
    }
    throw err;
  }
}

export function subscribeToFirestoreCollections(
  user: User | null,
  onUpdate: (partial: Partial<FirestoreAllData>) => void,
  onError?: (error: unknown, colName: string) => void,
): Unsubscribe {
  const unsubs: Unsubscribe[] = [];
  let cachedHybrids: any[] | null = null;
  let cachedLots: LotFsDoc[] | null = null;
  let cachedDrs: DrShipmentFsDoc[] | null = null;
  let cachedLogs: OpnameLogFsDoc[] | null = null;

  let pendingDatasetPatch: Partial<NormalizedDataset> = {};
  let pendingAccessRules: Record<string, Record<string, boolean>> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleFlush = (
    patchDataset?: Partial<NormalizedDataset>,
    accessRules?: Record<string, Record<string, boolean>>,
  ) => {
    if (patchDataset) {
      pendingDatasetPatch = { ...pendingDatasetPatch, ...patchDataset };
    }
    if (accessRules) {
      pendingAccessRules = accessRules;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const ds = pendingDatasetPatch;
      const ar = pendingAccessRules;
      pendingDatasetPatch = {};
      pendingAccessRules = undefined;
      onUpdate({
        ...(Object.keys(ds).length > 0 ? { dataset: ds as NormalizedDataset } : {}),
        ...(ar ? { accessRules: ar } : {}),
      });
    }, 60);
  };

  const listen = (colName: string, apply: (docs: any[]) => void) => {
    const q = getScopedQuery(colName, user);
    const unsub = onSnapshot(
      q,
      (snap) => {
        const docs = snap.docs.map((d) => ({ doc_id: d.id, ...(d.data() as any) }));
        apply(docs);
      },
      (error) => {
        if (onError) {
          onError(error, colName);
        } else {
          handleFirestoreError(error, OperationType.LIST, colName);
        }
      },
    );
    unsubs.push(unsub);
  };

  listen("employees", (docs) => scheduleFlush({ employees: docs }));
  listen("partners", (docs) => scheduleFlush({ partners: docs }));
  listen("hybrids", (docs) => {
    cachedHybrids = docs;
    scheduleFlush({ hybrids: docs.map(unpackHybridDoc) });
  });
  listen("lots", (docs) => {
    cachedLots = docs;
    scheduleFlush({
      lots: enrichLotsWithSku(docs),
      ...(cachedDrs ? { dr_shipments: enrichDrWithSku(cachedDrs) } : {}),
      ...(cachedLogs ? { opname_logs: enrichLogsWithSku(cachedLogs) } : {}),
    });
  });
  listen("dr_shipments", (docs) => {
    cachedDrs = docs;
    scheduleFlush({ dr_shipments: enrichDrWithSku(docs) });
  });
  listen("opname_logs", (docs) => {
    cachedLogs = docs;
    scheduleFlush({ opname_logs: enrichLogsWithSku(docs) });
  });
  listen("access_rules", (docs) => {
    const accessRules = parseAccessAndSkuMetaDocs(docs);
    scheduleFlush(
      {
        ...(cachedHybrids ? { hybrids: cachedHybrids.map(unpackHybridDoc) } : {}),
        ...(cachedLots ? { lots: enrichLotsWithSku(cachedLots) } : {}),
        ...(cachedDrs ? { dr_shipments: enrichDrWithSku(cachedDrs) } : {}),
        ...(cachedLogs ? { opname_logs: enrichLogsWithSku(cachedLogs) } : {}),
      },
      accessRules,
    );
  });

  return () => {
    if (flushTimer) clearTimeout(flushTimer);
    unsubs.forEach((u) => u());
  };
}

/**
 * Commit array of write operations in rule-safe batches.
 * Note: Firestore allows at most 20 get()/exists()/existsAfter() evaluations across a single batch/transaction.
 * Keep chunkSize <= 6 when documents trigger up to 3 existsAfter() lookups (e.g. opname_logs),
 * and <= 8 when documents trigger up to 2 existsAfter() lookups (e.g. dr_shipments).
 */
async function commitInChunks(
  ops: Array<{
    type: "create" | "update" | "delete";
    colName: string;
    docId: string;
    data?: Record<string, any>;
  }>,
  chunkSize = 6,
) {
  if (ops.length === 0) return;

  const chunks: Array<typeof ops> = [];
  for (let i = 0; i < ops.length; i += chunkSize) {
    chunks.push(ops.slice(i, i + chunkSize));
  }

  const CONCURRENCY = 5;
  for (let w = 0; w < chunks.length; w += CONCURRENCY) {
    const wave = chunks.slice(w, w + CONCURRENCY);
    await Promise.all(
      wave.map(async (slice) => {
        const batch = writeBatch(db);
        slice.forEach((op) => {
          const ref = doc(db, op.colName, op.docId);
          if (op.type === "delete") {
            batch.delete(ref);
          } else if (op.type === "create") {
            batch.set(ref, {
              ...(op.data || {}),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else {
            const updatePayload = { ...(op.data || {}) };
            delete updatePayload.doc_id;
            delete updatePayload.ownerUid;
            delete updatePayload.createdAt;
            batch.update(ref, {
              ...updatePayload,
              updatedAt: serverTimestamp(),
            });
          }
        });
        try {
          await batch.commit();
        } catch (err) {
          const sampleOp = slice[0];
          const samplePath = sampleOp ? `${sampleOp.colName}/${sampleOp.docId}` : "batch";
          const opType =
            sampleOp?.type === "delete"
              ? OperationType.DELETE
              : sampleOp?.type === "update"
                ? OperationType.UPDATE
                : OperationType.WRITE;
          handleFirestoreError(err, opType, samplePath);
        }
      }),
    );
  }
}

async function getExistingDocIds(colName: string, user?: User | null): Promise<Set<string>> {
  try {
    const snap = await getDocs(getScopedQuery(colName, user));
    return new Set(snap.docs.map((d) => d.id));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, colName);
  }
}

/**
 * Practical & Efficient Full Migration into the 6 normalized collections + access_rules.
 * Executes in 3 referentially safe stages (existsAfter constraints satisfied at every step).
 */
export async function migrateNormalizedDatasetToFirestore(
  user: User | null | undefined,
  dataset: NormalizedDataset,
  accessRules: Record<string, Record<string, boolean>>,
  onStage?: (msg: string) => void,
  options?: { replaceStale?: boolean },
): Promise<{ totalDocs: number; deletedStale?: number }> {
  if (user?.uid && user?.email) {
    await ensureUserBootstrap(user);
  }
  const ownerUid = user?.uid || "public";
  const replaceStale = Boolean(options?.replaceStale);

  onStage?.("Memeriksa dokumen existing di Firestore...");
  const [
    existingEmp,
    existingPartner,
    existingHybrid,
    existingLot,
    existingDr,
    existingLogs,
    existingAccess,
  ] = await Promise.all([
    getExistingDocIds("employees", user),
    getExistingDocIds("partners", user),
    getExistingDocIds("hybrids", user),
    getExistingDocIds("lots", user),
    getExistingDocIds("dr_shipments", user),
    getExistingDocIds("opname_logs", user),
    getExistingDocIds("access_rules", user),
  ]);

  const newEmpIds = new Set(dataset.employees.map((e) => toValidDocId(e.doc_id)));
  const newPartnerIds = new Set(dataset.partners.map((p) => toValidDocId(p.doc_id)));
  const newHybridIds = new Set(dataset.hybrids.map((h) => toValidDocId(h.doc_id)));
  const newLotIds = new Set(dataset.lots.map((l) => toValidDocId(l.doc_id)));
  const newDrIds = new Set(dataset.dr_shipments.map((d) => toValidDocId(d.doc_id)));
  const newLogIds = new Set(dataset.opname_logs.map((l) => toValidDocId(l.doc_id)));
  const newAccessIds = new Set(
    Object.keys(accessRules || {}).map((position) => toValidDocId(position, "ROLE")),
  );

  let deletedStale = 0;
  if (replaceStale) {
    const staleChildOps: Array<{ type: "delete"; colName: string; docId: string }> = [];
    existingLogs.forEach((id) => {
      if (!newLogIds.has(id)) {
        staleChildOps.push({ type: "delete", colName: "opname_logs", docId: id });
      }
    });
    existingDr.forEach((id) => {
      if (!newDrIds.has(id)) {
        staleChildOps.push({ type: "delete", colName: "dr_shipments", docId: id });
      }
    });
    if (staleChildOps.length > 0) {
      onStage?.(`Membersihkan ${staleChildOps.length} dokumen log lama di Firestore...`);
      await commitInChunks(staleChildOps, 50);
      deletedStale += staleChildOps.length;
    }
  }

  let totalDocs = 0;

  // STAGE 1: hybrids, employees, access_rules
  onStage?.("Tahap 1/3: Migrasi hybrids, employees & access_rules...");
  const stage1: Array<{
    type: "create" | "update";
    colName: string;
    docId: string;
    data: Record<string, any>;
  }> = [];

  dataset.hybrids.forEach((h) => {
    const docId = toValidDocId(h.doc_id);
    stage1.push({
      type: existingHybrid.has(docId) ? "update" : "create",
      colName: "hybrids",
      docId,
      data: {
        doc_id: docId,
        hybrid_name: clampStr(h.hybrid_name, 100, docId),
        crop_type: toStrictDivision(h.crop_type),
        ownerUid,
      },
    });
  });

  dataset.employees.forEach((e) => {
    const docId = toValidDocId(e.doc_id);
    stage1.push({
      type: existingEmp.has(docId) ? "update" : "create",
      colName: "employees",
      docId,
      data: {
        doc_id: docId,
        username: clampStr(e.username, 80),
        full_name: clampStr(e.full_name, 120, docId),
        position: clampStr(e.position, 100, "Business Solution"),
        role_level: Math.min(5, Math.max(1, Math.round(Number(e.role_level) || 1))),
        upline_id: e.upline_id ? toValidDocId(e.upline_id) : null,
        subordinate_ids: (e.subordinate_ids || []).map((id) => toValidDocId(id)).slice(0, 200),
        access_scope_ids: (e.access_scope_ids || []).map((id) => toValidDocId(id)).slice(0, 200),
        division_group: e.division_group === "All" ? "All" : toStrictDivision(e.division_group),
        province: clampStr(e.province, 80, "-"),
        area: clampStr(e.area, 80, "-"),
        status: e.status === "Nonaktif" ? "Nonaktif" : "Aktif",
        ownerUid,
      },
    });
  });

  Object.entries(accessRules || {}).forEach(([position, perms]) => {
    const docId = toValidDocId(position, "ROLE");
    stage1.push({
      type: existingAccess.has(docId) ? "update" : "create",
      colName: "access_rules",
      docId,
      data: {
        doc_id: docId,
        position: clampStr(position, 100, docId),
        home: !!perms.home,
        partner: !!perms.partner,
        stock: !!perms.stock,
        pog: !!perms.pog,
        overview: !!perms.overview,
        temp: !!perms.temp,
        access: !!perms.access,
        ownerUid,
      },
    });
  });

  await commitInChunks(stage1, 15);
  totalDocs += stage1.length;

  // STAGE 2: partners & lots (up to 1 existsAfter per doc -> max 15 <= 20)
  onStage?.("Tahap 2/3: Migrasi partners & lots...");
  const stage2: typeof stage1 = [];

  dataset.partners.forEach((p) => {
    const docId = toValidDocId(p.doc_id);
    stage2.push({
      type: existingPartner.has(docId) ? "update" : "create",
      colName: "partners",
      docId,
      data: {
        doc_id: docId,
        partner_name: clampStr(p.partner_name, 160, docId),
        category: clampStr(p.category, 40),
        pic_employee_id: p.pic_employee_id ? toValidDocId(p.pic_employee_id) : null,
        pic_name: clampStr(p.pic_name, 120),
        division_group: toStrictDivision(p.division_group),
        province: clampStr(p.province, 80, "-"),
        area: clampStr(p.area, 80, "-"),
        ownerUid,
      },
    });
  });

  dataset.lots.forEach((l) => {
    const docId = toValidDocId(l.doc_id);
    const numDr = Number(l.initial_dr_kg);
    stage2.push({
      type: existingLot.has(docId) ? "update" : "create",
      colName: "lots",
      docId,
      data: {
        doc_id: docId,
        hybrid_id: l.hybrid_id ? toValidDocId(l.hybrid_id) : null,
        shipping_date: clampStr(l.shipping_date, 20),
        exp_date: clampStr(l.exp_date, 20),
        initial_dr_kg: Number.isFinite(numDr) && numDr > 0 ? numDr : 0,
        ownerUid,
      },
    });
  });

  await commitInChunks(stage2, 15);
  totalDocs += stage2.length;

  // STAGE 3: dr_shipments & opname_logs (up to 3 existsAfter per doc -> max 6 per batch <= 20)
  onStage?.("Tahap 3/3: Migrasi dr_shipments & opname_logs...");
  const stage3: typeof stage1 = [];

  dataset.dr_shipments.forEach((dr) => {
    const docId = toValidDocId(dr.doc_id);
    const numQty = Number(dr.shipped_qty_kg);
    stage3.push({
      type: existingDr.has(docId) ? "update" : "create",
      colName: "dr_shipments",
      docId,
      data: {
        doc_id: docId,
        shipping_date: clampStr(dr.shipping_date, 20, "2026-01-01"),
        partner_id: dr.partner_id ? toValidDocId(dr.partner_id) : null,
        lot_no: toValidDocId(dr.lot_no),
        exp_date: clampStr(dr.exp_date, 20),
        shipped_qty_kg: Number.isFinite(numQty) && numQty > 0 ? numQty : 0,
        ownerUid,
      },
    });
  });

  dataset.opname_logs.forEach((log) => {
    const docId = toValidDocId(log.doc_id);
    const payload: Record<string, any> = {
      doc_id: docId,
      partner_id: log.partner_id ? toValidDocId(log.partner_id) : null,
      lot_no: toValidDocId(log.lot_no),
      checker_id: log.checker_id ? toValidDocId(log.checker_id) : null,
      crop_year: clampStr(log.crop_year, 12, "FY2026"),
      ownerUid,
    };
    FISCAL_MONTH_COLS.forEach(({ key }) => {
      const c = log[key];
      if (c) {
        const cIn = Number(c.in);
        const cIdle = Number(c.idle);
        const cPog = Number(c.pog);
        payload[key] = {
          in: Number.isFinite(cIn) && cIn > 0 ? cIn : 0,
          idle: Number.isFinite(cIdle) && cIdle > 0 ? cIdle : 0,
          pog: Number.isFinite(cPog) && cPog > 0 ? cPog : 0,
          updated_by: normalizeOpnameUpdatedBy(c.updated_by),
        };
      } else {
        payload[key] = null;
      }
    });

    stage3.push({
      type: existingLogs.has(docId) ? "update" : "create",
      colName: "opname_logs",
      docId,
      data: payload,
    });
  });

  await commitInChunks(stage3, 6);
  totalDocs += stage3.length;

  if (replaceStale) {
    const staleParentOps: Array<{ type: "delete"; colName: string; docId: string }> = [];
    existingLot.forEach((id) => {
      if (!newLotIds.has(id)) staleParentOps.push({ type: "delete", colName: "lots", docId: id });
    });
    existingPartner.forEach((id) => {
      if (!newPartnerIds.has(id)) {
        staleParentOps.push({ type: "delete", colName: "partners", docId: id });
      }
    });
    existingHybrid.forEach((id) => {
      if (!newHybridIds.has(id)) {
        staleParentOps.push({ type: "delete", colName: "hybrids", docId: id });
      }
    });
    existingEmp.forEach((id) => {
      if (!newEmpIds.has(id)) {
        staleParentOps.push({ type: "delete", colName: "employees", docId: id });
      }
    });
    existingAccess.forEach((id) => {
      if (!id.startsWith("SKU_") && !newAccessIds.has(id)) {
        staleParentOps.push({ type: "delete", colName: "access_rules", docId: id });
      }
    });
    if (staleParentOps.length > 0) {
      onStage?.(`Membersihkan ${staleParentOps.length} dokumen master usang di Firestore...`);
      await commitInChunks(staleParentOps, 50);
      deletedStale += staleParentOps.length;
    }
  }

  return { totalDocs, deletedStale };
}

// ============================================================================
// DIRECT FIRESTORE CRUD HELPERS (OPEN ACCESS: WORKS WITH OR WITHOUT SIGN-IN)
// ============================================================================

export async function saveAccessRulesFirestore(
  user: User | null | undefined,
  rules: Record<string, Record<string, boolean>>,
): Promise<void> {
  const ownerUid = user?.uid || "public";
  const existing = await getExistingDocIds("access_rules", user);
  const targetDocIds = new Set<string>();
  const ops: Array<{
    type: "create" | "update" | "delete";
    colName: string;
    docId: string;
    data?: Record<string, any>;
  }> = Object.entries(rules).map(([position, perms]) => {
    const docId = toValidDocId(position, "ROLE");
    targetDocIds.add(docId);
    return {
      type: existing.has(docId) ? ("update" as const) : ("create" as const),
      colName: "access_rules",
      docId,
      data: {
        doc_id: docId,
        position: clampStr(position, 100, docId),
        home: !!perms.home,
        partner: !!perms.partner,
        stock: !!perms.stock,
        pog: !!perms.pog,
        overview: !!perms.overview,
        temp: !!perms.temp,
        access: !!perms.access,
        ownerUid,
      },
    };
  });

  existing.forEach((existingDocId) => {
    if (!existingDocId.startsWith("SKU_") && !targetDocIds.has(existingDocId)) {
      ops.push({
        type: "delete",
        colName: "access_rules",
        docId: existingDocId,
      });
    }
  });

  await commitInChunks(ops, 15);
}

export async function upsertPartnerFirestore(
  user: User | null | undefined,
  partner: {
    doc_id: string;
    partner_name: string;
    category: string;
    pic_employee_id: string | null;
    pic_name: string;
    division_group: DivisionStrict;
    province: string;
    area: string;
  },
  isCreate: boolean,
): Promise<void> {
  const ownerUid = user?.uid || "public";
  const docId = toValidDocId(partner.doc_id);
  const path = `partners/${docId}`;
  const ref = doc(db, "partners", docId);
  try {
    if (isCreate) {
      await setDoc(ref, {
        doc_id: docId,
        partner_name: clampStr(partner.partner_name, 160, docId),
        category: clampStr(partner.category, 40),
        pic_employee_id: partner.pic_employee_id ? toValidDocId(partner.pic_employee_id) : null,
        pic_name: clampStr(partner.pic_name, 120),
        division_group: toStrictDivision(partner.division_group),
        province: clampStr(partner.province, 80, "-"),
        area: clampStr(partner.area, 80, "-"),
        ownerUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        partner_name: clampStr(partner.partner_name, 160, docId),
        category: clampStr(partner.category, 40),
        pic_employee_id: partner.pic_employee_id ? toValidDocId(partner.pic_employee_id) : null,
        pic_name: clampStr(partner.pic_name, 120),
        division_group: toStrictDivision(partner.division_group),
        province: clampStr(partner.province, 80, "-"),
        area: clampStr(partner.area, 80, "-"),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, isCreate ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function deletePartnerFirestore(docId: string): Promise<void> {
  const cleanId = toValidDocId(docId);
  const path = `partners/${cleanId}`;
  try {
    await deleteDoc(doc(db, "partners", cleanId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function upsertEmployeeFirestore(
  user: User | null | undefined,
  emp: EmployeeFsDoc,
  isCreate: boolean,
): Promise<void> {
  const ownerUid = user?.uid || "public";
  const docId = toValidDocId(emp.doc_id);
  const path = `employees/${docId}`;
  const ref = doc(db, "employees", docId);
  const baseFields = {
    username: clampStr(emp.username, 80),
    full_name: clampStr(emp.full_name, 120, docId),
    position: clampStr(emp.position, 100, "Business Solution"),
    role_level: Math.min(5, Math.max(1, Math.round(Number(emp.role_level) || 1))),
    upline_id: emp.upline_id ? toValidDocId(emp.upline_id) : null,
    subordinate_ids: (emp.subordinate_ids || []).map((id) => toValidDocId(id)).slice(0, 200),
    access_scope_ids: (emp.access_scope_ids || []).map((id) => toValidDocId(id)).slice(0, 200),
    division_group: emp.division_group === "All" ? "All" : toStrictDivision(emp.division_group),
    province: clampStr(emp.province, 80, "-"),
    area: clampStr(emp.area, 80, "-"),
    status: emp.status === "Nonaktif" ? "Nonaktif" : "Aktif",
  };

  try {
    if (isCreate) {
      await setDoc(ref, {
        doc_id: docId,
        ...baseFields,
        ownerUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        ...baseFields,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, isCreate ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function deleteEmployeeFirestore(docId: string): Promise<void> {
  const cleanId = toValidDocId(docId);
  const path = `employees/${cleanId}`;
  try {
    await deleteDoc(doc(db, "employees", cleanId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

/**
 * Save DR Spreadsheet upload directly to Firestore (hybrids -> partners & lots -> dr_shipments).
 */
export async function saveUploadedDrToFirestore(
  user: User | null | undefined,
  parsedRows: Array<{
    channel: string;
    lot: string;
    sku?: string;
    qty: number;
    drDate: string;
    expired: string;
    hybrid: string;
    crops: DivisionStrict;
  }>,
  currentDataset: NormalizedDataset,
): Promise<{ uploadedCount: number; createdPartners: number }> {
  const ownerUid = user?.uid || "public";
  const existingPartnersByClean = new Map<string, PartnerFsDoc>();
  const existingPartnerIds = new Set<string>();
  currentDataset.partners.forEach((p) => {
    existingPartnersByClean.set(cleanForMatch(p.partner_name), p);
    existingPartnerIds.add(toValidDocId(p.doc_id));
  });

  const existingHybridsByClean = new Map<string, HybridFsDoc>();
  const existingHybridIds = new Set<string>();
  currentDataset.hybrids.forEach((h) => {
    existingHybridsByClean.set(cleanForMatch(h.hybrid_name), h);
    existingHybridIds.add(toValidDocId(h.doc_id));
  });

  const existingLotsById = new Map<string, LotFsDoc>();
  const existingLotsByClean = new Map<string, LotFsDoc>();
  currentDataset.lots.forEach((l) => {
    const id = toValidDocId(l.doc_id);
    existingLotsById.set(id, l);
    const cl = cleanForMatch(id);
    if (cl) existingLotsByClean.set(cl, l);
  });

  const existingDrIds = new Set(currentDataset.dr_shipments.map((d) => toValidDocId(d.doc_id)));

  let createdPartners = 0;

  const hybridOps: any[] = [];
  const partnerOps: any[] = [];
  const lotOps: any[] = [];
  const drOps: any[] = [];

  const createdHybridKeys = new Set<string>();
  const createdPartnerKeys = new Set<string>();
  const lotDelta = new Map<
    string,
    {
      exists: boolean;
      addKg: number;
      hybridId: string | null;
      shippingDate: string;
      expDate: string;
      sku: string;
    }
  >();

  for (const row of parsedRows) {
    const rawLotNo = toValidDocId(String(row.lot || "").toUpperCase(), "");
    if (!rawLotNo) continue;
    const rowSku = clampStr(row.sku, 80);

    // 1. Ensure Hybrid
    const hybName = clampStr(String(row.hybrid || "ADV808").toUpperCase(), 100, "ADV808");
    const hybKey = cleanForMatch(hybName);
    let hybDoc = existingHybridsByClean.get(hybKey);
    if (!hybDoc && !createdHybridKeys.has(hybKey)) {
      let hybId = generateUniqueFsId("HYB");
      while (existingHybridIds.has(hybId)) {
        hybId = generateUniqueFsId("HYB");
      }
      existingHybridIds.add(hybId);
      hybDoc = {
        doc_id: hybId,
        hybrid_name: hybName,
        ...(rowSku ? { sku: rowSku } : {}),
        crop_type: toStrictDivision(row.crops),
      };
      existingHybridsByClean.set(hybKey, hybDoc);
      createdHybridKeys.add(hybKey);
      hybridOps.push({
        type: "create",
        colName: "hybrids",
        docId: hybId,
        data: {
          doc_id: hybId,
          hybrid_name: packHybridNameWithSku(hybName, rowSku),
          sku: rowSku || null,
          crop_type: hybDoc.crop_type,
          ownerUid,
        },
      });
    }

    // 2. Ensure Partner
    const pName = clampStr(row.channel, 160);
    const pKey = cleanForMatch(pName);
    let pDoc = existingPartnersByClean.get(pKey);
    if (!pDoc && pKey && !createdPartnerKeys.has(pKey)) {
      let prtId = generateUniqueFsId("PRT");
      while (existingPartnerIds.has(prtId)) {
        prtId = generateUniqueFsId("PRT");
      }
      existingPartnerIds.add(prtId);
      pDoc = {
        doc_id: prtId,
        partner_name: pName,
        category: getValidCategory("Distributor", undefined, pName),
        pic_employee_id: null,
        pic_name: "",
        division_group: toStrictDivision(row.crops),
        province: "-",
        area: "-",
      };
      existingPartnersByClean.set(pKey, pDoc);
      createdPartnerKeys.add(pKey);
      createdPartners++;
      partnerOps.push({
        type: "create",
        colName: "partners",
        docId: prtId,
        data: {
          doc_id: prtId,
          partner_name: pDoc.partner_name,
          category: pDoc.category,
          pic_employee_id: null,
          pic_name: "",
          division_group: pDoc.division_group,
          province: "-",
          area: "-",
          ownerUid,
        },
      });
    }

    // 3. Aggregate Lot delta atomically per lotNo
    const shippingDate = clampStr(toIsoDateStr(row.drDate), 20, "2026-01-01");
    const expDate = clampStr(toIsoDateStr(row.expired || extractExpFromLot(row.lot)), 20);
    const rawQty = Number(row.qty);
    const qtyKg = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 0;

    const cleanLotKey = cleanForMatch(rawLotNo);
    const existingLot = existingLotsById.get(rawLotNo) || existingLotsByClean.get(cleanLotKey);
    const lotNo = existingLot ? toValidDocId(existingLot.doc_id) : rawLotNo;
    const effectiveSku = rowSku || existingLot?.sku || hybDoc?.sku || "";

    const prevLotPending = lotDelta.get(lotNo);
    if (prevLotPending) {
      prevLotPending.addKg += qtyKg;
      if (!prevLotPending.sku && effectiveSku) prevLotPending.sku = effectiveSku;
    } else {
      lotDelta.set(lotNo, {
        exists: Boolean(existingLot),
        addKg: qtyKg,
        hybridId: existingLot?.hybrid_id || (hybDoc ? hybDoc.doc_id : null),
        shippingDate: existingLot?.shipping_date || shippingDate,
        expDate: existingLot?.exp_date || expDate,
        sku: clampStr(effectiveSku, 80),
      });
    }

    // 4. Create DR Shipment
    let drId = generateUniqueFsId("DR");
    while (existingDrIds.has(drId)) {
      drId = generateUniqueFsId("DR");
    }
    existingDrIds.add(drId);
    drOps.push({
      type: "create",
      colName: "dr_shipments",
      docId: drId,
      data: {
        doc_id: drId,
        shipping_date: shippingDate,
        partner_id: pDoc ? pDoc.doc_id : null,
        lot_no: lotNo,
        sku: effectiveSku || null,
        exp_date: expDate,
        shipped_qty_kg: qtyKg,
        ownerUid,
      },
    });
  }

  lotDelta.forEach((info, lotNo) => {
    if (!info.exists) {
      lotOps.push({
        type: "create",
        colName: "lots",
        docId: lotNo,
        data: {
          doc_id: lotNo,
          hybrid_id: info.hybridId,
          sku: info.sku || null,
          shipping_date: info.shippingDate,
          exp_date: info.expDate,
          initial_dr_kg: info.addKg,
          ownerUid,
        },
      });
    } else {
      lotOps.push({
        type: "update",
        colName: "lots",
        docId: lotNo,
        data: {
          hybrid_id: info.hybridId,
          ...(info.sku ? { sku: info.sku } : {}),
          shipping_date: info.shippingDate,
          exp_date: info.expDate,
          initial_dr_kg: increment(info.addKg),
        },
      });
    }
  });

  if (hybridOps.length > 0) await commitInChunks(hybridOps, 15);
  if (partnerOps.length > 0 || lotOps.length > 0) await commitInChunks([...partnerOps, ...lotOps], 15);
  if (drOps.length > 0) await commitInChunks(drOps, 8);

  return { uploadedCount: drOps.length, createdPartners };
}

/**
 * Persist HomeTab batch opname submission into Firestore (hybrids/lots if new + opname_logs).
 */
export async function saveBatchActivityToFirestore(
  user: User | null | undefined,
  params: {
    kioskName: string;
    checkerName: string;
    items: any[];
    currentDataset: NormalizedDataset;
  },
): Promise<void> {
  const { kioskName, checkerName, items, currentDataset } = params;
  const ownerUid = user?.uid || "public";

  const checker = currentDataset.employees.find(
    (e) =>
      cleanForMatch(e.full_name) === cleanForMatch(checkerName) ||
      cleanForMatch(e.username) === cleanForMatch(checkerName),
  );
  const cleanKiosk = cleanForMatch(kioskName);
  const partner =
    (checker
      ? currentDataset.partners.find(
          (p) =>
            cleanForMatch(p.partner_name) === cleanKiosk &&
            p.pic_employee_id === checker.doc_id,
        )
      : undefined) ||
    currentDataset.partners.find(
      (p) =>
        cleanForMatch(p.partner_name) === cleanKiosk &&
        cleanForMatch(p.pic_name) === cleanForMatch(checkerName),
    ) ||
    currentDataset.partners.find((p) => cleanForMatch(p.partner_name) === cleanKiosk);

  const existingHybrids = new Map(
    currentDataset.hybrids.map((h) => [cleanForMatch(h.hybrid_name), h]),
  );
  const existingHybridIds = new Set(currentDataset.hybrids.map((h) => toValidDocId(h.doc_id)));
  const existingLots = new Set(currentDataset.lots.map((l) => toValidDocId(l.doc_id)));
  const existingLogsMap = new Map(
    currentDataset.opname_logs.map((l) => [toValidDocId(l.doc_id), l]),
  );

  const stage1Hybrids: any[] = [];
  const stage2Lots: any[] = [];
  const stage3Logs: any[] = [];

  for (const item of items) {
    const lotNo = toValidDocId(String(item.lot || "").toUpperCase(), "");
    if (!lotNo) continue;

    // Ensure Hybrid (infer MADU 59 / Fresh Corn for PL52B/PJ52B lots if blank)
    const lotUpper = String(item.lot || "").trim().toUpperCase();
    const rawHybrid = String(item.hybrid || "").trim();
    const inferredHybrid =
      rawHybrid && rawHybrid.toLowerCase() !== "unknown"
        ? rawHybrid
        : lotUpper.startsWith("PL52B") || lotUpper.startsWith("PJ52B")
          ? "MADU 59"
          : "ADV808";
    const hybName = clampStr(inferredHybrid.toUpperCase(), 100, "ADV808");
    const hybClean = cleanForMatch(hybName);
    let hyb = existingHybrids.get(hybClean);
    if (!hyb) {
      let hybId = generateUniqueFsId("HYB");
      while (existingHybridIds.has(hybId)) {
        hybId = generateUniqueFsId("HYB");
      }
      existingHybridIds.add(hybId);
      hyb = { doc_id: hybId, hybrid_name: hybName, crop_type: toStrictDivision(item.crops) };
      existingHybrids.set(hybClean, hyb);
      stage1Hybrids.push({
        type: "create",
        colName: "hybrids",
        docId: hybId,
        data: { ...hyb, ownerUid },
      });
    }

    // Ensure Lot
    if (!existingLots.has(lotNo)) {
      existingLots.add(lotNo);
      stage2Lots.push({
        type: "create",
        colName: "lots",
        docId: lotNo,
        data: {
          doc_id: lotNo,
          hybrid_id: hyb.doc_id,
          shipping_date: clampStr(toIsoDateStr(item.drDate), 20),
          exp_date: clampStr(toIsoDateStr(item.expired || extractExpFromLot(item.lot)), 20),
          initial_dr_kg: 0,
          ownerUid,
        },
      });
    }

    // Compute Fiscal Apr->Mar monthly cells from item month values
    const prtPart = partner ? partner.doc_id : toValidDocId(kioskName, "NO_PRT");
    const chkPart = checker ? checker.doc_id : toValidDocId(checkerName, "NO_CHK");
    const preferredLogId = toValidDocId(`${prtPart}_${lotNo}_${chkPart}_FY2026`);
    const legacyLogId = toValidDocId(`${prtPart}_${lotNo}_FY2026`);
    const matchedLog = existingLogsMap.get(preferredLogId) || existingLogsMap.get(legacyLogId);
    const logId = matchedLog ? matchedLog.doc_id : preferredLogId;
    const existingLog = matchedLog;

    const monthPayload: Record<string, MonthlyOpnameCell | null> = {};
    let prev: number | null = null;
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
        const qty =
          hasVal
            ? Math.max(0, val)
            : Math.max(0, prevCell?.idle || 0);
        const inKg =
          isEditedMonth && item[`in_${key}`] !== undefined
            ? Math.max(0, Number(item[`in_${key}`]) || 0)
            : prev === null
              ? qty
              : qty > prev
                ? qty - prev
                : 0;
        const pogKg =
          isEditedMonth && item[`pog_${key}`] !== undefined
            ? Math.max(0, Number(item[`pog_${key}`]) || 0)
            : prev !== null && qty < prev
              ? prev - qty
              : 0;
        const updSource =
          item[`upd_${key}`] !== undefined && String(item[`upd_${key}`]).trim() !== ""
            ? item[`upd_${key}`]
            : prevCell?.updated_by;
        monthPayload[key] = {
          in: inKg,
          idle: qty,
          pog: pogKg,
          updated_by: normalizeOpnameUpdatedBy(updSource),
        };
        prev = qty;
      } else {
        monthPayload[key] = null;
      }
    });

    stage3Logs.push({
      type: existingLog ? "update" : "create",
      colName: "opname_logs",
      docId: logId,
      data: {
        doc_id: logId,
        partner_id: partner ? partner.doc_id : null,
        lot_no: lotNo,
        checker_id: checker ? checker.doc_id : existingLog?.checker_id || null,
        crop_year: "FY2026",
        ...monthPayload,
        ownerUid,
      },
    });
  }

  if (stage1Hybrids.length > 0) await commitInChunks(stage1Hybrids, 15);
  if (stage2Lots.length > 0) await commitInChunks(stage2Lots, 15);
  if (stage3Logs.length > 0) await commitInChunks(stage3Logs, 6);
}

/**
 * Add a single Hybrid document directly to Firestore (/hybrids/{doc_id}).
 */
export async function addHybridFirestore(
  user: User | null | undefined,
  params: {
    hybrid_name: string;
    sku?: string | null;
    crop_type: DivisionStrict;
    existingHybrids: HybridFsDoc[];
  },
): Promise<HybridFsDoc> {
  const ownerUid = user?.uid || "public";
  const cleanName = clampStr(params.hybrid_name.toUpperCase(), 100);
  if (!cleanName) throw new Error("Nama hybrid tidak boleh kosong.");
  const skuVal = clampStr(params.sku, 80);

  const existingIds = new Set(params.existingHybrids.map((h) => toValidDocId(h.doc_id)));
  let docId = generateUniqueFsId("HYB");
  while (existingIds.has(docId)) {
    docId = generateUniqueFsId("HYB");
  }

  const crop = toStrictDivision(params.crop_type);
  const newDoc: HybridFsDoc = {
    doc_id: docId,
    hybrid_name: cleanName,
    ...(skuVal ? { sku: skuVal } : {}),
    crop_type: crop,
  };

  try {
    await setDoc(doc(db, "hybrids", docId), {
      doc_id: docId,
      hybrid_name: packHybridNameWithSku(cleanName, skuVal),
      sku: skuVal || null,
      crop_type: crop,
      ownerUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return newDoc;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `hybrids/${docId}`);
  }
}

/**
 * Add a single Lot document directly to Firestore (/lots/{lot_no}).
 * Automatically creates a new hybrid atomically in the same batch if hybrid_name is supplied.
 */
export async function addLotFirestore(
  user: User | null | undefined,
  params: {
    lot_no: string;
    hybrid_id: string | null;
    sku?: string | null;
    new_hybrid_name?: string;
    crop_type?: DivisionStrict;
    shipping_date: string;
    exp_date: string;
    initial_dr_kg: number;
    existingHybrids: HybridFsDoc[];
    existingLots?: LotFsDoc[];
  },
): Promise<LotFsDoc> {
  const ownerUid = user?.uid || "public";
  const lotNo = toValidDocId(String(params.lot_no || "").toUpperCase(), "");
  if (!lotNo) throw new Error("Nomor Lot tidak boleh kosong.");
  const skuVal = clampStr(params.sku, 80);

  const ops: any[] = [];
  let finalHybridId = params.hybrid_id ? toValidDocId(params.hybrid_id) : null;

  if (!finalHybridId && params.new_hybrid_name?.trim()) {
    const hybName = clampStr(params.new_hybrid_name.toUpperCase(), 100);
    const existing = params.existingHybrids.find(
      (h) => cleanForMatch(h.hybrid_name) === cleanForMatch(hybName),
    );
    if (existing) {
      finalHybridId = existing.doc_id;
    } else {
      const existingIds = new Set(params.existingHybrids.map((h) => toValidDocId(h.doc_id)));
      let hybId = generateUniqueFsId("HYB");
      while (existingIds.has(hybId)) {
        hybId = generateUniqueFsId("HYB");
      }
      finalHybridId = hybId;
      ops.push({
        type: "create" as const,
        colName: "hybrids",
        docId: hybId,
        data: {
          doc_id: hybId,
          hybrid_name: packHybridNameWithSku(hybName, skuVal),
          sku: skuVal || null,
          crop_type: toStrictDivision(params.crop_type),
          ownerUid,
        },
      });
    }
  }

  const numDr = Number(params.initial_dr_kg);
  const newLot: LotFsDoc = {
    doc_id: lotNo,
    hybrid_id: finalHybridId,
    ...(skuVal ? { sku: skuVal } : {}),
    shipping_date: clampStr(toIsoDateStr(params.shipping_date), 20),
    exp_date: clampStr(toIsoDateStr(params.exp_date || extractExpFromLot(lotNo)), 20),
    initial_dr_kg: Number.isFinite(numDr) && numDr >= 0 ? numDr : 0,
  };

  const existingLot = (params.existingLots || []).find((l) => toValidDocId(l.doc_id) === lotNo);
  ops.push({
    type: (existingLot ? "update" : "create") as "create" | "update",
    colName: "lots",
    docId: lotNo,
    data: {
      doc_id: lotNo,
      hybrid_id: newLot.hybrid_id,
      sku: skuVal || null,
      shipping_date: newLot.shipping_date,
      exp_date: newLot.exp_date,
      initial_dr_kg: newLot.initial_dr_kg,
      ownerUid,
    },
  });
  const lotSkuOp = buildSkuMetaOp(ownerUid, "LOT", lotNo, skuVal);
  if (lotSkuOp) ops.push(lotSkuOp);

  await commitInChunks(ops, 15);
  return newLot;
}

export async function resolvePartnerIdByName(
  user: User | null | undefined,
  partnerNameInput: string,
  existingPartners: PartnerFsDoc[],
): Promise<string | null> {
  const nameStr = String(partnerNameInput || "").trim();
  if (!nameStr) return null;
  const cleanInput = cleanForMatch(nameStr);
  if (!cleanInput) return null;

  const found = existingPartners.find(
    (p) => cleanForMatch(p.partner_name) === cleanInput || cleanForMatch(p.doc_id) === cleanInput,
  );
  if (found) return found.doc_id;

  const newName = clampStr(nameStr.toUpperCase(), 160);
  const existingIds = new Set(existingPartners.map((p) => p.doc_id));
  let finalId = generateUniqueFsId("PRT");
  while (existingIds.has(finalId)) {
    finalId = generateUniqueFsId("PRT");
  }

  const newPartner: PartnerFsDoc = {
    doc_id: finalId,
    partner_name: newName,
    category: "R1",
    pic_employee_id: null,
    pic_name: "-",
    division_group: "Field Corn",
    province: "Central Java",
    area: "-",
  };

  try {
    await setDoc(doc(db, "partners", finalId), {
      doc_id: finalId,
      partner_name: newName,
      category: "R1",
      pic_employee_id: null,
      pic_name: "-",
      division_group: "Field Corn",
      province: "Central Java",
      area: "-",
      ownerUid: user?.uid || "public",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    existingPartners.push(newPartner);
  } catch (err) {
    // fallback
  }

  return finalId;
}

/**
 * Add a single DR Shipment document directly to Firestore (/dr_shipments/{doc_id}).
 * Atomically ensures referenced /lots/{lot_no} exists so existsAfter() succeeds.
 */
export async function addDrShipmentFirestore(
  user: User | null | undefined,
  params: {
    shipping_date: string;
    partner_name?: string | null;
    partner_id: string | null;
    lot_no: string;
    sku?: string | null;
    exp_date: string;
    shipped_qty_kg: number;
    hybrid_id?: string | null;
    existingLots: LotFsDoc[];
    existingDrShipments: DrShipmentFsDoc[];
    existingPartners: PartnerFsDoc[];
  },
): Promise<DrShipmentFsDoc> {
  const ownerUid = user?.uid || "public";
  const lotNo = toValidDocId(String(params.lot_no || "").toUpperCase(), "");
  if (!lotNo) throw new Error("Nomor Lot wajib diisi.");
  const skuVal = clampStr(params.sku, 80);

  const shippingDate = parseDDMMYYYYToIso(params.shipping_date);
  const resolvedPartnerId = params.partner_id
    ? toValidDocId(params.partner_id)
    : await resolvePartnerIdByName(user, params.partner_name || "", params.existingPartners);
  const expDate = clampStr(toIsoDateStr(params.exp_date || extractExpFromLot(lotNo)), 20);
  const numQty = Number(params.shipped_qty_kg);
  const qtyKg = Number.isFinite(numQty) && numQty >= 0 ? numQty : 0;

  const existingLot = params.existingLots.find((l) => toValidDocId(l.doc_id) === lotNo);
  const existingDrIds = new Set(params.existingDrShipments.map((d) => toValidDocId(d.doc_id)));
  let drId = generateUniqueFsId("DR");
  while (existingDrIds.has(drId)) {
    drId = generateUniqueFsId("DR");
  }

  const ops: any[] = [];
  if (!existingLot) {
    ops.push({
      type: "create" as const,
      colName: "lots",
      docId: lotNo,
      data: {
        doc_id: lotNo,
        hybrid_id: params.hybrid_id ? toValidDocId(params.hybrid_id) : null,
        sku: skuVal || null,
        shipping_date: shippingDate,
        exp_date: expDate,
        initial_dr_kg: qtyKg,
        ownerUid,
      },
    });
  } else {
    ops.push({
      type: "update" as const,
      colName: "lots",
      docId: lotNo,
      data: {
        ...(skuVal ? { sku: skuVal } : {}),
        initial_dr_kg: increment(qtyKg),
      },
    });
  }
  if (skuVal) {
    const lotSkuOp = buildSkuMetaOp(ownerUid, "LOT", lotNo, skuVal);
    if (lotSkuOp) ops.push(lotSkuOp);
  }

  const newDr: DrShipmentFsDoc = {
    doc_id: drId,
    shipping_date: shippingDate,
    partner_id: resolvedPartnerId,
    lot_no: lotNo,
    ...(skuVal ? { sku: skuVal } : {}),
    exp_date: expDate,
    shipped_qty_kg: qtyKg,
  };

  ops.push({
    type: "create" as const,
    colName: "dr_shipments",
    docId: drId,
    data: {
      doc_id: drId,
      shipping_date: shippingDate,
      partner_id: newDr.partner_id,
      lot_no: lotNo,
      sku: skuVal || null,
      exp_date: expDate,
      shipped_qty_kg: qtyKg,
      ownerUid,
    },
  });
  if (skuVal) {
    const drSkuOp = buildSkuMetaOp(ownerUid, "DR", drId, skuVal);
    if (drSkuOp) ops.push(drSkuOp);
  }

  await commitInChunks(ops, 10);
  return newDr;
}

/**
 * Add or update a single Opname Log document in Firestore (/opname_logs/{doc_id}).
 */
export async function addOpnameLogFirestore(
  user: User | null | undefined,
  params: {
    partner_id: string | null;
    lot_no: string;
    sku?: string | null;
    checker_id: string | null;
    crop_year: string;
    monthKey: (typeof FISCAL_MONTH_COLS)[number]["key"];
    inKg: number;
    idleKg: number;
    pogKg: number;
    updatedBy?: OpnameUpdatedBy;
    existingLots: LotFsDoc[];
    existingLogs: OpnameLogFsDoc[];
  },
): Promise<void> {
  const ownerUid = user?.uid || "public";
  const lotNo = toValidDocId(String(params.lot_no || "").toUpperCase(), "");
  if (!lotNo) throw new Error("Nomor Lot wajib diisi.");
  const skuVal = clampStr(params.sku, 80);

  const partnerId = params.partner_id ? toValidDocId(params.partner_id) : null;
  const checkerId = params.checker_id ? toValidDocId(params.checker_id) : null;
  const cropYear = clampStr(params.crop_year || "FY2026", 12, "FY2026");
  const preferredLogId = toValidDocId(
    `${partnerId || "NO_PRT"}_${lotNo}_${checkerId || "NO_CHK"}_${cropYear}`,
  );
  const legacyLogId = toValidDocId(`${partnerId || "NO_PRT"}_${lotNo}_${cropYear}`);
  const existingLog =
    params.existingLogs.find((l) => toValidDocId(l.doc_id) === preferredLogId) ||
    params.existingLogs.find((l) => toValidDocId(l.doc_id) === legacyLogId);
  const logId = existingLog ? toValidDocId(existingLog.doc_id) : preferredLogId;

  const cell: MonthlyOpnameCell = {
    in: Math.max(0, Number(params.inKg) || 0),
    idle: Math.max(0, Number(params.idleKg) || 0),
    pog: Math.max(0, Number(params.pogKg) || 0),
    updated_by: normalizeOpnameUpdatedBy(params.updatedBy),
  };

  const existingLot = params.existingLots.find((l) => toValidDocId(l.doc_id) === lotNo);

  const ops: any[] = [];
  if (!existingLot) {
    ops.push({
      type: "create" as const,
      colName: "lots",
      docId: lotNo,
      data: {
        doc_id: lotNo,
        hybrid_id: null,
        sku: skuVal || null,
        shipping_date: "",
        exp_date: clampStr(toIsoDateStr(extractExpFromLot(lotNo)), 20),
        initial_dr_kg: 0,
        ownerUid,
      },
    });
  }
  if (skuVal) {
    const lotSkuOp = buildSkuMetaOp(ownerUid, "LOT", lotNo, skuVal);
    if (lotSkuOp) ops.push(lotSkuOp);
  }

  if (existingLog) {
    ops.push({
      type: "update" as const,
      colName: "opname_logs",
      docId: logId,
      data: {
        partner_id: partnerId,
        lot_no: lotNo,
        ...(skuVal ? { sku: skuVal } : {}),
        checker_id: checkerId ?? existingLog.checker_id ?? null,
        crop_year: cropYear,
        [params.monthKey]: cell,
      },
    });
  } else {
    const payload: Record<string, any> = {
      doc_id: logId,
      partner_id: partnerId,
      lot_no: lotNo,
      sku: skuVal || null,
      checker_id: checkerId,
      crop_year: cropYear,
      ownerUid,
    };
    FISCAL_MONTH_COLS.forEach(({ key }) => {
      payload[key] = key === params.monthKey ? cell : null;
    });
    ops.push({
      type: "create" as const,
      colName: "opname_logs",
      docId: logId,
      data: payload,
    });
  }
  if (skuVal) {
    const logSkuOp = buildSkuMetaOp(ownerUid, "LOG", logId, skuVal);
    if (logSkuOp) ops.push(logSkuOp);
  }

  await commitInChunks(ops, 8);
}

/**
 * Ensure Super User employee `adityahead` (Business Analyst, Lv.5) exists in Firestore /employees.
 */
export async function ensureSuperUserAdityaFirestore(
  user: User | null | undefined,
  existingEmployees: EmployeeFsDoc[],
): Promise<boolean> {
  const alreadyExists = existingEmployees.some(
    (e) =>
      cleanForMatch(e.username) === "adityahead" ||
      e.doc_id === "EMP-ADITYAHEAD",
  );
  if (alreadyExists) return false;

  const existingIds = new Set(existingEmployees.map((e) => e.doc_id));
  let docId = "EMP-001";
  if (existingIds.has(docId)) {
    docId = "EMP-ADITYAHEAD";
  }

  const subIds = existingEmployees
    .filter((e) => e.doc_id !== docId)
    .map((e) => toValidDocId(e.doc_id))
    .slice(0, 200);

  await upsertEmployeeFirestore(
    user,
    {
      doc_id: docId,
      username: "adityahead",
      full_name: "Aditya Wiratama",
      position: "Business Analyst",
      role_level: 5,
      upline_id: null,
      subordinate_ids: subIds,
      access_scope_ids: [docId, ...subIds].slice(0, 200),
      division_group: "All",
      province: "Head Office",
      area: "Head Office",
      status: "Aktif",
    },
    true,
  );
  return true;
}

/**
 * Bulk add multiple Hybrid rows into Firestore /hybrids.
 */
export async function bulkAddHybridsFirestore(
  user: User | null | undefined,
  rows: Array<{ hybrid_name: string; sku?: string | null; crop_type: DivisionStrict }>,
  existingHybrids: HybridFsDoc[],
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const existingIds = new Set(existingHybrids.map((h) => toValidDocId(h.doc_id)));
  const existingByPair = new Map(
    existingHybrids.map((h) => [
      `${cleanForMatch(h.hybrid_name)}__${cleanForMatch(h.sku || "")}`,
      h,
    ]),
  );

  const opsMap = new Map<string, any>();

  for (const r of rows) {
    const cleanName = clampStr(String(r.hybrid_name || "").split(SKU_DELIM)[0].trim().toUpperCase(), 100);
    if (!cleanName) continue;
    const skuVal = clampStr(r.sku, 80);
    const pairKey = `${cleanForMatch(cleanName)}__${cleanForMatch(skuVal)}`;
    const crop = toStrictDivision(r.crop_type);

    const existingExact = existingByPair.get(pairKey);
    if (existingExact) {
      opsMap.set(existingExact.doc_id, {
        type: "update" as const,
        colName: "hybrids",
        docId: existingExact.doc_id,
        data: {
          hybrid_name: packHybridNameWithSku(cleanName, skuVal),
          sku: skuVal || null,
          crop_type: crop,
        },
      });
      continue;
    }

    let docId = generateUniqueFsId("HYB");
    while (existingIds.has(docId)) {
      docId = generateUniqueFsId("HYB");
    }
    existingIds.add(docId);

    const newHybrid: HybridFsDoc = {
      doc_id: docId,
      hybrid_name: cleanName,
      ...(skuVal ? { sku: skuVal } : {}),
      crop_type: crop,
    };
    existingByPair.set(pairKey, newHybrid);

    opsMap.set(docId, {
      type: "create" as const,
      colName: "hybrids",
      docId,
      data: {
        doc_id: docId,
        hybrid_name: packHybridNameWithSku(cleanName, skuVal),
        sku: skuVal || null,
        crop_type: crop,
        ownerUid,
      },
    });
  }

  const ops = Array.from(opsMap.values());
  if (ops.length === 0) throw new Error("Isi minimal 1 nama hybrid yang valid.");
  await commitInChunks(ops, 15);
  return ops.length;
}

/**
 * Bulk add or update multiple Lot rows into Firestore /lots.
 */
export async function bulkAddLotsFirestore(
  user: User | null | undefined,
  rows: Array<{
    lot_no: string;
    hybrid_id: string | null;
    sku?: string | null;
    shipping_date: string;
    exp_date: string;
    initial_dr_kg: number;
  }>,
  existingLots: LotFsDoc[],
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const existingLotMap = new Map(existingLots.map((l) => [toValidDocId(l.doc_id), l]));
  const opsMap = new Map<string, any>();
  const skuOpsMap = new Map<string, any>();

  for (const r of rows) {
    const lotNo = toValidDocId(String(r.lot_no || "").toUpperCase(), "");
    if (!lotNo) continue;
    const numDr = Number(r.initial_dr_kg);
    const existingLot = existingLotMap.get(lotNo);
    const isUpdate = Boolean(existingLot);
    const skuVal = clampStr(r.sku, 80);
    opsMap.set(lotNo, {
      type: (isUpdate ? "update" : "create") as "create" | "update",
      colName: "lots",
      docId: lotNo,
      data: {
        doc_id: lotNo,
        hybrid_id: r.hybrid_id ? toValidDocId(r.hybrid_id) : null,
        sku: skuVal || null,
        shipping_date: clampStr(toIsoDateStr(r.shipping_date), 20),
        exp_date: clampStr(toIsoDateStr(r.exp_date || extractExpFromLot(lotNo)), 20),
        initial_dr_kg: Number.isFinite(numDr) && numDr >= 0 ? numDr : 0,
        ownerUid,
      },
    });
    const skuOp = buildSkuMetaOp(ownerUid, "LOT", lotNo, skuVal);
    if (skuOp) skuOpsMap.set(skuOp.docId, skuOp);
  }

  const ops = [...Array.from(opsMap.values()), ...Array.from(skuOpsMap.values())];
  if (opsMap.size === 0) throw new Error("Isi minimal 1 nomor Lot yang valid.");
  await commitInChunks(ops, 15);
  return opsMap.size;
}

/**
 * Bulk add multiple DR Shipment rows into Firestore /dr_shipments.
 * Stage 1 ensures all referenced /lots/{lot_no} exist/updated atomically, Stage 2 writes DR rows.
 */
export async function bulkAddDrShipmentsFirestore(
  user: User | null | undefined,
  rows: Array<{
    shipping_date: string;
    partner_name?: string | null;
    partner_id: string | null;
    lot_no: string;
    sku?: string | null;
    exp_date: string;
    shipped_qty_kg: number;
  }>,
  existingLots: LotFsDoc[],
  existingDrShipments: DrShipmentFsDoc[],
  existingPartners: PartnerFsDoc[],
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const existingLotMap = new Map(existingLots.map((l) => [toValidDocId(l.doc_id), l]));
  const existingDrIds = new Set(existingDrShipments.map((d) => toValidDocId(d.doc_id)));

  const lotDelta = new Map<
    string,
    {
      exists: boolean;
      addKg: number;
      shippingDate: string;
      expDate: string;
      hybridId: string | null;
      sku: string;
    }
  >();
  const drOps: any[] = [];
  const skuOpsMap = new Map<string, any>();

  for (const r of rows) {
    const lotNo = toValidDocId(String(r.lot_no || "").toUpperCase(), "");
    if (!lotNo) continue;

    const shippingDate = parseDDMMYYYYToIso(r.shipping_date);
    const resolvedPartnerId = r.partner_id
      ? toValidDocId(r.partner_id)
      : await resolvePartnerIdByName(user, r.partner_name || "", existingPartners);
    const rawExpInput = String(r.exp_date || "").trim();
    const expDate = clampStr(
      rawExpInput ? parseDDMMYYYYToIso(rawExpInput) : toIsoDateStr(extractExpFromLot(lotNo)),
      20,
    );
    const numQty = Number(r.shipped_qty_kg);
    const qtyKg = Number.isFinite(numQty) && numQty >= 0 ? numQty : 0;
    const skuVal = clampStr(r.sku, 80);

    const existingLot = existingLotMap.get(lotNo);
    const prevPending = lotDelta.get(lotNo);
    if (prevPending) {
      prevPending.addKg += qtyKg;
      if (!prevPending.sku && skuVal) prevPending.sku = skuVal;
    } else {
      lotDelta.set(lotNo, {
        exists: Boolean(existingLot),
        addKg: qtyKg,
        shippingDate: existingLot?.shipping_date || shippingDate,
        expDate: existingLot?.exp_date || expDate,
        hybridId: existingLot?.hybrid_id || null,
        sku: clampStr(existingLot?.sku || skuVal, 80),
      });
    }

    let drId = generateUniqueFsId("DR");
    while (existingDrIds.has(drId)) {
      drId = generateUniqueFsId("DR");
    }
    existingDrIds.add(drId);

    drOps.push({
      type: "create" as const,
      colName: "dr_shipments",
      docId: drId,
      data: {
        doc_id: drId,
        shipping_date: shippingDate,
        partner_id: resolvedPartnerId,
        lot_no: lotNo,
        sku: skuVal || null,
        exp_date: expDate,
        shipped_qty_kg: qtyKg,
        ownerUid,
      },
    });
    if (skuVal) {
      const drSkuOp = buildSkuMetaOp(ownerUid, "DR", drId, skuVal);
      if (drSkuOp) skuOpsMap.set(drSkuOp.docId, drSkuOp);
    }
  }

  if (drOps.length === 0) throw new Error("Isi minimal 1 baris DR Shipment dengan Nomor Lot.");

  const lotOps: any[] = [];
  lotDelta.forEach((info, lotNo) => {
    if (info.exists) {
      lotOps.push({
        type: "update" as const,
        colName: "lots",
        docId: lotNo,
        data: {
          hybrid_id: info.hybridId,
          ...(info.sku ? { sku: info.sku } : {}),
          shipping_date: info.shippingDate,
          exp_date: info.expDate,
          initial_dr_kg: increment(info.addKg),
        },
      });
    } else {
      lotOps.push({
        type: "create" as const,
        colName: "lots",
        docId: lotNo,
        data: {
          doc_id: lotNo,
          hybrid_id: info.hybridId,
          sku: info.sku || null,
          shipping_date: info.shippingDate,
          exp_date: info.expDate,
          initial_dr_kg: info.addKg,
          ownerUid,
        },
      });
    }
    if (info.sku) {
      const lotSkuOp = buildSkuMetaOp(ownerUid, "LOT", lotNo, info.sku);
      if (lotSkuOp) skuOpsMap.set(lotSkuOp.docId, lotSkuOp);
    }
  });

  if (lotOps.length > 0) await commitInChunks(lotOps, 15);
  await commitInChunks(drOps, 8);
  if (skuOpsMap.size > 0) await commitInChunks(Array.from(skuOpsMap.values()), 15);
  return drOps.length;
}

/**
 * Bulk add or update multiple Opname Log rows (supports multiple monthly columns per row) in Firestore.
 */
export async function bulkAddOpnameLogsFirestore(
  user: User | null | undefined,
  rows: Array<{
    partner_id: string | null;
    lot_no: string;
    sku?: string | null;
    checker_id: string | null;
    crop_year: string;
    months: Partial<Record<(typeof FISCAL_MONTH_COLS)[number]["key"], MonthlyOpnameCell | null>>;
  }>,
  existingLots: LotFsDoc[],
  existingLogs: OpnameLogFsDoc[],
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const existingLotIds = new Set(existingLots.map((l) => toValidDocId(l.doc_id)));
  const existingLogsMap = new Map(existingLogs.map((l) => [toValidDocId(l.doc_id), l]));

  const newLotOpsMap = new Map<string, any>();
  const logOpsMap = new Map<string, any>();
  const skuOpsMap = new Map<string, any>();

  for (const r of rows) {
    const lotNo = toValidDocId(String(r.lot_no || "").toUpperCase(), "");
    if (!lotNo) continue;
    const skuVal = clampStr(r.sku, 80);

    if (!existingLotIds.has(lotNo) && !newLotOpsMap.has(lotNo)) {
      newLotOpsMap.set(lotNo, {
        type: "create" as const,
        colName: "lots",
        docId: lotNo,
        data: {
          doc_id: lotNo,
          hybrid_id: null,
          sku: skuVal || null,
          shipping_date: "",
          exp_date: clampStr(toIsoDateStr(extractExpFromLot(lotNo)), 20),
          initial_dr_kg: 0,
          ownerUid,
        },
      });
    }
    if (skuVal) {
      const lotSkuOp = buildSkuMetaOp(ownerUid, "LOT", lotNo, skuVal);
      if (lotSkuOp) skuOpsMap.set(lotSkuOp.docId, lotSkuOp);
    }

    const partnerId = r.partner_id ? toValidDocId(r.partner_id) : null;
    const checkerId = r.checker_id ? toValidDocId(r.checker_id) : null;
    const cropYear = clampStr(r.crop_year || "FY2026", 12, "FY2026");
    const logId = toValidDocId(`${partnerId || "NO_PRT"}_${lotNo}_${cropYear}`);
    const existingLog = existingLogsMap.get(logId);

    if (existingLog) {
      const updateData: Record<string, any> = {
        partner_id: partnerId,
        lot_no: lotNo,
        ...(skuVal ? { sku: skuVal } : {}),
        checker_id: checkerId ?? existingLog.checker_id ?? null,
        crop_year: cropYear,
      };
      FISCAL_MONTH_COLS.forEach(({ key }) => {
        const cell = r.months[key];
        if (cell) {
          updateData[key] = {
            in: Math.max(0, Number(cell.in) || 0),
            idle: Math.max(0, Number(cell.idle) || 0),
            pog: Math.max(0, Number(cell.pog) || 0),
            updated_by: normalizeOpnameUpdatedBy(cell.updated_by),
          };
        }
      });
      logOpsMap.set(logId, {
        type: "update" as const,
        colName: "opname_logs",
        docId: logId,
        data: updateData,
      });
    } else {
      const createData: Record<string, any> = {
        doc_id: logId,
        partner_id: partnerId,
        lot_no: lotNo,
        sku: skuVal || null,
        checker_id: checkerId,
        crop_year: cropYear,
        ownerUid,
      };
      FISCAL_MONTH_COLS.forEach(({ key }) => {
        const cell = r.months[key];
        createData[key] = cell
          ? {
              in: Math.max(0, Number(cell.in) || 0),
              idle: Math.max(0, Number(cell.idle) || 0),
              pog: Math.max(0, Number(cell.pog) || 0),
              updated_by: normalizeOpnameUpdatedBy(cell.updated_by),
            }
          : null;
      });
      logOpsMap.set(logId, {
        type: "create" as const,
        colName: "opname_logs",
        docId: logId,
        data: createData,
      });
    }
    if (skuVal) {
      const logSkuOp = buildSkuMetaOp(ownerUid, "LOG", logId, skuVal);
      if (logSkuOp) skuOpsMap.set(logSkuOp.docId, logSkuOp);
    }
  }

  const lotOps = Array.from(newLotOpsMap.values());
  const logOps = Array.from(logOpsMap.values());
  if (logOps.length === 0) throw new Error("Isi minimal 1 baris Opname Log dengan Nomor Lot.");

  if (lotOps.length > 0) await commitInChunks(lotOps, 15);
  await commitInChunks(logOps, 6);
  if (skuOpsMap.size > 0) await commitInChunks(Array.from(skuOpsMap.values()), 15);
  return logOps.length;
}

/**
 * Bulk add multiple Partner rows directly into Firestore /partners.
 */
export async function bulkAddPartnersFirestore(
  user: User | null | undefined,
  rows: Array<{
    partner_name: string;
    category: string;
    pic_employee_id: string | null;
    pic_name?: string | null;
    division_group: DivisionStrict;
    province: string;
    area: string;
  }>,
  existingPartners: PartnerFsDoc[],
  existingEmployees: EmployeeFsDoc[],
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const existingIds = new Set(existingPartners.map((p) => toValidDocId(p.doc_id)));
  const empById = new Map(existingEmployees.map((e) => [toValidDocId(e.doc_id), e]));
  const ops: any[] = [];

  for (const r of rows) {
    const partnerName = clampStr(r.partner_name, 160);
    if (!partnerName) continue;

    let docId = generateUniqueFsId("PRT");
    while (existingIds.has(docId)) {
      docId = generateUniqueFsId("PRT");
    }
    existingIds.add(docId);

    const picId = r.pic_employee_id ? toValidDocId(r.pic_employee_id) : null;
    const picEmp = picId ? empById.get(picId) : undefined;
    ops.push({
      type: "create" as const,
      colName: "partners",
      docId,
      data: {
        doc_id: docId,
        partner_name: partnerName,
        category: clampStr(r.category || "R1", 40),
        pic_employee_id: picId,
        pic_name: clampStr(picEmp?.full_name || r.pic_name || "", 120),
        division_group: toStrictDivision(r.division_group),
        province: clampStr(r.province, 80, "-"),
        area: clampStr(r.area || r.province, 80, "-"),
        ownerUid,
      },
    });
  }

  if (ops.length === 0) throw new Error("Isi minimal 1 Nama Partner.");
  await commitInChunks(ops, 15);
  return ops.length;
}

/**
 * Bulk add multiple Employee rows directly into Firestore /employees.
 */
export async function bulkAddEmployeesFirestore(
  user: User | null | undefined,
  rows: Array<{
    username: string;
    full_name: string;
    position: string;
    role_level: number;
    upline_id: string | null;
    division_group: DivisionStrict | "All";
    province: string;
    area: string;
    password?: string;
  }>,
  existingEmployees: EmployeeFsDoc[],
): Promise<Array<{ doc_id: string; username: string; password: string }>> {
  const ownerUid = user?.uid || "public";
  const existingIds = new Set(existingEmployees.map((e) => toValidDocId(e.doc_id)));
  const ops: any[] = [];
  const createdCreds: Array<{ doc_id: string; username: string; password: string }> = [];

  for (const r of rows) {
    const fullName = clampStr(r.full_name, 120);
    if (!fullName) continue;

    let docId = generateUniqueFsId("EMP");
    while (existingIds.has(docId)) {
      docId = generateUniqueFsId("EMP");
    }
    existingIds.add(docId);

    const username = clampStr(
      (r.username || fullName.replace(/\s+/g, "").toLowerCase()).toLowerCase(),
      80,
    );
    const divGroup = r.division_group === "All" ? "All" : toStrictDivision(r.division_group);
    const roleLevel = Math.min(5, Math.max(1, Math.round(Number(r.role_level) || 1)));

    ops.push({
      type: "create" as const,
      colName: "employees",
      docId,
      data: {
        doc_id: docId,
        username,
        full_name: fullName,
        position: clampStr(r.position || "Business Solution", 100, "Business Solution"),
        role_level: roleLevel,
        upline_id: r.upline_id ? toValidDocId(r.upline_id) : null,
        subordinate_ids: [],
        access_scope_ids: [docId],
        division_group: divGroup,
        province: clampStr(r.province, 80, "-"),
        area: clampStr(r.area || r.province, 80, "-"),
        status: "Aktif",
        ownerUid,
      },
    });
    createdCreds.push({
      doc_id: docId,
      username,
      password: String(r.password || "123"),
    });
  }

  if (ops.length === 0) throw new Error("Isi minimal 1 Nama Lengkap Employee.");
  await commitInChunks(ops, 15);
  return createdCreds;
}

/**
 * Bulk delete documents from any of the 6 operational collections in Firestore.
 */
export async function bulkDeleteCollectionDocsFirestore(
  colName: "opname_logs" | "dr_shipments" | "lots" | "hybrids" | "partners" | "employees",
  docIds: string[],
  user?: User | null,
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const uniqueIds = Array.from(
    new Set(docIds.map((id) => toValidDocId(id, "")).filter(Boolean)),
  );
  if (uniqueIds.length === 0) throw new Error("Tidak ada dokumen valid untuk dihapus.");

  const ops: any[] = uniqueIds.map((docId) => ({
    type: "delete" as const,
    colName,
    docId,
  }));

  if (colName === "lots" || colName === "dr_shipments" || colName === "opname_logs") {
    const prefix = colName === "lots" ? "LOT" : colName === "dr_shipments" ? "DR" : "LOG";
    uniqueIds.forEach((docId) => {
      const skuOp = buildSkuMetaOp(ownerUid, prefix, docId, "");
      if (skuOp) ops.push(skuOp);
    });
  }

  await commitInChunks(ops, 15);
  return uniqueIds.length;
}

/**
 * Bulk update existing Hybrid documents in Firestore /hybrids.
 */
export async function bulkUpdateHybridsFirestore(
  rows: Array<{ doc_id: string; hybrid_name: string; sku?: string | null; hadSku?: boolean; crop_type: DivisionStrict }>,
  _user?: User | null,
): Promise<number> {
  const ops = rows
    .filter((r) => toValidDocId(r.doc_id, "") && clampStr(r.hybrid_name, 100))
    .map((r) => {
      const skuVal = clampStr(r.sku, 80);
      return {
        type: "update" as const,
        colName: "hybrids",
        docId: toValidDocId(r.doc_id),
        data: {
          hybrid_name: packHybridNameWithSku(r.hybrid_name, skuVal),
          sku: skuVal || null,
          crop_type: toStrictDivision(r.crop_type),
        },
      };
    });

  if (ops.length === 0) throw new Error("Isi nama hybrid yang valid untuk disimpan.");
  await commitInChunks(ops, 15);
  return ops.length;
}

/**
 * Bulk update existing Lot documents in Firestore /lots.
 */
export async function bulkUpdateLotsFirestore(
  rows: Array<{
    doc_id: string;
    hybrid_id: string | null;
    sku?: string | null;
    hadSku?: boolean;
    shipping_date: string;
    exp_date: string;
    initial_dr_kg: number;
  }>,
  user?: User | null,
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const ops: any[] = [];
  const skuOps: any[] = [];

  rows
    .filter((r) => toValidDocId(r.doc_id, ""))
    .forEach((r) => {
      const lotId = toValidDocId(r.doc_id);
      const numDr = Number(r.initial_dr_kg);
      const skuVal = clampStr(r.sku, 80);
      ops.push({
        type: "update" as const,
        colName: "lots",
        docId: lotId,
        data: {
          hybrid_id: r.hybrid_id ? toValidDocId(r.hybrid_id) : null,
          sku: skuVal || null,
          shipping_date: clampStr(toIsoDateStr(r.shipping_date), 20),
          exp_date: clampStr(toIsoDateStr(r.exp_date || extractExpFromLot(lotId)), 20),
          initial_dr_kg: Number.isFinite(numDr) && numDr >= 0 ? numDr : 0,
        },
      });
      const skuOp = buildSkuMetaOp(ownerUid, "LOT", lotId, skuVal);
      if (skuOp) skuOps.push(skuOp);
    });

  if (ops.length === 0) throw new Error("Tidak ada data Lot valid untuk diperbarui.");
  await commitInChunks([...ops, ...skuOps], 15);
  return ops.length;
}

/**
 * Bulk update existing DR Shipment documents in Firestore /dr_shipments.
 */
export async function bulkUpdateDrShipmentsFirestore(
  user: User | null | undefined,
  rows: Array<{
    doc_id: string;
    shipping_date: string;
    partner_name?: string | null;
    partner_id: string | null;
    lot_no: string;
    sku?: string | null;
    hadSku?: boolean;
    exp_date: string;
    shipped_qty_kg: number;
  }>,
  existingLots: LotFsDoc[],
  existingPartners: PartnerFsDoc[],
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const existingLotIds = new Set(existingLots.map((l) => toValidDocId(l.doc_id)));
  const newLotOps = new Map<string, any>();
  const drOps: any[] = [];
  const skuOpsMap = new Map<string, any>();

  for (const r of rows) {
    const docId = toValidDocId(r.doc_id, "");
    const lotNo = toValidDocId(String(r.lot_no || "").toUpperCase(), "");
    if (!docId || !lotNo) continue;

    const shippingDate = parseDDMMYYYYToIso(r.shipping_date);
    const resolvedPartnerId = r.partner_id
      ? toValidDocId(r.partner_id)
      : await resolvePartnerIdByName(user, r.partner_name || "", existingPartners);
    const rawExpInput = String(r.exp_date || "").trim();
    const expDate = clampStr(
      rawExpInput ? parseDDMMYYYYToIso(rawExpInput) : toIsoDateStr(extractExpFromLot(lotNo)),
      20,
    );
    const numQty = Number(r.shipped_qty_kg);
    const qtyKg = Number.isFinite(numQty) && numQty >= 0 ? numQty : 0;
    const skuVal = clampStr(r.sku, 80);

    if (!existingLotIds.has(lotNo) && !newLotOps.has(lotNo)) {
      newLotOps.set(lotNo, {
        type: "create" as const,
        colName: "lots",
        docId: lotNo,
        data: {
          doc_id: lotNo,
          hybrid_id: null,
          sku: skuVal || null,
          shipping_date: shippingDate,
          exp_date: expDate,
          initial_dr_kg: qtyKg,
          ownerUid,
        },
      });
    }

    drOps.push({
      type: "update" as const,
      colName: "dr_shipments",
      docId,
      data: {
        shipping_date: shippingDate,
        partner_id: resolvedPartnerId,
        lot_no: lotNo,
        sku: skuVal || null,
        exp_date: expDate,
        shipped_qty_kg: qtyKg,
      },
    });
    const drSkuOp = buildSkuMetaOp(ownerUid, "DR", docId, skuVal);
    if (drSkuOp) skuOpsMap.set(drSkuOp.docId, drSkuOp);
  }

  if (drOps.length === 0) throw new Error("Nomor Lot wajib diisi pada DR Shipment yang diedit.");
  if (newLotOps.size > 0) await commitInChunks(Array.from(newLotOps.values()), 15);
  await commitInChunks(drOps, 15);
  if (skuOpsMap.size > 0) await commitInChunks(Array.from(skuOpsMap.values()), 15);
  return drOps.length;
}

/**
 * Bulk update existing Opname Log documents in Firestore /opname_logs.
 */
export async function bulkUpdateOpnameLogsFirestore(
  user: User | null | undefined,
  rows: Array<{
    doc_id: string;
    partner_id: string | null;
    lot_no: string;
    sku?: string | null;
    hadSku?: boolean;
    checker_id: string | null;
    crop_year: string;
    months: Partial<Record<(typeof FISCAL_MONTH_COLS)[number]["key"], MonthlyOpnameCell | null>>;
  }>,
  existingLots: LotFsDoc[],
): Promise<number> {
  const ownerUid = user?.uid || "public";
  const existingLotIds = new Set(existingLots.map((l) => toValidDocId(l.doc_id)));
  const newLotOps = new Map<string, any>();
  const logOps: any[] = [];
  const skuOpsMap = new Map<string, any>();

  for (const r of rows) {
    const docId = toValidDocId(r.doc_id, "");
    const lotNo = toValidDocId(String(r.lot_no || "").toUpperCase(), "");
    if (!docId || !lotNo) continue;
    const skuVal = clampStr(r.sku, 80);

    if (!existingLotIds.has(lotNo) && !newLotOps.has(lotNo)) {
      newLotOps.set(lotNo, {
        type: "create" as const,
        colName: "lots",
        docId: lotNo,
        data: {
          doc_id: lotNo,
          hybrid_id: null,
          sku: skuVal || null,
          shipping_date: "",
          exp_date: clampStr(toIsoDateStr(extractExpFromLot(lotNo)), 20),
          initial_dr_kg: 0,
          ownerUid,
        },
      });
    }

    const updateData: Record<string, any> = {
      partner_id: r.partner_id ? toValidDocId(r.partner_id) : null,
      lot_no: lotNo,
      sku: skuVal || null,
      checker_id: r.checker_id ? toValidDocId(r.checker_id) : null,
      crop_year: clampStr(r.crop_year || "FY2026", 12, "FY2026"),
    };

    FISCAL_MONTH_COLS.forEach(({ key }) => {
      const cell = r.months[key];
      updateData[key] = cell
        ? {
            in: Math.max(0, Number(cell.in) || 0),
            idle: Math.max(0, Number(cell.idle) || 0),
            pog: Math.max(0, Number(cell.pog) || 0),
            updated_by: normalizeOpnameUpdatedBy(cell.updated_by),
          }
        : null;
    });

    logOps.push({
      type: "update" as const,
      colName: "opname_logs",
      docId,
      data: updateData,
    });
    const logSkuOp = buildSkuMetaOp(ownerUid, "LOG", docId, skuVal);
    if (logSkuOp) skuOpsMap.set(logSkuOp.docId, logSkuOp);
  }

  if (logOps.length === 0) throw new Error("Nomor Lot wajib diisi pada Opname Log yang diedit.");
  if (newLotOps.size > 0) await commitInChunks(Array.from(newLotOps.values()), 15);
  await commitInChunks(logOps, 6);
  if (skuOpsMap.size > 0) await commitInChunks(Array.from(skuOpsMap.values()), 15);
  return logOps.length;
}

/**
 * Bulk update existing Partner documents in Firestore /partners.
 */
export async function bulkUpdatePartnersFirestore(
  rows: Array<{
    doc_id: string;
    partner_name: string;
    category: string;
    pic_employee_id: string | null;
    pic_name?: string | null;
    division_group: DivisionStrict;
    province: string;
    area: string;
  }>,
  existingEmployees: EmployeeFsDoc[],
  _user?: User | null,
): Promise<number> {
  const empById = new Map(existingEmployees.map((e) => [toValidDocId(e.doc_id), e]));
  const ops = rows
    .filter((r) => toValidDocId(r.doc_id, "") && clampStr(r.partner_name, 160))
    .map((r) => {
      const docId = toValidDocId(r.doc_id);
      const picId = r.pic_employee_id ? toValidDocId(r.pic_employee_id) : null;
      const picEmp = picId ? empById.get(picId) : undefined;
      return {
        type: "update" as const,
        colName: "partners",
        docId,
        data: {
          partner_name: clampStr(r.partner_name, 160),
          category: clampStr(r.category || "R1", 40),
          pic_employee_id: picId,
          pic_name: clampStr(picEmp?.full_name || r.pic_name || "", 120),
          division_group: toStrictDivision(r.division_group),
          province: clampStr(r.province, 80, "-"),
          area: clampStr(r.area || r.province, 80, "-"),
        },
      };
    });

  if (ops.length === 0) throw new Error("Nama Partner wajib diisi.");
  await commitInChunks(ops, 15);
  return ops.length;
}

/**
 * Bulk update existing Employee documents in Firestore /employees.
 */
export async function bulkUpdateEmployeesFirestore(
  rows: Array<{
    doc_id: string;
    username: string;
    full_name: string;
    position: string;
    role_level: number;
    upline_id: string | null;
    subordinate_ids?: string[];
    access_scope_ids?: string[];
    division_group: DivisionStrict | "All";
    province: string;
    area: string;
    status?: "Aktif" | "Nonaktif";
    password?: string;
  }>,
  _user?: User | null,
): Promise<Array<{ doc_id: string; username: string; password?: string }>> {
  const ops: any[] = [];
  const updatedCreds: Array<{ doc_id: string; username: string; password?: string }> = [];

  for (const r of rows) {
    const docId = toValidDocId(r.doc_id, "");
    const fullName = clampStr(r.full_name, 120);
    if (!docId || !fullName) continue;

    const username = clampStr(String(r.username || "").toLowerCase(), 80);
    const divGroup = r.division_group === "All" ? "All" : toStrictDivision(r.division_group);
    const roleLevel = Math.min(5, Math.max(1, Math.round(Number(r.role_level) || 1)));
    const subIds = (r.subordinate_ids || []).map((id) => toValidDocId(id)).slice(0, 200);
    const scopeIds = (r.access_scope_ids && r.access_scope_ids.length > 0
      ? r.access_scope_ids
      : [docId, ...subIds]
    )
      .map((id) => toValidDocId(id))
      .slice(0, 200);

    ops.push({
      type: "update" as const,
      colName: "employees",
      docId,
      data: {
        username,
        full_name: fullName,
        position: clampStr(r.position || "Business Solution", 100, "Business Solution"),
        role_level: roleLevel,
        upline_id: r.upline_id ? toValidDocId(r.upline_id) : null,
        subordinate_ids: subIds,
        access_scope_ids: scopeIds,
        division_group: divGroup,
        province: clampStr(r.province, 80, "-"),
        area: clampStr(r.area || r.province, 80, "-"),
        status: r.status === "Nonaktif" ? "Nonaktif" : "Aktif",
      },
    });
    updatedCreds.push({
      doc_id: docId,
      username,
      password: r.password,
    });
  }

  if (ops.length === 0) throw new Error("Nama Lengkap Employee wajib diisi.");
  await commitInChunks(ops, 15);
  return updatedCreds;
}
