# Portfolio Tracker — Roadmap

## Completed Phases

### Phase 1 — Core Schema & Seed Data ✅
Database schema for crypto holdings, wallets, and price tracking with Supabase.

### Phase 2 — Live Prices & Portfolio Value ✅
Real-time BTC/ETH prices, FX rates, portfolio valuation in user's primary currency.

### Phase 3 — Dashboard UI ✅
Main dashboard with summary cards, crypto holdings table, allocation breakdown.

### Phase 4 — Cash & Bank Accounts ✅
Bank account tracking, exchange fiat deposits, cash section in dashboard.

### Phase 5 — Stock / ETF Tracking ✅
Stock asset definitions, broker-based positions, stock table with position editor.

### Phase 6 — Settings & Configuration ✅
Settings page for managing wallets, brokers, primary currency, user preferences.

### Phase 7 — Configurable Columns & Grouping ✅
Column visibility/reordering system, bank accounts grouped by bank name with expand/collapse, exchange deposits grouped by wallet.

### Mobile UI Polish ✅
Responsive sidebar, card layouts for small screens, modal overflow fixes, subtle hamburger button, LAN dev origin config.

### Phase 8 — Trade Diary ✅
Structured trade log for recording significant buys and sells.
- `trade_entries` table: date, asset type/name, buy/sell, quantity, price, currency, notes
- CRUD server actions, desktop table + mobile card layouts
- Add/edit modal with live total preview, buy/sell toggle
- Asset type badges (crypto/stock/cash/other) and action badges (buy/sell)

### Phase 9 — Activity History / Audit Trail ✅
Track all portfolio changes for accountability and review.
- `activity_log` table with entity_type enum, action logging across all 23 mutations
- Filterable timeline by entity type and action (created/updated/removed)
- Date-grouped entries with colored action badges
- CSV export, pagination, empty states

### Phase 10 — Performance Analytics & Charts ✅
Portfolio performance tracking with benchmarks and visualizations.
- Snapshot-based portfolio value line chart with period selectors (24h, 3d, 7d, 30d, 90d, 1y, all)
- Cash-flow-adjusted S&P 500 Total Return benchmark for fair comparison
- Asset allocation breakdown (crypto/stocks/cash) synced to period toggles
- Market indices dashboard (S&P 500, Gold, Nasdaq, Dow Jones, EUR/USD)
- Dividend yield tracking and weighted APY indicators

### Phase 11 — Crypto & Stock Enhancements ✅
Multi-chain wallets, asset classification, and yield tracking.
- Multi-chain wallet support with toggleable chain chips and EVM group preset
- Crypto subcategory field (staking, defi, bridge, etc.) with auto-detection
- Chain/subcategory columns with group-by-chain mode, custody column
- Crypto asset icons from CoinGecko
- Stock taxonomy with subcategories (index, growth, value, dividend, etc.)
- Per-position APY tracking for staking/lending yields
- Two-phase crypto modal flow (asset selection then quantity entry)

### Phase 12 — Institutions & Accounts ✅
Unified institution model with dedicated account management page.
- Institutions table (banks, brokers, custodians) replacing separate bank/broker models
- Institution hierarchy with cascade soft-delete triggers and bank roles
- Wallet/exchange correlation enforcement (custodial inside institutions, self-custody standalone)
- Institution-centric accounts page with summary card and collapsible institution cards
- Full CRUD for crypto/stock positions with per-row loading, dirty detection, saved flash
- Region-to-country migration, unified bank editing interface

### Phase 13 — Dashboard Redesign & Theming ✅
Modern dashboard layout with multi-theme support.
- Unified dashboard grid with synced period toggles across all sections
- Per-section collapse/expand toggles, ticker group expansion
- Performance indicators inline with totals
- 6-theme system (Default, Dark, Sunset, Forest, Ocean, Nord)
- Toast notifications (sonner) replacing native alert/confirm dialogs
- Inline ConfirmButton component for destructive actions

### Phase 14 — Soft Deletes & Undo System ✅
Reversible deletion with audit snapshots across 13 tables.
- `deleted_at` soft-delete columns with partial unique indexes
- Cascade soft-delete triggers (institution → wallets → positions)
- Snapshot audit trail storing state before deletion
- Undo functionality restoring soft-deleted records
- Dedicated "undone" action type in activity log

### Phase 15 — Portfolio Sharing ✅
Secure read-only sharing with expiring tokens.
- Share links via nanoid tokens with customizable scope (overview, full, full_with_history)
- Configurable expiry (never, 1h, 1d, 7d, 30d, custom) with revocation
- Shared portfolio page mirroring dashboard sections (crypto, stocks, cash, accounts, history, diary)
- RLS policies for secure token-based access
- Share management UI in settings with list/revoke/edit

### Phase 16 — Portfolio Comparison ✅
Side-by-side portfolio analysis on shared pages and dedicated comparison dashboard.
- **Phase A**: Floating comparison widget on shared pages — slide-in panel with totals, allocation bars, class breakdowns
- **Phase B**: Dedicated `/dashboard/compare/[token]` page with:
  - Allocation radar chart and holdings overlap visualization
  - Performance race chart tracking both portfolios over time
  - "What If" calculator with draggable sliders for scenario modeling
- Currency-normalized aggregations for fair cross-portfolio comparison

### Phase 17 — Import/Export & Auth ✅
Data portability and account security features.
- JSON backup export (PortfolioBackup v1) covering all portfolio entities
- CSV exports per entity (crypto, stocks, cash, trades, activity, snapshots)
- JSON import with merge mode (add new, skip duplicates) and replace mode (full restore)
- Import validation with preview and confirmation prompts
- Clear all data functionality (purges all portfolio tables)
- Forgot/reset password flow with email verification and secure token handling

### Phase 18 — Multi-User & User Management ✅
Full multi-user isolation with admin controls and invite system.
- Supabase Auth with sign-up, login, forgot/reset password, MFA (TOTP)
- RLS policies on every portfolio table scoped to `auth.uid() = user_id`
- Profiles table with per-user settings (currency, theme, display name, role, status)
- Invite code system (nanoid, expiry, single-use) — invited users auto-approved
- Pending approval flow for users registering without invite code
- Admin panel: approve/reject/suspend users, manage invite codes
- Admin role enforcement with service-role client for privileged operations

### Phase 19 — Automated Snapshots & Price API Optimization ✅
Automated daily portfolio snapshots and batch price fetching.
- pg_cron + pg_net daily cron job (23:55 UTC) triggering Edge Function
- `daily-snapshot` Supabase Edge Function with service-role auth and CRON_SECRET bearer token
- Yahoo Finance v7 batch API — single request for all user tickers with crumb+cookie auth
- v8/chart fallback for tickers missing from v7 batch (chunked in groups of 20)
- On-demand snapshot deduplication (cron won't overwrite a more complete earlier snapshot)

### Phase 20 — Portfolio Adjustments & Chart Accuracy ✅
Adjustment-aware portfolio chart that compensates for data entry artifacts.
- Adjustment flagging (`is_adjustment`) on all CRUD operations with checkbox in create/edit/delete UIs
- `delta_usd` / `delta_eur` columns on `activity_log` — write-time cached value deltas
- Historical FX rates via Frankfurter date endpoint for accurate delta computation
- Adjustment-aware chart with "Adj" toggle (defaults ON) — formula: `value + (finalCumDelta - cumDeltaAtDate)`
- S&P benchmark seeding from adjusted display-currency value for pixel-perfect starting alignment
- Cascade delete logging — parent deletes (asset/wallet/broker/institution) individually log child entity removals
- Retroactive toggle: compute deltas from before/after snapshots with historical prices (CoinGecko/Yahoo)
- Activity log CSV export includes delta columns

### Phase 21 — Portfolio Transfers ✅
Two-legged transfer system for recording sells, buys, and moves between portfolio entities.
- `transfer_group_id` UUID linking source (reduce) and destination (increase) activity log entries
- Both legs flagged as `is_adjustment=true` — S&P benchmark ignores internal moves
- Fees captured implicitly (source delta ≠ destination delta → net = fee)
- `last_was_transfer` column on 5 entity tables for Xfer badge (teal, precedence over Adj. amber)
- Sell: position → cash; Move: position → position (different location); Buy: stub for Phase 22
- Paired undo via `transfer_group_id` — undoing one leg reverts both
- `effectiveDate` parameter for backdated transfers (historical price lookups automatically use the date)

### Phase 22 — Buy Mode ✅
Guided purchase wizard that creates missing entities inline — no pre-setup needed.
- Progressive buy form in TransferDialog: asset search → institution picker → cash tracking → summary
- Asset search via Yahoo Finance (stocks/ETFs) and CoinGecko (crypto) with debounced API calls
- Inline institution creation: create broker or exchange wallet by name during the buy flow
- Cash tracking: auto-detect existing deposits, prompt to declare balance (with adjustment flag), or skip
- Skip cash = single-legged position creation (identical to "Add Asset" flow, no `transfer_group_id`)
- Crypto auto-detection: background `/api/crypto/detail` call for chain and subcategory
- "Record Buy" entry point buttons on stock and crypto dashboard tables
- `source` optional on `TransferInput`; `createBroker`/`createWallet` return created ID for patching

### Phase 23 — Chart View Modes ✅
Per-asset-class chart views with mode-specific S&P benchmark and adjustment deltas.
- View mode cycling: Total → Investments → Crypto → Stocks → Cash (cycle button with `BarChart3` icon)
- Slice values extracted from snapshot columns (`crypto_value_usd`, `stocks_value_usd`, `cash_value_usd`)
- Per-asset-class adjustment deltas: `entity_type` mapped to crypto/stocks/cash for mode-specific adjustments
- FX conversion via snapshot's implicit historical rate (`total_value_eur / total_value_usd`)
- S&P per mode: ratio-based scaling using `slice_usd / total_usd` at each cash flow date
- Editable stock asset fields (name, yahoo_ticker, ISIN) in position editor — fix broken tickers without recreating

### Phase 24 — Testing Infrastructure ✅
Comprehensive test suite with CI pipeline for ongoing quality assurance.
- Vitest framework with separate unit and integration test projects
- 118 unit tests across 11 files: validation (46), csv (14), rate-limit (6), fx (12), aggregate (4), activity-log (13), dashboard-insights (2), holdings (3), shares (8), import-backup (6), chart-enrichment (4)
- 9 integration tests across 3 files: migration-bootstrap (2), RLS enforcement (3), snapshot-validation (4) — real local Supabase via Docker
- GitHub Actions CI pipeline: lint → build → unit tests → supabase start → integration tests → supabase stop
- Design doc: `docs/plans/2026-03-04-test-infrastructure-design.md`

### Phase 25 — Code Review & Hardening ✅
Security audit, API hardening, and codebase quality improvements.
- Auth guards (`getUser()` + 401) on all 4 previously unprotected API routes
- Sliding-window rate limiting on all API endpoints (`src/lib/rate-limit.ts`)
- Pure module extractions for testability: `share-utils.ts`, `stock-categories.ts`, `format.ts`, `csv.ts`, `deltas.ts`
- Security fix: `deleteAccount` now uses `admin.auth.admin.deleteUser()` (was only deleting profile row)
- Compensating transaction undo system replacing RPC-based undo for all entity types
- Test quality: deterministic IDs, unconditional assertions, afterEach cleanup

### Phase 26 — Command Palette ✅
Global search with portfolio holdings, external asset lookup, and quick navigation.
- Cmd+K / SearchPill trigger with strict substring filter (not fuzzy)
- Holdings preview with inline chevron toggle for quantity/price/total expansion
- External CoinGecko + Yahoo Finance search with "Owned" badge on matching portfolio tickers
- localStorage cache + `/api/holdings` endpoint (rate-limited 30/min)
- `buildPaletteHoldings()` shared builder in `src/lib/portfolio/holdings.ts`

### Phase 27 — FX Decomposition Accuracy ✅
Accurate per-asset-class Prices vs FX attribution in chart view modes.
- 5 new snapshot columns: per-class EUR values + `stocks_eur_denominated_value`, `cash_eur_denominated_value`
- FX-sensitive fraction (`avgFxFraction`) for accurate per-class Prices vs FX split
- Daily snapshot Edge Function writes all per-class EUR value columns
- One-time backfill script for historical snapshot data
- Design doc: `docs/plans/2026-03-09-fx-decomposition-design.md`

### Miscellaneous Improvements (Phases 23–27) ✅
- History timeline: grouped transfer pairs, specific field changes shown for updates
- Mobile UI polish: responsive tables with staggered column visibility, truncated assets, flex-wrap toolbars
- S&P benchmark fixes: chart tooltip delta annotation, zero-slice FX seeding fix for EUR users
- Entity name resolution in deposit tooltips, FX round-trip rounding elimination
- CoinGecko-internal FX for stablecoin decomposition accuracy

---

## Future Ideas (Unscoped)

- **Collaborative Portfolios** — Invite others to view or contribute to your portfolio with role-based permissions
- **Alerts & Notifications** — Price targets, portfolio threshold alerts
- **Asset Search** — Search functionality per asset showing location (wallets/brokers), quantities per category, etc.
- **Donate Button** — Donate/tip button with full backend infrastructure (payment processing, thank-you flow, etc.)
- **Mobile App** — Native mobile experience (PWA or React Native)
- **API Access** — Public API for programmatic portfolio access

---

*Last updated after: Phase 27 — FX Decomposition Accuracy*
