// ─── Shared CSV utilities ────────────────────────────────

/** Escape a value for safe CSV inclusion (RFC 4180). */
export function escapeCsv(s: string | number | null | undefined): string {
  if (s == null) return "";
  const str = String(s);
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

/** Build a CSV string from headers + rows. */
export function toCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsv).join(","));
  }
  return lines.join("\n");
}
