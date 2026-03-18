/**
 * Build a safe partial update payload for Supabase .update() calls.
 *
 * Strips keys where the value is `undefined` (meaning "not provided by caller").
 * Preserves `null` values (meaning "explicitly set to null").
 *
 * This prevents the silent FK-wipe bug where `input.field ?? null` treats
 * "not provided" and "explicitly null" the same way.
 *
 * Usage:
 *   const updates = partialUpdate({ name: "New", region: undefined, apy: null });
 *   // → { name: "New", apy: null }  (region omitted, apy explicitly null)
 */
export function partialUpdate<T extends Record<string, unknown>>(
  fields: T,
): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as Partial<T>;
}
