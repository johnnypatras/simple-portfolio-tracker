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

---

## Upcoming Phases

### Phase 10 — Performance Analytics & Charts 🔲
Time-weighted portfolio performance with interactive charts.
- Portfolio value chart (already started with snapshot-based line chart)
- Asset allocation pie/donut chart
- Individual asset performance over time
- Benchmark comparisons (BTC, S&P 500)
- Period selectors (7d, 30d, 90d, 1y, all)

---

## Future Ideas (Unscoped)

- **Alerts & Notifications** — Price targets, portfolio threshold alerts
- **Import / Export** — CSV/JSON import of positions, export portfolio snapshots
- **Multi-user / Sharing** — Shared portfolios, read-only viewer links

---

*Last updated after: Phase 9 — Activity History / Audit Trail*
