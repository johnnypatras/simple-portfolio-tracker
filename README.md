# Simple Portfolio Tracker

A self-hosted portfolio tracker for crypto, stocks, and bank deposits. Track your holdings, monitor live prices, and view your portfolio's performance over time.

Built with Next.js, Supabase, and Tailwind CSS. Runs entirely on your own infrastructure — your financial data never touches third-party servers.

<!-- TODO: Add a screenshot here -->
<!-- ![Dashboard](docs/screenshot.png) -->

## Features

- **Dashboard** — portfolio value chart with historical snapshots
- **Crypto** — live prices from CoinGecko, search by name or ticker, multi-currency display
- **Stocks** — live quotes from Yahoo Finance, search and add any listed stock
- **Banks & Deposits** — track bank accounts and exchange deposits
- **Trade Diary** — log buy/sell trades across all asset types
- **Activity History** — audit trail of all portfolio changes
- **Settings** — customizable columns, primary currency, invite-only user registration
- **Mobile-friendly** — fully responsive dark-themed UI
- **MFA support** — optional TOTP two-factor authentication

## S&P 500 Benchmark

The dashboard includes an S&P 500 Total Return benchmark overlay on the portfolio chart. It answers: **"What if every dollar I invested had gone into the S&P 500 instead?"**

### How It Works

The benchmark uses a **cash-flow-adjusted** approach rather than naive normalization. Each deposit, purchase, or withdrawal is replayed against the S&P 500 TR index: for each cash flow, hypothetical "S&P units" are bought or sold at the index price on that date. The hypothetical portfolio value on any day is simply `units * S&P price`.

Cash flows are derived from the activity log, which tracks bank account changes, exchange/broker deposits, and crypto/stock position changes (valued at historical market prices from CoinGecko and Yahoo Finance). All amounts are converted to USD using actual daily FX rates.

### Known Compromises

1. **Backfilled history is approximate.** Pre-existing positions are recorded as a single "created" event using the current quantity at the asset's original `created_at` date. Intermediate buys/sells before activity log snapshots were enabled are not captured. This approximation naturally shrinks over time as new changes are tracked precisely.

2. **Position creation dates use the parent asset's timestamp.** Crypto/stock positions inherit `created_at` from their parent asset — if multiple positions were added on different days, they share one date.

3. **No explicit cash flow ledger.** Cash flows are derived from activity log snapshots rather than a dedicated table. This avoids schema changes while providing a good approximation.

4. **FX conversion for chart display** uses the portfolio snapshot's implicit EUR/USD rate rather than a separate FX spot feed. This is exact per snapshot date but is a portfolio-weighted rate.

For the full algorithm deep-dive, see [NOTES-benchmark-algorithm.md](./NOTES-benchmark-algorithm.md).

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | [Next.js 16](https://nextjs.org) (App Router, React 19) |
| Database & Auth | [Supabase](https://supabase.com) (Postgres + Row Level Security) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) |
| Charts | [Recharts](https://recharts.org) |
| Icons | [Lucide React](https://lucide.dev) |
| Language | TypeScript (strict mode) |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- A free [Supabase](https://supabase.com) account

### 1. Clone the repo

```bash
git clone https://github.com/johnnypatras/simple-portfolio-tracker.git
cd simple-portfolio-tracker
npm install
```

### 2. Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to the **SQL Editor** in your Supabase dashboard
3. Run each migration file from `supabase/migrations/` **in order** (001, 002, ... 009)

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in your keys:

| Variable | Where to find it |
|----------|-----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → **Project URL** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → **anon / public** key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role / secret** key |
| `NEXT_PUBLIC_COINGECKO_API_KEY` | *(Optional)* [CoinGecko API](https://www.coingecko.com/en/api/pricing) — free tier works without it |

> **Note:** If you skip this step, the app will show a friendly setup page with these instructions when you open it.

### 4. Create your first user

The app uses invite-only registration. To create the first user:

1. Go to your Supabase dashboard → **Authentication** → **Users**
2. Click **Add user** → **Create new user**
3. Enter an email and password — this will be your login

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in.

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── (protected)/        # Auth-gated routes (dashboard, crypto, stocks, etc.)
│   ├── api/                # API routes (crypto prices, stock quotes, auth)
│   ├── login/              # Login page
│   └── setup/              # Setup page (shown when env vars are missing)
├── components/             # React components
│   ├── cash/               # Bank & deposit tables
│   ├── crypto/             # Crypto table & modals
│   ├── dashboard/          # Portfolio chart & summary
│   ├── diary/              # Trade diary table
│   ├── stocks/             # Stock table & modals
│   └── ui/                 # Shared UI components (sidebar, modals, column config)
└── lib/                    # Utilities & hooks
    ├── hooks/              # Custom React hooks
    ├── prices/             # CoinGecko API client
    └── supabase/           # Supabase client (browser, server, middleware)
```

## License

[MIT](LICENSE)
