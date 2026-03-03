# Global Search Command Palette — Design

**Date:** 2026-03-03
**Status:** Approved

## Overview

A Cmd+K command palette that provides instant search across portfolio holdings,
page navigation, app actions, and external asset discovery (CoinGecko/Yahoo).
Available on all dashboard and share pages.

## Trigger & Placement

- **Keyboard:** `Cmd+K` (Mac) / `Ctrl+K` (Windows/Linux)
- **UI:** Search pill next to CurrencyToggle (top-right corner) for discoverability
- **Placement:** Centered overlay modal (Spotlight-style) via React portal
- **Scope:** All `/dashboard/*` and `/share/[token]/*` pages
- **Dismiss:** `Escape`, click outside, or selecting a result

## Result Groups

Four groups, rendered in order. Share pages only see groups 1-2.

| # | Group | Source | Latency | Share pages? |
|---|-------|--------|---------|-------------|
| 1 | **Your Holdings** | Client-side filter of portfolio props | Instant | Yes |
| 2 | **Pages** | Static route list | Instant | Yes (share routes) |
| 3 | **Actions** | Static action list | Instant | No |
| 4 | **Add New Asset** | `/api/crypto/search` + `/api/stocks/search` | 500ms debounce | No |

### Your Holdings

Shows all portfolio assets (crypto, stocks, bank accounts, deposits) matching
the query by name or ticker. Each result displays: icon, name, ticker, value in
primary currency, 24h change. Selecting navigates to the detail page.

### Pages

Static list: Dashboard, Crypto, Equities, Banks & Deposits, Accounts, History,
Diary, Settings. Matched by name and aliases (e.g., "stocks" matches Equities).

### Actions

Static list: Add Crypto Asset, Add Stock/ETF, Record Buy (Crypto), Record Buy
(Stock), Transfer, Export Data. Selecting opens the relevant modal or navigates
to the action.

### Add New Asset (External)

Lazy-loaded after 500ms debounce, minimum 3 chars. Queries CoinGecko search +
Yahoo Finance search in parallel. Results show: icon, name, ticker, price.
Selecting opens the existing Add Crypto/Stock modal pre-filled with the asset.

## Architecture

### New Files

```
src/components/ui/command-palette.tsx           — Main palette component (cmdk)
src/components/ui/command-palette-provider.tsx   — Context + Cmd+K listener
src/components/ui/search-pill.tsx               — Visible trigger next to CurrencyToggle
```

### Dependencies

- `cmdk` (~3KB) — keyboard nav, focus trapping, accessibility, scroll management

### Data Flow

1. **Dashboard layout** fetches portfolio data (already does this)
2. **Provider** wraps layout, receives portfolio data as props
3. **Palette** reads data from provider context
4. Local groups: `useMemo` filter on portfolio data (instant)
5. External group: `fetch` to existing API routes (debounced)

### Share Page Scoping

Provider receives `isReadOnly` from `useSharedView()`. When true:
- Actions group hidden
- External search group hidden
- Page navigation scoped to share routes only

## Keyboard Navigation

- `↑` / `↓` — move selection (cmdk handles this)
- `Enter` — execute selected item
- `Escape` — close palette
- Type to filter — instant local, 500ms debounced external

## Visual Design

- **Theme-aware:** Uses Tailwind tokens, respects current theme automatically
- **Colors:** `bg-zinc-900` modal, `border-zinc-800`, `text-zinc-100` results,
  `bg-zinc-800` hover, blue accent on selected item
- **Group headers:** `text-xs text-zinc-500 uppercase tracking-wider`
- **Input:** Search icon + text input + `⌘K` badge
- **Dimensions:** max-width 640px, max-height 400px, centered with slight
  upward offset
- **Overlay:** `bg-black/50` backdrop with `backdrop-blur-sm`

## Rate Limit Considerations

External search shares the existing rate limit budget:
- CoinGecko: 30 calls/min (search route)
- Yahoo: no hard limit, but 30/min enforced server-side
- 500ms debounce + 3-char minimum prevents excessive calls
- Typical session: 5-10 external searches, well within budget

## What This Does NOT Include

- Recent/frequent items (can add later)
- Fuzzy matching beyond substring (cmdk supports this if needed)
- Inline asset preview/details (keep it fast and simple)
- Quick-add without modal (reuse existing Add modals instead)
