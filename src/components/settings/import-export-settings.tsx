"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Download,
  Database,
  FileText,
  Loader2,
  Upload,
} from "lucide-react";
import {
  exportFullJson,
  exportCryptoCsv,
  exportStocksCsv,
  exportCashCsv,
  exportTradesCsv,
  exportSnapshotsCsv,
  exportActivityLogCsv,
} from "@/lib/actions/export";

// ─── Download helpers ───────────────────────────────────

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function datestamp() {
  return new Date().toISOString().split("T")[0];
}

// ─── CSV export items ───────────────────────────────────

const csvExports = [
  {
    id: "crypto",
    label: "Crypto Holdings",
    desc: "All crypto positions with wallet, quantity, and method",
    action: exportCryptoCsv,
  },
  {
    id: "stocks",
    label: "Equities",
    desc: "All stock and ETF positions with broker and quantity",
    action: exportStocksCsv,
  },
  {
    id: "cash",
    label: "Cash & Deposits",
    desc: "Bank accounts, exchange deposits, and broker deposits",
    action: exportCashCsv,
  },
  {
    id: "trades",
    label: "Trade Diary",
    desc: "All logged trades with dates, prices, and notes",
    action: exportTradesCsv,
  },
  {
    id: "snapshots",
    label: "Portfolio History",
    desc: "Daily portfolio value snapshots (USD & EUR)",
    action: exportSnapshotsCsv,
  },
  {
    id: "activity",
    label: "Activity Log",
    desc: "Full audit trail of all changes",
    action: exportActivityLogCsv,
  },
] as const;

// ─── Component ──────────────────────────────────────────

export function ImportExportSettings() {
  const [loadingJson, setLoadingJson] = useState(false);
  const [loadingCsv, setLoadingCsv] = useState<string | null>(null);

  async function handleJsonExport() {
    setLoadingJson(true);
    try {
      const data = await exportFullJson();
      const json = JSON.stringify(data, null, 2);
      downloadBlob(json, `portfolio-backup-${datestamp()}.json`, "application/json");
      toast.success("JSON backup downloaded");
    } catch {
      toast.error("Failed to export backup");
    } finally {
      setLoadingJson(false);
    }
  }

  async function handleCsvExport(id: string, label: string, action: () => Promise<string>) {
    setLoadingCsv(id);
    try {
      const csv = await action();
      downloadBlob(csv, `portfolio-${id}-${datestamp()}.csv`, "text/csv");
      toast.success(`${label} CSV downloaded`);
    } catch {
      toast.error(`Failed to export ${label}`);
    } finally {
      setLoadingCsv(null);
    }
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-zinc-400">
        Export your portfolio data as a full JSON backup or individual CSV files
      </p>

      {/* ── Full JSON Backup ─────────────────────────── */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
          <Database className="w-4 h-4 text-zinc-500" />
          Full Backup
        </h3>
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-4">
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <p className="text-sm text-zinc-300">
                JSON Backup
              </p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Complete portfolio export — all assets, positions, wallets, brokers,
                bank accounts, deposits, trades, and daily snapshots in a single file
              </p>
            </div>
            <button
              onClick={handleJsonExport}
              disabled={loadingJson}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {loadingJson ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {loadingJson ? "Exporting..." : "Download .json"}
            </button>
          </div>
        </div>
      </div>

      {/* ── CSV Exports ──────────────────────────────── */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
          <FileText className="w-4 h-4 text-zinc-500" />
          CSV Exports
        </h3>
        <div className="space-y-2">
          {csvExports.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-4 px-4 py-3 bg-zinc-900/50 border border-zinc-800/50 rounded-lg"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-300">{item.label}</p>
                <p className="text-xs text-zinc-500 mt-0.5 truncate">
                  {item.desc}
                </p>
              </div>
              <button
                onClick={() => handleCsvExport(item.id, item.label, item.action)}
                disabled={loadingCsv !== null}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/50 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {loadingCsv === item.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                .csv
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Import (coming soon) ─────────────────────── */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
          <Upload className="w-4 h-4 text-zinc-500" />
          Import
        </h3>
        <div className="flex items-start gap-3 px-4 py-3 bg-zinc-900/50 border border-zinc-800/50 rounded-lg opacity-60">
          <div className="flex-1">
            <p className="text-sm text-zinc-300">Import from JSON or CSV</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Restore a JSON backup or import positions from CSV files
            </p>
          </div>
          <span className="text-xs text-zinc-600 bg-zinc-800 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">
            Coming soon
          </span>
        </div>
      </div>
    </div>
  );
}
