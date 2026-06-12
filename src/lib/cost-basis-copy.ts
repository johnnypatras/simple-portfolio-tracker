export const TYPE_GUIDANCE = {
  buy:        "Bought this asset. You'll say what paid for it — new money starts counting toward the S&P comparison; money from a tracked account just changes shape (S&P unchanged).",
  sell:       "Sold for cash — locks in your gain or loss. You'll say where the proceeds went: a tracked account keeps them counting; money that left the portfolio stops counting.",
  yield:      "Interest, staking, rewards, or an airdrop — units you earned, didn't pay for. Cost is 0, so it's all gain. Counts toward the S&P comparison at its value on the day you received it.",
  deposit:    "External money in (e.g. salary, savings). Counts as a contribution in the S&P comparison.",
  withdrawal: "Money leaving your tracked portfolio (spending). Counts as a withdrawal in the S&P comparison.",
  transfer:   "Move this asset between places you track — same asset, nothing bought or sold. The S&P comparison doesn't move.",
} as const;

export const COST_COPY = {
  amountOptionalHint:  "Leave blank to use the market value on that date.",
  // Position editors only: the quantity field there holds the NEW TOTAL, so the
  // cost must be pinned to the change. (Add modals and the transaction modal
  // keep amountOptionalHint — their quantity IS the transacted amount.)
  amountDeltaHint:     "For this change only — e.g. raising 100 → 110 means what you paid for the 10 (incl. fees). Leave blank to use the market value on that date.",
  amountUserSetHint:   "This is the real amount you paid (incl. fees) — used for your gain/loss and the S&P comparison, not the chart's value line.",
  fxDivergenceTooltip: "EUR and USD cost can differ slightly: each buy was converted at the exchange rate on its own date.",
  markAsYieldConfirm:  "Mark these as Yield? Their cost becomes 0 — pure gain. They keep counting toward the S&P comparison at their recorded value.",
  transferLegLocked:   "This is part of a transfer — edit it from the Transfer screen so both sides stay in sync.",
  splitChildLocked:    "This entry was split into dated parts. Unsplit it first to edit the original.",
  yieldHasNoCost:      "Yield entries have no cost — they're earned income. Unmark as yield first if you need to record a cost.",
  // Shown when "Transfer" is selected on a surface with no move-screen route
  // (e.g. the Accounts-page editor) — keeps it from being a dead end.
  transferUnavailableHere: "To move this asset between places you track, open it from its own page and choose Transfer.",
} as const;

/**
 * Verbatim copy for the C2a "money-flow" question on per-asset Buy/Sell.
 *
 * Buy asks "Paid with?" and Sell asks "Proceeds went to?". Answering
 * "tracked account" routes the submission through the transfer machinery
 * (S&P-neutral); answering "new money / left portfolio" keeps the plain
 * addTransaction path (S&P contribution/withdrawal). Every user-visible
 * string for the question lives here — the modal imports them, never inlines.
 */
export const MONEY_FLOW_COPY = {
  // ── Buy: "Paid with?" ──────────────────────────────────────
  buy: {
    question: "Paid with?",
    // External — new money entering the portfolio (S&P +contribution).
    externalLabel: "New money entering the portfolio",
    externalSub: "salary, savings from outside",
    /** Effect chip when the Amount field is blank. */
    externalChipBlank: "S&P +contribution",
    /** Effect chip prefix when an amount is present → `S&P +€X`. */
    externalChipPrefix: "S&P +",
    // Tracked — money from a cash account you already track (S&P unchanged).
    trackedLabel: "From a tracked account",
    trackedChip: "S&P unchanged",
  },
  // ── Sell: "Proceeds went to?" ──────────────────────────────
  sell: {
    question: "Proceeds went to?",
    // Tracked — proceeds land in a cash account you track (S&P unchanged).
    trackedLabel: "A tracked account",
    trackedChip: "S&P unchanged",
    // External — money left the portfolio (S&P −withdrawal).
    externalLabel: "Left the portfolio",
    externalSub: "spent / sent somewhere untracked",
    /** Effect chip when the Amount field is blank. */
    externalChipBlank: "S&P −withdrawal",
    /** Effect chip prefix when an amount is present → `S&P −€X`. */
    externalChipPrefix: "S&P −",
  },
  // ── Shared (both Buy and Sell) ─────────────────────────────
  /** Placeholder option in the tracked-account select. */
  accountPlaceholder: "Choose account…",
  /** Sub-text on the disabled tracked option when no cash accounts exist. */
  noAccounts: "No tracked cash accounts yet",
  /** Inline hint while tracked is selected but no account is chosen yet. */
  accountRequiredHint: "Pick the account so both sides stay in sync.",
  /** Tooltip on the (disabled) currency control when locked to the account currency. */
  currencyLockTooltip: "Amount is in the account's currency.",
  /**
   * Inline hint while tracked is selected and Amount is blank. `verb` is
   * "pays" for Buy and "receives" for Sell.
   */
  amountRequiredHint: (verb: "pays" | "receives") =>
    `Enter the amount — it's what the account ${verb}.`,
  /**
   * Overdraft guard message (Buy + tracked, amount > balance). `available` is
   * already formatted in the account currency; `account` is its display name.
   */
  overdraft: (available: string, account: string) =>
    `Only ${available} available in ${account}.`,
} as const;

/**
 * Verbatim copy for the "adjustment / off-book" concept — a record correction
 * that books NO benchmark flow (money that never actually moved). One home for
 * every surface that exposes it: the history Mark-as-adjustment confirm (#5),
 * the delete router's "never really here" option (#7/#22), and the editors'
 * correction path. Mirrors COST_COPY / MONEY_FLOW_COPY above — surfaces import
 * these strings, never inline their own wording.
 *
 * Builders take an already-formatted amount string (e.g. "+€2,400") so the
 * confirm can name the stakes.
 */
export const ADJUSTMENT_COPY = {
  /** Radio / checkbox label for "this is a correction, not a money event". */
  optionLabel: "Just cleaning up records — not a real money event",
  /** The consequence, stated where the choice is made. */
  consequence: "S&P comparison unchanged",
  /** Two-step confirm when flagging a counted row as off-book. */
  markConfirm: (amount: string) =>
    `Stop counting this ${amount} in the S&P comparison?`,
  /** Two-step confirm when restoring an off-book row to counted. */
  unmarkConfirm: (amount: string) =>
    `Count this ${amount} in the S&P comparison again?`,
  /** Reassurance under the confirm — the operation is lossless. */
  reversibleNote: "The benchmark line recalculates. Reversible anytime.",
} as const;

/**
 * Verbatim copy for the C3 editor intent question — the direction-aware
 * "Does this reflect real value?" step that position editors and the cash
 * modal show on every quantity/balance-changing save. Mirrors the other
 * copy blocks above: surfaces import these strings, never inline wording.
 * The cosmetic guard's title/reassurance come from ADJUSTMENT_COPY.
 * Note: yesTransferNudgeSub conditionally REPLACES yesIncreaseSub/yesDecreaseSub whenever the transfer nudge is visible.
 */
export const INTENT_COPY = {
  questionIncrease: "Does this reflect real value you gained?",
  questionDecrease: "Does this reflect real value?",
  questionCash: "Does this reflect real money moving?",
  yesIncreaseLabel: "Yes — real units I have",
  yesIncreaseSub: "bought, received, or found them",
  yesDecreaseLabel: "Yes — I sold or lost them",
  yesDecreaseSub: "opens Sell to record where it went",
  /** Shown as the Yes option's sub WHENEVER the transfer nudge is visible
   *  (verbatim mock §4 wording; reads correctly for both directions — the
   *  point is "independent of the transfer"). */
  yesTransferNudgeSub: "a new buy/yield, independent of the transfer",
  yesCashLabel: "Money came in / went out",
  yesCashSub: "deposit / withdrawal — moves the S&P",
  noLabel: "No — cosmetic number fix",
  noCashLabel: "Cosmetic fix (interest already logged, rounding…)",
  chipCounts: "counts",
  chipOffBook: "off-book",
  freeToggle: "These were free — interest, staking, airdrop, reward",
  yieldConsequence:
    "Cost €0 · counts toward the S&P at market value on the date received (all gain).", // EUR intentional — spec §8.11: consequence/guard lines always render in EUR.
  yieldDateLabel: "Date received",
  yieldDateHint: "defaults to today — backdate if it accrued earlier",
  cosmeticQuietNote: "Won't affect your S&P comparison.",
  cosmeticGuardBody:
    'If you sold or lost them, choose "real value" instead — else your benchmark shows a phantom gap.',
  cosmeticGuardReal: "← It's real value",
  cosmeticGuardProceed: "Yes, cosmetic",
  nudgeTitle: "↔ Last change here was a transfer",
  nudgeBody:
    "If you're correcting that transfer, edit it on the Transfer screen so both sides stay in sync. Otherwise this records a new trade.",
  nudgeButton: "Open Transfer screen",
  toastYield: "Yield recorded",
  toastCosmetic: "Saved as cosmetic fix — S&P comparison unchanged.",
} as const;
