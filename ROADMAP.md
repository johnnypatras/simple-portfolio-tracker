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

---

## Upcoming Phases

### Phase 18 — User Management & Multi-User 🔲
Expand beyond single-user to support invited collaborators.
- User invitations system (foundations laid with invite codes table)
- Role-based permissions for shared portfolios
- Per-user display names and profile settings

---

## Future Ideas (Unscoped)

- **Alerts & Notifications** — Price targets, portfolio threshold alerts
- **Asset Search** — Search functionality per asset showing location (wallets/brokers), quantities per category, etc.
- **Donate Button** — Donate/tip button with full backend infrastructure (payment processing, thank-you flow, etc.)
- **Mobile App** — Native mobile experience (PWA or React Native)
- **API Access** — Public API for programmatic portfolio access

---

*Last updated after: Phase 17 — Import/Export & Auth*
