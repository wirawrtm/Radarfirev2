import React, { useEffect, useMemo, useState } from "react";
import { DEFAULT_ACCESS_RULES } from "../../utils/constants";
import { cleanForMatch } from "../../utils/formatters";
import { normalizePosition } from "../../utils/hierarchy";

interface AccessTabProps {
  allPositionsList: string[];
  accessRules: Record<string, Record<string, boolean>>;
  employees?: any[];
  toggleAccessRule: (position: string, page: string) => void;
  removeAccessRule: (position: string) => void;
  accessSaveSuccess: boolean;
  accessSaveError?: string | null;
  onClearAccessSaveError?: () => void;
  handleSaveAccessRules: (
    rulesOverride?: Record<string, Record<string, boolean>>,
  ) => Promise<void>;
  isSavingAccess: boolean;
}

const MENU_COLUMNS: Array<{
  key: string;
  label: string;
  icon: string;
  desc: string;
}> = [
  { key: "home", label: "Home", icon: "edit_note", desc: "Input Opname" },
  { key: "partner", label: "Partner", icon: "handshake", desc: "Data Partner & Tim" },
  { key: "stock", label: "Stock", icon: "donut_large", desc: "Stock Summary" },
  { key: "pog", label: "POG", icon: "trending_up", desc: "POG Tracking" },
  { key: "overview", label: "Overview", icon: "analytics", desc: "Analitik Utama" },
  { key: "temp", label: "Database", icon: "database", desc: "Manajemen Data" },
  {
    key: "access",
    label: "Access",
    icon: "admin_panel_settings",
    desc: "Kontrol Akses",
  },
];

function buildNormalizedRuleRow(
  pos: string,
  source?: Record<string, boolean>,
): Record<string, boolean> {
  const base = source || DEFAULT_ACCESS_RULES[pos];
  if (base) {
    return {
      home: !!base.home,
      partner: !!base.partner,
      stock: !!base.stock,
      pog: !!base.pog,
      overview: !!base.overview,
      temp: !!base.temp,
      access: !!base.access,
    };
  }
  const isBA = cleanForMatch(pos) === "businessanalyst";
  return {
    home: true,
    partner: true,
    stock: true,
    pog: true,
    overview: isBA,
    temp: isBA,
    access: isBA,
  };
}

function buildBaselineRules(
  positions: string[],
  rules: Record<string, Record<string, boolean>>,
): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  const seen = new Set<string>();

  const add = (pos: string, raw?: Record<string, boolean>) => {
    const trimmed = String(pos || "").trim();
    if (!trimmed) return;
    const clean = cleanForMatch(trimmed);
    if (seen.has(clean)) return;
    seen.add(clean);
    out[trimmed] = buildNormalizedRuleRow(trimmed, raw);
  };

  Object.entries(rules || {}).forEach(([pos, row]) => {
    if (pos !== "Sales Manager") add(pos, row);
  });
  positions.forEach((pos) => add(pos, rules?.[pos]));

  return out;
}

export default function AccessTab({
  allPositionsList,
  accessRules,
  employees = [],
  accessSaveSuccess,
  accessSaveError,
  onClearAccessSaveError,
  handleSaveAccessRules,
  isSavingAccess,
}: AccessTabProps) {
  const baselineRules = useMemo(
    () => buildBaselineRules(allPositionsList, accessRules),
    [allPositionsList, accessRules],
  );

  const [draftRules, setDraftRules] =
    useState<Record<string, Record<string, boolean>>>(baselineRules);
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRolePreset, setNewRolePreset] = useState<"field" | "full">("field");
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmDeletePos, setConfirmDeletePos] = useState<string | null>(null);

  useEffect(() => {
    setDraftRules(baselineRules);
  }, [baselineRules]);

  const isDirty = useMemo(() => {
    const baseKeys = Object.keys(baselineRules).sort();
    const draftKeys = Object.keys(draftRules).sort();
    if (baseKeys.length !== draftKeys.length) return true;
    for (let i = 0; i < baseKeys.length; i++) {
      const k = baseKeys[i];
      if (k !== draftKeys[i]) return true;
      const bRow = baselineRules[k] || {};
      const dRow = draftRules[k] || {};
      for (const col of MENU_COLUMNS) {
        if (!!bRow[col.key] !== !!dRow[col.key]) return true;
      }
    }
    return false;
  }, [baselineRules, draftRules]);

  const employeeCountByPosition = useMemo(() => {
    const counts: Record<string, number> = {};
    (employees || []).forEach((emp: any) => {
      const norm = normalizePosition(emp?.position || "");
      const clean = cleanForMatch(norm);
      if (clean && clean !== "unknown") {
        counts[clean] = (counts[clean] || 0) + 1;
      }
    });
    return counts;
  }, [employees]);

  const totalMappedEmployees = useMemo(() => {
    const draftCleanKeys = new Set(
      Object.keys(draftRules).map((k) => cleanForMatch(k)),
    );
    return (Object.entries(employeeCountByPosition) as Array<[string, number]>).reduce(
      (acc, [clean, cnt]) => {
        return draftCleanKeys.has(clean) ? acc + cnt : acc;
      },
      0,
    );
  }, [draftRules, employeeCountByPosition]);

  const displayedPositions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return Object.keys(draftRules).filter((pos) =>
      q ? pos.toLowerCase().includes(q) : true,
    );
  }, [draftRules, searchQuery]);

  const handleToggleCell = (position: string, page: string) => {
    setLocalError(null);
    onClearAccessSaveError?.();
    setDraftRules((prev) => {
      const row = buildNormalizedRuleRow(position, prev[position]);
      return {
        ...prev,
        [position]: {
          ...row,
          [page]: !row[page],
        },
      };
    });
  };

  const handleToggleAllForRow = (position: string) => {
    setLocalError(null);
    onClearAccessSaveError?.();
    setDraftRules((prev) => {
      const row = buildNormalizedRuleRow(position, prev[position]);
      const allActive = MENU_COLUMNS.every((c) => !!row[c.key]);
      const nextVal = !allActive;
      const updated: Record<string, boolean> = {};
      MENU_COLUMNS.forEach((c) => {
        updated[c.key] = nextVal;
      });
      return {
        ...prev,
        [position]: updated,
      };
    });
  };

  const handleAddPosition = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newRoleName.trim();
    if (!trimmed) {
      setLocalError("Nama posisi tidak boleh kosong.");
      return;
    }
    const cleanNew = cleanForMatch(trimmed);
    if (!cleanNew) {
      setLocalError("Nama posisi harus berisi huruf atau angka.");
      return;
    }
    const duplicate = Object.keys(draftRules).find(
      (p) => cleanForMatch(p) === cleanNew,
    );
    if (duplicate) {
      setLocalError(`Posisi "${duplicate}" sudah ada dalam daftar.`);
      return;
    }

    const row: Record<string, boolean> =
      newRolePreset === "full"
        ? {
            home: true,
            partner: true,
            stock: true,
            pog: true,
            overview: true,
            temp: true,
            access: true,
          }
        : {
            home: true,
            partner: true,
            stock: true,
            pog: true,
            overview: false,
            temp: false,
            access: false,
          };

    setDraftRules((prev) => ({
      ...prev,
      [trimmed]: row,
    }));
    setNewRoleName("");
    setIsAddOpen(false);
    setLocalError(null);
    onClearAccessSaveError?.();
  };

  const handleDeletePosition = (position: string) => {
    setLocalError(null);
    onClearAccessSaveError?.();
    setDraftRules((prev) => {
      const next = { ...prev };
      delete next[position];
      return next;
    });
    setConfirmDeletePos(null);
  };

  const handleResetToDefaults = () => {
    setLocalError(null);
    onClearAccessSaveError?.();
    setDraftRules((prev) => {
      const next: Record<string, Record<string, boolean>> = {};
      Object.entries(DEFAULT_ACCESS_RULES).forEach(([pos, perms]) => {
        next[pos] = { ...perms };
      });
      // Preserve any active employee positions not in DEFAULT_ACCESS_RULES
      Object.keys(prev).forEach((pos) => {
        const clean = cleanForMatch(pos);
        const alreadyHas = Object.keys(next).some(
          (k) => cleanForMatch(k) === clean,
        );
        if (!alreadyHas && (employeeCountByPosition[clean] || 0) > 0) {
          next[pos] = buildNormalizedRuleRow(pos);
        }
      });
      return next;
    });
  };

  const handleDiscardChanges = () => {
    setDraftRules(baselineRules);
    setConfirmDeletePos(null);
    setLocalError(null);
    onClearAccessSaveError?.();
  };

  const onSaveClick = async () => {
    setLocalError(null);
    onClearAccessSaveError?.();
    await handleSaveAccessRules(draftRules);
  };

  const activeError = localError || accessSaveError;

  return (
    <div className="animate-in fade-in slide-in-from-right-4 duration-300 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-1">
        <div>
          <h1 className="text-lg font-bold text-[#181a2c] tracking-tight">
            Kontrol Akses Menu
          </h1>
          <p className="text-[#8E94B7] text-[11px] font-semibold mt-0.5">
            Atur visibilitas dan hak akses halaman untuk setiap posisi jabatan
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleResetToDefaults}
            disabled={isSavingAccess}
            className="h-9 px-3.5 rounded-xl bg-white hover:bg-slate-50 text-[#434655] border border-[#e2e8f0] text-[11px] font-bold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[15px]">
              restart_alt
            </span>
            Reset Default
          </button>
          <button
            type="button"
            onClick={() => {
              setIsAddOpen((v) => !v);
              setLocalError(null);
            }}
            className="h-9 px-3.5 rounded-xl bg-[#154be2] hover:bg-[#154be2]/90 text-white text-[11px] font-bold inline-flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">
              {isAddOpen ? "close" : "add"}
            </span>
            {isAddOpen ? "Tutup Form" : "Tambah Posisi"}
          </button>
        </div>
      </div>

      {/* Ringkasan KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl p-4 border border-[#154be2]/10 shadow-sm flex items-center gap-3">
          <div className="size-10 rounded-xl bg-[#154be2]/10 text-[#154be2] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[20px]">
              badge
            </span>
          </div>
          <div>
            <p className="text-[10px] font-bold text-[#8E94B7] uppercase tracking-wider">
              Total Posisi
            </p>
            <p className="text-base font-extrabold text-[#181a2c]">
              {Object.keys(draftRules).length} Posisi
            </p>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-4 border border-[#154be2]/10 shadow-sm flex items-center gap-3">
          <div className="size-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[20px]">
              group
            </span>
          </div>
          <div>
            <p className="text-[10px] font-bold text-[#8E94B7] uppercase tracking-wider">
              Karyawan Terpetakan
            </p>
            <p className="text-base font-extrabold text-[#181a2c]">
              {totalMappedEmployees} Karyawan
            </p>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-4 border border-[#154be2]/10 shadow-sm flex items-center gap-3">
          <div
            className={`size-10 rounded-xl flex items-center justify-center shrink-0 ${
              isDirty
                ? "bg-amber-50 text-amber-600"
                : "bg-indigo-50 text-indigo-600"
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">
              {isDirty ? "edit_notifications" : "cloud_done"}
            </span>
          </div>
          <div>
            <p className="text-[10px] font-bold text-[#8E94B7] uppercase tracking-wider">
              Status Konfigurasi
            </p>
            <p
              className={`text-sm font-extrabold ${
                isDirty ? "text-amber-600" : "text-emerald-600"
              }`}
            >
              {isDirty ? "Belum Disimpan" : "Tersinkronisasi"}
            </p>
          </div>
        </div>
      </div>

      {/* Form Tambah Posisi */}
      {isAddOpen && (
        <form
          onSubmit={handleAddPosition}
          className="bg-white rounded-2xl p-4 border border-[#154be2]/20 shadow-sm flex flex-col md:flex-row items-stretch md:items-end gap-3 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="flex-1">
            <label className="block text-[10px] font-bold text-[#8E94B7] uppercase tracking-wider mb-1.5">
              Nama Posisi / Jabatan Baru
            </label>
            <input
              type="text"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              placeholder="Contoh: Regional Sales Manager"
              maxLength={80}
              className="w-full h-10 px-3.5 rounded-xl bg-[#fbfaff] border border-[#e2e8f0] text-xs font-semibold text-[#181a2c] focus:outline-none focus:border-[#154be2]"
            />
          </div>

          <div className="w-full md:w-56">
            <label className="block text-[10px] font-bold text-[#8E94B7] uppercase tracking-wider mb-1.5">
              Template Awal
            </label>
            <select
              value={newRolePreset}
              onChange={(e) =>
                setNewRolePreset(e.target.value as "field" | "full")
              }
              className="w-full h-10 px-3 rounded-xl bg-[#fbfaff] border border-[#e2e8f0] text-xs font-semibold text-[#181a2c] focus:outline-none focus:border-[#154be2] cursor-pointer"
            >
              <option value="field">Standar Tim Lapangan (4 Menu)</option>
              <option value="full">Akses Penuh (7 Menu)</option>
            </select>
          </div>

          <button
            type="submit"
            className="h-10 px-5 rounded-xl bg-[#154be2] hover:bg-[#154be2]/90 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
          >
            <span className="material-symbols-outlined text-[16px]">
              add_circle
            </span>
            Tambahkan
          </button>
        </form>
      )}

      {/* Alert Error / Unsaved */}
      {activeError && (
        <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-rose-600 text-[18px] shrink-0">
              error
            </span>
            <span className="font-semibold">{activeError}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setLocalError(null);
              onClearAccessSaveError?.();
            }}
            className="text-rose-600 hover:text-rose-800 font-bold px-2 py-0.5 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {isDirty && !activeError && (
        <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-amber-600 text-[18px] shrink-0">
              info
            </span>
            <span className="font-semibold">
              Ada perubahan hak akses yang belum disimpan ke database.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleDiscardChanges}
              disabled={isSavingAccess}
              className="px-3 py-1.5 rounded-lg bg-white border border-amber-300 text-amber-900 text-[11px] font-bold hover:bg-amber-100 cursor-pointer"
            >
              Batalkan
            </button>
            <button
              type="button"
              onClick={onSaveClick}
              disabled={isSavingAccess}
              className="px-3 py-1.5 rounded-lg bg-[#154be2] text-white text-[11px] font-bold hover:bg-[#154be2]/90 cursor-pointer"
            >
              {isSavingAccess ? "Menyimpan..." : "Simpan Sekarang"}
            </button>
          </div>
        </div>
      )}

      {/* Main Matrix Card */}
      <div className="bg-white rounded-[24px] shadow-[0_12px_32px_rgba(21,75,226,0.03)] border border-[#154be2]/10 overflow-hidden">
        <div className="p-5 sm:p-6 border-b border-[#f1f5f9] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-xl bg-[#154be2]/10 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[#154be2] text-[20px]">
                admin_panel_settings
              </span>
            </div>
            <div>
              <h3 className="text-sm font-bold text-[#181a2c]">
                Matriks Hak Akses Sistem
              </h3>
              <p className="text-[10.5px] font-semibold text-[#8E94B7] mt-0.5">
                Klik status pada setiap kolom untuk mengaktifkan atau menonaktifkan menu
              </p>
            </div>
          </div>

          <div className="relative w-full sm:w-64">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-[#8E94B7]">
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari posisi..."
              className="w-full h-9 pl-9 pr-3 rounded-xl bg-[#fbfaff] border border-[#e2e8f0] text-xs font-semibold text-[#181a2c] placeholder:text-[#8E94B7] focus:outline-none focus:border-[#154be2]"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[820px]">
            <thead>
              <tr className="bg-[#fbfaff]">
                <th className="sticky left-0 z-10 bg-[#fbfaff] px-5 py-3 text-[10px] font-bold text-[#8E94B7] uppercase tracking-wider border-b border-r border-[#f1f5f9] min-w-[210px]">
                  Posisi / Jabatan
                </th>
                {MENU_COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="px-3 py-3 text-center border-b border-[#f1f5f9]"
                    title={col.desc}
                  >
                    <div className="inline-flex flex-col items-center gap-0.5">
                      <span className="material-symbols-outlined text-[15px] text-[#154be2]">
                        {col.icon}
                      </span>
                      <span className="text-[10px] font-bold text-[#434655] uppercase tracking-wider">
                        {col.label}
                      </span>
                    </div>
                  </th>
                ))}
                <th className="px-4 py-3 text-[10px] font-bold text-[#8E94B7] uppercase tracking-wider border-b border-[#f1f5f9] text-right">
                  Aksi
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f5f9]">
              {displayedPositions.length === 0 ? (
                <tr>
                  <td
                    colSpan={MENU_COLUMNS.length + 2}
                    className="px-5 py-10 text-center text-xs font-semibold text-[#8E94B7]"
                  >
                    Tidak ada posisi yang sesuai dengan pencarian "{searchQuery}".
                  </td>
                </tr>
              ) : (
                displayedPositions.map((position) => {
                  const row = buildNormalizedRuleRow(
                    position,
                    draftRules[position],
                  );
                  const cleanPos = cleanForMatch(position);
                  const empCount = employeeCountByPosition[cleanPos] || 0;
                  const activeCount = MENU_COLUMNS.filter(
                    (c) => !!row[c.key],
                  ).length;
                  const isAdminRole = cleanPos === "businessanalyst";
                  const isConfirming = confirmDeletePos === position;

                  return (
                    <tr
                      key={position}
                      className="hover:bg-slate-50/70 transition-colors group"
                    >
                      <td className="sticky left-0 z-10 bg-white group-hover:bg-slate-50/70 px-5 py-3.5 border-r border-[#f1f5f9]">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs font-bold text-[#181a2c]">
                              {position}
                            </span>
                            {isAdminRole && (
                              <span className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#154be2]/10 text-[#154be2]">
                                Utama
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[10px] font-semibold text-[#8E94B7]">
                            <span>{empCount} karyawan</span>
                            <span>·</span>
                            <span
                              className={
                                activeCount === MENU_COLUMNS.length
                                  ? "text-emerald-600 font-bold"
                                  : "text-[#434655]"
                              }
                            >
                              {activeCount}/{MENU_COLUMNS.length} menu
                            </span>
                          </div>
                        </div>
                      </td>

                      {MENU_COLUMNS.map((col) => {
                        const isChecked = !!row[col.key];
                        return (
                          <td key={col.key} className="px-2.5 py-3.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleToggleCell(position, col.key)}
                              aria-label={`${position} - ${col.label}: ${isChecked ? "Aktif" : "Nonaktif"}`}
                              className={`inline-flex items-center justify-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full border transition-all cursor-pointer ${
                                isChecked
                                  ? "text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100"
                                  : "text-slate-400 bg-slate-50 border-slate-200 hover:bg-slate-100 hover:text-slate-600"
                              }`}
                            >
                              <span className="material-symbols-outlined text-[13px]">
                                {isChecked ? "check_circle" : "cancel"}
                              </span>
                              {isChecked ? "Ya" : "Tidak"}
                            </button>
                          </td>
                        );
                      })}

                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        {isConfirming ? (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleDeletePosition(position)}
                              className="px-2 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold cursor-pointer"
                            >
                              Hapus
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeletePos(null)}
                              className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-[#434655] text-[10px] font-bold cursor-pointer"
                            >
                              Batal
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleToggleAllForRow(position)}
                              title={
                                activeCount === MENU_COLUMNS.length
                                  ? "Nonaktifkan semua menu pada posisi ini"
                                  : "Aktifkan semua menu pada posisi ini"
                              }
                              className="text-[#154be2] hover:bg-[#154be2]/10 p-1.5 rounded-lg transition-colors cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[16px]">
                                {activeCount === MENU_COLUMNS.length
                                  ? "deselect"
                                  : "select_all"}
                              </span>
                            </button>
                            <button
                              type="button"
                              disabled={isAdminRole || empCount > 0}
                              onClick={() => setConfirmDeletePos(position)}
                              title={
                                isAdminRole
                                  ? "Posisi utama tidak dapat dihapus"
                                  : empCount > 0
                                    ? `Masih digunakan oleh ${empCount} karyawan`
                                    : "Hapus Posisi"
                              }
                              className={`p-1.5 rounded-lg transition-colors ${
                                isAdminRole || empCount > 0
                                  ? "text-slate-300 cursor-not-allowed"
                                  : "text-rose-500 hover:bg-rose-50 cursor-pointer"
                              }`}
                            >
                              <span className="material-symbols-outlined text-[16px]">
                                delete
                              </span>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Info & Save Action */}
        <div className="p-5 border-t border-[#f1f5f9] bg-[#fbfaff] flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex items-start gap-2.5 flex-1">
            <span className="material-symbols-outlined text-[#8E94B7] text-[18px] mt-0.5 shrink-0">
              info
            </span>
            <div className="text-[10.5px] font-semibold text-[#64748b] leading-relaxed">
              <span className="text-[#181a2c] font-bold uppercase tracking-wider block mb-0.5">
                Panduan Kontrol Akses
              </span>
              Pengaturan di atas langsung menentukan menu navigasi yang muncul
              ketika pengguna masuk atau beralih ke posisi terkait. Akun
              Administrator utama tetap memiliki akses ke halaman ini agar
              sistem tidak terkunci. Klik{" "}
              <strong className="text-[#154be2]">Simpan Hak Akses</strong> untuk
              menerapkan ke seluruh perangkat.
            </div>
          </div>

          <div className="flex items-center justify-end gap-2.5 w-full md:w-auto shrink-0">
            {accessSaveSuccess && (
              <div className="flex items-center gap-1.5 text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-xl text-xs font-bold animate-in fade-in slide-in-from-bottom-2">
                <span className="material-symbols-outlined text-[16px]">
                  check_circle
                </span>
                Tersimpan
              </div>
            )}
            {isDirty && (
              <button
                type="button"
                onClick={handleDiscardChanges}
                disabled={isSavingAccess}
                className="px-4 py-2.5 rounded-xl bg-white hover:bg-slate-50 border border-[#e2e8f0] text-[#434655] text-xs font-bold transition-colors cursor-pointer disabled:opacity-50"
              >
                Batalkan
              </button>
            )}
            <button
              type="button"
              onClick={onSaveClick}
              disabled={isSavingAccess}
              className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-[#154be2] hover:bg-[#154be2]/90 text-white px-6 py-2.5 rounded-xl text-xs font-bold transition-all shadow-sm disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSavingAccess ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <span className="material-symbols-outlined text-[18px]">
                  save
                </span>
              )}
              {isSavingAccess ? "Menyimpan..." : "Simpan Hak Akses"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
