"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionType, CashAccount, CashAccountCreateInput, CashAccountUpdateInput, CashAccountOpts } from "@/lib/types";
import { logActivity, toUsdAndEur } from "@/lib/actions/activity-log";
import { validateAmount, validateApy, validateCurrency, validateName, validateUUID } from "@/lib/validation";
import { partialUpdate } from "@/lib/partial-update";
import { round2 } from "@/lib/format";
import { type FxResult, emptyFx } from "@/lib/activity-fx";
import { captureAction } from "@/lib/actions/with-sentry";
import { pickJoinedName } from "@/lib/supabase/join-utils";

// CashAccountOpts is defined in @/lib/types — Turbopack strips re-exports
// from "use server" modules.

// ─── Cache invalidation paths ────────────────────────────

function revalidateCashPaths(): void {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard/accounts");
}

// ─── Reads ───────────────────────────────────────────────

export async function getCashAccounts(): Promise<CashAccount[]> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("cash_accounts")
    .select("*, institutions(name), wallets(name), brokers(name)")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    institution_id: row.institution_id,
    name: row.name,
    currency: row.currency,
    balance: row.balance,
    apy: row.apy,
    region: row.region,
    wallet_id: row.wallet_id,
    broker_id: row.broker_id,
    last_was_adjustment: row.last_was_adjustment ?? false,
    last_was_transfer: row.last_was_transfer ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    // Flattened display names from JOINs
    institution_name: pickJoinedName(row.institutions),
    wallet_name: pickJoinedName(row.wallets),
    broker_name: pickJoinedName(row.brokers),
  }));
}

/**
 * Find existing cash accounts matching institution + currency.
 * Accepts a pre-built supabase client (used by transfers and other server actions).
 */
export async function findExistingCash(
  supabase: SupabaseClient,
  userId: string,
  institutionId: string,
  currency: string,
): Promise<CashAccount[]> {
  const { data, error } = await supabase
    .from("cash_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("institution_id", institutionId)
    .eq("currency", currency)
    .is("deleted_at", null);

  if (error) throw new Error(error.message);
  return data ?? [];
}

// ─── Label helper ────────────────────────────────────────

interface LabelNames {
  name: string | null;
  institutionName: string | null;
  walletName: string | null;
  brokerName: string | null;
  currency: string;
}

function deriveLabel(names: LabelNames): string {
  const { name, institutionName, walletName, brokerName, currency } = names;
  // Consistent compact format: "Name (Institution)" for all origins
  const loc = walletName ?? brokerName ?? institutionName;
  if (name && loc) return `${name} (${loc})`;
  if (name) return name;
  if (loc) return `${currency} (${loc})`;
  return `${currency} cash`;
}

/**
 * Refresh entity_name on all activity_log entries for cash accounts matching a filter.
 * Called when an entity is renamed (institution, wallet, broker, or cash account itself).
 */
export async function refreshCashEntityNames(
  supabase: SupabaseClient,
  userId: string,
  filter: { institution_id?: string; wallet_id?: string; broker_id?: string; cash_id?: string },
): Promise<void> {
  return captureAction("cash-accounts.refreshCashEntityNames", async () => {
  let query = supabase
    .from("cash_accounts")
    .select("id, name, currency, institution_id, wallet_id, broker_id, institutions(name), wallets(name), brokers(name)")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (filter.cash_id) query = query.eq("id", filter.cash_id);
  else if (filter.wallet_id) query = query.eq("wallet_id", filter.wallet_id);
  else if (filter.broker_id) query = query.eq("broker_id", filter.broker_id);
  else if (filter.institution_id) query = query.eq("institution_id", filter.institution_id);
  else return;

  const { data: accounts, error: accountsErr } = await query;
  if (accountsErr) {
    console.error("[refreshCashEntityNames] Failed to fetch cash accounts:", accountsErr.message);
    return;
  }
  if (!accounts?.length) return;

  for (const ca of accounts) {
    const instName = pickJoinedName(ca.institutions);
    const walletName = pickJoinedName(ca.wallets);
    const brokerName = pickJoinedName(ca.brokers);
    const label = deriveLabel({ name: ca.name, institutionName: instName, walletName, brokerName, currency: ca.currency });
    const { error: updateErr } = await supabase
      .from("activity_log")
      .update({ entity_name: label })
      .eq("entity_id", ca.id)
      .eq("user_id", userId);
    if (updateErr) console.warn(`[refreshCashEntityNames] Failed to update entity_name for ${ca.id}:`, updateErr.message);
  }
  });
}

// ─── FX computation helpers ──────────────────────────────

// round2 imported from @/lib/format

/**
 * Compute adjustment deltas (portfolio correction — no real money moved).
 */
async function computeAdjustmentDelta(
  amount: number,
  currency: string,
  effectiveDate?: string,
): Promise<Pick<FxResult, "deltaUsd" | "deltaEur" | "deltaStatus">> {
  try {
    const converted = await toUsdAndEur(
      amount,
      currency,
      effectiveDate?.split("T")[0],
    );
    return {
      deltaUsd: round2(converted.usd),
      deltaEur: round2(converted.eur),
      deltaStatus: "complete",
    };
  } catch (err) {
    console.error(
      "[cash-accounts] FX delta failed, marked pending:",
      err instanceof Error ? err.message : err,
    );
    return { deltaUsd: null, deltaEur: null, deltaStatus: "pending" };
  }
}

/**
 * Compute cashflow for real money movements.
 */
async function computeCashflow(
  action: ActionType,
  beforeQty: number,
  afterQty: number,
  currency: string,
  fxRate?: number,
): Promise<
  Pick<
    FxResult,
    "cashflowUsd" | "cashflowEur" | "cashflowAssetClass" | "cashflowStatus"
  >
> {
  const { computeCashflowFromPrices, classifyAssetClass } = await import(
    "@/lib/cashflow"
  );
  const assetClass = classifyAssetClass("cash_account");

  if (fxRate) {
    const cf = computeCashflowFromPrices({
      action,
      beforeQty,
      afterQty,
      entityCurrency: currency,
      fxRate,
    });
    if (cf) {
      return {
        cashflowUsd: round2(cf.usd),
        cashflowEur: round2(cf.eur),
        cashflowAssetClass: assetClass,
        cashflowStatus: "complete",
      };
    }
    // Non-EUR/USD currency with fxRate but computeCashflowFromPrices can't handle it — fall through to FX API
  }

  // Fallback: use FX API
  try {
    const delta = afterQty - beforeQty;
    const converted = await toUsdAndEur(delta, currency);
    return {
      cashflowUsd: round2(converted.usd),
      cashflowEur: round2(converted.eur),
      cashflowAssetClass: assetClass,
      cashflowStatus: "complete",
    };
  } catch (err) {
    console.error(
      "[cash-accounts] FX cashflow failed, marked pending:",
      err instanceof Error ? err.message : err,
    );
    return {
      cashflowUsd: null,
      cashflowEur: null,
      cashflowAssetClass: assetClass,
      cashflowStatus: "pending",
    };
  }
}

// ─── Mutations ───────────────────────────────────────────

export async function createCashAccount(
  input: CashAccountCreateInput,
  opts?: CashAccountOpts,
): Promise<string> {
  return captureAction("cash-accounts.createCashAccount", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Validate
  validateCurrency(input.currency);
  validateAmount(input.balance, "Balance");
  if (input.apy != null) validateApy(input.apy, "APY");
  if (input.institution_id) validateUUID(input.institution_id, "Institution ID");
  if (input.wallet_id) validateUUID(input.wallet_id, "Wallet ID");
  if (input.broker_id) validateUUID(input.broker_id, "Broker ID");

  // A bank-origin cash account (not an exchange/broker deposit) MUST belong to
  // an institution. Without this guard, a context-free "Add Cash" creates an
  // orphan that renders as "Unknown Bank" and is invisible in the Accounts tab.
  // Defense-in-depth: the modal also requires a bank, but this blocks any
  // caller (API/import/bug) from persisting an institution-less bank account.
  if (!input.wallet_id && !input.broker_id && !input.institution_id) {
    throw new Error("A bank account must have a bank — please select or create one.");
  }

  // Ownership: the FK only checks an institution EXISTS globally, and RLS on
  // cash_accounts scopes the row's OWNER — neither stops a direct server-action
  // call from linking to ANOTHER user's institution_id (the bank picker is the
  // first path that lets a raw client-chosen id reach the insert). Verify with
  // an RLS-scoped read, mirroring the ownership checks in institutions.ts.
  if (input.institution_id) {
    const { data: ownsInstitution } = await supabase
      .from("institutions")
      .select("id")
      .eq("id", input.institution_id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!ownsInstitution) throw new Error("Institution not found");
  }

  // Normalize empty name to null
  const normalizedName = input.name?.trim() || null;
  if (normalizedName) validateName(normalizedName, 100, "Account name");

  const { data: created, error } = await supabase
    .from("cash_accounts")
    .insert({
      user_id: user.id,
      institution_id: input.institution_id ?? null,
      name: normalizedName,
      currency: input.currency,
      balance: input.balance,
      apy: input.apy ?? 0,
      region: input.region ?? null,
      wallet_id: input.wallet_id ?? null,
      broker_id: input.broker_id ?? null,
      last_was_adjustment: opts?.isAdjustment ?? false,
      last_was_transfer: opts?.transferGroupId != null,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  // Resolve display names for logging
  const names = await resolveDisplayNames(supabase, {
    institutionId: input.institution_id ?? null,
    walletId: input.wallet_id ?? null,
    brokerId: input.broker_id ?? null,
  });

  const label = deriveLabel({
    name: normalizedName,
    institutionName: names.institutionName,
    walletName: names.walletName,
    brokerName: names.brokerName,
    currency: input.currency,
  });

  // Compute FX
  const fx = created ? await computeFx(
    "created",
    0,
    created.balance ?? 0,
    created.currency ?? input.currency,
    opts,
  ) : emptyFx();

  await logActivity({
    action: "created",
    entity_type: "cash_account",
    entity_name: label,
    description: `Added cash account "${label}"`,
    entity_id: created?.id,
    entity_table: "cash_accounts",
    before_snapshot: null,
    after_snapshot: created,
    is_adjustment: opts?.isAdjustment,
    delta_usd: fx.deltaUsd,
    delta_eur: fx.deltaEur,
    delta_status: fx.deltaStatus,
    cashflow_amount_usd: fx.cashflowUsd,
    cashflow_amount_eur: fx.cashflowEur,
    cashflow_asset_class: fx.cashflowAssetClass,
    cashflow_status: fx.cashflowStatus,
    transfer_group_id: opts?.transferGroupId,
    effective_date: opts?.effectiveDate,
  });

  revalidateCashPaths();
  if (!created) throw new Error("Failed to create cash account");
  return created.id;
  });
}

export async function updateCashAccount(
  id: string,
  input: CashAccountUpdateInput,
  opts?: CashAccountOpts,
): Promise<void> {
  return captureAction("cash-accounts.updateCashAccount", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Validate. Every field is optional in CashAccountUpdateInput; gate each
  // validator so callers can do a partial update (e.g. just `{ apy: 5 }`)
  // without supplying currency/balance.
  validateUUID(id, "Cash account ID");
  if (input.currency !== undefined) validateCurrency(input.currency);
  if (input.balance !== undefined) validateAmount(input.balance, "Balance");
  if (input.apy != null) validateApy(input.apy, "APY");
  if (input.institution_id) validateUUID(input.institution_id, "Institution ID");
  if (input.wallet_id) validateUUID(input.wallet_id, "Wallet ID");
  if (input.broker_id) validateUUID(input.broker_id, "Broker ID");

  // Ownership check when (re)assigning an institution — e.g. the orphan-fix
  // edit path. Mirrors createCashAccount; see the rationale there.
  if (input.institution_id) {
    const { data: ownsInstitution } = await supabase
      .from("institutions")
      .select("id")
      .eq("id", input.institution_id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!ownsInstitution) throw new Error("Institution not found");
  }

  // Normalize inputs once; partialUpdate() strips `undefined` keys so that
  // "not provided" is distinguished from "explicitly null". A caller that
  // omits a field (e.g. a transfer destination passing only currency+balance)
  // must NOT clobber other columns.
  let normalizedName: string | null | undefined;
  if (input.name !== undefined) {
    normalizedName = input.name?.trim() || null;
    if (normalizedName) validateName(normalizedName, 100, "Account name");
  }

  // Build the value-field payload separately from the badge flags. If the
  // caller passed no real fields, this update is a no-op — return early to
  // avoid:
  //   - issuing a SQL UPDATE that only writes badge flags (which would
  //     silently clear `last_was_transfer` for a row that genuinely is the
  //     last-was-transfer state)
  //   - writing a meaningless activity_log entry for a no-op
  //   - paying for round-trips and FX computation with nothing to record
  // Badge flags are layered on AFTER this check so they only fire on real
  // updates — they're metadata about the operation, not about the row.
  const valuePayload = partialUpdate({
    name: normalizedName,
    currency: input.currency,
    balance: input.balance,
    apy: input.apy,
    institution_id: input.institution_id,
    region: input.region,
    wallet_id: input.wallet_id,
    broker_id: input.broker_id,
  });
  if (Object.keys(valuePayload).length === 0) return;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("cash_accounts")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("cash_accounts")
    .update({
      ...valuePayload,
      last_was_adjustment: opts?.isAdjustment ?? false,
      last_was_transfer: opts?.transferGroupId != null,
    })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  // Capture after snapshot
  const { data: after } = await supabase
    .from("cash_accounts")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  // Resolve display names for logging. When the caller didn't pass an FK
  // (institution/wallet/broker), fall back to the post-update row so the
  // label reflects actual stored state rather than the (possibly partial)
  // input shape.
  const names = await resolveDisplayNames(supabase, {
    institutionId: (input.institution_id ?? (after?.institution_id as string | null) ?? null),
    walletId: (input.wallet_id ?? (after?.wallet_id as string | null) ?? null),
    brokerId: (input.broker_id ?? (after?.broker_id as string | null) ?? null),
  });

  // Use the post-update name; when caller didn't pass `name`, this preserves
  // the existing value rather than rendering the row as nameless.
  const label = deriveLabel({
    name: (after?.name as string | null | undefined) ?? null,
    institutionName: names.institutionName,
    walletName: names.walletName,
    brokerName: names.brokerName,
    // Read currency from the post-update row — `input.currency` may be
    // `undefined` under the partial-update contract.
    currency: String(after?.currency ?? before?.currency ?? "EUR"),
  });

  // Compute FX on balance delta
  const beforeBal = Number(before?.balance ?? 0);
  const afterBal = Number(after?.balance ?? 0);
  const currency =
    String(after?.currency ?? before?.currency ?? "EUR");

  const fx = await computeFx("updated", beforeBal, afterBal, currency, opts);

  await logActivity({
    action: "updated",
    entity_type: "cash_account",
    entity_name: label,
    description: `Updated cash account "${label}"`,
    entity_id: id,
    entity_table: "cash_accounts",
    before_snapshot: before,
    after_snapshot: after,
    is_adjustment: opts?.isAdjustment,
    delta_usd: fx.deltaUsd,
    delta_eur: fx.deltaEur,
    delta_status: fx.deltaStatus,
    cashflow_amount_usd: fx.cashflowUsd,
    cashflow_amount_eur: fx.cashflowEur,
    cashflow_asset_class: fx.cashflowAssetClass,
    cashflow_status: fx.cashflowStatus,
    transfer_group_id: opts?.transferGroupId,
    effective_date: opts?.effectiveDate,
  });

  // If name actually changed in the DB row, refresh entity_name on ALL
  // activity_log entries for this account. Comparing `before.name` to
  // `after.name` (post-update DB state) is correct under the partial-update
  // contract — using `normalizedName` (which is `undefined` when the caller
  // didn't pass `name`) would falsely report a change for any named account.
  if (before?.name !== after?.name) {
    await refreshCashEntityNames(supabase, user.id, { cash_id: id });
  }

  revalidateCashPaths();
  });
}

export async function deleteCashAccount(
  id: string,
  opts?: CashAccountOpts,
): Promise<void> {
  return captureAction("cash-accounts.deleteCashAccount", async () => {
  validateUUID(id, "Cash account ID");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Capture full snapshot before soft-delete (with joined names)
  const { data: snapshot } = await supabase
    .from("cash_accounts")
    .select("*, institutions(name), wallets(name), brokers(name)")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("cash_accounts")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  const institutionName = pickJoinedName(snapshot?.institutions);
  const walletName = pickJoinedName(snapshot?.wallets);
  const brokerName = pickJoinedName(snapshot?.brokers);

  const label = snapshot
    ? deriveLabel({
        name: snapshot.name,
        institutionName,
        walletName,
        brokerName,
        currency: snapshot.currency ?? "EUR",
      })
    : "Unknown";

  // Compute FX for the full balance being removed
  const fx = snapshot
    ? await computeFx(
        "removed",
        snapshot.balance ?? 0,
        0,
        snapshot.currency ?? "EUR",
        opts,
      )
    : emptyFx();

  // Strip joined relations from snapshot before logging (they cause DB insert issues)
  const cleanSnapshot = snapshot
    ? (() => {
        const { institutions, wallets, brokers, ...rest } = snapshot as Record<
          string,
          unknown
        >;
        // Suppress unused variable warnings
        void institutions;
        void wallets;
        void brokers;
        return rest;
      })()
    : null;

  await logActivity({
    action: "removed",
    entity_type: "cash_account",
    entity_name: label,
    description: `Removed cash account "${label}"`,
    entity_id: id,
    entity_table: "cash_accounts",
    before_snapshot: cleanSnapshot,
    after_snapshot: null,
    is_adjustment: opts?.isAdjustment,
    delta_usd: fx.deltaUsd,
    delta_eur: fx.deltaEur,
    delta_status: fx.deltaStatus,
    cashflow_amount_usd: fx.cashflowUsd,
    cashflow_amount_eur: fx.cashflowEur,
    cashflow_asset_class: fx.cashflowAssetClass,
    cashflow_status: fx.cashflowStatus,
    transfer_group_id: opts?.transferGroupId,
    effective_date: opts?.effectiveDate,
  });

  revalidateCashPaths();
  });
}

// ─── Merge duplicates ────────────────────────────────────

/**
 * Merge two cash accounts at the same institution + currency.
 * Adds the duplicate's balance to the survivor, then soft-deletes the duplicate.
 * Both operations are logged as adjustments (no real money moved).
 */
export async function mergeCashAccounts(
  survivorId: string,
  duplicateId: string,
): Promise<void> {
  return captureAction("cash-accounts.mergeCashAccounts", async () => {
  validateUUID(survivorId, "Survivor account ID");
  validateUUID(duplicateId, "Duplicate account ID");
  if (survivorId === duplicateId) {
    throw new Error("Cannot merge a cash account with itself");
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Fetch both accounts
  const { data: survivor } = await supabase
    .from("cash_accounts")
    .select("*")
    .eq("id", survivorId)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { data: duplicate } = await supabase
    .from("cash_accounts")
    .select("*")
    .eq("id", duplicateId)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  if (!survivor || !duplicate) {
    throw new Error("One or both cash accounts not found");
  }

  // Verify same institution + currency
  if (survivor.institution_id !== duplicate.institution_id) {
    throw new Error("Cash accounts must be at the same institution");
  }
  if (survivor.currency !== duplicate.currency) {
    throw new Error("Cash accounts must have the same currency");
  }

  // Merge: add duplicate balance to survivor.
  // `balance` and `apy` are NOT NULL in the schema (migration 014), so the
  // CashAccount type's `number` reflects truth — no `?? 0` defaults needed.
  const newBalance = survivor.balance + duplicate.balance;

  await updateCashAccount(survivorId, {
    currency: survivor.currency,
    balance: newBalance,
    institution_id: survivor.institution_id ?? undefined,
    name: survivor.name,
    apy: survivor.apy,
    region: survivor.region,
    wallet_id: survivor.wallet_id,
    broker_id: survivor.broker_id,
  }, { isAdjustment: true });

  // Soft-delete the duplicate
  await deleteCashAccount(duplicateId, { isAdjustment: true });
  });
}

// ─── Internal helpers ────────────────────────────────────

/**
 * Unified FX computation: routes to adjustment delta or cashflow based on opts.
 */
async function computeFx(
  action: ActionType,
  beforeBal: number,
  afterBal: number,
  currency: string,
  opts?: CashAccountOpts,
): Promise<FxResult> {
  const fx = emptyFx();

  if (opts?.isAdjustment) {
    const delta = await computeAdjustmentDelta(
      afterBal - beforeBal,
      currency,
      opts.effectiveDate,
    );
    fx.deltaUsd = delta.deltaUsd;
    fx.deltaEur = delta.deltaEur;
    fx.deltaStatus = delta.deltaStatus;
  } else {
    const cf = await computeCashflow(
      action,
      beforeBal,
      afterBal,
      currency,
      opts?.fxRate,
    );
    fx.cashflowUsd = cf.cashflowUsd;
    fx.cashflowEur = cf.cashflowEur;
    fx.cashflowAssetClass = cf.cashflowAssetClass;
    fx.cashflowStatus = cf.cashflowStatus;
  }

  return fx;
}

/**
 * Resolve display names for institution/wallet/broker by ID.
 */
async function resolveDisplayNames(
  supabase: SupabaseClient,
  ids: {
    institutionId: string | null;
    walletId: string | null;
    brokerId: string | null;
  },
): Promise<{
  institutionName: string | null;
  walletName: string | null;
  brokerName: string | null;
}> {
  const queries: PromiseLike<{ name: string | null }>[] = [];

  // Institution name
  if (ids.institutionId) {
    queries.push(
      supabase
        .from("institutions")
        .select("name")
        .eq("id", ids.institutionId)
        .single()
        .then(({ data }) => ({ name: pickJoinedName(data) })),
    );
  } else {
    queries.push(Promise.resolve({ name: null }));
  }

  // Wallet name
  if (ids.walletId) {
    queries.push(
      supabase
        .from("wallets")
        .select("name")
        .eq("id", ids.walletId)
        .single()
        .then(({ data }) => ({ name: pickJoinedName(data) })),
    );
  } else {
    queries.push(Promise.resolve({ name: null }));
  }

  // Broker name
  if (ids.brokerId) {
    queries.push(
      supabase
        .from("brokers")
        .select("name")
        .eq("id", ids.brokerId)
        .single()
        .then(({ data }) => ({ name: pickJoinedName(data) })),
    );
  } else {
    queries.push(Promise.resolve({ name: null }));
  }

  const [inst, wallet, broker] = await Promise.all(queries);
  return {
    institutionName: inst.name,
    walletName: wallet.name,
    brokerName: broker.name,
  };
}
