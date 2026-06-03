export const TYPE_GUIDANCE = {
  buy:        "Bought with new money you added. Moving cash you already track into this? Use Transfer instead — otherwise it double-counts against the S&P.",
  sell:       "Sold for cash. This locks in a gain or loss. If the cash stays in an account you track, record it as a Transfer.",
  yield:      "Interest, staking, rewards, or an airdrop — units you earned, didn't pay for. Counted as profit (cost 0); not a contribution to the S&P comparison.",
  deposit:    "External money in (e.g. salary, savings). Counts as a contribution in the S&P comparison.",
  withdrawal: "Money leaving your tracked portfolio (spending). Counts as a withdrawal in the S&P comparison.",
  transfer:   "Move value between accounts you already track (e.g. cash → crypto). Doesn't affect the S&P comparison — it's internal.",
} as const;

export const COST_COPY = {
  amountOptionalHint:  "Leave blank to use the market value on that date.",
  amountUserSetHint:   "This is the real amount you paid (incl. fees) — used for your gain/loss and the S&P comparison, not the chart's value line.",
  fxDivergenceTooltip: "EUR and USD cost can differ slightly: each buy was converted at the exchange rate on its own date.",
  markAsYieldConfirm:  "Mark these as Yield? They'll count as earned income (cost 0) and drop out of the S&P contributions.",
  transferLegLocked:   "This is part of a transfer — edit it from the Transfer screen so both sides stay in sync.",
  splitChildLocked:    "This entry was split into dated parts. Unsplit it first to edit the original.",
  yieldHasNoCost:      "Yield entries have no cost — they're earned income. Unmark as yield first if you need to record a cost.",
} as const;
