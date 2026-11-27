import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  run200UserLoadBenchmark,
  type BenchmarkProgress,
  type EfficiencyDiagnosis,
  type LoadBenchmarkResult,
} from "../../utils/loadBenchmark";

interface LoadBenchmarkModalProps {
  isOpen: boolean;
  onClose: () => void;
  runNonce: number;
  employees: any[];
  kiosks: any[];
  workingData: any[];
  accessRules: Record<string, Record<string, boolean>>;
  isOnline: boolean;
}

const GRADE_STYLE: Record<EfficiencyDiagnosis["websiteGrade"], string> = {
  "Sangat Efisien": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Cukup Baik": "bg-amber-50 text-amber-700 border-amber-200",
  "Perlu Optimasi": "bg-rose-50 text-rose-700 border-rose-200",
};

function fmtMs(val: number): string {
  if (!Number.isFinite(val)) return "0 ms";
  if (val >= 1000) return `${(val / 1000).toFixed(2)} dtk`;
  return `${val.toFixed(1)} ms`;
}

function fmtNum(val: number): string {
  return new Intl.NumberFormat("id-ID").format(Math.round(val));
}

export const LoadBenchmarkModal: React.FC<LoadBenchmarkModalProps> = ({
  isOpen,
  onClose,
  runNonce,
  employees,
  kiosks,
  workingData,
  accessRules,
  isOnline,
}) => {
  const [userCount, setUserCount] = useState<50 | 100 | 200>(200);
  const [includeCrudWriteTest, setIncludeCrudWriteTest] = useState<boolean>(true);
  const [includeFullCollectionColdRead, setIncludeFullCollectionColdRead] =
    useState<boolean>(true);

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
  const [result, setResult] = useState<LoadBenchmarkResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const isRunningRef = useRef<boolean>(false);
  const lastRunNonceRef = useRef<number>(-1);

  const startBenchmark = useCallback(
    async (overrideUserCount?: 50 | 100 | 200) => {
      if (isRunningRef.current) return;
      const targetUsers = overrideUserCount ?? userCount;

      const controller = new AbortController();
      abortRef.current = controller;
      isRunningRef.current = true;
      setIsRunning(true);
      setRunError(null);
      setProgress({
        phase: "cleanup_pre",
        stepIndex: 0,
        totalSteps: includeCrudWriteTest ? 7 : 3,
        message: `Menyiapkan simulasi ${targetUsers} user bersamaan...`,
        percent: 5,
      });

      try {
        const res = await run200UserLoadBenchmark({
          userCount: targetUsers,
          employees,
          kiosks,
          workingData,
          accessRules,
          includeCrudWriteTest,
          includeFullCollectionColdRead,
          onProgress: (p) => setProgress(p),
          signal: controller.signal,
        });
        setResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setRunError(msg);
      } finally {
        isRunningRef.current = false;
        setIsRunning(false);
        abortRef.current = null;
      }
    },
    [
      userCount,
      employees,
      kiosks,
      workingData,
      accessRules,
      includeCrudWriteTest,
      includeFullCollectionColdRead,
    ],
  );

  // Auto-run immediately when opened from the header button
  useEffect(() => {
    if (!isOpen) return;
    if (lastRunNonceRef.current !== runNonce) {
      lastRunNonceRef.current = runNonce;
      setUserCount(200);
      startBenchmark(200);
    }
  }, [isOpen, runNonce, startBenchmark]);

  const handleClose = () => {
    if (isRunning) {
      abortRef.current?.abort();
      return;
    }
    onClose();
  };

  const handleDownloadJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `radar-benchmark-${result.userCount}users-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  const loginOp = result?.operations.find((o) => o.id === "login_server");
  const hydrationOp = result?.operations.find((o) => o.id === "website_hydration");
  const crudOps =
    result?.operations.filter((o) => o.category === "crud") || [];
  const avgCrudOpsSec =
    crudOps.length > 0
      ? Math.round(
          crudOps.reduce((acc, o) => acc + o.opsPerSec, 0) / crudOps.length,
        )
      : 0;
  const maxSyncMs = Math.max(
    1,
    ...(result?.syncStrategies.map((s) => s.durationMs) || [1]),
  );

  return (
    <div
      className="fixed inset-0 z-[120] bg-[#121528]/60 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label="Simulasi Performa 200 User"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isRunning) {
          handleClose();
        }
      }}
    >
      <div className="bg-white border border-[#e0e0fa] rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden text-[#181a2c]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#e8e8fa] flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-[#f8f9ff]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[#154be2] text-[22px]">
                speed
              </span>
              <h2 className="text-base sm:text-lg font-bold tracking-tight text-[#181a2c] truncate">
                Simulasi Beban 200 User Bersamaan — Website, Database &amp; CRUD
              </h2>
            </div>
            <p className="text-xs text-[#646987] mt-0.5">
              Mengukur latensi login paralel, kalkulasi scope/KPI browser, efisiensi Sync (Cache vs Delta vs Full), dan throughput CRUD real ke Firestore (/hybrids terisolasi).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <select
              aria-label="Jumlah User Simulasi"
              disabled={isRunning}
              value={userCount}
              onChange={(e) =>
                setUserCount(Number(e.target.value) as 50 | 100 | 200)
              }
              className="h-8 px-2.5 rounded-lg border border-[#d6d8f5] bg-white text-xs font-semibold text-[#181a2c] outline-none disabled:opacity-50"
            >
              <option value={50}>50 User</option>
              <option value={100}>100 User</option>
              <option value={200}>200 User</option>
            </select>

            <button
              type="button"
              disabled={isRunning || !isOnline}
              onClick={() => startBenchmark()}
              className="h-8 px-3 rounded-lg bg-[#154be2] hover:bg-[#103cc0] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <span
                className={`material-symbols-outlined text-[15px] ${
                  isRunning ? "animate-spin" : ""
                }`}
              >
                {isRunning ? "progress_activity" : "play_arrow"}
              </span>
              <span>{isRunning ? "Menguji..." : "Ulangi Simulasi"}</span>
            </button>

            {result && !isRunning && (
              <button
                type="button"
                onClick={handleDownloadJson}
                className="h-8 px-2.5 rounded-lg border border-[#d6d8f5] bg-white hover:bg-[#f1f3ff] text-xs font-semibold text-[#181a2c] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
              >
                <span className="material-symbols-outlined text-[15px]">
                  download
                </span>
                <span>JSON</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleClose}
              title={
                isRunning
                  ? "Batalkan & bersihkan dokumen uji"
                  : "Tutup hasil benchmark"
              }
              className="h-8 px-2.5 rounded-lg border border-[#d6d8f5] bg-white hover:bg-rose-50 hover:text-rose-700 text-xs font-semibold text-[#646987] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]">close</span>
              <span>{isRunning ? "Batal" : "Tutup"}</span>
            </button>
          </div>
        </div>

        {/* Options & Live Progress Strip */}
        <div className="px-5 py-2.5 border-b border-[#eceefd] bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                disabled={isRunning}
                checked={includeCrudWriteTest}
                onChange={(e) => setIncludeCrudWriteTest(e.target.checked)}
                className="rounded border-[#cfd2f0] text-[#154be2]"
              />
              <span className="font-medium text-[#343852]">
                Uji CRUD Real {userCount} Dokumen (auto-hapus setelah selesai)
              </span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                disabled={isRunning}
                checked={includeFullCollectionColdRead}
                onChange={(e) =>
                  setIncludeFullCollectionColdRead(e.target.checked)
                }
                className="rounded border-[#cfd2f0] text-[#154be2]"
              />
              <span className="font-medium text-[#343852]">
                Ukur 1× Cold Full Collection Read
              </span>
            </label>
          </div>

          {!isOnline && (
            <span className="text-rose-600 font-semibold">
              Browser offline — sambungkan internet untuk menguji ke Firestore.
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 bg-[#fafbff]">
          {/* Active Progress */}
          {isRunning && progress && (
            <div className="p-4 rounded-xl border border-[#cfd8ff] bg-[#eef2ff] space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs font-bold text-[#154be2]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="material-symbols-outlined text-[16px] animate-spin shrink-0">
                    sync
                  </span>
                  <span className="truncate">{progress.message}</span>
                </div>
                <span className="font-mono tabular-nums shrink-0">
                  Langkah {progress.stepIndex}/{progress.totalSteps} ({progress.percent}%)
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-white/80 overflow-hidden">
                <div
                  className="h-full bg-[#154be2] transition-all duration-200"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          )}

          {/* Error Banner */}
          {runError && (
            <div className="p-3.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-800 text-xs flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] shrink-0">
                error
              </span>
              <div>
                <p className="font-bold">Simulasi Terhenti</p>
                <p className="mt-0.5">{runError}</p>
              </div>
            </div>
          )}

          {result && (
            <>
              {/* 4-Column KPI Summary Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="p-3.5 rounded-xl bg-white border border-[#e0e0fa]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[#646987]">
                      Login {result.userCount} User
                    </span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded border bg-slate-50 text-slate-700 border-slate-200 font-mono tabular-nums">
                      {loginOp?.successCount ?? 0}/{loginOp?.count ?? 0} OK
                    </span>
                  </div>
                  <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-[#181a2c]">
                    {fmtMs(loginOp?.totalMs ?? 0)}
                  </div>
                  <p className="text-[11px] text-[#646987] mt-1 font-mono tabular-nums">
                    p95: {fmtMs(loginOp?.p95Ms ?? 0)} · {loginOp?.opsPerSec ?? 0} login/dtk
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-white border border-[#e0e0fa]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[#646987]">
                      Performa Website
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${GRADE_STYLE[result.diagnosis.websiteGrade]}`}
                    >
                      {result.diagnosis.websiteGrade}
                    </span>
                  </div>
                  <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-[#181a2c]">
                    {fmtMs(hydrationOp?.totalMs ?? 0)}
                  </div>
                  <p className="text-[11px] text-[#646987] mt-1 font-mono tabular-nums">
                    {result.websiteHealth.avgFps} FPS · max jeda{" "}
                    {result.websiteHealth.maxFrameGapMs} ms
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-white border border-[#e0e0fa]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[#646987]">
                      Efisiensi Sync DB
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${GRADE_STYLE[result.diagnosis.databaseGrade]}`}
                    >
                      {result.diagnosis.databaseGrade}
                    </span>
                  </div>
                  <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-[#154be2]">
                    -{result.diagnosis.readSavingsPct.toFixed(1)}% Read
                  </div>
                  <p className="text-[11px] text-[#646987] mt-1 font-mono tabular-nums">
                    {fmtNum(result.diagnosis.projected200UsersOptimizedReads)} vs{" "}
                    {fmtNum(result.diagnosis.projected200UsersFullReads)} reads
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-white border border-[#e0e0fa]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[#646987]">
                      CRUD Firestore ({result.userCount} Dok)
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                        result.includeCrudWriteTest
                          ? GRADE_STYLE[result.diagnosis.crudGrade]
                          : "bg-slate-50 text-slate-600 border-slate-200"
                      }`}
                    >
                      {result.includeCrudWriteTest
                        ? result.diagnosis.crudGrade
                        : "Dilewati"}
                    </span>
                  </div>
                  <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-[#181a2c]">
                    {result.includeCrudWriteTest
                      ? `${avgCrudOpsSec} ops/dtk`
                      : "Nonaktif"}
                  </div>
                  <p className="text-[11px] text-[#646987] mt-1 font-mono tabular-nums">
                    {result.includeCrudWriteTest
                      ? result.cleanupVerifiedZeroRemaining
                        ? "Cleanup terverifikasi: 0 sisa dokumen"
                        : `Peringatan: ${result.remainingBenchDocs} sisa dokumen`
                      : "Centang Uji CRUD untuk tes tulis/hapus"}
                  </p>
                </div>
              </div>

              {/* Main Benchmark Metrics Table */}
              <div className="bg-white border border-[#e0e0fa] rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#eceefd] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-[#181a2c]">
                      Rincian Latensi &amp; Throughput Semua Operasi
                    </h3>
                    <p className="text-[11px] text-[#646987]">
                      Diukur menggunakan high-resolution browser Performance timer (total durasi simulasi: {fmtMs(result.websiteHealth.totalBenchmarkMs)})
                    </p>
                  </div>
                  {result.websiteHealth.heapSupported && (
                    <span className="text-[11px] font-mono tabular-nums text-[#646987]">
                      JS Heap: {result.websiteHealth.heapBeforeMb} MB →{" "}
                      {result.websiteHealth.heapAfterMb} MB (
                      {(result.websiteHealth.heapPeakDeltaMb ?? 0) >= 0 ? "+" : ""}
                      {result.websiteHealth.heapPeakDeltaMb} MB)
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#f7f8ff] border-b border-[#e8e8fa] text-[11px] uppercase tracking-wide text-[#646987]">
                        <th className="py-2.5 px-4 font-semibold">Operasi</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Beban</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Total</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Avg</th>
                        <th className="py-2.5 px-3 font-semibold text-right">p50</th>
                        <th className="py-2.5 px-3 font-semibold text-right">p95</th>
                        <th className="py-2.5 px-3 font-semibold text-right">p99</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Throughput</th>
                        <th className="py-2.5 px-4 font-semibold text-right">Sukses</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#eff0fc]">
                      {result.operations.map((op) => {
                        const isHealthy = op.failCount === 0;
                        return (
                          <tr key={op.id} className="hover:bg-[#fafbff]">
                            <td className="py-2.5 px-4">
                              <div className="font-semibold text-[#181a2c]">
                                {op.label}
                              </div>
                              {op.note && (
                                <div className="text-[11px] text-[#646987]">
                                  {op.note}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                              {op.count} {op.unitLabel}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap">
                              {fmtMs(op.totalMs)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                              {fmtMs(op.avgMs)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                              {fmtMs(op.p50Ms)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-[#154be2] whitespace-nowrap">
                              {fmtMs(op.p95Ms)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                              {fmtMs(op.p99Ms)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                              {op.opsPerSec.toFixed(1)}/dtk
                            </td>
                            <td className="py-2.5 px-4 text-right whitespace-nowrap">
                              <span
                                className={`inline-block px-2 py-0.5 rounded border text-[11px] font-mono tabular-nums font-semibold ${
                                  isHealthy
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-rose-50 text-rose-700 border-rose-200"
                                }`}
                              >
                                {op.successCount}/{op.count}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Sync Efficiency & Role Hydration 2-column Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Database Sync Strategy Comparison */}
                <div className="bg-white border border-[#e0e0fa] rounded-xl p-4 space-y-3">
                  <div>
                    <h3 className="text-sm font-bold text-[#181a2c]">
                      Efisiensi Query Database (Cache vs Delta vs Cold Full)
                    </h3>
                    <p className="text-[11px] text-[#646987]">
                      Perbandingan waktu muat dan konsumsi Firestore read unit untuk 7 koleksi utama
                    </p>
                  </div>

                  <div className="space-y-3">
                    {result.syncStrategies.map((strat) => {
                      const pct = Math.max(
                        3,
                        Math.round((strat.durationMs / maxSyncMs) * 100),
                      );
                      const barColor =
                        strat.strategy === "cache"
                          ? "bg-emerald-500"
                          : strat.strategy === "delta"
                            ? "bg-[#154be2]"
                            : "bg-amber-500";
                      return (
                        <div key={strat.strategy} className="space-y-1">
                          <div className="flex items-center justify-between text-xs gap-2">
                            <span className="font-semibold text-[#181a2c]">
                              {strat.label}
                            </span>
                            <span className="font-mono tabular-nums text-[#181a2c] font-bold">
                              {fmtMs(strat.durationMs)} ·{" "}
                              {fmtNum(strat.docsReturned)} docs ·{" "}
                              {fmtNum(strat.estimatedServerReads)} reads
                            </span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-[#eef0fc] overflow-hidden">
                            <div
                              className={`h-full rounded-full ${barColor}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="text-[11px] text-[#646987]">
                            {strat.note}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Client Scope & KPI Hydration Breakdown by Role */}
                <div className="bg-white border border-[#e0e0fa] rounded-xl overflow-hidden flex flex-col">
                  <div className="px-4 py-3 border-b border-[#eceefd]">
                    <h3 className="text-sm font-bold text-[#181a2c]">
                      Hidrasi Sesi {result.userCount} User per Jabatan
                    </h3>
                    <p className="text-[11px] text-[#646987]">
                      Waktu CPU client untuk memetakan hierarki tim, partner, dan metrik POG per role
                    </p>
                  </div>
                  <div className="overflow-x-auto flex-1">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-[#f7f8ff] border-b border-[#e8e8fa] text-[11px] uppercase tracking-wide text-[#646987]">
                          <th className="py-2 px-3.5 font-semibold">Jabatan</th>
                          <th className="py-2 px-2.5 font-semibold text-right">Sesi</th>
                          <th className="py-2 px-2.5 font-semibold text-right">Partner</th>
                          <th className="py-2 px-2.5 font-semibold text-right">Logs</th>
                          <th className="py-2 px-2.5 font-semibold text-right">Avg</th>
                          <th className="py-2 px-3.5 font-semibold text-right">p95</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#eff0fc]">
                        {result.roleBreakdown.map((rb) => (
                          <tr key={rb.role}>
                            <td className="py-2 px-3.5 font-semibold text-[#181a2c]">
                              {rb.role}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums">
                              {rb.sessionCount}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums">
                              {rb.avgScopedPartners}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums">
                              {rb.avgScopedLogs}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums">
                              {rb.avgHydrationMs.toFixed(2)} ms
                            </td>
                            <td className="py-2 px-3.5 text-right font-mono tabular-nums font-semibold text-[#154be2]">
                              {rb.p95HydrationMs.toFixed(2)} ms
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Automated Engineering Verdict */}
              <div className="bg-white border border-[#e0e0fa] rounded-xl p-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[#181a2c]">
                    Kesimpulan Efisiensi Sistem (Berbasis Pengukuran Aktual)
                  </h3>
                  <div className="text-[11px] font-mono tabular-nums text-[#646987]">
                    Tercepat: {result.diagnosis.fastestOp.label} (p95{" "}
                    {fmtMs(result.diagnosis.fastestOp.p95Ms)}) · Terlama:{" "}
                    {result.diagnosis.slowestOp.label} (p95{" "}
                    {fmtMs(result.diagnosis.slowestOp.p95Ms)})
                  </div>
                </div>

                <ul className="space-y-1.5 text-xs text-[#2b3048] list-disc pl-5">
                  {result.diagnosis.findings.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>

                {result.errors.length > 0 && (
                  <div className="mt-2 p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px] space-y-1">
                    <div className="font-bold">
                      Catatan Error Saat Pengujian ({result.errors.length}):
                    </div>
                    {result.errors.map((e, idx) => (
                      <div key={idx} className="font-mono break-all">
                        • {e}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
