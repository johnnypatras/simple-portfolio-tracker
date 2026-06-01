// Server-only module (no "use server"): this is an internal render-time helper,
// NOT a client-callable action. It must not be exposed as an RPC endpoint —
// it accepts a userId arg and is meant for server-side dedup only. Server-only
// is enforced by the createServerSupabaseClient import (uses next/headers).
import { cache } from "react";
import * as Sentry from "@sentry/nextjs";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fetchHistoricalPriceInputsFor,
  type HistoricalLot,
  type HistoricalPriceRow,
} from "@/lib/portfolio/historical-prices-augmentation";

/**
 * Request-cached wrapper around fetchHistoricalPriceInputsFor for the
 * authenticated-user (server-client / RLS) path. React cache() dedups the
 * call across getSnapshots + getHistoricalBenchmarkExtension within a single
 * render. Keyed on userId (string) — passing the supabase client object would
 * defeat cache() arg-identity dedup (a fresh client per call would never hit).
 *
 * Owns graceful degradation + single Sentry capture: never throws. On any
 * failure returns empty inputs so the chart degrades to literal snapshots.
 *
 * Admin / cross-user (share, comparison) callers must use the sibling
 * getHistoricalPriceInputsForOwner(ownerId) below — this wrapper is
 * server-client/current-user only.
 */
export const getHistoricalPriceInputs = cache(
  async (
    userId: string,
  ): Promise<{ lots: HistoricalLot[]; prices: HistoricalPriceRow[] }> => {
    try {
      const supabase = await createServerSupabaseClient();
      return await fetchHistoricalPriceInputsFor(supabase, userId);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "historical-inputs-cache.getHistoricalPriceInputs" },
      });
      return { lots: [], prices: [] };
    }
  },
);

/**
 * Admin-client variant of getHistoricalPriceInputs for the share / cross-user
 * (owner_id) path. React cache() dedups across getSharedPortfolio +
 * getHistoricalBenchmarkExtension within one share render. Keyed on ownerId
 * (string) — the admin client is a fresh object per call, so keying on it would
 * defeat dedup. Owns graceful degradation: never throws; on any failure returns
 * empty inputs so the share chart degrades to literal snapshots instead of
 * error-pinning the public link.
 *
 * SECURITY: callers MUST pass a server-validated ownerId (from a verified share
 * token). This wrapper does NOT validate the token — that's the caller's job
 * (shared-portfolio validates via validateShareToken before calling). The admin
 * client bypasses RLS by design for the share read, scoped by the ownerId arg.
 */
export const getHistoricalPriceInputsForOwner = cache(
  async (
    ownerId: string,
  ): Promise<{ lots: HistoricalLot[]; prices: HistoricalPriceRow[] }> => {
    try {
      const admin = createAdminClient();
      return await fetchHistoricalPriceInputsFor(admin, ownerId);
    } catch (err) {
      Sentry.captureException(err, {
        tags: {
          context: "historical-inputs-cache.getHistoricalPriceInputsForOwner",
        },
      });
      return { lots: [], prices: [] };
    }
  },
);
