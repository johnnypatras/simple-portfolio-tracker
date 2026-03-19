# Enhanced `/review` Skill — Audit Mode

**Date**: 2026-03-19
**Status**: Design approved, pending implementation
**Goal**: Add a 16-agent iterative audit mode to the existing `/review` skill that finds and fixes ALL issues in the full codebase.

## Overview

The `/review` skill gets a second mode:

| Mode | Trigger | Agents | Scope | Loop | Exit condition |
|------|---------|--------|-------|------|----------------|
| **Standard** | `/review` | 2-4 (dynamic) | Git diff | Single pass | Severity-driven |
| **Audit** | `/review audit` | 16 (all, always) | Full codebase | Iterative | Zero objective findings or max 5 rounds |

Standard mode is unchanged. Audit mode is the new addition.

---

## Agent Roster (16 agents)

### Batch 1 (agents 1-4, launched in parallel)

| # | `subagent_type` | Focus | Primary file set |
|---|----------------|-------|-----------------|
| 1 | `Security Engineer` | OWASP, secrets, auth, RLS, injection | `src/lib/actions/`, `src/app/api/`, `src/lib/validation.ts`, `src/lib/supabase/`, `src/proxy.ts`, `src/lib/rate-limit.ts`, `src/lib/share-utils.ts`, `src/lib/csv.ts` |
| 2 | `Frontend Developer` | UI patterns, rendering, dark theme, responsive | `src/components/`, `src/app/` (pages), `src/lib/format.ts` |
| 3 | `Backend Architect` | Transactions, race conditions, N+1, data flow | `src/lib/actions/`, `src/lib/portfolio/`, `src/lib/prices/`, `src/lib/cashflow.ts`, `src/lib/deltas.ts` |
| 4 | `Database Optimizer` | Indexes, queries, schema, RLS policies, FKs | `supabase/migrations/`, `src/lib/actions/` (query patterns) |

### Batch 2 (agents 5-8, launched in parallel)

| # | `subagent_type` | Focus | Primary file set |
|---|----------------|-------|-----------------|
| 5 | `Software Architect` | Duplication, abstractions, module boundaries | All `src/lib/`, cross-file patterns |
| 6 | `Performance Benchmarker` | Latency, waterfalls, re-renders, bundle, timeouts | `src/lib/prices/`, `src/lib/portfolio/`, `src/components/` (heavy components) |
| 7 | `Accessibility Auditor` | WCAG AA, ARIA, focus traps, keyboard, screen reader | `src/components/`, `src/app/` (layouts, pages) |
| 8 | `Code Reviewer` | Validation gaps, logic bugs, convention adherence | `src/lib/actions/`, `src/lib/`, CLAUDE.md conventions |

### Batch 3 (agents 9-12, launched in parallel)

| # | `subagent_type` | Focus | Primary file set |
|---|----------------|-------|-----------------|
| 9 | `SRE` | Observability, timeouts, monitoring, cron, edge functions, deploy config | `supabase/functions/`, `.github/workflows/`, `next.config.ts`, `sentry.*`, `src/instrumentation*` |
| 10 | `Evidence Collector` | Concrete reproducible bugs, edge cases, boundary values | Full codebase — follows leads from any file |
| 11 | `pr-review-toolkit:silent-failure-hunter` | Swallowed errors, empty catch blocks, fallbacks hiding failures | `src/lib/actions/`, `src/lib/prices/`, `src/app/api/`, `src/lib/supabase/` |
| 12 | `Git Workflow Master` | Commits, CI workflow, secrets, dependabot, repo hygiene | `.github/`, `package.json`, `.gitignore`, `tsconfig.json`, `vitest.config.ts` |

### Batch 4 (agents 13-16, launched in parallel)

| # | `subagent_type` | Focus | Primary file set |
|---|----------------|-------|-----------------|
| 13 | `pr-review-toolkit:pr-test-analyzer` | Test coverage gaps, missing scenarios, untested branches | `__tests__/` + corresponding source files |
| 14 | `pr-review-toolkit:type-design-analyzer` | Type encapsulation, invariants, `any` casts, weak types | `src/lib/types.ts`, `src/lib/`, exported interfaces |
| 15 | `Reality Checker` | Overall production readiness, dimensional ratings | Full codebase — holistic assessment |
| 16 | Test Quality Agent (custom prompt) | Mock correctness, assertion quality, false confidence, test isolation | `__tests__/`, `vitest.config.ts` |

**File routing is guidance, not constraint.** Each agent focuses on its primary file set but may explore other files when following a lead. The `[CROSS-DOMAIN]` rule (see Agent Prompt Structure) handles boundary issues.

---

## The Audit Loop

```
Phase 0: Context & Calibration
  ├── Read CLAUDE.md + memory files (MEMORY.md, gotchas.md, decisions.md, etc.)
  ├── Build shared context package for agents
  ├── Assign primary file sets to each agent
  ├── Run build + lint (fix if broken before starting)
  └── Run test suite (fix if failing before starting)

Phase 1: Full Review (Round N)
  ├── Launch Batch 1 (agents 1-4) in parallel
  ├── Launch Batch 2 (agents 5-8) in parallel
  ├── Launch Batch 3 (agents 9-12) in parallel
  └── Launch Batch 4 (agents 13-16) in parallel

Phase 2: Synthesis
  ├── Collect all findings from 16 agents
  ├── Deduplicate (multiple agents may flag same issue)
  ├── Route [CROSS-DOMAIN] findings to the appropriate agent's category
  ├── Categorize: Critical / High / Medium / Low
  └── Present ALL findings to user

Phase 3: Fix
  ├── Fix all unambiguous findings (Critical → Low, no skipping)
  ├── Batch ambiguous items into a single numbered decision prompt
  │   └── User responds: "fix 1,3,5 — skip 2,4" (one pause per round)
  ├── Commit fixes
  └── Record: fixed issues list, modified files, user decisions

Phase 4: Verify
  ├── Run build (must pass)
  ├── Run lint (must pass)
  └── Run test suite (must pass)

Phase 5: Re-review decision
  ├── If Round < 5 AND findings were found → go to Phase 1
  ├── If Round = 5 AND findings remain → present as "diminishing returns" list, go to Phase 6
  └── If zero findings → go to Phase 6

Phase 6: Clean-pass verification
  ├── Single comprehensive agent reviews entire codebase
  ├── Higher bar: only OBJECTIVE issues (broken, insecure, violates CLAUDE.md)
  ├── If APPROVED → done
  └── If any finding → one FINAL fix round (Phase 3-4 only, no re-review), then done regardless
```

### Convergence guarantees

- **Max 5 rounds** (hard cap) — if not converged, remaining items are reported as "diminishing returns"
- **Agent calibration** — agents are instructed: "Report only OBJECTIVE issues — violations of conventions, bugs, security flaws, broken patterns. NOT style preferences, subjective naming, or 'consider doing X' suggestions."
- **Clean-pass higher bar** — Phase 6 agent only flags things that are broken, insecure, or violate CLAUDE.md. Subjective observations do not restart the loop.
- **Modified-files focus** — Round 2+ agents receive the list of files modified by fixes and focus extra scrutiny there (regression detection)
- **Agent timeout** — if an agent does not return within 3 minutes, mark its focus area as UNCOVERED in the round output and proceed with synthesis. Do not block the entire batch.
- **Test-exposes-bug** — if fixing a false-confidence test causes it to correctly fail (revealing a production bug), treat the production bug as a new finding for the current round. Fix both the test and the production code.
- **Phase 6 is terminal** — fixes applied in Phase 6 are verified by build+lint+tests only. No re-review. This prevents an infinite tail.

---

## Agent Prompt Structure

### Shared context package (built in Phase 0)

Every agent receives:
1. CLAUDE.md conventions (full file)
2. Relevant memory patterns (UI patterns table, gotchas, decisions)
3. Their primary file set assignment
4. Round-specific context (Round 2+ only):
   - Latest round's fixed issues (itemized — "do not re-report")
   - Older rounds' fixes (summarized — "Round 1 fixed 12 issues: 3 security, 4 quality, 5 UI")
   - Files modified by fixes (focus here for regressions)
   - User decisions on ambiguous items (respect these)

### Per-agent prompt template

```
You are a [ROLE] reviewing the codebase at /Users/lxp/simple-portfolio-tracker.

[SHARED CONTEXT PACKAGE]

Your PRIMARY focus area: [AGENT-SPECIFIC FOCUS]
Your primary file set: [FILE LIST — start here, but explore other files if following a lead]

Specific checklist: [AGENT-SPECIFIC CHECKLIST]

Calibration: Report only OBJECTIVE issues — violations of stated conventions,
bugs, security flaws, broken patterns, missing required behavior.
Do NOT report style preferences, subjective naming suggestions, or "consider" advice.

If you notice an issue clearly in another agent's domain, include it with a
[CROSS-DOMAIN] tag (brief description only — don't investigate deeply).

For each finding, report:
- File path and line number
- Severity: CRITICAL / HIGH / MEDIUM / LOW
- Description: what's wrong and why it matters
- Suggested fix: exact code change or approach

If you find zero issues in your focus area, say CLEAN and list what you checked.

[ROUND 2+ ONLY]
These issues were FIXED in previous rounds — do NOT re-report:
[ITEMIZED LIST FROM LATEST ROUND]
[SUMMARY OF OLDER ROUNDS]

These files were modified by fixes — check for regressions:
[MODIFIED FILES LIST]

These items were decided by the user — do NOT re-flag:
[USER DECISIONS LIST]
```

---

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

---

## Integration with Standard Mode

The SKILL.md file will have this structure:

```
# Standard mode (default)
[Current SKILL.md content — unchanged]

# Audit mode (/review audit)
[New content from this spec]
```

Detection logic in the skill:
- `/review audit` → audit mode
- `/review` → standard mode (current behavior)
- No aliases — `audit` is the only trigger for the 16-agent mode. The existing `exhaustive`/`full` keywords in standard mode continue to mean "spawn all 4 agents regardless of scope" as before.

---

## Model Selection

All 16 agents use the same model per audit run:

- **Default: `sonnet`** — fast, capable, good for pattern matching
- **Escalate to `opus`** when:
  - Changed files involve financial logic
  - User explicitly asks for "deep" or "thorough"
  - Previous round found Critical issues that need careful analysis

The orchestrator (main session) always runs on the user's current model.

---

## Practical Considerations

- **Token cost**: ~800K-1.2M tokens per round (16 agents × ~50-75K each, depending on file count read). 3 rounds ≈ 2.4-3.6M tokens. Estimate is approximate — actual cost depends on codebase size and number of findings.
- **Wall clock time**: ~6-8 minutes per round (4 batches × ~90s each + fix time). 3 rounds ≈ 20-25 minutes.
- **When to use**: Pre-release, pre-merge of major features, quarterly audits. NOT for everyday code changes (use standard `/review` for that).
