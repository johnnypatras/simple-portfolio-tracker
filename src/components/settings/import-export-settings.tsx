"use client";

import { Upload, Download, FileSpreadsheet } from "lucide-react";

const planned = [
  {
    icon: Upload,
    title: "Import Positions",
    desc: "Import crypto and stock positions from CSV or JSON files",
  },
  {
    icon: Download,
    title: "Export Portfolio",
    desc: "Download a snapshot of your current portfolio as CSV",
  },
  {
    icon: FileSpreadsheet,
    title: "Import from Spreadsheet",
    desc: "Bulk-import from Excel-style spreadsheets (XLSX)",
  },
];

export function ImportExportSettings() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-400">
        Import and export your portfolio data
      </p>

      <div className="space-y-3 max-w-md">
        {planned.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.title}
              className="flex items-start gap-3 px-4 py-3 bg-zinc-900/50 border border-zinc-800/50 rounded-lg opacity-60"
            >
              <Icon className="w-5 h-5 text-zinc-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm text-zinc-300">{item.title}</p>
                <p className="text-xs text-zinc-500 mt-0.5">{item.desc}</p>
              </div>
              <span className="ml-auto text-xs text-zinc-600 bg-zinc-800 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">
                Coming soon
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
