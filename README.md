# Simple Portfolio Tracker

A privacy-first, self-hosted portfolio tracker for crypto, stocks/ETFs, and cash holdings. Manual data entry by design — no exchange API keys stored, no third-party access to your financial data.

Built with Next.js, Supabase, and Tailwind CSS. Deployed on Vercel with automated daily snapshots.

<!-- TODO: Add screenshot -->
<!-- ![Dashboard](docs/screenshot.png) -->

## Features

### Portfolio Dashboard
- **Portfolio value chart** with configurable periods (24H, 3D, 7D, 30D, 90D, 1Y, All)
- **S&P 500 benchmark** overlay — cash-flow-adjusted "what if" comparison
- **Adjustment-aware chart** — compensates for portfolio corrections and imports so the chart reflects real growth, not data entry artifacts
- **Allocation breakdown** by asset class (crypto, stocks, cash) with visual bars
- **Market overview** — live BTC, ETH, Gold, S&P 500, Nasdaq, Dow, EUR/USD
- **Dual currency** — toggle between EUR and USD at any time

### Crypto
- Live prices from CoinGecko (batch API, 30 calls/min free tier)
- Search by name, ticker, or contract address
- Multi-wallet support with custody grouping (exchange / self-custody)
- Chain detection (Ethereum, Solana, etc.)
- Stablecoin tracking with separate totals
- USD primary price + secondary currency line

### Stocks & ETFs
- Live quotes from Yahoo Finance (v7 batch + v8 chart fallback)
- Search any listed security by name or ticker
- Native trading currency display (EUR, USD, GBP, CHF, etc.) with % change
- Dividend yield tracking and income projections (daily/monthly/yearly)
- ETF vs individual stock breakdown, sector grouping, UCITS tagging

### Banks & Deposits
- Bank accounts, exchange deposits, and broker deposits
- Interest rate tracking with APY calculations
- Income projections (daily/monthly/yearly)
- Stablecoin deposits counted as USD cash equivalents
- Multi-currency aggregation

### Accounts & Institutions
- Organize holdings under institutions with multiple roles (wallet, broker, bank)
- Add/remove roles without recreating entities
- Institution-level grouping across asset classes

### Activity & History
- **Activity log** — full audit trail of every portfolio change with before/after snapshots
- **Undo** — revert any logged change (soft-delete with `undone_at` timestamp)
- **Portfolio adjustment flagging** — mark entries as corrections vs. real transactions
- **Trade diary** — manual buy/sell trade logging across all asset types
- **Snapshot history** — browse historical portfolio snapshots with value breakdown

### Sharing & Comparison
- **Portfolio sharing** via unique token link (read-only, no auth required)
- **Multi-user comparison** — TWR-based performance comparison that strips cash flow noise
- Shared views mirror the full dashboard (chart, crypto, stocks, cash, history, diary)

### Import & Export
- **JSON export/import** — full portfolio backup and restore
- **Activity log CSV export** with adjustment deltas

### Admin & Security
- Invite-only registration (admin generates invite codes)
- MFA support (TOTP two-factor authentication)
- Row Level Security on every table
- Customizable columns per table (persisted in localStorage)
- Password and email change flows with confirmation

## S&P 500 Benchmark

The dashboard chart includes an S&P 500 Total Return benchmark. It answers: **"What if every dollar I invested had gone into the S&P 500 instead?"**

### How It Works

The benchmark uses a **cash-flow-adjusted** approach. Each deposit, purchase, or withdrawal is replayed against the S&P 500 TR index — for each cash flow, hypothetical "S&P units" are bought or sold at the index price on that date. The hypothetical portfolio value on any day is `units × S&P price`.

Cash flows are derived from the activity log (bank account changes, exchange/broker deposits, crypto/stock position changes valued at historical prices). All amounts are converted to USD using daily FX rates from Yahoo Finance and Frankfurter (ECB data).

### Adjustment Awareness

When portfolio corrections are flagged as adjustments (e.g., importing pre-existing holdings), the chart compensates so the line reflects real growth. The S&P benchmark seeds its starting units from the adjusted portfolio value, ensuring both lines start at the same point. Deltas are cached at write-time in USD and EUR using historical FX rates for accuracy.

### Known Compromises

1. **Backfilled history is approximate.** Pre-existing positions are recorded as a single "created" event. Intermediate trades before activity logging was enabled are not captured.
2. **No explicit cash flow ledger.** Cash flows are derived from activity log snapshots rather than a dedicated table.
3. **FX conversion for chart display** uses the portfolio snapshot's implicit EUR/USD rate rather than a separate FX spot feed.

For the full algorithm deep-dive, see [NOTES-benchmark-algorithm.md](./NOTES-benchmark-algorithm.md).

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | [Next.js 16](https://nextjs.org) (App Router, Turbopack, React 19) |
| Language | TypeScript |
| Database & Auth | [Supabase](https://supabase.com) (PostgreSQL, RLS, JWT + MFA) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) |
| Charts | [Recharts](https://recharts.org) |
| Crypto prices | [CoinGecko](https://www.coingecko.com/en/api) (free Demo plan) |
| Stock prices | [Yahoo Finance](https://finance.yahoo.com) (v7 batch + v8 chart) |
| FX rates | [Frankfurter](https://www.frankfurter.app) (ECB data) + Yahoo for EUR/USD |
| Daily snapshots | pg_cron + pg_net → Supabase Edge Function |
| Hosting | [Vercel](https://vercel.com) |
| Icons | [Lucide React](https://lucide.dev) |
| Fonts | [Geist](https://vercel.com/font) (Sans + Mono) |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- A [Supabase](https://supabase.com) project (free tier works)

### 1. Clone and install

```bash
git clone https://github.com/johnnypatras/simple-portfolio-tracker.git
cd simple-portfolio-tracker
npm install
```

### 2. Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to the **SQL Editor** in your Supabase dashboard
3. Run each migration file from `supabase/migrations/` **in numerical order** (001 through 044)

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

| Variable | Where to find it |
|----------|-----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → **Project URL** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → **anon / public** key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role / secret** key |
| `NEXT_PUBLIC_COINGECKO_API_KEY` | *(Optional)* [CoinGecko API](https://www.coingecko.com/en/api/pricing) — free Demo key for higher rate limits |

> If environment variables are missing, the app shows a setup page with these instructions.

### 4. Create your first user

The app uses invite-only registration:

1. Generate an invite code from the **Settings** page (or insert one directly into the `invite_codes` table)
2. Open `/register` and use the invite code to create your account

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in.

### Daily Snapshots (optional)

To enable automated daily portfolio snapshots:

1. Enable `pg_cron` and `pg_net` extensions in Supabase (migration 039 handles this)
2. Deploy the `daily-snapshot` Edge Function from `supabase/functions/`
3. Set the `CRON_SECRET` secret via `supabase secrets set`
4. The cron job runs at 23:55 UTC daily, snapshotting all users' portfolios

## Project Structure

```
src/
├── app/                        # Next.js App Router
│   ├── api/                    #   API routes (auth, crypto search, stock quotes)
│   ├── dashboard/              #   Main app (accounts, crypto, stocks, cash, etc.)
│   ├── share/[token]/          #   Public shared portfolio views
│   ├── login/                  #   Authentication pages
│   ├── register/               #   Invite-only registration
│   └── setup/                  #   First-run setup (missing env vars)
├── components/                 # React components by domain
│   ├── accounts/               #   Institution & account management
│   ├── cash/                   #   Bank accounts & deposits
│   ├── comparison/             #   Multi-user portfolio comparison
│   ├── crypto/                 #   Crypto positions & modals
│   ├── dashboard/              #   Portfolio chart, summary cards, insights
│   ├── diary/                  #   Trade diary
│   ├── history/                #   Activity log & snapshots
│   ├── settings/               #   User settings & admin
│   ├── stocks/                 #   Stock/ETF positions & modals
│   └── ui/                     #   Shared primitives (modals, tooltips, etc.)
├── lib/
│   ├── actions/                #   20 server action modules (mutations + queries)
│   ├── portfolio/              #   Aggregate calculations & dashboard insights
│   ├── prices/                 #   Price clients (CoinGecko, Yahoo, Frankfurter)
│   ├── supabase/               #   4 Supabase clients (browser, server, middleware, admin)
│   ├── hooks/                  #   Custom React hooks
│   ├── types.ts                #   TypeScript type definitions
│   └── format.ts               #   Currency & number formatting
supabase/
├── migrations/                 # 44 SQL migrations (schema, RLS, triggers, cron)
└── functions/                  # Edge Functions (daily-snapshot)
```

## License

[MIT](LICENSE)
