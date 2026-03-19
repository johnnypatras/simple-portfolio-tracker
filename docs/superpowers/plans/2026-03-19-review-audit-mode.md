# Review Audit Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 16-agent iterative audit mode to the existing `/review` skill.

**Architecture:** Append audit mode section to existing SKILL.md. The skill detects `/review audit` vs `/review` and branches to the appropriate mode. All agent types are built-in — no custom agents to create.

**Tech Stack:** Claude Code skill (Markdown), built-in agent types, pr-review-toolkit agents

**Spec:** `docs/superpowers/specs/2026-03-19-review-audit-mode-design.md`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `.claude/skills/review/SKILL.md` | Modify | Add audit mode section after existing standard mode content |

Only one file changes. The existing standard mode content (lines 1-227) stays exactly as-is. The audit mode is appended after.

---

### Task 1: Update Skill Frontmatter

**Files:**
- Modify: `.claude/skills/review/SKILL.md` (lines 1-12)

- [ ] **Step 1: Update the frontmatter description to mention audit mode**

Change the `description` field to include "audit" as a trigger word. The current description covers standard mode triggers. Add audit mode:

```yaml
---
name: review
description: >
  Comprehensive code review and cleanup for the portfolio tracker codebase. Two modes:
  Standard mode covers security, performance, type safety, dead code, UI consistency,
  convention adherence, and code quality for recently changed code. Audit mode
  (`/review audit`) runs 16 specialist agents against the full codebase in iterative
  rounds until zero findings remain. Use this skill whenever the user asks for a
  "code review", "cleanup", "review my code", "professional review", "comprehensive review",
  "exhaustive review", "full review", or any variation of reviewing and cleaning up recently
  changed code. Also trigger when the user says "audit the codebase", "review and fix",
  "check the code", "make sure everything is clean", or "do a review pass".
---
```

- [ ] **Step 2: Verify no syntax errors in frontmatter**

Check that the YAML frontmatter is valid (proper indentation, no stray characters).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/review/SKILL.md
git commit -m "feat: update review skill frontmatter for audit mode"
```

---

### Task 2: Add Mode Detection Section

**Files:**
- Modify: `.claude/skills/review/SKILL.md` (insert after line 12, before existing content)

- [ ] **Step 1: Add mode detection section right after the frontmatter, before the existing `# Comprehensive Code Review & Cleanup` heading**

Insert this block between the frontmatter `---` and the existing `# Comprehensive Code Review & Cleanup`:

```markdown
## Mode Detection

This skill has two modes. Detect which mode to use BEFORE doing anything else:

- **`/review audit`** → Jump to the **Audit Mode** section below
- **`/review`** (any other invocation) → Continue with Standard Mode below

The `exhaustive`/`full` keywords in standard mode continue to mean "spawn all 4 agents
regardless of scope" — they do NOT trigger audit mode. Only the explicit `audit` keyword does.

---
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/review/SKILL.md
git commit -m "feat: add mode detection section to review skill"
```

---

### Task 3: Add Audit Mode Content

**Files:**
- Modify: `.claude/skills/review/SKILL.md` (append after existing content, line 227+)

This is the main task — appending the full audit mode section. The content comes directly from the spec, adapted into skill instructions.

- [ ] **Step 1: Append the audit mode section after the existing content**

Append everything below after the current last line of SKILL.md:

````markdown

---

# Audit Mode

> Triggered by `/review audit`. Runs 16 specialist agents against the FULL codebase
> in iterative rounds until zero objective findings remain (max 5 rounds).
>
> **Cost**: ~800K-1.2M tokens per round, 3 rounds ≈ 2.4-3.6M tokens.
> **Time**: ~6-8 minutes per round, 3 rounds ≈ 20-25 minutes.
> **When to use**: Pre-release, pre-merge of major features, quarterly audits. NOT for everyday changes.

## Audit Philosophy

- **Zero tolerance.** Every finding gets fixed or explicitly accepted by the user. No severity thresholds.
- **Iterative.** Review → fix → re-review until clean. Not a single pass.
- **Full codebase.** Always reviews everything: `src/`, `scripts/`, `.github/`, `__tests__/`, `supabase/`.
- **Objective only.** Agents report bugs, violations, and broken patterns — not style preferences.
- **User synergy.** Ambiguous items are batched into a single decision prompt per round.

## Phase 0 — Context & Calibration (do this yourself, no agents)

1. Read `CLAUDE.md` (project root)
2. Read memory files:
   - `~/.claude/projects/-Users-lxp-simple-portfolio-tracker/memory/MEMORY.md` (UI patterns, testing, skills)
   - Topic files relevant to the audit: `gotchas.md`, `decisions.md`, `apis.md`
3. Build the **shared context package** (used by all 16 agents):
   - CLAUDE.md conventions (full file content)
   - UI patterns table from MEMORY.md
   - Key gotchas and decisions
4. Run automated checks in parallel:
   ```bash
   npm run build 2>&1 | tail -30
   npm run lint 2>&1 | tail -50
   npm test 2>&1 | tail -10
   npm run test:component 2>&1 | tail -10
   ```
   If local Supabase is running, also run integration tests:
   ```bash
   npx vitest run --project integration 2>&1 | tail -10
   ```
   If any fail, fix before proceeding — broken code can't be meaningfully audited.
5. Count files in scope:
   ```bash
   find src/ scripts/ .github/ __tests__/ supabase/ -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.sh' -o -name '*.yml' -o -name '*.sql' \) | wc -l
   ```

## Phase 1 — 16-Agent Review (Round N)

Launch agents in 4 batches of 4. Each batch runs in parallel via the `Agent` tool.
Wait for each batch to complete before launching the next.

### Model Selection

All 16 agents use the same model per audit run:
- **Default: `model: "sonnet"`**
- **Escalate to `model: "opus"`** when:
  - Codebase includes financial logic (`aggregate.ts`, `benchmark.ts`, `dashboard-insights.ts`, `fx.ts`, `cashflow.ts`, `deltas.ts`)
  - Previous round found Critical issues needing careful analysis
  - User explicitly asks for "deep" or "thorough"

### Agent Prompt Template

Every agent receives this prompt structure. Fill in the bracketed sections per agent.

```
You are a [ROLE] reviewing the portfolio tracker codebase at /Users/lxp/simple-portfolio-tracker.

## Project Conventions (from CLAUDE.md)
[PASTE FULL CLAUDE.MD CONTENT]

## Key Patterns (from memory)
[PASTE RELEVANT MEMORY SECTIONS — UI patterns for Frontend agent, gotchas for all, etc.]

## Your Assignment
PRIMARY focus area: [AGENT-SPECIFIC FOCUS]
Primary file set (start here, explore others if following a lead): [FILE LIST]

## Specific Checklist
[AGENT-SPECIFIC CHECKLIST — see below]

## Calibration
Report only OBJECTIVE issues — violations of stated conventions, bugs, security flaws,
broken patterns, missing required behavior.
Do NOT report style preferences, subjective naming suggestions, or "consider doing X" advice.

If you notice an issue clearly in another agent's domain, include it with a
[CROSS-DOMAIN] tag (brief description only — don't investigate deeply).

## Output Format
For each finding:
- File path and line number
- Severity: CRITICAL / HIGH / MEDIUM / LOW
- Description: what's wrong and why it matters
- Suggested fix: exact code change or approach

If you find zero issues in your focus area, say CLEAN and list what you checked.

[ROUND 2+ ONLY — add this section]
These issues were FIXED in previous rounds — do NOT re-report:
[ITEMIZED LIST FROM LATEST ROUND]
[SUMMARY OF OLDER ROUNDS]

These files were modified by fixes — check for regressions:
[MODIFIED FILES LIST]

These items were decided by the user — do NOT re-flag:
[USER DECISIONS LIST]
```

### Batch 1 (agents 1-4, launch in parallel)

**Agent 1: Security Engineer** (`subagent_type: "Security Engineer"`)
- Primary files: `src/lib/actions/`, `src/app/api/`, `src/lib/validation.ts`, `src/lib/supabase/`, `src/proxy.ts`, `src/lib/rate-limit.ts`, `src/lib/share-utils.ts`, `src/lib/csv.ts`
- Checklist: OWASP Top 10 (XSS, injection, SSRF, open redirects), server action input validation (every mutation validates with `src/lib/validation.ts`), API route auth (`getUser()` before data access), API rate limiting (`rateLimit()` call), RLS reliance (reads use standard client not admin), no secrets in client code, Supabase admin client usage only where documented

**Agent 2: Frontend Developer** (`subagent_type: "Frontend Developer"`)
- Primary files: `src/components/`, `src/app/` (pages), `src/lib/format.ts`
- Checklist: Badge styling (Adj. = amber, Xfer = teal), badge precedence (Xfer > Adj.), modal spacing (`space-y-4`), label styling (`text-xs text-zinc-500 mb-1`), ChangeTooltip `open` prop wired for mobile, checkbox accent (`accent-amber-500`), responsive `flex-wrap` on toolbars, chart colors (crypto=orange, stocks=cyan, cash=emerald), dark theme consistency (zinc-950/900/800), currency formatting (`Intl.NumberFormat`), `next/image` (never raw `<img>`), form input `text-zinc-100` (never `text-white`)

**Agent 3: Backend Architect** (`subagent_type: "Backend Architect"`)
- Primary files: `src/lib/actions/`, `src/lib/portfolio/`, `src/lib/prices/`, `src/lib/cashflow.ts`, `src/lib/deltas.ts`
- Checklist: Transaction safety (TOCTOU, read-then-write), N+1 query patterns, missing `Promise.all` for independent async calls, error handling in server actions (try-catch with descriptive errors), `getFXRates` (throws) vs `getFXRatesSafe` (fallback) in correct contexts, activity log entries on mutations, `revalidatePath()` after mutations, soft-delete pattern (`deleted_at`)

**Agent 4: Database Optimizer** (`subagent_type: "Database Optimizer"`)
- Primary files: `supabase/migrations/`, `src/lib/actions/` (query patterns)
- Checklist: Missing partial indexes (`deleted_at IS NULL`), slow query patterns, FK cascade correctness, RLS policy review (`auth.uid() = user_id AND is_active_user()`), TEXT over enum convention, `NUMERIC(28,18)` for crypto quantities, SECURITY DEFINER functions have REVOKE + fixed `search_path`

### Batch 2 (agents 5-8, launch in parallel)

**Agent 5: Software Architect** (`subagent_type: "Software Architect"`)
- Primary files: All `src/lib/`, cross-file patterns
- Checklist: Cross-file duplication (crypto-table vs stock-table vs cash-table drift), module boundary clarity, over-engineering (unnecessary abstractions), server actions for mutations (not API routes), `partialUpdate()` usage for safe partial updates, constants in `src/lib/constants.ts` (not magic numbers)

**Agent 6: Performance Benchmarker** (`subagent_type: "Performance Benchmarker"`)
- Primary files: `src/lib/prices/`, `src/lib/portfolio/`, `src/components/` (heavy components)
- Checklist: `fetchWithTimeout()` on all price API calls (8s AbortController), sequential queries that should be parallel, re-render risks (missing `useMemo`/`useCallback` on expensive ops), N+1 Yahoo requests, waterfall detection in server components

**Agent 7: Accessibility Auditor** (`subagent_type: "Accessibility Auditor"`)
- Primary files: `src/components/`, `src/app/` (layouts, pages)
- Checklist: `focus-trap-react` on all modals, `role="dialog"` + `aria-modal`, `htmlFor`/`id` on form labels, `role="alert"` on errors, `aria-label` on icon-only buttons, skip-to-content link, `prefers-reduced-motion`, keyboard navigation, table `scope="col"`

**Agent 8: Code Reviewer** (`subagent_type: "Code Reviewer"`)
- Primary files: `src/lib/actions/`, `src/lib/`, CLAUDE.md conventions
- Checklist: Missing validators on mutations (`validateAmount`, `validateCurrency`, `validateName`, `validateUUID`, `validateCoinGeckoId`, `validateYahooTicker`), unscoped queries (missing `.eq("user_id")`), unused imports/variables, `as any` casts, commented-out code, inconsistent error handling patterns

### Batch 3 (agents 9-12, launch in parallel)

**Agent 9: SRE** (`subagent_type: "SRE"`)
- Primary files: `supabase/functions/`, `.github/workflows/`, `next.config.ts`, `sentry.*`, `src/instrumentation*`
- Checklist: Sentry integration (error tracking, tracing, replay), fetch timeouts on all external calls, cron pipeline reliability (pg_cron → pg_net → Edge Function), zero-value snapshot risk, CI workflow correctness, security headers in `next.config.ts`, deploy config

**Agent 10: Evidence Collector** (`subagent_type: "Evidence Collector"`)
- Primary files: Full codebase — follows leads from any file
- Checklist: Reproduce concrete bugs (boundary values, negative inputs, zero division, Infinity, NaN), edge cases in financial logic, transfer leg pairing, FX conversion direction, quantity precision

**Agent 11: Silent Failure Hunter** (`subagent_type: "pr-review-toolkit:silent-failure-hunter"`)
- Primary files: `src/lib/actions/`, `src/lib/prices/`, `src/app/api/`, `src/lib/supabase/`
- Checklist: Empty catch blocks, `|| true` on critical paths, fallbacks that hide real errors, `catch { }` without logging, `console.error` without user-visible feedback, swallowed promise rejections

**Agent 12: Git Workflow Master** (`subagent_type: "Git Workflow Master"`)
- Primary files: `.github/`, `package.json`, `.gitignore`, `tsconfig.json`, `vitest.config.ts`
- Checklist: CI workflow correctness (jobs, conditions, secrets), dependabot config (grouped packages), git hygiene (no committed secrets, no large binaries), branch strategy, commit message conventions

### Batch 4 (agents 13-16, launch in parallel)

**Agent 13: Test Coverage Analyzer** (`subagent_type: "pr-review-toolkit:pr-test-analyzer"`)
- Primary files: `__tests__/` + corresponding source files
- Checklist: Untested branches in source, missing edge case tests, security-critical logic without tests (validators, auth checks, RLS), untested error paths

**Agent 14: Type Design Analyzer** (`subagent_type: "pr-review-toolkit:type-design-analyzer"`)
- Primary files: `src/lib/types.ts`, `src/lib/`, exported interfaces
- Checklist: `any` casts, weak type boundaries, missing return types on exported functions, `BaseCurrency` usage (not `Currency`), leaky abstractions, type invariant enforcement

**Agent 15: Reality Checker** (`subagent_type: "Reality Checker"`)
- Primary files: Full codebase — holistic assessment
- Checklist: Overall production readiness, dimensional ratings (Code Quality, Security, Error Handling, Data Integrity, Test Coverage, Financial Calculations, Rate Limiting, Recovery, Monitoring)

**Agent 16: Test Quality Agent** (custom prompt, `subagent_type: "general-purpose"`)
- Primary files: `__tests__/`, `vitest.config.ts`
- Checklist: False confidence (tests reimplementing production logic instead of importing), assertion quality (specific values not just `toBeDefined`), conditional assertions (vacuous truth), mock correctness (`vi.mock()` hoisting, cleanup in `afterEach`), test isolation (no shared mutable state), edge cases with injection payloads (SQL, XSS), boundary values, `as any` in tests

## Phase 2 — Synthesis (do this yourself)

After ALL 4 batches return:

1. **Deduplicate** — agents may flag the same issue from different angles. Merge them.
2. **Route `[CROSS-DOMAIN]` items** — assign to the appropriate category.
3. **Categorize** by severity: Critical / High / Medium / Low
4. **Present** ALL findings to user using the per-round output format.

## Phase 3 — Fix

1. Fix all **unambiguous** findings, starting from Critical down to Low. No skipping.
2. **Batch ambiguous items** into a single numbered decision prompt:
   ```
   Decision needed:
   1. [file:line] Description → Options: A / B / C
   2. [file:line] Description → Options: A / B
   Reply: "fix 1 — skip 2" or "fix all" or "skip all"
   ```
3. Commit fixes.
4. Record: fixed issues list, modified files list, user decisions list.

## Phase 4 — Verify

Run in parallel:
```bash
npm run build 2>&1 | tail -30
npm run lint 2>&1 | tail -50
npm test 2>&1 | tail -10
npm run test:component 2>&1 | tail -10
```

If local Supabase is running, also run: `npx vitest run --project integration`

All must pass. If a test correctly fails because a fix exposed a real bug (test-exposes-bug scenario),
treat the production bug as a new finding — fix both the test and the production code.

## Phase 5 — Re-review Decision

- If **Round < 5 AND findings were found** → go to Phase 1 with refined context
- If **Round = 5 AND findings remain** → present as "diminishing returns" list, go to Phase 6
- If **zero findings** → go to Phase 6

### Refined context for Round 2+

Add to each agent's prompt:
- **Latest round fixes** (itemized): "These were FIXED — do not re-report: [list]"
- **Older round fixes** (summarized): "Round 1 fixed 12 issues (3 security, 4 quality, 5 UI)"
- **Modified files**: "These files were changed by fixes — check for regressions: [list]"
- **User decisions**: "These were accepted by the user — do not re-flag: [list]"

## Phase 6 — Clean-Pass Verification

Launch a single comprehensive agent (`subagent_type: "Code Reviewer"`, `model: "opus"`) with:
- Full CLAUDE.md + memory context
- ALL files in scope
- Higher bar: "Only flag issues that are OBJECTIVELY broken, insecure, or violate CLAUDE.md. Subjective observations do not count."

- If **APPROVED** → done. Present final output.
- If **any finding** → one FINAL fix round (Phase 3-4 only, no re-review), then done regardless.

## Convergence Guarantees

- **Max 5 rounds** (hard cap)
- **Agent calibration**: "OBJECTIVE issues only"
- **Clean-pass higher bar**: only broken/insecure/violates-CLAUDE.md
- **Agent timeout**: 3 minutes per agent, mark UNCOVERED and proceed
- **Test-exposes-bug**: if fixing a false-confidence test reveals a production bug, treat as new finding for current round
- **Phase 6 is terminal**: fixes verified by build+lint+tests only, no re-review

## Output Format

### Per-round output

```
## Audit Round N

**Scope**: Full codebase (X files)
**Build**: Pass | **Lint**: N warnings | **Tests**: N passed
**Agents**: 16 dispatched, M returned findings

### Findings by severity

#### Critical (N)
- [file:line] Agent #X (Role): Description → Fix: what was done

#### High (N)
- [file:line] Agent #X (Role): Description → Fix: what was done

#### Medium (N)
- [file:line] Agent #X (Role): Description → Fix: what was done

#### Low (N)
- [file:line] Agent #X (Role): Description → Fix: what was done

#### Decision needed (N)
1. [file:line] Agent #X: Description → Options: A / B / C
2. [file:line] Agent #X: Description → Options: A / B
(Reply: "fix 1 — skip 2" or "fix all" or "skip all")

#### Cross-domain (routed)
- [file:line] Flagged by Agent #X → routed to Agent #Y category

### Clean areas
- Agent #2 (Frontend): CLEAN — checked badges, spacing, responsive, dark theme
- Agent #12 (Git): CLEAN — commits, CI, secrets, repo hygiene

### Round summary
- Found: N new | Fixed: N | Awaiting decision: N
- Files modified: list
- Cumulative: R1 found X, R2 found Y
```

### Final output (after clean-pass)

```
## Audit Complete

**Rounds**: N (max 5)
**Total findings**: X found, X fixed, 0 remaining
**User decisions**: N items accepted as-is
**Diminishing returns**: N items (if max rounds reached)

### Codebase health (Reality Checker)
| Dimension | Rating |
|-----------|--------|
| Code Quality | A/B/C |
| Security | A/B/C |
| ... | ... |

### All findings (cumulative log)
[Full list from all rounds with final status: Fixed / User decision / Diminishing returns]
```
````

- [ ] **Step 2: Verify the full SKILL.md is valid**

Read the complete file and check:
- Frontmatter YAML is valid
- Mode Detection section links to `#audit-mode` anchor
- Standard mode content is untouched (lines 14-227 of original)
- Audit mode content follows the spec exactly
- No broken markdown (unclosed code blocks, missing table columns)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/review/SKILL.md
git commit -m "feat: add 16-agent audit mode to review skill"
```

---

### Task 4: Verify Skill Works

- [ ] **Step 1: Test that `/review` still triggers standard mode**

In a separate terminal, start Claude Code and type `/review`. Verify it:
- Detects the Mode Detection section
- Falls through to standard mode (diff-scoped, 2-4 agents)
- Does NOT launch 16 agents

- [ ] **Step 2: Test that `/review audit` triggers audit mode**

Type `/review audit`. Verify it:
- Detects audit mode from the keyword
- Starts Phase 0 (reads CLAUDE.md, memory, runs build+lint+tests)
- Proceeds to Phase 1 (16 agents in 4 batches)

Note: This is a manual verification — the skill is instructions, not executable code.

- [ ] **Step 3: Final commit if any remaining changes**

```bash
git status
# If clean, done. If changes, commit with appropriate message.
```
