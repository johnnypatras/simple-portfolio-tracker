// ─── Shared CSV utilities ────────────────────────────────

const FORMULA_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Escape a value for safe CSV inclusion (RFC 4180 + formula injection protection). */
export function escapeCsv(s: string | number | null | undefined): string {
  if (s == null) return "";
  let str = String(s);
  // Neutralize formula injection: leading =, +, -, @ interpreted as formulas by spreadsheets
  if (str.length > 0 && FORMULA_CHARS.has(str[0])) {
    str = "'" + str;
  }
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

/** Build a CSV string from headers + rows. */
export function toCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const lines = [headers.map(escapeCsv).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsv).join(","));
  }
  return lines.join("\n");
}
