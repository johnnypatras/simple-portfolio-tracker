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

---

## Upcoming Phases

### Phase 8 — Trade Diary ✅
Structured trade log for recording significant buys and sells.
- `trade_entries` table: date, asset type/name, buy/sell, quantity, price, currency, notes
- CRUD server actions, desktop table + mobile card layouts
- Add/edit modal with live total preview, buy/sell toggle
- Asset type badges (crypto/stock/cash/other) and action badges (buy/sell)

### Phase 9 — Activity History / Audit Trail 🔲
Track all portfolio changes for accountability and review.
- Automatic change log (position edits, account adds/deletes)
- Filterable timeline by asset type, date range, action type
- Exportable history
- Stub page exists at `/dashboard/history`

---

## Future Ideas (Unscoped)

- **Alerts & Notifications** — Price targets, portfolio threshold alerts
- **Import / Export** — CSV/JSON import of positions, export portfolio snapshots
- **Performance Analytics** — Time-weighted returns, benchmark comparisons, charts
- **Multi-user / Sharing** — Shared portfolios, read-only viewer links

---

*Last updated after: Phase 8 — Trade Diary*
