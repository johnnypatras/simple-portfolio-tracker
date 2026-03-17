"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CashAccount, CashAccountInput } from "@/lib/types";
import { logActivity, toUsdAndEur } from "@/lib/actions/activity-log";
import { validateAmount, validateCurrency, validateUUID } from "@/lib/validation";

// ─── Shared types ────────────────────────────────────────

export interface CashAccountOpts {
  isAdjustment?: boolean;
  transferGroupId?: string;
  effectiveDate?: string;
  fxRate?: number;
}

// ─── Cache invalidation paths ────────────────────────────

function revalidateCashPaths(): void {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard/accounts");
}

// ─── Reads ───────────────────────────────────────────────

export async function getCashAccounts(): Promise<CashAccount[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("cash_accounts")
    .select("*, institutions(name), wallets(name), brokers(name)")
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
    institution_name:
      (row.institutions as { name: string } | null)?.name ?? null,
    wallet_name: (row.wallets as { name: string } | null)?.name ?? null,
    broker_name: (row.brokers as { name: string } | null)?.name ?? null,
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
  return (data ?? []) as CashAccount[];
}

// ─── Label helper ────────────────────────────────────────

interface LabelNames {
  name: string | null;
  institutionName: string | null;
  walletName: string | null;
  brokerName: string | null;
  currency: string;
  balance: number;
}

function deriveLabel(names: LabelNames): string {
  const { name, institutionName, walletName, brokerName, currency, balance } =
    names;
  if (walletName) return `${balance} ${currency} on ${walletName}`;
  if (brokerName) return `${balance} ${currency} on ${brokerName}`;
  const acctName = name ?? "";
  const instName = institutionName ?? "Unknown";
  return acctName
    ? `${acctName} (${instName})`
    : `${balance} ${currency} at ${instName}`;
}

// ─── FX computation helpers ──────────────────────────────

type FxStatus = "complete" | "pending" | null;

interface FxResult {
  deltaUsd: number | null;
  deltaEur: number | null;
  deltaStatus: FxStatus;
  cashflowUsd: number | null;
  cashflowEur: number | null;
  cashflowAssetClass: string | null;
  cashflowStatus: FxStatus;
}

function emptyFx(): FxResult {
  return {
    deltaUsd: null,
    deltaEur: null,
    deltaStatus: null,
    cashflowUsd: null,
    cashflowEur: null,
    cashflowAssetClass: null,
    cashflowStatus: null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  action: string,
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
    return {
      cashflowUsd: round2(cf.usd),
      cashflowEur: round2(cf.eur),
      cashflowAssetClass: assetClass,
      cashflowStatus: "complete",
    };
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
  input: CashAccountInput,
  opts?: CashAccountOpts,
): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Validate
  validateCurrency(input.currency);
  validateAmount(input.balance, "Balance");
  if (input.institution_id) validateUUID(input.institution_id, "Institution ID");
  if (input.wallet_id) validateUUID(input.wallet_id, "Wallet ID");
  if (input.broker_id) validateUUID(input.broker_id, "Broker ID");

  // Normalize empty name to null
  const normalizedName = input.name?.trim() || null;

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
    balance: input.balance,
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
    created_at: opts?.effectiveDate,
  });

  revalidateCashPaths();
  return created!.id;
}

export async function updateCashAccount(
  id: string,
  input: CashAccountInput,
  opts?: CashAccountOpts,
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Validate
  validateUUID(id, "Cash account ID");
  validateCurrency(input.currency);
  validateAmount(input.balance, "Balance");
  if (input.institution_id) validateUUID(input.institution_id, "Institution ID");
  if (input.wallet_id) validateUUID(input.wallet_id, "Wallet ID");
  if (input.broker_id) validateUUID(input.broker_id, "Broker ID");

  // Normalize empty name to null
  const normalizedName = input.name?.trim() || null;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("cash_accounts")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("cash_accounts")
    .update({
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
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  // Capture after snapshot
  const { data: after } = await supabase
    .from("cash_accounts")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

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
    balance: input.balance,
  });

  // Compute FX on balance delta
  const beforeBal = (before?.balance as number) ?? 0;
  const afterBal = (after?.balance as number) ?? 0;
  const currency =
    (after?.currency as string) ?? (before?.currency as string) ?? "EUR";

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
    created_at: opts?.effectiveDate,
  });

  revalidateCashPaths();
}

export async function deleteCashAccount(
  id: string,
  opts?: CashAccountOpts,
): Promise<void> {
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

  const institutionName =
    (snapshot?.institutions as { name: string } | null)?.name ?? null;
  const walletName =
    (snapshot?.wallets as { name: string } | null)?.name ?? null;
  const brokerName =
    (snapshot?.brokers as { name: string } | null)?.name ?? null;

  const label = snapshot
    ? deriveLabel({
        name: snapshot.name,
        institutionName,
        walletName,
        brokerName,
        currency: snapshot.currency ?? "EUR",
        balance: snapshot.balance ?? 0,
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
    created_at: opts?.effectiveDate,
  });

  revalidateCashPaths();
}

// ─── Internal helpers ────────────────────────────────────

/**
 * Unified FX computation: routes to adjustment delta or cashflow based on opts.
 */
async function computeFx(
  action: string,
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
        .then(({ data }) => ({ name: (data as { name: string } | null)?.name ?? null })),
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
        .then(({ data }) => ({ name: (data as { name: string } | null)?.name ?? null })),
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
        .then(({ data }) => ({ name: (data as { name: string } | null)?.name ?? null })),
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
