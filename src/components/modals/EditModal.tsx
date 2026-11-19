import React, { useEffect, useState } from "react";
import { MONTH_KEYS } from "../../utils/constants";
import { safeParseFloat } from "../../utils/formatters";

const FISCAL_MONTH_KEYS = [
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

interface EditModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: any;
  onSave: (id: any, newQty: string, updatedFields?: any) => void;
  isSaving: boolean;
}

export const EditModal: React.FC<EditModalProps> = ({
  isOpen,
  onClose,
  item,
  onSave,
  isSaving,
}) => {
  const [stockIn, setStockIn] = useState("");
  const [stockOut, setStockOut] = useState("");

  const currentMonthIdx = new Date().getMonth();
  const currentMonthKey = MONTH_KEYS[currentMonthIdx];
  const fallbackPrevIdx = currentMonthIdx === 0 ? 11 : currentMonthIdx - 1;
  const fallbackPrevKey = MONTH_KEYS[fallbackPrevIdx];

  let prevMonthKey = fallbackPrevKey;
  let prevVal = 0;
  let foundPrior = false;

  if (item) {
    const curFiscalIdx = FISCAL_MONTH_KEYS.indexOf(currentMonthKey as any);
    for (let i = curFiscalIdx - 1; i >= 0; i--) {
      const mk = FISCAL_MONTH_KEYS[i];
      if (item[`has_${mk}`]) {
        prevMonthKey = mk;
        prevVal = safeParseFloat(item[mk]);
        foundPrior = true;
        break;
      }
    }
    if (!foundPrior && item[fallbackPrevKey] !== undefined) {
      prevVal = safeParseFloat(item[fallbackPrevKey]);
    }
  }

  useEffect(() => {
    if (item) {
      const curIn =
        item[`in_${currentMonthKey}`] !== undefined
          ? safeParseFloat(item[`in_${currentMonthKey}`])
          : 0;
      const curOut =
        item[`pog_${currentMonthKey}`] !== undefined
          ? safeParseFloat(item[`pog_${currentMonthKey}`])
          : 0;
      setStockIn(curIn > 0 ? String(curIn) : "");
      setStockOut(curOut > 0 ? String(curOut) : "");
    } else {
      setStockIn("");
      setStockOut("");
    }
  }, [item, currentMonthKey]);

  if (!isOpen) return null;

  const prevMonthLabel = prevMonthKey.toUpperCase();
  const isInvalidIn =
    stockIn.trim() !== "" && (isNaN(Number(stockIn)) || Number(stockIn) < 0);
  const isInvalidOut =
    stockOut.trim() !== "" && (isNaN(Number(stockOut)) || Number(stockOut) < 0);

  const stockInNum =
    stockIn.trim() === "" || isInvalidIn ? 0 : Number(stockIn) || 0;
  const stockOutNum =
    stockOut.trim() === "" || isInvalidOut ? 0 : Number(stockOut) || 0;

  const rawIdleOnly = prevVal - stockOutNum;
  const calculatedIdle = Math.max(0, Number(rawIdleOnly.toFixed(4)));
  const rawTotalStock = prevVal + stockInNum - stockOutNum;
  const isDeficit = rawTotalStock < 0;
  const calculatedTotalStock = Math.max(0, Number(rawTotalStock.toFixed(4)));

  const handleSaveClick = () => {
    if (isSaving || isInvalidIn || isInvalidOut || isDeficit) return;
    onSave(item.id, String(calculatedTotalStock), {
      [`in_${currentMonthKey}`]: stockInNum,
      [`pog_${currentMonthKey}`]: stockOutNum,
      [`idle_${currentMonthKey}`]: calculatedIdle,
      [`has_${currentMonthKey}`]: true,
      [`edited_${currentMonthKey}`]: true,
      [`upd_${currentMonthKey}`]: "sales",
    });
  };

  return (
    <div className="fixed inset-0 z-[110] bg-[#181a2c]/50 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-[380px] rounded-[24px] p-6 shadow-2xl border border-[#edecff] animate-in fade-in zoom-in-95 duration-200 my-auto">
        <div className="size-12 bg-[#edecff] rounded-full flex items-center justify-center text-primary mb-4">
          <span className="material-symbols-outlined text-[24px]">
            edit_note
          </span>
        </div>
        <h2 className="text-lg font-semibold text-[#181a2c] leading-tight mb-1">
          Edit Detail LOT & Stock
        </h2>
        <p className="text-[10px] text-[#8E94B7] font-semibold uppercase tracking-wider mb-5">
          Input Stock In & Stock Out untuk LOT ini
        </p>

        <div className="space-y-4 mb-6">
          <div className="p-4 bg-[#fbf8ff] border border-[#edecff] rounded-2xl space-y-3">
            <div className="flex justify-between items-center gap-2">
              <span className="text-[10px] text-[#8E94B7] font-bold uppercase tracking-wider">
                Hybrid / Varietas
              </span>
              <span
                className="text-xs font-bold text-primary text-right max-w-[180px] truncate"
                title={item?.hybrid}
              >
                {item?.hybrid}
              </span>
            </div>

            <div className="h-px bg-[#edecff]" />

            <div className="flex justify-between items-center">
              <span className="text-[10px] text-[#8E94B7] font-bold uppercase tracking-wider">
                Nomor Lot
              </span>
              <span className="text-xs font-mono font-bold text-[#181a2c]">
                {item?.lot}
              </span>
            </div>

            <div className="h-px bg-[#edecff]" />

            <div className="flex justify-between items-center">
              <span className="text-[10px] text-[#8E94B7] font-bold uppercase tracking-wider">
                Stok Sebelumnya ({prevMonthLabel})
              </span>
              <span className="text-xs font-bold text-slate-700">
                {prevVal} Kg
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] text-[#8E94B7] font-bold uppercase tracking-wider ml-1 block">
                Stock In (Kg)
              </label>
              <input
                type="number"
                min="0"
                step="any"
                value={stockIn}
                onChange={(e) => setStockIn(e.target.value)}
                placeholder="0"
                className="w-full h-11 bg-[#fbf8ff] border border-[#edecff] rounded-xl px-4 font-bold text-xs text-[#111] outline-none focus:border-primary transition-all"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-[#8E94B7] font-bold uppercase tracking-wider ml-1 block">
                Stock Out (Kg)
              </label>
              <input
                type="number"
                min="0"
                step="any"
                value={stockOut}
                onChange={(e) => setStockOut(e.target.value)}
                placeholder="0"
                className="w-full h-11 bg-[#fbf8ff] border border-[#edecff] rounded-xl px-4 font-bold text-xs text-[#111] outline-none focus:border-primary transition-all"
                autoFocus
              />
            </div>
          </div>

          <div
            className={`p-3.5 rounded-2xl border space-y-2.5 ${
              isDeficit
                ? "bg-red-50 border-red-200"
                : "bg-[#f4f2ff] border-[#dce2ff]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-[10px] text-[#8E94B7] font-bold uppercase tracking-wider block">
                  Idle
                </span>
                <span className="text-[10px] font-medium text-[#635b6e] block mt-0.5">
                  {prevVal} − {stockOutNum} Kg
                </span>
              </div>
              <span
                className={`text-sm font-extrabold shrink-0 ${
                  rawIdleOnly < 0 ? "text-amber-600" : "text-slate-700"
                }`}
              >
                {calculatedIdle} Kg
              </span>
            </div>

            <div className="h-px bg-[#dce2ff]" />

            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-[10px] text-[#8E94B7] font-bold uppercase tracking-wider block">
                  Total Stock
                </span>
                <span className="text-[10px] font-medium text-[#635b6e] block mt-0.5">
                  {prevVal} + {stockInNum} − {stockOutNum} Kg
                </span>
                {isDeficit && (
                  <span className="text-[10px] font-bold text-red-600 block mt-0.5">
                    Stock Out melebihi stok ({prevVal + stockInNum} Kg)
                  </span>
                )}
              </div>
              <span
                className={`text-base font-extrabold shrink-0 ${
                  isDeficit ? "text-red-600" : "text-primary"
                }`}
              >
                {calculatedTotalStock} Kg
              </span>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 text-[#635b6e] font-semibold text-xs uppercase tracking-wider hover:bg-[#f4f2ff] rounded-full transition-colors cursor-pointer"
          >
            Batal
          </button>
          <button
            onClick={handleSaveClick}
            disabled={isSaving || isInvalidIn || isInvalidOut || isDeficit}
            className={`flex-[2] py-3 rounded-full font-semibold text-xs uppercase tracking-wider transition-all ${
              isSaving || isInvalidIn || isInvalidOut || isDeficit
                ? "bg-[#e0e0fa] text-[#8E94B7] cursor-not-allowed"
                : "bg-gradient-to-r from-primary to-cyan-400 text-white shadow-[0_4px_12px_rgba(21,75,226,0.25)] active:scale-[0.98] cursor-pointer"
            }`}
          >
            {isSaving ? "Saving..." : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  );
};
