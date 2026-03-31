#!/usr/bin/env python3
"""
Generate Architecture PDF for Simple Portfolio Tracker.

Uses fpdf2 to create a professional dark-themed architecture document
with Mermaid-rendered diagram images.

Prerequisites:
  pip install fpdf2
  bash docs/doc-gen/generate_diagrams.sh   # render Mermaid PNGs first

Run:    python3 docs/doc-gen/generate_architecture_pdf.py
Output: docs/architecture.pdf
"""

import os
from fpdf import FPDF

# ── Paths ────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(SCRIPT_DIR, "..", "architecture.pdf")
DIAGRAMS_DIR = os.path.join(SCRIPT_DIR, "diagrams")

# ── Colors (RGB) ─────────────────────────────────────────────────────
C_BG = (24, 24, 27)            # zinc-950
C_BG_CARD = (39, 39, 42)       # zinc-800
C_BG_CODE = (30, 30, 34)       # slightly lighter than bg
C_TEXT = (228, 228, 231)        # zinc-200
C_TEXT_DIM = (161, 161, 170)    # zinc-400
C_HEADING = (244, 244, 245)    # zinc-100
C_ACCENT = (96, 165, 250)      # blue-400
C_ACCENT_DIM = (59, 130, 246)  # blue-500
C_TABLE_HEAD_BG = (59, 130, 246)  # blue-500 for table headers
C_TABLE_ROW1 = (39, 39, 42)    # zinc-800
C_TABLE_ROW2 = (35, 35, 39)    # slightly lighter row
C_BORDER = (63, 63, 70)        # zinc-700
C_WHITE = (255, 255, 255)

# ── Layout ───────────────────────────────────────────────────────────
LEFT_MARGIN = 20
RIGHT_MARGIN = 20
TOP_MARGIN = 25
BOTTOM_MARGIN = 20
PAGE_W = 210  # A4 width
USABLE_W = PAGE_W - LEFT_MARGIN - RIGHT_MARGIN  # 170mm


def _diagram_path(name: str) -> str:
    """Return absolute path to a rendered diagram PNG."""
    return os.path.join(DIAGRAMS_DIR, f"{name}.png")


class ArchitecturePDF(FPDF):
    """Custom PDF with dark theme, proper margins, and diagram embedding."""

    def __init__(self):
        super().__init__(orientation="P", unit="mm", format="A4")
        self.set_auto_page_break(auto=True, margin=BOTTOM_MARGIN)
        self.set_margins(LEFT_MARGIN, TOP_MARGIN, RIGHT_MARGIN)
        self._is_cover = False

    # ── Header / Footer ──────────────────────────────────────────

    def header(self):
        if self._is_cover:
            return
        self._fill_bg()
        if self.page_no() > 1:
            self.set_font("Helvetica", "I", 8)
            self.set_text_color(*C_TEXT_DIM)
            self.set_y(10)
            self.cell(0, 5, "Simple Portfolio Tracker  |  Architecture Document", align="L")
            self.set_y(TOP_MARGIN)

    def footer(self):
        if self._is_cover:
            return
        self.set_y(-15)
        self.set_font("Helvetica", "I", 7)
        self.set_text_color(*C_TEXT_DIM)
        self.cell(USABLE_W / 2, 5, "Confidential  --  Simple Portfolio Tracker", align="L")
        self.cell(USABLE_W / 2, 5, f"Page {self.page_no()}", align="R")

    def _fill_bg(self):
        """Fill full page with dark background."""
        self.set_fill_color(*C_BG)
        self.rect(0, 0, self.w, self.h, "F")

    # ── Page helpers ─────────────────────────────────────────────

    def new_section_page(self):
        """Add a new page with dark background."""
        self.add_page()
        self._is_cover = False

    def _check_space(self, needed_mm: float):
        """If less than needed_mm remains, start a new page."""
        if self.get_y() + needed_mm > self.h - BOTTOM_MARGIN:
            self.new_section_page()

    # ── Text helpers ─────────────────────────────────────────────

    def section_title(self, number: str, title: str):
        """Render a numbered section heading with proper wrapping."""
        self.set_font("Helvetica", "B", 16)
        self.set_text_color(*C_ACCENT)
        full = f"{number}. {title}"
        self.multi_cell(USABLE_W, 10, full, new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(*C_ACCENT_DIM)
        self.line(LEFT_MARGIN, self.get_y(), PAGE_W - RIGHT_MARGIN, self.get_y())
        self.ln(4)

    def sub_heading(self, title: str):
        """Render a sub-heading."""
        self._check_space(15)
        self.set_font("Helvetica", "B", 13)
        self.set_text_color(*C_HEADING)
        self.multi_cell(USABLE_W, 8, title, new_x="LMARGIN", new_y="NEXT")
        self.ln(2)

    def body_text(self, text: str, bold: bool = False):
        """Render body paragraph text with wrapping."""
        style = "B" if bold else ""
        self.set_font("Helvetica", style, 10)
        self.set_text_color(*C_TEXT)
        self.multi_cell(USABLE_W, 5.5, text)
        self.ln(2)

    def bullet(self, text: str, indent: float = 8):
        """Render a bullet point."""
        self._check_space(10)
        self.set_font("Helvetica", "", 9.5)
        x0 = LEFT_MARGIN + indent
        self.set_x(x0)
        self.set_text_color(*C_ACCENT)
        self.cell(5, 5.5, ">")
        self.set_text_color(*C_TEXT)
        remaining = USABLE_W - indent - 5
        self.multi_cell(remaining, 5.5, text)
        self.ln(1)

    def bullet_bold_value(self, label: str, value: str, indent: float = 8):
        """Render a bullet with bold label and normal value."""
        self._check_space(10)
        x0 = LEFT_MARGIN + indent
        self.set_x(x0)
        self.set_text_color(*C_ACCENT)
        self.set_font("Helvetica", "", 9.5)
        self.cell(5, 5.5, ">")
        self.set_font("Helvetica", "B", 9.5)
        self.set_text_color(*C_HEADING)
        label_w = self.get_string_width(label + " ") + 1
        self.cell(label_w, 5.5, label + " ")
        self.set_font("Helvetica", "", 9.5)
        self.set_text_color(*C_TEXT)
        remaining = PAGE_W - RIGHT_MARGIN - self.get_x()
        self.multi_cell(remaining, 5.5, value)
        self.ln(1)

    def code_block(self, text: str):
        """Render a monospaced code block with dark card background."""
        self.set_font("Courier", "", 8)
        lines = text.strip().split("\n")
        block_h = len(lines) * 4.5 + 6
        self._check_space(block_h + 5)
        y_start = self.get_y()
        self.set_fill_color(*C_BG_CODE)
        self.set_draw_color(*C_BORDER)
        self.rect(LEFT_MARGIN + 2, y_start, USABLE_W - 4, block_h, "FD")
        self.set_y(y_start + 3)
        self.set_text_color(*C_TEXT)
        for line in lines:
            self.set_x(LEFT_MARGIN + 6)
            self.cell(USABLE_W - 12, 4.5, line)
            self.ln(4.5)
        self.ln(3)

    # ── Diagram embedding ────────────────────────────────────────

    def diagram(self, name: str, caption: str = "", width: float = 150):
        """Embed a Mermaid-rendered PNG diagram, centered."""
        path = _diagram_path(name)
        if not os.path.exists(path):
            self.body_text(f"[Diagram missing: {name}.png]")
            return

        self._check_space(width * 0.6 + 15)

        x_center = LEFT_MARGIN + (USABLE_W - width) / 2
        self.image(path, x=x_center, w=width)
        self.ln(3)

        if caption:
            self.set_font("Helvetica", "I", 8)
            self.set_text_color(*C_TEXT_DIM)
            self.cell(USABLE_W, 4, caption, align="C", new_x="LMARGIN", new_y="NEXT")
            self.ln(3)

    # ── Table rendering ──────────────────────────────────────────

    def table(self, headers: list, rows: list, col_widths: list | None = None):
        """Render a styled table with text wrapping in all cells."""
        n_cols = len(headers)
        if col_widths is None:
            col_widths = [USABLE_W / n_cols] * n_cols

        # Scale col_widths to fit USABLE_W exactly
        total = sum(col_widths)
        if abs(total - USABLE_W) > 0.5:
            scale = USABLE_W / total
            col_widths = [w * scale for w in col_widths]

        pad = 2
        line_h = 5

        def _row_height(cells):
            max_lines = 1
            for i, txt in enumerate(cells):
                w = col_widths[i] - 2 * pad
                n = max(1, len(self.multi_cell(w, line_h, str(txt), dry_run=True, output="LINES")))
                if n > max_lines:
                    max_lines = n
            return max(7, max_lines * line_h + 2 * pad)

        def _draw_row(cells, is_header=False, row_idx=0):
            rh = 8 if is_header else _row_height(cells)

            if self.get_y() + rh > self.h - BOTTOM_MARGIN:
                self.new_section_page()
                _draw_row(headers, is_header=True)

            y0 = self.get_y()

            if is_header:
                self.set_fill_color(*C_TABLE_HEAD_BG)
                self.set_font("Helvetica", "B", 8.5)
                self.set_text_color(*C_WHITE)
            else:
                bg = C_TABLE_ROW1 if row_idx % 2 == 0 else C_TABLE_ROW2
                self.set_fill_color(*bg)
                self.set_font("Helvetica", "", 8.5)
                self.set_text_color(*C_TEXT)

            # Draw row background
            self.rect(LEFT_MARGIN, y0, sum(col_widths), rh, "F")

            # Draw cell text
            for i, txt in enumerate(cells):
                x = LEFT_MARGIN + sum(col_widths[:i]) + pad
                self.set_xy(x, y0 + pad)
                w = col_widths[i] - 2 * pad
                if is_header:
                    self.cell(w, line_h, str(txt))
                else:
                    self.multi_cell(w, line_h, str(txt))

            self.set_y(y0 + rh)

        _draw_row(headers, is_header=True)
        for idx, row in enumerate(rows):
            _draw_row(row, row_idx=idx)
        self.ln(4)


# ════════════════════════════════════════════════════════════════════
# BUILD DOCUMENT
# ════════════════════════════════════════════════════════════════════

def build_document():
    """Build the full architecture PDF."""
    pdf = ArchitecturePDF()

    # ── COVER PAGE ───────────────────────────────────────────────
    pdf._is_cover = True
    pdf.add_page()
    pdf._fill_bg()

    pdf.ln(60)
    pdf.set_font("Helvetica", "B", 32)
    pdf.set_text_color(*C_ACCENT)
    pdf.cell(0, 14, "Simple Portfolio Tracker", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    pdf.set_draw_color(*C_ACCENT_DIM)
    pdf.set_line_width(0.8)
    pdf.line(50, pdf.get_y(), PAGE_W - 50, pdf.get_y())
    pdf.ln(8)

    pdf.set_font("Helvetica", "", 18)
    pdf.set_text_color(*C_HEADING)
    pdf.cell(0, 10, "Architecture Document", align="C", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(2)
    pdf.set_font("Helvetica", "I", 13)
    pdf.set_text_color(*C_TEXT_DIM)
    pdf.cell(0, 8, "System Design & Technical Reference", align="C", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(20)
    pdf.set_font("Helvetica", "", 11)
    pdf.set_text_color(*C_TEXT_DIM)
    pdf.cell(0, 7, "March 2026", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 7, "Version 2.0", align="C", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(30)
    pdf.set_draw_color(*C_BORDER)
    pdf.set_line_width(0.3)
    pdf.line(60, pdf.get_y(), PAGE_W - 60, pdf.get_y())
    pdf.ln(5)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(*C_TEXT_DIM)
    pdf.cell(0, 5, "Confidential  --  For internal reference only", align="C")

    pdf._is_cover = False

    # ── TABLE OF CONTENTS ────────────────────────────────────────
    pdf.new_section_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.set_text_color(*C_ACCENT)
    pdf.cell(USABLE_W, 12, "Table of Contents", new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(*C_ACCENT_DIM)
    pdf.line(LEFT_MARGIN, pdf.get_y(), PAGE_W - RIGHT_MARGIN, pdf.get_y())
    pdf.ln(8)

    toc_items = [
        ("1", "System Overview"),
        ("2", "Tech Stack"),
        ("3", "Database Schema"),
        ("4", "Application Architecture"),
        ("5", "Price Pipeline"),
        ("6", "Portfolio Snapshots & Chart"),
        ("7", "S&P 500 Benchmark Algorithm"),
        ("8", "Adjustment-Aware Chart & Period Percentages"),
        ("9", "Activity Log & Undo System"),
        ("10", "Transfer System"),
        ("11", "Backdated Entry Splits"),
        ("12", "Sharing & Comparison"),
        ("13", "Security Architecture"),
        ("14", "Testing & CI/CD"),
    ]

    for num, title in toc_items:
        pdf.set_font("Helvetica", "", 11)
        pdf.set_text_color(*C_TEXT)
        pdf.cell(12, 8, f"{num}.", align="R")
        pdf.cell(5, 8, "")
        pdf.set_text_color(*C_HEADING)
        pdf.cell(0, 8, title, new_x="LMARGIN", new_y="NEXT")

    # ════════════════════════════════════════════════════════════
    # 1. SYSTEM OVERVIEW
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("1", "System Overview")

    pdf.body_text(
        "Simple Portfolio Tracker is a privacy-first web application for tracking crypto, "
        "stock/ETF, and cash holdings in a single unified dashboard. It replaces manual "
        "spreadsheet tracking with live prices, portfolio analytics, S&P 500 benchmarking, "
        "multi-currency support (EUR/USD), and secure read-only sharing. The application is "
        "designed for personal use with invite-only access, enforcing data isolation through "
        "PostgreSQL Row Level Security on every table."
    )

    pdf.sub_heading("Key Design Principles")
    pdf.bullet_bold_value("Privacy-first:", "No exchange API keys stored. Manual data entry by design. Users never expose credentials to third-party APIs.")
    pdf.bullet_bold_value("Invite-only:", "Registration requires an admin-generated invite code. Pending users are blocked at the database level by the is_active_user() RLS function.")
    pdf.bullet_bold_value("Dual currency:", "All values computed in both USD and EUR. Crypto prices are USD-primary; stocks show native trading currency. User selects a base display currency.")
    pdf.bullet_bold_value("Manual entry:", "All portfolio positions are entered manually. This is a deliberate security decision -- storing exchange API keys would be a significant attack surface.")
    pdf.bullet_bold_value("Audit trail:", "Every mutation is logged to an activity_log table with before/after snapshots, enabling undo, delta tracking, and full accountability.")

    pdf.ln(3)
    pdf.sub_heading("High-Level Architecture")
    pdf.diagram("system-overview", "System Overview -- Component interactions and data flow")

    # ════════════════════════════════════════════════════════════
    # 2. TECH STACK
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("2", "Tech Stack")

    pdf.body_text(
        "The application is built on a modern TypeScript stack with server-side rendering "
        "and server actions for data mutations. All external API calls use timeout-guarded "
        "fetch to stay within Vercel's 10-second function limit."
    )

    pdf.table(
        headers=["Layer", "Technology", "Purpose"],
        rows=[
            ["Framework", "Next.js 16 (App Router)", "SSR, routing, server actions, API routes"],
            ["Runtime", "React 19, Turbopack", "UI rendering, fast dev builds"],
            ["Language", "TypeScript (strict)", "Type safety across client and server"],
            ["Database", "Supabase PostgreSQL", "18 tables, 11 migrations, full RLS"],
            ["Auth", "Supabase Auth (JWT)", "MFA/TOTP, invite codes, role-based access"],
            ["Styling", "Tailwind CSS 4, Geist", "Utility-first CSS, 8 dark themes"],
            ["Charts", "Recharts", "Portfolio value line charts, allocation overlays"],
            ["Crypto API", "CoinGecko (Demo)", "Live prices, search, coin images (30 req/min)"],
            ["Stock API", "Yahoo Finance v7+v8", "Batch quotes (crumb auth), chart fallback"],
            ["FX API", "Frankfurter + Yahoo", "ECB-sourced EUR/USD, real-time FX"],
            ["Snapshots", "pg_cron + pg_net", "Daily cron -> Edge Function for batch snapshots"],
            ["Monitoring", "Sentry", "Error tracking, performance tracing, session replay"],
            ["Testing", "Vitest + RTL", "Unit (399), component (92), integration (54)"],
            ["CI/CD", "GitHub Actions", "Lint, build, test, preview deploy, production deploy"],
            ["Hosting", "Vercel (Hobby)", "10s function timeout, auto-scaling"],
        ],
        col_widths=[28, 42, 100],
    )

    # ════════════════════════════════════════════════════════════
    # 3. DATABASE SCHEMA
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("3", "Database Schema")

    pdf.body_text(
        "The database consists of 18 tables organized across 6 domains. All tables use UUID "
        "primary keys, soft deletes via deleted_at timestamps, and Row Level Security policies "
        "scoped to auth.uid() = user_id AND is_active_user(). Crypto quantities use "
        "NUMERIC(28,18) precision; monetary values use NUMERIC(18,2)."
    )

    pdf.sub_heading("Core Tables")
    pdf.table(
        headers=["Table", "Key Columns", "Relationships"],
        rows=[
            ["profiles", "id (= auth.uid), email, primary_currency, theme, role, status", "1:1 with auth.users. Created by handle_new_user() trigger."],
            ["institutions", "id, user_id, name, deleted_at", "Parent of wallets, brokers, bank_accounts. Cascade soft-delete trigger."],
            ["wallets", "id, user_id, name, wallet_type, chain, institution_id", "FK -> institutions. Parent of crypto_positions, exchange_deposits."],
            ["brokers", "id, user_id, name, institution_id", "FK -> institutions. Parent of stock_positions, broker_deposits."],
        ],
        col_widths=[28, 65, 77],
    )

    pdf.sub_heading("Crypto Tables")
    pdf.table(
        headers=["Table", "Key Columns", "Notes"],
        rows=[
            ["crypto_assets", "id, user_id, ticker, name, coingecko_id, chain, subcategory, image_url", "Unique on (user_id, coingecko_id) where active. Subcategory for stablecoin classification."],
            ["crypto_positions", "id, crypto_asset_id, wallet_id, quantity NUMERIC(28,18), apy", "FK -> crypto_assets, wallets. Unique on (asset, wallet) where active."],
        ],
        col_widths=[32, 65, 73],
    )

    pdf.sub_heading("Stock Tables")
    pdf.table(
        headers=["Table", "Key Columns", "Notes"],
        rows=[
            ["stock_assets", "id, user_id, ticker, name, yahoo_ticker, category, currency (TEXT), tags[]", "Currency is TEXT (not enum) to support any ISO 4217 code."],
            ["stock_positions", "id, stock_asset_id, broker_id, quantity NUMERIC(18,8)", "FK -> stock_assets, brokers. Tracks last_was_adjustment and last_was_transfer."],
        ],
        col_widths=[32, 65, 73],
    )

    pdf.sub_heading("Cash Tables")
    pdf.table(
        headers=["Table", "Key Columns", "Notes"],
        rows=[
            ["cash_accounts", "id, user_id, institution_id, currency, balance, apy, wallet_id, broker_id", "Unified table (Phase 34) replacing bank_accounts + exchange_deposits + broker_deposits."],
            ["bank_accounts", "id, user_id, name, bank_name, currency, balance, apy, institution_id", "Legacy table. Still in schema for backward-compatible undo of historical entries."],
            ["exchange_deposits", "id, user_id, wallet_id, currency, amount, apy", "Legacy. Unique on (user_id, wallet_id, currency) where active."],
            ["broker_deposits", "id, user_id, broker_id, currency, amount, apy", "Legacy. Unique on (user_id, broker_id, currency) where active."],
        ],
        col_widths=[32, 65, 73],
    )

    # Page break for remaining schema
    pdf.new_section_page()

    pdf.sub_heading("Portfolio & Sharing Tables")
    pdf.table(
        headers=["Table", "Key Columns", "Notes"],
        rows=[
            ["portfolio_snapshots", "id, user_id, snapshot_date, total_value_usd/eur, crypto/stocks/cash_value_usd, per-class EUR values", "Unique on (user_id, snapshot_date). 12 value columns for FX decomposition."],
            ["portfolio_shares", "id, owner_id, share_type (link|user), token, scope, expires_at, revoked_at", "Nanoid tokens. Scope: overview, full, full_with_history. CHECK constraints enforce token/viewer presence."],
        ],
        col_widths=[32, 65, 73],
    )

    pdf.sub_heading("Activity & Trading Tables")
    pdf.table(
        headers=["Table", "Key Columns", "Notes"],
        rows=[
            ["activity_log", "id, user_id, action, entity_type, entity_name, before/after_snapshot, delta_usd/eur, transfer_group_id, compensates_for, effective_date, split_from_id, cashflow_amount_usd/eur", "Central audit trail. 25+ columns covering deltas, transfers, splits, cashflows, undo state."],
            ["invite_codes", "id, code, created_by, used_by, used_at, expires_at", "Admin-generated. Single-use. Invited users auto-approved."],
            ["diary_entries", "id, user_id, entry_date, content", "Free-form portfolio diary."],
            ["goal_prices", "id, crypto_asset_id, target_price, weight, label", "Price targets for crypto assets."],
            ["trade_entries", "id, user_id, trade_date, asset_type, asset_name, action, quantity, price, currency", "Manual trade log. CHECK constraints on action (buy/sell) and asset_type."],
        ],
        col_widths=[28, 65, 77],
    )

    pdf.sub_heading("RLS Policy Pattern")
    pdf.body_text(
        "Every table has RLS enabled with policies following this pattern:"
    )
    pdf.code_block(
        'CREATE POLICY "Users can access own data"\n'
        "ON table_name FOR ALL\n"
        "USING (auth.uid() = user_id AND is_active_user());"
    )
    pdf.body_text(
        "The is_active_user() function checks that the authenticated user's profile "
        "has status = 'active', blocking pending or suspended users at the database level. "
        "SECURITY DEFINER functions (cascade_soft_delete, handle_new_user, call_daily_snapshot, "
        "sync_institution_name) have explicit REVOKE from anon and authenticated roles."
    )

    # ════════════════════════════════════════════════════════════
    # 4. APPLICATION ARCHITECTURE
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("4", "Application Architecture")

    pdf.sub_heading("Request Flow")
    pdf.diagram("request-flow", "Request flow through application layers")

    pdf.sub_heading("Four Supabase Clients")
    pdf.table(
        headers=["Client", "Use Case", "Auth Level"],
        rows=[
            ["Browser", "Client components, real-time subscriptions", "Anon key + user JWT"],
            ["Server", "Server components, server actions", "Anon key + user cookie"],
            ["Middleware", "Auth guard in proxy.ts", "Anon key + request cookies"],
            ["Admin", "User management, cron, backfill", "Service-role key (bypasses RLS)"],
        ],
        col_widths=[28, 80, 62],
    )

    pdf.sub_heading("Server Actions vs. API Routes")
    pdf.body_text(
        "The application uses Server Actions (\"use server\" functions) for all data mutations: "
        "creating, updating, and deleting portfolio entities. This provides automatic CSRF "
        "protection and eliminates the need for separate API endpoints for write operations."
    )
    pdf.body_text(
        "API Routes are reserved for operations that require custom HTTP handling: "
        "user registration, CoinGecko/Yahoo search endpoints, portfolio holdings for the "
        "command palette, and the /api/health status check. All API routes (except /api/health) "
        "require authentication via supabase.auth.getUser() and return 401 on failure."
    )

    pdf.sub_heading("File Structure Overview")
    pdf.code_block(
        "src/\n"
        "  app/             App Router pages & API routes\n"
        "    dashboard/     Main dashboard, compare, settings\n"
        "    api/           REST endpoints (search, quotes, health)\n"
        "    share/[token]/ Read-only shared portfolio views\n"
        "    login/         Authentication pages\n"
        "  components/      React components by domain\n"
        "    crypto/        Crypto table, modals, position editor\n"
        "    stocks/        Stock table, modals, position editor\n"
        "    cash/          Cash accounts table and modals\n"
        "    dashboard/     Chart, grid, market panel, sidebar\n"
        "    ui/            Shared primitives (modals, tooltips, etc.)\n"
        "  lib/\n"
        "    actions/       23 server action modules\n"
        "    portfolio/     Aggregation, chart enrichment, insights\n"
        "    prices/        CoinGecko, Yahoo, FX clients\n"
        "    supabase/      4 client configurations\n"
        "    hooks/         Custom React hooks\n"
        "supabase/\n"
        "  migrations/      001 through 011 (consolidated)\n"
        "  functions/       Edge Functions (daily-snapshot)\n"
        "__tests__/\n"
        "  unit/            399 unit tests (27 files)\n"
        "  component/       92 component tests (12 files)\n"
        "  integration/     54 integration tests (10 files)"
    )

    # ════════════════════════════════════════════════════════════
    # 5. PRICE PIPELINE
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("5", "Price Pipeline")

    pdf.body_text(
        "The application fetches live prices from three external APIs, all wrapped in "
        "fetchWithTimeout() which uses an 8-second AbortController to ensure requests "
        "complete within Vercel's 10-second function timeout."
    )

    pdf.sub_heading("Crypto Prices (CoinGecko)")
    pdf.bullet_bold_value("Endpoint:", "/api/v3/simple/price with vs_currencies=usd,eur and include_24hr_change=true")
    pdf.bullet_bold_value("Rate limit:", "Free Demo plan -- 30 calls/minute with API key in x-cg-demo-key header")
    pdf.bullet_bold_value("Search:", "/api/v3/search for asset lookup by name, ticker, or contract address")
    pdf.bullet_bold_value("History:", "/api/v3/coins/{id}/market_chart for historical prices (benchmark, delta backfill)")

    pdf.sub_heading("Stock Prices (Yahoo Finance)")
    pdf.bullet_bold_value("Primary (v7 batch):", "Single request for all user tickers. Requires crumb+cookie authentication -- fetches a crumb token from Yahoo's consent flow, then passes it with session cookies.")
    pdf.bullet_bold_value("Fallback (v8 chart):", "For tickers missing from v7 batch response. Chunked in groups of 20 to avoid URL length limits.")
    pdf.bullet_bold_value("Data returned:", "Current price, previous close, 24h change, currency, regularMarketTime per ticker.")

    pdf.sub_heading("FX Rates")
    pdf.bullet_bold_value("Frankfurter:", "ECB-sourced historical and current EUR/USD rates. Used for delta computation and chart FX decomposition.")
    pdf.bullet_bold_value("Yahoo EURUSD=X:", "Real-time EUR/USD rate for dashboard display. Also provides historical FX via chart API.")
    pdf.bullet_bold_value("Conversion:", "computeActivityFx() and computeActivityFxWithConversion() compute dual-currency deltas at write time using historical rates.")

    pdf.sub_heading("Data Flow")
    pdf.diagram("price-pipeline", "Price data pipeline -- external APIs through fetchWithTimeout to dashboard")

    # ════════════════════════════════════════════════════════════
    # 6. PORTFOLIO SNAPSHOTS & CHART
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("6", "Portfolio Snapshots & Chart")

    pdf.sub_heading("Snapshot Pipeline")
    pdf.diagram("snapshot-flow", "Dual snapshot paths -- daily cron and on-demand dashboard load")

    pdf.sub_heading("Daily Cron Snapshots")
    pdf.body_text(
        "Portfolio snapshots are taken daily via a PostgreSQL cron job. The pg_cron extension "
        "schedules a call at 23:59 UTC that uses pg_net to invoke a Supabase Edge Function. "
        "The Edge Function authenticates with a CRON_SECRET bearer token and iterates over "
        "all active users, computing and storing a snapshot for each."
    )

    pdf.sub_heading("On-Demand Snapshots")
    pdf.body_text(
        "Every dashboard load triggers a fire-and-forget snapshot creation. This ensures "
        "snapshots exist even if the cron job fails. The UPSERT uses ON CONFLICT (user_id, "
        "snapshot_date) to deduplicate -- the cron job will not overwrite a more complete "
        "earlier snapshot from the same day."
    )

    pdf.sub_heading("Snapshot Columns")
    pdf.body_text("Each snapshot stores 12 value columns for precise FX decomposition:")
    pdf.table(
        headers=["Column", "Description"],
        rows=[
            ["total_value_usd / total_value_eur", "Full portfolio value in both currencies"],
            ["crypto_value_usd / crypto_value_eur", "Crypto positions (stablecoins -> cash)"],
            ["stocks_value_usd / stocks_value_eur", "Stock/ETF positions"],
            ["cash_value_usd / cash_value_eur", "All cash holdings"],
            ["stocks_eur_denominated_value", "Value of EUR-traded stocks (for FX attribution)"],
            ["cash_eur_denominated_value", "Value of EUR-denominated cash (for FX attribution)"],
        ],
        col_widths=[65, 105],
    )

    pdf.sub_heading("Chart View Modes")
    pdf.body_text(
        "The portfolio chart supports 5 view modes: Total, Investments (crypto + stocks), "
        "Crypto, Stocks, and Cash. Each mode slices the appropriate value columns from "
        "snapshots. The S&P 500 benchmark line is scaled per-mode using the ratio of the "
        "class value to total value at each cash flow date."
    )
    pdf.bullet_bold_value("Allocation overlay:", "In total mode, three overlapping Area elements show crypto/stocks/cash proportions (overlapping fills from yDomain minimum, not stacked).")
    pdf.bullet_bold_value("Return mode:", "Toggle to cumulative percentage return view. Both portfolio and S&P start at 0% and diverge.")

    # ════════════════════════════════════════════════════════════
    # 7. S&P 500 BENCHMARK
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("7", "S&P 500 Benchmark Algorithm")

    pdf.body_text(
        "The S&P 500 benchmark answers: \"What if I had invested the same cash flows into "
        "the S&P 500 instead?\" It uses a cash-flow-adjusted approach that replays actual "
        "deposits and withdrawals into a hypothetical S&P investment."
    )

    pdf.sub_heading("Algorithm Visualization")
    pdf.diagram("sp500-benchmark", "S&P 500 benchmark -- cash flow replay into hypothetical S&P units")

    pdf.sub_heading("Algorithm Steps")
    pdf.bullet_bold_value("Step 1:", "Take the first portfolio snapshot value. Compute initial S&P units: units = first_value / sp500_price_on_first_date.")
    pdf.bullet_bold_value("Step 2:", "For each cash flow (deposit or withdrawal) from the activity log: units += cashflow_amount_usd / sp500_price_on_that_date.")
    pdf.bullet_bold_value("Step 3:", "On any chart date: hypothetical_value = units * sp500_price_on_that_date.")
    pdf.bullet_bold_value("Step 4:", "Seed additional units from the first adjusted chart point to compensate for adjustment-flagged imports (which are excluded from cash flows).")

    pdf.sub_heading("Cash Flow Derivation")
    pdf.body_text(
        "Cash flows are derived from the activity_log table. Each entry carries pre-computed "
        "cashflow_amount_usd and cashflow_amount_eur columns (written at mutation time). "
        "The deriveCashFlows() function reads these directly -- no historical price fetches "
        "needed at read time."
    )
    pdf.bullet_bold_value("Filtering:", "Entries with is_adjustment = true are excluded (not real deposits). Entries with undone_at IS NOT NULL are excluded (reversed transactions). Transfer legs are excluded (both legs are is_adjustment = true).")
    pdf.bullet_bold_value("Classification:", "Each cash flow is tagged with an asset_class (crypto, stocks, cash) using the same classification as getAdjustmentDeltas(). Stablecoin positions are classified as cash to match aggregate.ts.")
    pdf.bullet_bold_value("Dual currency:", "CashFlowEvent carries both amount_usd and optional amount_eur (computed via historical FX). EUR entities pass through natively to avoid lossy USD->EUR round-trip conversion.")

    pdf.sub_heading("Per-Class Scaling")
    pdf.body_text(
        "When the chart is in a per-class view mode (Crypto, Stocks, Cash), each cash flow "
        "is scaled by the ratio of that class's value to the total portfolio value at the "
        "nearest snapshot date:"
    )
    pdf.code_block(
        "adjusted_cashflow = cashflow * (class_value_usd / total_value_usd)\n"
        "\n"
        "Example: $1000 deposit, crypto is 60% of portfolio\n"
        "-> Crypto view: adjusted_cf = $1000 * 0.60 = $600\n"
        "-> Benchmark shows what $600 in S&P would have returned"
    )

    pdf.sub_heading("S&P Seeding (Adjustment Compensation)")
    pdf.body_text(
        "Because adjustment-flagged entries are excluded from cash flows but their value "
        "IS in the portfolio, the benchmark needs initial capital seeding. After computing "
        "units from cash flows, additional units are seeded from the first chart point's "
        "adjusted value. The conversion uses a three-tier fallback: (1) per-class ratio "
        "slice_usd/slice_val, (2) portfolio-wide ratio, (3) identity 1."
    )

    # ════════════════════════════════════════════════════════════
    # 8. ADJUSTMENT-AWARE CHART
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("8", "Adjustment-Aware Chart & Period Percentages")

    pdf.sub_heading("The Problem")
    pdf.body_text(
        "When a user imports existing holdings (e.g., migrating from another tracker), "
        "the portfolio value jumps suddenly. Without compensation, the chart shows an "
        "artificial upward ramp from zero to the imported value, and period percentages "
        "(7d, 30d, 1y) show inflated growth that is not real investment performance."
    )

    pdf.sub_heading("Chart Adjustment Formula")
    pdf.body_text("For each chart point, the adjusted value is computed as:")
    pdf.code_block(
        "adjustedValue = rawValue + (finalCumulativeDelta - cumulativeDeltaAtDate)\n"
        "\n"
        "Where:\n"
        "  rawValue             = snapshot value on that date\n"
        "  cumulativeDeltaAtDate = sum of all adjustment deltas\n"
        "                         up to and including that date\n"
        "  finalCumulativeDelta  = sum of ALL adjustment deltas\n"
        "                         (total at the end of the timeline)\n"
        "\n"
        "Effect: Early dates get boosted by not-yet-imported value,\n"
        "flattening the artificial ramp. Current value stays exact."
    )

    pdf.sub_heading("Period Percentage Compensation")
    pdf.body_text(
        "The same formula applies to the 7d, 30d, and 1y summary percentages. The past "
        "snapshot value is adjusted before computing the percentage change:"
    )
    pdf.code_block(
        "adjustedPastValue = rawPastValue\n"
        "                  + (finalCumDelta - cumDeltaAtPastSnapshot)\n"
        "\n"
        "changePercent = (currentValue - adjustedPastValue)\n"
        "                / adjustedPastValue * 100"
    )

    pdf.sub_heading("Implementation Details")
    pdf.bullet_bold_value("getAdjustmentDeltas():", "Queries activity_log for entries where is_adjustment = true AND undone_at IS NULL AND delta_usd IS NOT NULL. Returns running cumulative sums per date, with per-class breakdown (crypto, stocks, cash).")
    pdf.bullet_bold_value("Per-class support:", "Each adjustment delta carries per-class cumulatives (crypto_cumulative_usd/eur, stocks_cumulative_usd/eur, cash_cumulative_usd/eur). Chart view modes use the appropriate class-specific deltas.")
    pdf.bullet_bold_value("Always-on:", "Adjustment compensation is automatically applied whenever deltas exist. There is no user-facing toggle -- the feature was simplified after removing a debug-only toggle that added UX complexity without user benefit.")
    pdf.bullet_bold_value("Effective date ordering:", "All queries use COALESCE(effective_date, created_at) for date ordering and post-sort results to ensure correct chronological cumulative sums.")

    # ════════════════════════════════════════════════════════════
    # 9. ACTIVITY LOG & UNDO
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("9", "Activity Log & Undo System")

    pdf.sub_heading("Activity Log Structure")
    pdf.body_text(
        "Every portfolio mutation writes to the activity_log table with comprehensive "
        "metadata. The log serves as an audit trail, undo mechanism, delta source for "
        "chart adjustments, and cash flow source for the S&P benchmark."
    )
    pdf.table(
        headers=["Field Group", "Columns", "Purpose"],
        rows=[
            ["Identity", "entity_type, entity_name, entity_id, entity_table", "What was changed and where"],
            ["Action", "action (created/updated/removed/undone)", "What type of change"],
            ["Snapshots", "before_snapshot, after_snapshot (JSONB)", "Full entity state before/after for undo"],
            ["Deltas", "delta_usd, delta_eur, delta_status", "Value change in both currencies (write-time)"],
            ["Cashflows", "cashflow_amount_usd/eur, cashflow_asset_class, cashflow_status", "Pre-computed cash flow for S&P benchmark"],
            ["Transfers", "transfer_group_id", "Links two-legged transfer entries"],
            ["Undo", "undone_at, compensates_for", "Undo timestamp and compensation link"],
            ["Splits", "effective_date, split_from_id", "Backdated date and parent entry reference"],
            ["Flags", "is_adjustment", "Marks non-real transactions (imports, corrections)"],
        ],
        col_widths=[25, 58, 87],
    )

    pdf.sub_heading("Write-Time Delta Computation")
    pdf.body_text(
        "When a mutation occurs, the server action computes the value change (delta) at "
        "write time using computeActivityFx() or computeActivityFxWithConversion(). These "
        "functions fetch the current or historical FX rate (via Frankfurter for backdated "
        "entries) and compute deltas in both USD and EUR. This avoids expensive historical "
        "price lookups at read time."
    )

    pdf.sub_heading("Undo System")
    pdf.diagram("undo-system", "Undo routing -- split check, transfer group, and single entry paths")

    pdf.sub_heading("Undo via Compensating Transactions")
    pdf.body_text(
        "The undo system uses compensating transactions rather than snapshot restoration. "
        "This is safer because it preserves intermediate changes made after the original action."
    )
    pdf.bullet_bold_value("Delta reversal:", "For value fields (balance, quantity, amount): new_value = current_value + (before_value - after_value). This applies the inverse of the original change.")
    pdf.bullet_bold_value("Safe restore:", "For identity fields (name, currency): restore the before_snapshot value only if the current value still matches the after_snapshot. If someone changed it since, the undo skips that field.")
    pdf.bullet_bold_value("Compensation linking:", "The compensates_for UUID column links the undo entry to the original. A double-undo prevention check looks for active (non-undone) compensation entries.")
    pdf.bullet_bold_value("Redo:", "Undoing a compensation entry delta-reverses it AND clears the original's undone_at, effectively re-doing the original action.")

    pdf.sub_heading("Transfer Undo")
    pdf.body_text(
        "Transfers (two-legged operations) are undone sequentially. If the second leg's undo "
        "fails, the first leg's compensation is auto-rolled back via snapshot restoration "
        "(safe because it was just created). The undoTransferGroup() function detects the "
        "transfer_group_id and coordinates both legs."
    )

    pdf.sub_heading("Split Undo")
    pdf.body_text(
        "When an entry has been split into children (via split_from_id), the undo check "
        "runs BEFORE the undone_at guard. Unsplit hard-deletes all children and restores "
        "the parent's undone_at to NULL."
    )

    # ════════════════════════════════════════════════════════════
    # 10. TRANSFER SYSTEM
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("10", "Transfer System")

    pdf.body_text(
        "Portfolio transfers model real-world operations: selling a position for cash, "
        "buying a new position with cash, or moving holdings between institutions. "
        "All transfers use a two-legged model linked by a transfer_group_id UUID."
    )

    pdf.sub_heading("Two-Legged Model")
    pdf.diagram("transfer-model", "Transfer model -- source reduces, destination increases, both marked as adjustment")

    pdf.sub_heading("Transfer Modes")
    pdf.table(
        headers=["Mode", "Source", "Destination", "Use Case"],
        rows=[
            ["Sell", "Crypto/stock position", "Cash account", "Taking profits, rebalancing"],
            ["Buy", "Cash account (or skip)", "Crypto/stock position", "New purchase via wizard"],
            ["Move", "Position at Location A", "Same asset at Location B", "Transferring between brokers"],
        ],
        col_widths=[18, 42, 42, 68],
    )

    pdf.sub_heading("Buy Wizard")
    pdf.body_text(
        "The buy mode provides a guided multi-step flow: (1) search and select asset, "
        "(2) pick or create institution (broker/exchange), (3) optionally track cash "
        "(auto-detect existing deposit, declare new balance, or skip), (4) review and "
        "execute. Skipping cash creates a single-legged entry identical to the Add Asset flow."
    )

    pdf.sub_heading("Failure Handling")
    pdf.body_text(
        "The executeTransfer() function implements careful rollback. If the destination leg "
        "fails after the source leg succeeds, the source is reversed. If both legs fail and "
        "new entities were created during the flow (broker, wallet, deposit), they are "
        "hard-deleted via cleanupTransferEntities() in reverse FK order."
    )

    # ════════════════════════════════════════════════════════════
    # 11. BACKDATED ENTRY SPLITS
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("11", "Backdated Entry Splits")

    pdf.body_text(
        "Backdated entry splits solve the problem of recording when money actually entered "
        "the portfolio versus when the user entered it into the tracker. This affects "
        "benchmarks, chart accuracy, and period percentages."
    )

    pdf.sub_heading("Split Operation")
    pdf.diagram("split-flow", "Split operation -- parent marked undone, children created with effective dates")

    pdf.sub_heading("effective_date Column")
    pdf.body_text(
        "Every activity_log entry has an optional effective_date (DATE) column. When set, "
        "all pipelines use COALESCE(effective_date, created_at) instead of raw created_at "
        "for date-based operations. The original created_at timestamp is preserved as the "
        "recording date. This applies to:"
    )
    pdf.bullet("getAdjustmentDeltas() -- cumulative delta computation")
    pdf.bullet("deriveCashFlows() -- S&P benchmark cash flow timeline")
    pdf.bullet("toggleActivityAdjustment() -- retroactive price lookups")
    pdf.bullet("backfillCashflowsAndDeltas() -- batch delta recomputation")
    pdf.bullet("exportActivityLogsCsv() -- CSV export with effective dates")

    pdf.sub_heading("Unsplit")
    pdf.body_text(
        "The unsplit operation hard-deletes all children and restores the parent by clearing "
        "its undone_at. This is checked before the normal undo guard, so undoing a split "
        "parent triggers unsplit rather than a normal undo."
    )

    # ════════════════════════════════════════════════════════════
    # 12. SHARING & COMPARISON
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("12", "Sharing & Comparison")

    pdf.body_text(
        "The sharing system allows users to create read-only portfolio views accessible via "
        "unique URLs. Share tokens are generated using nanoid and stored in the "
        "portfolio_shares table with configurable scope and expiry."
    )

    pdf.sub_heading("Share Scopes")
    pdf.table(
        headers=["Scope", "What is Visible"],
        rows=[
            ["overview", "Total value, allocation breakdown, chart"],
            ["full", "All of overview + crypto, stocks, cash detail tables"],
            ["full_with_history", "All of full + activity timeline and trade diary"],
        ],
        col_widths=[45, 125],
    )

    pdf.sub_heading("TWR-Based Comparison")
    pdf.body_text(
        "The comparison feature uses Time-Weighted Return (TWR) to compare portfolio "
        "performance across users. TWR strips out cash flow noise (deposits/withdrawals) "
        "so that two portfolios with different investment timings can be fairly compared. "
        "The dedicated comparison page (/dashboard/compare/[token]) shows allocation radar "
        "charts, holdings overlap, performance race charts, and what-if scenario modeling."
    )

    # ════════════════════════════════════════════════════════════
    # 13. SECURITY ARCHITECTURE
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("13", "Security Architecture")

    pdf.body_text(
        "Security is enforced at multiple layers following a defense-in-depth approach. "
        "No single layer is trusted exclusively."
    )

    pdf.sub_heading("Security Layers")
    pdf.diagram("security-layers", "Defense-in-depth -- 5 security layers from request to database")

    pdf.sub_heading("Database Layer")
    pdf.bullet_bold_value("Row Level Security:", "Every table has RLS enabled with policies scoped to auth.uid() = user_id AND is_active_user(). No query can access another user's data, even if application logic has a bug.")
    pdf.bullet_bold_value("is_active_user():", "An RLS helper function that checks the user's profile status = 'active'. Pending users (registered without invite) and suspended users are blocked at the SQL level.")
    pdf.bullet_bold_value("SECURITY DEFINER:", "Functions that need elevated privileges (cascade_soft_delete, handle_new_user, call_daily_snapshot) run as the defining role. Each has explicit REVOKE from anon and authenticated to prevent direct invocation.")
    pdf.bullet_bold_value("Soft deletes:", "deleted_at timestamps with partial unique indexes ensure deduplication only among active records.")

    pdf.sub_heading("Application Layer")
    pdf.bullet_bold_value("Auth guard (proxy.ts):", "Middleware intercepts all requests except /api/*. Unauthenticated users are redirected to /login.")
    pdf.bullet_bold_value("API route auth:", "All API routes (except /api/health) call supabase.auth.getUser() and return 401 on failure.")
    pdf.bullet_bold_value("Rate limiting:", "Sliding-window rate limiter (src/lib/rate-limit.ts) applied to all API endpoints. Limits: 5/min registration, 30/min search and holdings, 60/min detail and quotes.")
    pdf.bullet_bold_value("Input validation:", "All server actions and API routes validate inputs using validators from src/lib/validation.ts. Includes validateCoinGeckoId and validateYahooTicker to prevent URL parameter injection attacks.")
    pdf.bullet_bold_value("CSRF protection:", "Server Actions provide built-in CSRF protection via Next.js (automatic token validation).")

    pdf.sub_heading("Network Layer")
    pdf.table(
        headers=["Header", "Value", "Purpose"],
        rows=[
            ["Strict-Transport-Security", "max-age=63072000; includeSubDomains", "Force HTTPS for 2 years"],
            ["X-Content-Type-Options", "nosniff", "Prevent MIME type sniffing"],
            ["X-Frame-Options", "DENY", "Prevent clickjacking"],
            ["Referrer-Policy", "strict-origin-when-cross-origin", "Limit referrer leakage"],
            ["Permissions-Policy", "camera=(), microphone=(), geolocation=()", "Disable unused browser APIs"],
        ],
        col_widths=[48, 62, 60],
    )

    pdf.sub_heading("Authentication")
    pdf.bullet_bold_value("Invite-only:", "Registration requires a valid, unexpired, unused invite code. Users without an invite are created with status = 'pending' and blocked by RLS.")
    pdf.bullet_bold_value("MFA:", "TOTP-based two-factor authentication via Supabase Auth. Configurable per user in settings.")
    pdf.bullet_bold_value("JWT:", "Supabase issues short-lived JWTs. The middleware client validates tokens on every request.")
    pdf.bullet_bold_value("Account deletion:", "Uses admin.auth.admin.deleteUser() to fully remove from auth.users (not just the profile row).")

    # ════════════════════════════════════════════════════════════
    # 14. TESTING & CI/CD
    # ════════════════════════════════════════════════════════════
    pdf.new_section_page()
    pdf.section_title("14", "Testing & CI/CD")

    pdf.sub_heading("Test Architecture")
    pdf.body_text(
        "The test suite is organized into three layers, each with its own Vitest project "
        "configuration. Total: 545 tests across 49 files."
    )

    pdf.table(
        headers=["Layer", "Count", "Runtime", "Scope"],
        rows=[
            ["Unit", "399 tests (27 files)", "~500ms", "Pure functions: validation, formatting, aggregation, deltas, cashflows, chart enrichment, CSV, rate limiting"],
            ["Component", "92 tests (12 files)", "~1.3s", "React components via RTL + jsdom: tooltips, modals, buttons, popovers, column settings"],
            ["Integration", "54 tests (10 files)", "~1s", "Real Supabase via Docker: RLS enforcement, cascade deletes, server actions, migration bootstrap"],
        ],
        col_widths=[24, 38, 18, 90],
    )

    pdf.sub_heading("Testing Patterns")
    pdf.bullet_bold_value("Server action mocking:", "vi.hoisted + vi.mock('@/lib/supabase/server') injects test clients into 'use server' modules. Also mocks next/cache, price clients, and admin client.")
    pdf.bullet_bold_value("Integration auth:", "auth.signUp() (not admin.createUser() due to ES256 JWT issues) with retry logic for transient failures under concurrent test load.")
    pdf.bullet_bold_value("Cleanup:", "Integration tests clean up via docker exec psql. Component tests use explicit afterEach(cleanup) since RTL auto-cleanup does not work in Vitest project mode without globals: true.")
    pdf.bullet_bold_value("Fake timers:", "afterEach(() => vi.useRealTimers()) prevents timer poisoning. Tests use fireEvent (sync) instead of userEvent (async) with fake timers.")

    pdf.sub_heading("CI/CD Pipeline")
    pdf.diagram("ci-pipeline", "CI/CD pipeline -- test, preview, and deploy jobs")

    pdf.sub_heading("Development Phases")
    pdf.body_text(
        "The application has been developed over 34 phases, from the initial Core Schema "
        "through Cash Table Consolidation. Each phase is documented in ROADMAP.md. Key "
        "milestones include: Dashboard UI (Phase 3), Performance Charts (Phase 10), "
        "Multi-User (Phase 18), Portfolio Adjustments (Phase 20), Transfers (Phase 21), "
        "Testing Infrastructure (Phase 24), 13-Round Security Audit (Phase 32), "
        "and Adjustment-Aware Periods (Phase 33)."
    )

    # ── OUTPUT ───────────────────────────────────────────────────
    pdf.output(OUTPUT_PATH)
    abs_path = os.path.abspath(OUTPUT_PATH)
    size_kb = os.path.getsize(abs_path) / 1024
    print(f"PDF generated: {abs_path}")
    print(f"Pages: {pdf.page_no()}")
    print(f"Size: {size_kb:.0f} KB")


if __name__ == "__main__":
    build_document()
