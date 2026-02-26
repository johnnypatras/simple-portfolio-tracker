"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Database,
  FileText,
  Loader2,
  Upload,
  X,
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
import type { PortfolioBackup } from "@/lib/actions/export";
import { validateBackup, importFromJson } from "@/lib/actions/import";
import type { ImportResult } from "@/lib/actions/import";

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

// ─── Import preview helpers ─────────────────────────────

function countEntities(data: PortfolioBackup) {
  return [
    { label: "Institutions", count: data.institutions.length },
    { label: "Wallets", count: data.wallets.length },
    { label: "Brokers", count: data.brokers.length },
    { label: "Bank Accounts", count: data.bankAccounts.length },
    { label: "Crypto Assets", count: data.cryptoAssets.length },
    { label: "Crypto Positions", count: data.cryptoAssets.reduce((s, a) => s + a.positions.length, 0) },
    { label: "Stock Assets", count: data.stockAssets.length },
    { label: "Stock Positions", count: data.stockAssets.reduce((s, a) => s + a.positions.length, 0) },
    { label: "Exchange Deposits", count: data.exchangeDeposits.length },
    { label: "Broker Deposits", count: data.brokerDeposits.length },
    { label: "Trade Entries", count: data.tradeEntries.length },
    { label: "Snapshots", count: data.snapshots.length },
  ].filter((e) => e.count > 0);
}

type ImportStage = "idle" | "previewing" | "confirming" | "importing" | "done";

export function ImportExportSettings() {
  const [loadingJson, setLoadingJson] = useState(false);
  const [loadingCsv, setLoadingCsv] = useState<string | null>(null);

  // Import state
  const fileRef = useRef<HTMLInputElement>(null);
  const [importStage, setImportStage] = useState<ImportStage>("idle");
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [previewData, setPreviewData] = useState<PortfolioBackup | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

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

  // ── Import handlers ──────────────────────────────────

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset state
    setImportError(null);
    setImportResult(null);
    setImportMode("merge");

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const result = await validateBackup(json);

      if (!result.ok) {
        setImportError(result.error);
        return;
      }

      setPreviewData(result.preview);
      setImportStage("previewing");
    } catch {
      setImportError("Could not parse file — ensure it's a valid JSON backup");
    } finally {
      // Reset file input so the same file can be re-selected
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function handleCancelImport() {
    setImportStage("idle");
    setPreviewData(null);
    setImportResult(null);
    setImportError(null);
  }

  function handleImportClick() {
    if (!previewData) return;
    if (importMode === "replace") {
      setImportStage("confirming");
    } else {
      executeImport();
    }
  }

  async function executeImport() {
    if (!previewData) return;
    setImportStage("importing");
    setImportError(null);

    try {
      const result = await importFromJson(previewData, importMode);
      if (!result.ok) {
        setImportError(result.error);
        setImportStage("previewing");
        return;
      }
      setImportResult(result);
      setImportStage("done");
      toast.success("Import complete");
    } catch {
      setImportError("Import failed unexpectedly");
      setImportStage("previewing");
    }
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-zinc-400">
        Export your portfolio data as a full JSON backup or individual CSV files,
        or restore from a previous backup
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

      {/* ── Import ─────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
          <Upload className="w-4 h-4 text-zinc-500" />
          Import
        </h3>

        {/* Hidden file input */}
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* ── Idle: file picker ── */}
        {importStage === "idle" && (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-4">
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <p className="text-sm text-zinc-300">Restore from JSON Backup</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Upload a previously exported <code className="text-zinc-400">.json</code> backup
                  file to restore your portfolio data
                </p>
              </div>
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors shrink-0"
              >
                <Upload className="w-4 h-4" />
                Choose file
              </button>
            </div>
            {importError && (
              <p className="mt-3 text-xs text-red-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {importError}
              </p>
            )}
          </div>
        )}

        {/* ── Preview: show entity counts + mode selector ── */}
        {importStage === "previewing" && previewData && (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-zinc-200">Backup Preview</p>
              <button
                onClick={handleCancelImport}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs text-zinc-500">
              Exported {new Date(previewData.exportedAt).toLocaleDateString()} · Currency: {previewData.primaryCurrency}
            </div>

            {/* Entity counts grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {countEntities(previewData).map((e) => (
                <div
                  key={e.label}
                  className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/50 rounded-md"
                >
                  <span className="text-xs text-zinc-400">{e.label}</span>
                  <span className="text-xs font-medium text-zinc-200">{e.count}</span>
                </div>
              ))}
            </div>

            {/* Mode selector */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-zinc-400">Import Mode</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setImportMode("merge")}
                  className={`flex-1 px-3 py-2 text-xs rounded-md border transition-colors ${
                    importMode === "merge"
                      ? "bg-zinc-700 border-zinc-600 text-zinc-200"
                      : "bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:text-zinc-300"
                  }`}
                >
                  <span className="font-medium">Merge</span>
                  <span className="block text-zinc-500 mt-0.5">
                    Skip duplicates, add new data only
                  </span>
                </button>
                <button
                  onClick={() => setImportMode("replace")}
                  className={`flex-1 px-3 py-2 text-xs rounded-md border transition-colors ${
                    importMode === "replace"
                      ? "bg-red-950/50 border-red-800/50 text-red-300"
                      : "bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:text-zinc-300"
                  }`}
                >
                  <span className="font-medium">Replace</span>
                  <span className="block text-zinc-500 mt-0.5">
                    Delete all existing data first
                  </span>
                </button>
              </div>
            </div>

            {importMode === "replace" && (
              <div className="flex items-start gap-2 px-3 py-2 bg-red-950/30 border border-red-900/30 rounded-md">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <p className="text-xs text-red-300">
                  Replace mode will permanently delete all existing portfolio data before
                  importing. This cannot be undone.
                </p>
              </div>
            )}

            {importError && (
              <p className="text-xs text-red-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {importError}
              </p>
            )}

            <button
              onClick={handleImportClick}
              className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                importMode === "replace"
                  ? "bg-red-900/50 hover:bg-red-900/70 text-red-200 border border-red-800/50"
                  : "bg-emerald-900/50 hover:bg-emerald-900/70 text-emerald-200 border border-emerald-800/50"
              }`}
            >
              <Upload className="w-4 h-4" />
              {importMode === "replace" ? "Replace & Import" : "Merge Import"}
            </button>
          </div>
        )}

        {/* ── Confirm replace ── */}
        {importStage === "confirming" && (
          <div className="bg-zinc-900/50 border border-red-900/40 rounded-lg p-4 space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-400" />
              <p className="text-sm font-medium text-red-300">Are you sure?</p>
            </div>
            <p className="text-xs text-zinc-400">
              This will <span className="text-red-300 font-medium">permanently delete</span> all
              your existing portfolio data — assets, positions, wallets, brokers, bank accounts,
              deposits, trades, and snapshots — then replace it with the backup file.
              This action cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setImportStage("previewing")}
                className="flex-1 px-3 py-2 text-sm font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeImport}
                className="flex-1 px-3 py-2 text-sm font-medium text-red-200 bg-red-900/60 hover:bg-red-900/80 border border-red-800/50 rounded-lg transition-colors"
              >
                Yes, delete and replace
              </button>
            </div>
          </div>
        )}

        {/* ── Importing: spinner ── */}
        {importStage === "importing" && (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-6 flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 text-zinc-400 animate-spin" />
            <p className="text-sm text-zinc-400">Importing data…</p>
            <p className="text-xs text-zinc-600">This may take a moment</p>
          </div>
        )}

        {/* ── Done: results ── */}
        {importStage === "done" && importResult && (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-4 space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <p className="text-sm font-medium text-emerald-300">Import Complete</p>
            </div>

            {/* Imported counts */}
            <div>
              <p className="text-xs font-medium text-zinc-400 mb-2">Imported</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {Object.entries(importResult.counts)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => (
                    <div
                      key={k}
                      className="flex items-center justify-between px-2.5 py-1 bg-emerald-950/30 border border-emerald-900/20 rounded-md"
                    >
                      <span className="text-xs text-zinc-400">
                        {k.replace(/([A-Z])/g, " $1").trim()}
                      </span>
                      <span className="text-xs font-medium text-emerald-300">{v}</span>
                    </div>
                  ))}
              </div>
            </div>

            {/* Skipped counts */}
            {Object.values(importResult.skipped).some((v) => v > 0) && (
              <div>
                <p className="text-xs font-medium text-zinc-400 mb-2">Skipped (duplicates)</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {Object.entries(importResult.skipped)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => (
                      <div
                        key={k}
                        className="flex items-center justify-between px-2.5 py-1 bg-zinc-800/50 rounded-md"
                      >
                        <span className="text-xs text-zinc-500">
                          {k.replace(/([A-Z])/g, " $1").trim()}
                        </span>
                        <span className="text-xs text-zinc-400">{v}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <button
              onClick={handleCancelImport}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
