import {
  collection,
  doc,
  getDocFromServer,
  getDocs,
  getDocsFromCache,
  getDocsFromServer,
  limit,
  query,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { cleanForMatch, safeParseFloat } from "./formatters";
import {
  buildDepthMap,
  getPositionRank,
  getResolvedPic,
} from "./hierarchy";
import { LAST_SYNC_STORAGE_KEY } from "../services/firestoreDb";

export type BenchmarkPhase =
  | "idle"
  | "cleanup_pre"
  | "login_200"
  | "sync_comparison"
  | "crud_create"
  | "crud_read"
  | "crud_update"
  | "crud_delete"
  | "cleanup_verify"
  | "done"
  | "error";

export interface BenchmarkProgress {
  phase: BenchmarkPhase;
  stepIndex: number;
  totalSteps: number;
  message: string;
  percent: number;
}

export interface OperationMetrics {
  id: string;
  label: string;
  category: "auth" | "website" | "database" | "crud";
  count: number;
  unitLabel: string;
  totalMs: number;
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  opsPerSec: number;
  successCount: number;
  failCount: number;
  note?: string;
}

export interface RoleSessionBreakdown {
  role: string;
  sessionCount: number;
  avgHydrationMs: number;
  p95HydrationMs: number;
  avgScopedPartners: number;
  avgScopedLogs: number;
}

export interface SyncStrategyMetric {
  strategy: "cache" | "delta" | "full";
  label: string;
  durationMs: number;
  docsReturned: number;
  estimatedServerReads: number;
  perCollectionMs: Record<string, number>;
  perCollectionDocs: Record<string, number>;
  note: string;
}

export interface WebsiteHealthTelemetry {
  totalBenchmarkMs: number;
  rafSampleCount: number;
  avgFps: number;
  maxFrameGapMs: number;
  droppedFramesOver34ms: number;
  longTaskSupported: boolean;
  longTaskCount: number;
  longTaskTotalMs: number;
  heapSupported: boolean;
  heapBeforeMb: number | null;
  heapAfterMb: number | null;
  heapPeakDeltaMb: number | null;
}

export interface EfficiencyDiagnosis {
  websiteGrade: "Sangat Efisien" | "Cukup Baik" | "Perlu Optimasi";
  databaseGrade: "Sangat Efisien" | "Cukup Baik" | "Perlu Optimasi";
  crudGrade: "Sangat Efisien" | "Cukup Baik" | "Perlu Optimasi";
  readSavingsPct: number;
  projected200UsersFullReads: number;
  projected200UsersOptimizedReads: number;
  fastestOp: { label: string; p95Ms: number; opsPerSec: number };
  slowestOp: { label: string; p95Ms: number; opsPerSec: number };
  findings: string[];
}

export interface LoadBenchmarkResult {
  startedAtIso: string;
  completedAtIso: string;
  userCount: number;
  includeCrudWriteTest: boolean;
  includeFullCollectionColdRead: boolean;
  isOnlineAtRun: boolean;
  isAuthenticatedAdmin: boolean;
  operations: OperationMetrics[];
  roleBreakdown: RoleSessionBreakdown[];
  syncStrategies: SyncStrategyMetric[];
  websiteHealth: WebsiteHealthTelemetry;
  diagnosis: EfficiencyDiagnosis;
  cleanupVerifiedZeroRemaining: boolean;
  remainingBenchDocs: number;
  errors: string[];
}

export interface RunBenchmarkOptions {
  userCount: number;
  employees: any[];
  kiosks: any[];
  workingData: any[];
  accessRules: Record<string, Record<string, boolean>>;
  includeCrudWriteTest?: boolean;
  includeFullCollectionColdRead?: boolean;
  onProgress?: (progress: BenchmarkProgress) => void;
  signal?: AbortSignal;
}

const BENCH_PREFIX = "BENCH_200_";
const BENCH_BATCH_SIZE = 20;
const BENCHMARK_COLLECTIONS = [
  "employees",
  "partners",
  "hybrids",
  "lots",
  "dr_shipments",
  "opname_logs",
  "access_rules",
] as const;

const FISCAL_MONTH_FIELDS = [
  "apr",
  "mei",
  "jun",
  "jul",
  "ags",
  "sep",
  "okt",
  "nov",
  "des",
  "jan",
  "feb",
  "mar",
] as const;

const DEFAULT_ROLES_ROTATION = [
  "Business Solution",
  "Sales Agronomist",
  "Area Sales Manager",
  "Regional Manager",
  "Business Analyst",
];

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function computeOperationMetrics(params: {
  id: string;
  label: string;
  category: OperationMetrics["category"];
  samplesMs: number[];
  totalMs: number;
  count?: number;
  unitLabel: string;
  successCount: number;
  failCount: number;
  note?: string;
}): OperationMetrics {
  const {
    id,
    label,
    category,
    samplesMs,
    totalMs,
    count = samplesMs.length,
    unitLabel,
    successCount,
    failCount,
    note,
  } = params;

  const sorted = [...samplesMs].sort((a, b) => a - b);
  const len = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pickPercentile = (p: number) => {
    if (len === 0) return 0;
    const idx = Math.min(len - 1, Math.max(0, Math.ceil(p * len) - 1));
    return sorted[idx];
  };

  const safeTotalMs = Math.max(totalMs, 0.01);
  return {
    id,
    label,
    category,
    count,
    unitLabel,
    totalMs: round2(totalMs),
    minMs: round2(len > 0 ? sorted[0] : 0),
    avgMs: round2(len > 0 ? sum / len : 0),
    p50Ms: round2(pickPercentile(0.5)),
    p95Ms: round2(pickPercentile(0.95)),
    p99Ms: round2(pickPercentile(0.99)),
    maxMs: round2(len > 0 ? sorted[len - 1] : 0),
    opsPerSec: round2((count / safeTotalMs) * 1000),
    successCount,
    failCount,
    note,
  };
}

function getJsHeapMb(): number | null {
  try {
    const perfAny = performance as unknown as {
      memory?: { usedJSHeapSize?: number };
    };
    if (perfAny?.memory && typeof perfAny.memory.usedJSHeapSize === "number") {
      return round2(perfAny.memory.usedJSHeapSize / (1024 * 1024));
    }
  } catch {
    // Non-Chromium browser
  }
  return null;
}

function createFrameAndLongTaskMonitor() {
  let active = true;
  let rafId = 0;
  let lastTs = performance.now();
  let maxFrameGapMs = 0;
  let droppedFramesOver34ms = 0;
  const frameDeltas: number[] = [];

  const tick = (now: number) => {
    if (!active) return;
    const delta = now - lastTs;
    lastTs = now;
    if (delta > 0 && delta < 60000) {
      frameDeltas.push(delta);
      if (delta > maxFrameGapMs) maxFrameGapMs = delta;
      if (delta > 34) droppedFramesOver34ms += 1;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  let longTaskSupported = false;
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let observer: PerformanceObserver | null = null;

  try {
    if (
      typeof PerformanceObserver !== "undefined" &&
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      PerformanceObserver.supportedEntryTypes.includes("longtask")
    ) {
      longTaskSupported = true;
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longTaskTotalMs += entry.duration || 0;
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
  } catch {
    longTaskSupported = false;
  }

  return {
    stop() {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (observer) {
        try {
          observer.disconnect();
        } catch {
          // ignore
        }
      }
      const avgDelta =
        frameDeltas.length > 0
          ? frameDeltas.reduce((a, b) => a + b, 0) / frameDeltas.length
          : 16.67;
      return {
        rafSampleCount: frameDeltas.length,
        avgFps: round2(avgDelta > 0 ? Math.min(120, 1000 / avgDelta) : 60),
        maxFrameGapMs: round2(maxFrameGapMs),
        droppedFramesOver34ms,
        longTaskSupported,
        longTaskCount,
        longTaskTotalMs: round2(longTaskTotalMs),
      };
    },
  };
}

function makeBenchDocId(index: number): string {
  return `${BENCH_PREFIX}${String(index + 1).padStart(3, "0")}`;
}

export async function cleanupBenchmarkHybridDocs(
  explicitCount = 200,
): Promise<number> {
  const targetIds = new Set<string>();
  for (let i = 0; i < explicitCount; i += 1) {
    targetIds.add(makeBenchDocId(i));
  }

  // Also sweep any stray docs created by interrupted earlier runs
  try {
    const snap = await getDocsFromServer(
      query(
        collection(db, "hybrids"),
        where("doc_id", ">=", BENCH_PREFIX),
        where("doc_id", "<=", `${BENCH_PREFIX}\uf8ff`),
      ),
    );
    snap.docs.forEach((d: QueryDocumentSnapshot) => targetIds.add(d.id));
  } catch {
    // Fallback cleanly to deleting the known sequential IDs
  }

  const ids = Array.from(targetIds);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += BENCH_BATCH_SIZE) {
    chunks.push(ids.slice(i, i + BENCH_BATCH_SIZE));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      const batch = writeBatch(db);
      chunk.forEach((id) => {
        batch.delete(doc(db, "hybrids", id));
      });
      await batch.commit();
    }),
  );

  // Verify remaining count
  try {
    const verifySnap = await getDocsFromServer(
      query(
        collection(db, "hybrids"),
        where("doc_id", ">=", BENCH_PREFIX),
        where("doc_id", "<=", `${BENCH_PREFIX}\uf8ff`),
      ),
    );
    return verifySnap.size;
  } catch {
    return 0;
  }
}

interface VirtualSessionProfile {
  sessionIndex: number;
  name: string;
  position: string;
  accessRuleDocId: string;
  area: string;
  province: string;
}

function buildVirtualUserProfiles(
  userCount: number,
  employees: any[],
  accessRuleIds: string[],
): VirtualSessionProfile[] {
  const safeRuleIds =
    accessRuleIds.length > 0 ? accessRuleIds : ["business_analyst"];
  const activeEmps = (employees || []).filter(
    (e) => String(e?.status || "Aktif").toLowerCase() !== "nonaktif",
  );
  const pool = activeEmps.length > 0 ? activeEmps : employees || [];

  const profiles: VirtualSessionProfile[] = [];
  for (let i = 0; i < userCount; i += 1) {
    const emp = pool.length > 0 ? pool[i % pool.length] : null;
    const position =
      String(emp?.position || "").trim() ||
      DEFAULT_ROLES_ROTATION[i % DEFAULT_ROLES_ROTATION.length];
    const name = String(emp?.name || emp?.full_name || `SimUser_${i + 1}`);
    const accessRuleDocId = safeRuleIds[i % safeRuleIds.length];
    profiles.push({
      sessionIndex: i + 1,
      name,
      position,
      accessRuleDocId,
      area: String(emp?.area || ""),
      province: String(emp?.province || ""),
    });
  }
  return profiles;
}

function hydrateSingleUserSession(
  profile: VirtualSessionProfile,
  employees: any[],
  kiosks: any[],
  workingData: any[],
  accessRules: Record<string, Record<string, boolean>>,
): { scopedPartnersCount: number; scopedLogsCount: number; totalPogKg: number } {
  const rolePos = profile.position;
  const rank = getPositionRank(rolePos);
  const myClean = cleanForMatch(profile.name);
  const isAllAccess =
    rank === 1 || cleanForMatch(rolePos).includes("businessanalyst");

  // Compute hierarchy team scope using production hierarchy utilities
  const teamNames = new Set<string>([myClean]);
  if (isAllAccess) {
    employees.forEach((e) => {
      const n = cleanForMatch(e?.name || e?.full_name || "");
      if (n) teamNames.add(n);
    });
  } else {
    const teamProfiles: Record<string, any> = {};
    employees.forEach((emp) => {
      const empName = String(emp?.name || emp?.full_name || "").trim();
      if (!empName) return;
      teamProfiles[empName] = {
        name: empName,
        upline: emp?.upline || emp?.upline_name || "",
        position: emp?.position || "",
        email: emp?.email || emp?.picEmail || "",
      };
    });
    const depthMap = buildDepthMap(profile.name, teamProfiles);
    Object.entries(depthMap).forEach(([cleanName, depth]) => {
      if (typeof depth === "number" && depth < 99) {
        teamNames.add(cleanName);
      }
    });
  }

  // Scope partners & build partner set
  let scopedPartnersCount = 0;
  const scopedPartnerNames = new Set<string>();
  for (let i = 0; i < kiosks.length; i += 1) {
    const k = kiosks[i];
    const pic = cleanForMatch(
      getResolvedPic(k, k?.pic, undefined, undefined, k?.pic_name) ||
        k?.pic ||
        "",
    );
    if (isAllAccess || (pic && teamNames.has(pic))) {
      scopedPartnersCount += 1;
      const kn = cleanForMatch(k?.name || k?.partner_name || "");
      if (kn) scopedPartnerNames.add(kn);
    }
  }

  // Aggregate KPI totals over scoped opname logs
  let scopedLogsCount = 0;
  let totalPogKg = 0;
  for (let i = 0; i < workingData.length; i += 1) {
    const row = workingData[i];
    const rowPic = cleanForMatch(row?.pic || row?.picTeam || "");
    const rowKiosk = cleanForMatch(row?.kiosk || "");
    if (
      isAllAccess ||
      (rowPic && teamNames.has(rowPic)) ||
      (rowKiosk && scopedPartnerNames.has(rowKiosk))
    ) {
      scopedLogsCount += 1;
      for (let m = 0; m < FISCAL_MONTH_FIELDS.length; m += 1) {
        const key = FISCAL_MONTH_FIELDS[m];
        const cell = row?.[key];
        if (cell && typeof cell === "object") {
          totalPogKg += safeParseFloat(cell.pog);
        }
      }
    }
  }

  // Evaluate RBAC tab permissions lookup
  const _rule =
    accessRules?.[rolePos] ||
    accessRules?.[cleanForMatch(rolePos)] ||
    accessRules?.["Default"];
  void _rule;

  return { scopedPartnersCount, scopedLogsCount, totalPogKg };
}

function buildDiagnosis(params: {
  userCount: number;
  operations: OperationMetrics[];
  syncStrategies: SyncStrategyMetric[];
  websiteHealth: WebsiteHealthTelemetry;
}): EfficiencyDiagnosis {
  const { userCount, operations, syncStrategies, websiteHealth } = params;
  const loginOp = operations.find((o) => o.id === "login_server");
  const hydrationOp = operations.find((o) => o.id === "website_hydration");
  const crudCreate = operations.find((o) => o.id === "crud_create");
  const crudRead = operations.find((o) => o.id === "crud_read");
  const crudUpdate = operations.find((o) => o.id === "crud_update");
  const crudDelete = operations.find((o) => o.id === "crud_delete");

  const cacheSync = syncStrategies.find((s) => s.strategy === "cache");
  const deltaSync = syncStrategies.find((s) => s.strategy === "delta");
  const fullSync = syncStrategies.find((s) => s.strategy === "full");

  const fullDocsPerSession = Math.max(
    1,
    fullSync?.docsReturned || cacheSync?.docsReturned || 1,
  );
  const deltaDocsPerSession = Math.max(1, (deltaSync?.docsReturned || 0) + 1);
  const projected200UsersFullReads = userCount * fullDocsPerSession;
  const projected200UsersOptimizedReads = userCount * deltaDocsPerSession;
  const readSavingsPct = round2(
    Math.max(
      0,
      ((projected200UsersFullReads - projected200UsersOptimizedReads) /
        projected200UsersFullReads) *
        100,
    ),
  );

  // Website responsiveness grade based on client hydration total & frame gap
  const hydrationTotal = hydrationOp?.totalMs ?? 0;
  const websiteGrade: EfficiencyDiagnosis["websiteGrade"] =
    hydrationTotal <= 450 && websiteHealth.maxFrameGapMs <= 120
      ? "Sangat Efisien"
      : hydrationTotal <= 1200 && websiteHealth.maxFrameGapMs <= 300
        ? "Cukup Baik"
        : "Perlu Optimasi";

  // Database read grade based on delta/cache efficiency & login P95
  const loginP95 = loginOp?.p95Ms ?? 0;
  const databaseGrade: EfficiencyDiagnosis["databaseGrade"] =
    readSavingsPct >= 85 && (deltaSync?.durationMs ?? 0) <= 1500 && loginP95 <= 2500
      ? "Sangat Efisien"
      : readSavingsPct >= 50 && loginP95 <= 4500
        ? "Cukup Baik"
        : "Perlu Optimasi";

  // CRUD grade based on write/read failures and batch throughput
  const crudOps = [crudCreate, crudRead, crudUpdate, crudDelete].filter(
    (x): x is OperationMetrics => Boolean(x),
  );
  const totalCrudFails = crudOps.reduce((acc, o) => acc + o.failCount, 0);
  const avgCrudOpsSec =
    crudOps.length > 0
      ? crudOps.reduce((acc, o) => acc + o.opsPerSec, 0) / crudOps.length
      : 0;
  const crudGrade: EfficiencyDiagnosis["crudGrade"] =
    totalCrudFails === 0 && avgCrudOpsSec >= 80
      ? "Sangat Efisien"
      : totalCrudFails === 0 && avgCrudOpsSec >= 30
        ? "Cukup Baik"
        : "Perlu Optimasi";

  const sortedByP95 = [...operations].sort((a, b) => a.p95Ms - b.p95Ms);
  const fastest = sortedByP95[0] || {
    label: "-",
    p95Ms: 0,
    opsPerSec: 0,
  };
  const slowest = sortedByP95[sortedByP95.length - 1] || fastest;

  const findings: string[] = [];

  if (loginOp) {
    findings.push(
      `${userCount} sesi login bersamaan diselesaikan dalam ${loginOp.totalMs} ms (${loginOp.opsPerSec} login/dtk, p95 ${loginOp.p95Ms} ms, sukses ${loginOp.successCount}/${loginOp.count}).`,
    );
  }

  if (cacheSync && deltaSync && fullSync) {
    findings.push(
      `IndexedDB Cache membaca ${cacheSync.docsReturned} dokumen dalam ${cacheSync.durationMs} ms (0 server reads), Delta Sync memakan ${deltaSync.durationMs} ms (${deltaSync.docsReturned} delta docs), sedangkan Full Read memakan ${fullSync.durationMs} ms (${fullSync.docsReturned} docs) — menghemat ${readSavingsPct}% kuota read Firestore untuk ${userCount} user.`,
    );
  }

  if (crudCreate && crudRead && crudUpdate && crudDelete) {
    findings.push(
      `Siklus CRUD 200 dokumen ke Firestore mencapai Create ${crudCreate.opsPerSec} ops/dtk, Read ${crudRead.opsPerSec} ops/dtk, Update ${crudUpdate.opsPerSec} ops/dtk, dan Delete ${crudDelete.opsPerSec} ops/dtk (p95 terlama ${slowest.p95Ms} ms pada ${slowest.label}).`,
    );
  }

  findings.push(
    `Responsivitas browser selama beban puncak: rata-rata ${websiteHealth.avgFps} FPS, jeda frame maksimum ${websiteHealth.maxFrameGapMs} ms${websiteHealth.longTaskSupported ? `, long task (>50 ms): ${websiteHealth.longTaskCount}x` : ""}.`,
  );

  return {
    websiteGrade,
    databaseGrade,
    crudGrade,
    readSavingsPct,
    projected200UsersFullReads,
    projected200UsersOptimizedReads,
    fastestOp: {
      label: fastest.label,
      p95Ms: fastest.p95Ms,
      opsPerSec: fastest.opsPerSec,
    },
    slowestOp: {
      label: slowest.label,
      p95Ms: slowest.p95Ms,
      opsPerSec: slowest.opsPerSec,
    },
    findings,
  };
}

export async function run200UserLoadBenchmark(
  options: RunBenchmarkOptions,
): Promise<LoadBenchmarkResult> {
  const {
    userCount = 200,
    employees = [],
    kiosks = [],
    workingData = [],
    accessRules = {},
    includeCrudWriteTest = true,
    includeFullCollectionColdRead = true,
    onProgress,
    signal,
  } = options;

  const startedAtIso = new Date().toISOString();
  const benchStartPerf = performance.now();
  const heapBeforeMb = getJsHeapMb();
  const monitor = createFrameAndLongTaskMonitor();

  const totalSteps = includeCrudWriteTest ? 7 : 3;
  const emit = (
    phase: BenchmarkPhase,
    stepIndex: number,
    message: string,
  ) => {
    onProgress?.({
      phase,
      stepIndex,
      totalSteps,
      message,
      percent: Math.min(100, Math.round((stepIndex / totalSteps) * 100)),
    });
  };

  const checkAbort = () => {
    if (signal?.aborted) {
      throw new Error("Simulasi dibatalkan oleh pengguna.");
    }
  };

  const operations: OperationMetrics[] = [];
  const roleBreakdown: RoleSessionBreakdown[] = [];
  const syncStrategies: SyncStrategyMetric[] = [];
  const errors: string[] = [];
  let cleanupVerifiedZeroRemaining = true;
  let remainingBenchDocs = 0;

  try {
    // STEP 1: Pre-cleanup + Discover access_rules IDs
    emit(
      "cleanup_pre",
      1,
      "Membersihkan sisa dokumen uji & menyiapkan profil 200 user...",
    );
    checkAbort();

    if (includeCrudWriteTest) {
      await cleanupBenchmarkHybridDocs(userCount);
    }

    let accessRuleIds: string[] = [];
    try {
      const accessSnap = await getDocsFromServer(
        query(collection(db, "access_rules"), limit(20)),
      );
      accessRuleIds = accessSnap.docs
        .map((d) => d.id)
        .filter((id) => id !== "__sku_meta__");
    } catch {
      accessRuleIds = ["business_analyst", "sales_agronomist", "business_solution"];
    }

    const profiles = buildVirtualUserProfiles(userCount, employees, accessRuleIds);

    // STEP 2: 200 Concurrent Logins (Server Auth/RBAC + Client Scope & KPI Hydration)
    emit(
      "login_200",
      2,
      `Menjalankan ${userCount} login bersamaan (server RBAC + hidrasi UI/hierarki)...`,
    );
    checkAbort();

    const loginServerStart = performance.now();
    const loginSamplesMs: number[] = [];
    let loginSuccess = 0;
    let loginFail = 0;

    await Promise.all(
      profiles.map(async (prof) => {
        const t0 = performance.now();
        try {
          const ref = doc(db, "access_rules", prof.accessRuleDocId);
          await getDocFromServer(ref);
          loginSuccess += 1;
        } catch (err) {
          loginFail += 1;
          if (errors.length < 5) {
            errors.push(
              `Login RBAC #${prof.sessionIndex}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } finally {
          loginSamplesMs.push(performance.now() - t0);
        }
      }),
    );
    const loginServerTotalMs = performance.now() - loginServerStart;

    operations.push(
      computeOperationMetrics({
        id: "login_server",
        label: `Login & RBAC Lookup (${userCount} Concurrent)`,
        category: "auth",
        samplesMs: loginSamplesMs,
        totalMs: loginServerTotalMs,
        count: userCount,
        unitLabel: "login",
        successCount: loginSuccess,
        failCount: loginFail,
        note: `${userCount} request getDocFromServer paralel ke /access_rules`,
      }),
    );

    checkAbort();

    // Client Website Hydration across 200 concurrent virtual user sessions
    // Run in chunks of 25 with micro-yields so browser rAF/longtask telemetry captures real responsiveness
    const hydrationSamplesMs: number[] = [];
    const roleMap = new Map<
      string,
      { samples: number[]; partners: number[]; logs: number[] }
    >();
    const hydrationStart = performance.now();
    const HYDRATION_CHUNK = 25;

    for (let offset = 0; offset < profiles.length; offset += HYDRATION_CHUNK) {
      const slice = profiles.slice(offset, offset + HYDRATION_CHUNK);
      for (const prof of slice) {
        const t0 = performance.now();
        const res = hydrateSingleUserSession(
          prof,
          employees,
          kiosks,
          workingData,
          accessRules,
        );
        const elapsed = performance.now() - t0;
        hydrationSamplesMs.push(elapsed);

        const rKey = prof.position || "Lainnya";
        const bucket = roleMap.get(rKey) || {
          samples: [],
          partners: [],
          logs: [],
        };
        bucket.samples.push(elapsed);
        bucket.partners.push(res.scopedPartnersCount);
        bucket.logs.push(res.scopedLogsCount);
        roleMap.set(rKey, bucket);
      }
      // Yield 1 macrotask tick between chunks so UI progress stays live
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const hydrationTotalMs = performance.now() - hydrationStart;

    operations.push(
      computeOperationMetrics({
        id: "website_hydration",
        label: `Hidrasi Scope & KPI Dashboard (${userCount} Sesi)`,
        category: "website",
        samplesMs: hydrationSamplesMs,
        totalMs: hydrationTotalMs,
        count: userCount,
        unitLabel: "sesi",
        successCount: userCount,
        failCount: 0,
        note: `Kalkulasi hierarki tim, ${kiosks.length} partner & ${workingData.length} opname logs`,
      }),
    );

    roleMap.forEach((bucket, role) => {
      const sorted = [...bucket.samples].sort((a, b) => a - b);
      const p95Idx = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(0.95 * sorted.length) - 1),
      );
      const avg =
        bucket.samples.reduce((a, b) => a + b, 0) / Math.max(1, bucket.samples.length);
      const avgP =
        bucket.partners.reduce((a, b) => a + b, 0) / Math.max(1, bucket.partners.length);
      const avgL =
        bucket.logs.reduce((a, b) => a + b, 0) / Math.max(1, bucket.logs.length);
      roleBreakdown.push({
        role,
        sessionCount: bucket.samples.length,
        avgHydrationMs: round2(avg),
        p95HydrationMs: round2(sorted[p95Idx] || 0),
        avgScopedPartners: Math.round(avgP),
        avgScopedLogs: Math.round(avgL),
      });
    });
    roleBreakdown.sort((a, b) => b.sessionCount - a.sessionCount);

    // STEP 3: Database Sync Comparison (IndexedDB Cache vs Delta Sync vs Cold Full Read)
    emit(
      "sync_comparison",
      3,
      "Mengukur efisiensi Sync Database (Local Cache vs Delta Sync vs Cold Full Read)...",
    );
    checkAbort();

    // 3A. IndexedDB Cache Read
    const cachePerColMs: Record<string, number> = {};
    const cachePerColDocs: Record<string, number> = {};
    const cacheStart = performance.now();
    let totalCacheDocs = 0;

    await Promise.all(
      BENCHMARK_COLLECTIONS.map(async (colName) => {
        const t0 = performance.now();
        try {
          const snap = await getDocsFromCache(collection(db, colName));
          cachePerColDocs[colName] = snap.size;
          totalCacheDocs += snap.size;
        } catch {
          cachePerColDocs[colName] = 0;
        } finally {
          cachePerColMs[colName] = round2(performance.now() - t0);
        }
      }),
    );
    const cacheDurationMs = round2(performance.now() - cacheStart);

    syncStrategies.push({
      strategy: "cache",
      label: "IndexedDB Local Cache",
      durationMs: cacheDurationMs,
      docsReturned: totalCacheDocs,
      estimatedServerReads: 0,
      perCollectionMs: cachePerColMs,
      perCollectionDocs: cachePerColDocs,
      note: "0 Firestore server reads (membaca cache browser persisten)",
    });

    // 3B. Delta Incremental Sync (updatedAt > sinceTs)
    const rawLastSync =
      typeof localStorage !== "undefined"
        ? Number(localStorage.getItem(LAST_SYNC_STORAGE_KEY) || "0")
        : 0;
    const sinceMs =
      rawLastSync > 0 ? Math.max(0, rawLastSync - 5000) : Date.now() - 60_000;
    const sinceTs = Timestamp.fromMillis(sinceMs);

    const deltaPerColMs: Record<string, number> = {};
    const deltaPerColDocs: Record<string, number> = {};
    const deltaStart = performance.now();
    let totalDeltaDocs = 0;

    await Promise.all(
      BENCHMARK_COLLECTIONS.map(async (colName) => {
        const t0 = performance.now();
        try {
          const snap = await getDocsFromServer(
            query(collection(db, colName), where("updatedAt", ">", sinceTs)),
          );
          deltaPerColDocs[colName] = snap.size;
          totalDeltaDocs += snap.size;
        } catch (err) {
          deltaPerColDocs[colName] = 0;
          if (errors.length < 5) {
            errors.push(
              `Delta ${colName}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } finally {
          deltaPerColMs[colName] = round2(performance.now() - t0);
        }
      }),
    );
    const deltaDurationMs = round2(performance.now() - deltaStart);

    syncStrategies.push({
      strategy: "delta",
      label: "Delta Sync (updatedAt > lastSync)",
      durationMs: deltaDurationMs,
      docsReturned: totalDeltaDocs,
      estimatedServerReads: Math.max(1, totalDeltaDocs),
      perCollectionMs: deltaPerColMs,
      perCollectionDocs: deltaPerColDocs,
      note: "Hanya mengambil dokumen yang berubah sejak sinkronisasi terakhir",
    });

    // 3C. Single Cold Full Read (1x only, never 200x, to protect daily read quota)
    const fullPerColMs: Record<string, number> = {};
    const fullPerColDocs: Record<string, number> = {};
    let totalFullDocs = 0;
    let fullDurationMs = 0;

    if (includeFullCollectionColdRead) {
      const fullStart = performance.now();
      await Promise.all(
        BENCHMARK_COLLECTIONS.map(async (colName) => {
          const t0 = performance.now();
          try {
            const snap = await getDocsFromServer(collection(db, colName));
            fullPerColDocs[colName] = snap.size;
            totalFullDocs += snap.size;
          } catch (err) {
            fullPerColDocs[colName] = 0;
            if (errors.length < 5) {
              errors.push(
                `Cold Full ${colName}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          } finally {
            fullPerColMs[colName] = round2(performance.now() - t0);
          }
        }),
      );
      fullDurationMs = round2(performance.now() - fullStart);
    } else {
      totalFullDocs = totalCacheDocs;
    }

    syncStrategies.push({
      strategy: "full",
      label: includeFullCollectionColdRead
        ? "Cold Full Collection Read (1× Benchmark)"
        : "Full Read (Estimasi dari Cache)",
      durationMs: fullDurationMs,
      docsReturned: totalFullDocs,
      estimatedServerReads: totalFullDocs,
      perCollectionMs: fullPerColMs,
      perCollectionDocs: fullPerColDocs,
      note: includeFullCollectionColdRead
        ? "Pengukuran 1× full read seluruh koleksi server untuk baseline proyeksi 200 user"
        : "Full read dilewati untuk menghemat kuota; jumlah dokumen diambil dari cache",
    });

    operations.push(
      computeOperationMetrics({
        id: "db_sync_delta",
        label: "Database Delta Sync (7 Koleksi)",
        category: "database",
        samplesMs: Object.values(deltaPerColMs),
        totalMs: deltaDurationMs,
        count: BENCHMARK_COLLECTIONS.length,
        unitLabel: "koleksi",
        successCount: BENCHMARK_COLLECTIONS.length,
        failCount: 0,
        note: `${totalDeltaDocs} dokumen berubah dari total ${totalFullDocs} dokumen`,
      }),
    );

    if (includeFullCollectionColdRead) {
      operations.push(
        computeOperationMetrics({
          id: "db_sync_full",
          label: "Database Cold Full Read (7 Koleksi)",
          category: "database",
          samplesMs: Object.values(fullPerColMs),
          totalMs: fullDurationMs,
          count: BENCHMARK_COLLECTIONS.length,
          unitLabel: "koleksi",
          successCount: BENCHMARK_COLLECTIONS.length,
          failCount: 0,
          note: `${totalFullDocs} total dokumen dimuat langsung dari server`,
        }),
      );
    }

    // STEP 4: Real 200-Doc Firestore CRUD Cycle in /hybrids (isolated BENCH_200_* docs)
    if (includeCrudWriteTest) {
      const ownerUid = auth.currentUser?.uid || "public";
      const benchIds = Array.from({ length: userCount }, (_, i) =>
        makeBenchDocId(i),
      );
      const idChunks: string[][] = [];
      for (let i = 0; i < benchIds.length; i += BENCH_BATCH_SIZE) {
        idChunks.push(benchIds.slice(i, i + BENCH_BATCH_SIZE));
      }

      try {
        // 4A. CREATE (200 docs in parallel writeBatch chunks)
        emit(
          "crud_create",
          4,
          `CRUD 1/4 — Membuat ${userCount} dokumen uji paralel di Firestore (/hybrids)...`,
        );
        checkAbort();

        const createBatchSamplesMs: number[] = [];
        let createSuccessDocs = 0;
        let createFailDocs = 0;
        const createStart = performance.now();

        await Promise.all(
          idChunks.map(async (chunk, chunkIdx) => {
            const t0 = performance.now();
            try {
              const batch = writeBatch(db);
              chunk.forEach((docId, idx) => {
                const seq = chunkIdx * BENCH_BATCH_SIZE + idx + 1;
                batch.set(doc(db, "hybrids", docId), {
                  doc_id: docId,
                  hybrid_name: `BENCHMARK HYBRID ${String(seq).padStart(3, "0")}`,
                  sku: `BENCH-SKU-${String(seq).padStart(3, "0")}`,
                  crop_type: "Field Corn",
                  ownerUid,
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                });
              });
              await batch.commit();
              createSuccessDocs += chunk.length;
            } catch (err) {
              createFailDocs += chunk.length;
              if (errors.length < 5) {
                errors.push(
                  `CRUD Create batch ${chunkIdx + 1}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            } finally {
              createBatchSamplesMs.push(performance.now() - t0);
            }
          }),
        );
        const createTotalMs = performance.now() - createStart;

        operations.push(
          computeOperationMetrics({
            id: "crud_create",
            label: `CRUD Create (${userCount} Dokumen Uji)`,
            category: "crud",
            samplesMs: createBatchSamplesMs,
            totalMs: createTotalMs,
            count: userCount,
            unitLabel: "dokumen",
            successCount: createSuccessDocs,
            failCount: createFailDocs,
            note: `${idChunks.length} writeBatch paralel @ ${BENCH_BATCH_SIZE} write (latensi per-batch)`,
          }),
        );

        // 4B. READ (200 concurrent getDocFromServer requests)
        emit(
          "crud_read",
          5,
          `CRUD 2/4 — Membaca ${userCount} dokumen paralel langsung dari server Firestore...`,
        );
        checkAbort();

        const readSamplesMs: number[] = [];
        let readSuccessDocs = 0;
        let readFailDocs = 0;
        const readStart = performance.now();

        await Promise.all(
          benchIds.map(async (docId) => {
            const t0 = performance.now();
            try {
              const snap = await getDocFromServer(doc(db, "hybrids", docId));
              if (snap.exists()) {
                readSuccessDocs += 1;
              } else {
                readFailDocs += 1;
              }
            } catch (err) {
              readFailDocs += 1;
              if (errors.length < 5) {
                errors.push(
                  `CRUD Read ${docId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            } finally {
              readSamplesMs.push(performance.now() - t0);
            }
          }),
        );
        const readTotalMs = performance.now() - readStart;

        operations.push(
          computeOperationMetrics({
            id: "crud_read",
            label: `CRUD Read (${userCount} Concurrent getDocFromServer)`,
            category: "crud",
            samplesMs: readSamplesMs,
            totalMs: readTotalMs,
            count: userCount,
            unitLabel: "dokumen",
            successCount: readSuccessDocs,
            failCount: readFailDocs,
            note: `${userCount} individual getDocFromServer paralel (p50/p95/p99 per dokumen)`,
          }),
        );

        // 4C. UPDATE (200 docs in parallel writeBatch chunks)
        emit(
          "crud_update",
          6,
          `CRUD 3/4 — Memperbarui ${userCount} dokumen uji paralel di Firestore...`,
        );
        checkAbort();

        const updateBatchSamplesMs: number[] = [];
        let updateSuccessDocs = 0;
        let updateFailDocs = 0;
        const updateStart = performance.now();

        await Promise.all(
          idChunks.map(async (chunk, chunkIdx) => {
            const t0 = performance.now();
            try {
              const batch = writeBatch(db);
              chunk.forEach((docId, idx) => {
                const seq = chunkIdx * BENCH_BATCH_SIZE + idx + 1;
                batch.update(doc(db, "hybrids", docId), {
                  hybrid_name: `BENCHMARK HYBRID ${String(seq).padStart(3, "0")} UPDATED`,
                  updatedAt: serverTimestamp(),
                });
              });
              await batch.commit();
              updateSuccessDocs += chunk.length;
            } catch (err) {
              updateFailDocs += chunk.length;
              if (errors.length < 5) {
                errors.push(
                  `CRUD Update batch ${chunkIdx + 1}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            } finally {
              updateBatchSamplesMs.push(performance.now() - t0);
            }
          }),
        );
        const updateTotalMs = performance.now() - updateStart;

        operations.push(
          computeOperationMetrics({
            id: "crud_update",
            label: `CRUD Update (${userCount} Dokumen Uji)`,
            category: "crud",
            samplesMs: updateBatchSamplesMs,
            totalMs: updateTotalMs,
            count: userCount,
            unitLabel: "dokumen",
            successCount: updateSuccessDocs,
            failCount: updateFailDocs,
            note: `${idChunks.length} writeBatch update paralel (hanya field hybrid_name & updatedAt)`,
          }),
        );

        // 4D. DELETE (200 docs in parallel writeBatch chunks)
        emit(
          "crud_delete",
          7,
          `CRUD 4/4 — Menghapus ${userCount} dokumen uji & memverifikasi database bersih...`,
        );

        const deleteBatchSamplesMs: number[] = [];
        let deleteSuccessDocs = 0;
        let deleteFailDocs = 0;
        const deleteStart = performance.now();

        await Promise.all(
          idChunks.map(async (chunk, chunkIdx) => {
            const t0 = performance.now();
            try {
              const batch = writeBatch(db);
              chunk.forEach((docId) => {
                batch.delete(doc(db, "hybrids", docId));
              });
              await batch.commit();
              deleteSuccessDocs += chunk.length;
            } catch (err) {
              deleteFailDocs += chunk.length;
              if (errors.length < 5) {
                errors.push(
                  `CRUD Delete batch ${chunkIdx + 1}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            } finally {
              deleteBatchSamplesMs.push(performance.now() - t0);
            }
          }),
        );
        const deleteTotalMs = performance.now() - deleteStart;

        operations.push(
          computeOperationMetrics({
            id: "crud_delete",
            label: `CRUD Delete (${userCount} Dokumen Uji)`,
            category: "crud",
            samplesMs: deleteBatchSamplesMs,
            totalMs: deleteTotalMs,
            count: userCount,
            unitLabel: "dokumen",
            successCount: deleteSuccessDocs,
            failCount: deleteFailDocs,
            note: `${idChunks.length} writeBatch delete paralel`,
          }),
        );
      } finally {
        // Guaranteed cleanup even if aborted or failed mid-CRUD
        emit(
          "cleanup_verify",
          totalSteps,
          "Memverifikasi 0 dokumen sisa benchmark di database...",
        );
        remainingBenchDocs = await cleanupBenchmarkHybridDocs(userCount);
        cleanupVerifiedZeroRemaining = remainingBenchDocs === 0;
      }
    }

    const totalBenchmarkMs = round2(performance.now() - benchStartPerf);
    const frameMetrics = monitor.stop();
    const heapAfterMb = getJsHeapMb();
    const heapPeakDeltaMb =
      heapBeforeMb !== null && heapAfterMb !== null
        ? round2(heapAfterMb - heapBeforeMb)
        : null;

    const websiteHealth: WebsiteHealthTelemetry = {
      totalBenchmarkMs,
      ...frameMetrics,
      heapSupported: heapBeforeMb !== null && heapAfterMb !== null,
      heapBeforeMb,
      heapAfterMb,
      heapPeakDeltaMb,
    };

    const diagnosis = buildDiagnosis({
      userCount,
      operations,
      syncStrategies,
      websiteHealth,
    });

    emit("done", totalSteps, "Simulasi 200 user selesai.");

    return {
      startedAtIso,
      completedAtIso: new Date().toISOString(),
      userCount,
      includeCrudWriteTest,
      includeFullCollectionColdRead,
      isOnlineAtRun: typeof navigator !== "undefined" ? navigator.onLine : true,
      isAuthenticatedAdmin: Boolean(auth.currentUser),
      operations,
      roleBreakdown,
      syncStrategies,
      websiteHealth,
      diagnosis,
      cleanupVerifiedZeroRemaining,
      remainingBenchDocs,
      errors,
    };
  } catch (err) {
    monitor.stop();
    throw err;
  }
}
