# Simple Portfolio Tracker

A privacy-first portfolio tracker for crypto, stocks/ETFs, and cash holdings. Track everything in one place with live prices, analytics, S&P 500 benchmarking, and multi-currency support.

**Your data stays yours** — no exchange API keys stored, no third-party access, manual entry by design. Invite-only access with MFA support.

<!-- TODO: Add screenshot -->
<!-- ![Dashboard](docs/screenshot.png) -->

---

## What You Get

### All-in-One Dashboard
- **Total portfolio value** with period changes (24h, 7d, 30d, 1y) and value/FX decomposition tooltips
- **Live market overview** — BTC, ETH, SOL, S&P 500, Nasdaq, Dow, Stoxx 50, Gold, Silver, Brent, VIX, 10Y UST, EUR/USD
- **Dual currency toggle** — switch between EUR and USD instantly
- **Command palette** (Cmd+K) — search your holdings, CoinGecko, and Yahoo Finance in one place

### Performance Chart
- Configurable periods: 24H, 3D, 7D, 30D, 90D, 1Y, All
- **Per-class view modes** — cycle through Total, Investments, Crypto, Stocks, Cash
- **S&P 500 benchmark** — cash-flow-adjusted "what if I had invested in the S&P instead?"
- **Adjustment-aware** — compensates for portfolio imports and corrections so the chart shows real growth
- **Allocation overlay** — see crypto/stocks/cash breakdown over time
- **Return mode** — toggle cumulative % return view

### Crypto
- Live prices from CoinGecko with coin images
- Search by name, ticker, or contract address
- Multi-wallet support with custody grouping (exchange / self-custody / mixed)
- Chain detection, stablecoin tracking, APY/staking yields
- USD primary price with secondary currency line

### Stocks & ETFs
- Live quotes from Yahoo Finance
- Search any listed security worldwide
- Native trading currency display (EUR, USD, GBP, CHF, etc.) with % change
- Dividend yield tracking and income projections (daily/monthly/yearly)
- ETF vs stock breakdown, sector grouping, UCITS tagging

### Cash & Banking
- Bank accounts, exchange deposits, broker deposits
- Interest rate tracking with APY and income projections
- Stablecoin deposits counted as USD cash equivalents
- Multi-currency aggregation with currency exposure breakdown

### Institutions & Accounts
- Organize everything under institutions with multiple roles (wallet, broker, bank)
- Institution-level grouping across all asset classes
- Add/remove roles without recreating entities

### Record Transactions
- **Buy** — guided wizard: search asset, pick/create institution, optionally track cash
- **Sell** — reduce a position, increase cash at the same institution
- **Move** — relocate between brokers/wallets (same asset, different location)
- **Backdating** — pick a past date; prices and FX use that date's historical rates
- **Effective dates** — set when money actually entered your portfolio (affects benchmarks and analytics)
- **Entry splitting** — split one import across multiple dates for accurate historical tracking
- **Inline creation** — create brokers, exchanges, and assets directly inside the buy flow
- **Implicit fees** — if cash paid differs from position value, the delta shows as a fee

### Activity & History
- Full audit trail of every portfolio change with before/after snapshots
- **Undo any action** — compensating transactions restore via reverse operations
- **Transfer grouping** — linked sell/buy/move legs displayed together
- **Split grouping** — parent entries with expandable date allocations
- **Effective date annotations** — see when entries really happened vs when recorded
- Field-level change descriptions ("Qty: 34.365 → 34.393")
- Portfolio adjustment flagging — mark corrections vs real transactions
- CSV export

### Trade Diary
- Manual buy/sell trade logging across all asset types
- Structured entries with date, quantity, price, notes

### Sharing & Comparison
- **Share your portfolio** via unique link (read-only, no auth required)
- **Multi-user comparison** — TWR-based performance comparison that strips cash flow noise
- Shared views mirror the full dashboard (chart, crypto, stocks, cash, history, diary)
- Configurable scope and expiry

### Import & Export
- Full JSON backup and restore (all portfolio entities)
- CSV exports per section (crypto, stocks, cash, trades, activity, snapshots)
- Round-trip preservation of effective dates and split data

---

## Security & Privacy

| Feature | Detail |
|---------|--------|
| **No API keys stored** | Manual data entry — your exchange credentials never touch the server |
| **Invite-only** | Registration requires an admin-generated invite code |
| **MFA** | TOTP two-factor authentication |
| **Row Level Security** | Every database table scoped to the authenticated user |
| **Auth on every route** | All API endpoints require `getUser()` + 401 |
| **Rate limiting** | Sliding-window limits on all endpoints |
| **Input validation** | All mutations and imports validated server-side |
| **Security headers** | HSTS, X-Frame-Options, CSP, Referrer-Policy |

---

## For Developers

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack, React 19) |
| Language | TypeScript |
| Database & Auth | Supabase PostgreSQL (18 tables, 11 migrations, RLS, JWT + MFA) |
| Styling | Tailwind CSS 4, Geist fonts |
| Charts | Recharts |
| Crypto prices | CoinGecko (free Demo plan, 30 calls/min) |
| Stock prices | Yahoo Finance v7 batch + v8 chart fallback |
| FX rates | Frankfurter (ECB) + Yahoo for EUR/USD |
| Monitoring | Sentry (error tracking + tracing + replay) |
| Daily snapshots | pg_cron + pg_net + Supabase Edge Function |
| Testing | Vitest (unit + component + integration) |
| CI/CD | GitHub Actions (lint, build, test, deploy) |
| Hosting | Vercel |

### Running Locally

**Prerequisites:** Node.js 20+, Docker (for local Supabase)

```bash
# Clone and install
git clone https://github.com/johnnypatras/simple-portfolio-tracker.git
cd simple-portfolio-tracker
npm install

# Start local Supabase (applies all migrations automatically)
npx supabase start

# Start dev server (auto-syncs production data if linked)
npm run dev

# Or skip sync and use existing local data
npm run dev:skip-sync
```

The dev server runs at [http://localhost:3000](http://localhost:3000).

### Running in Production (Vercel)

1. Push to GitHub — CI pipeline runs automatically
2. PRs get preview deployments
3. Merging to `main` triggers: migrate Supabase → deploy to Vercel → deploy Edge Functions

**Environment variables** (set in Vercel dashboard or `.env.local`):

| Variable | Source |
|----------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → API → anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API → service_role key |
| `COINGECKO_API_KEY` | CoinGecko API (optional, for higher rate limits) |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry project DSN |

### First-Time Setup

1. Set up a Supabase project and configure environment variables
2. Apply migrations: `npx supabase db push` (or they run automatically in CI)
3. Generate an invite code from Settings (or insert into `invite_codes` table)
4. Register at `/register` with the invite code

### Testing

```bash
npm test                  # Unit tests (399 cases, ~500ms)
npm run test:component    # Component tests (92 cases, ~1.3s)
npm run test:integration  # Integration tests (54 cases, needs local Supabase)
npm run test:all          # All three layers
npm run test:watch        # Unit tests in watch mode
```

### Project Structure

```
src/
  app/                    # Next.js App Router (dashboard, api, share, login, register)
  components/             # React components by domain (crypto, stocks, cash, etc.)
  lib/
    actions/              # 23 server action modules
    portfolio/            # Aggregation, chart enrichment, dashboard logic
    prices/               # CoinGecko, Yahoo Finance, Frankfurter clients
    supabase/             # 4 Supabase clients (browser, server, middleware, admin)
    hooks/                # Custom React hooks
    types.ts              # TypeScript definitions
    validation.ts         # Input validators
    split-helpers.ts      # Entry splitting utilities
__tests__/
  unit/                   # 399 unit tests (27 files)
  component/              # 92 component tests (12 files)
  integration/            # 54 integration tests (10 files)
supabase/
  migrations/             # 001 through 011 (consolidated schema)
  migrations-archive/     # Original 52 migrations (reference only)
  functions/              # Edge Functions (daily-snapshot)
.github/
  workflows/ci.yml        # CI: lint → build → test → deploy
```

### Daily Snapshots

Automated daily portfolio snapshots via pg_cron:
1. Enable `pg_cron` and `pg_net` extensions (handled by migrations)
2. Deploy the `daily-snapshot` Edge Function
3. Set `CRON_SECRET` via `supabase secrets set`
4. Runs at 23:59 UTC, snapshotting all users

---

## License

[MIT](LICENSE)
