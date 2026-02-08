# System Friction Log — 2026-02-08

Full-stack analysis of the openclaw + Ralph + Codex + Claude Code pipeline.
Goal: coding sessions that RUN and actually COMPLETE.

**Period:** 2026-02-07 23:45 UTC through 2026-02-08 16:42 UTC (~17 hours)
**Data sources:** .ralph-iterations.jsonl (58 iterations), progress.txt, gateway logs, ralph-events, watchdog, session transcripts, systemd journal, process table

---

## The Numbers

| Metric | Value |
|--------|-------|
| Total Codex iterations | 58 |
| Succeeded | 34 (58.6%) |
| Failed | 24 (41.4%) |
| Iterations with 0 tool calls | 57 of 58 (98.3%) |
| Iterations hitting 600s timeout | 21 (36.2%) |
| Wasted compute time | 3.8 hours of 6.4 total |
| Gateway restarts in 24h | 14 |
| Orphaned processes after restarts | 39 |
| Gateway peak memory | 11.9 GB (on 16 GB machine) |
| Orphaned session files | 750 (144 MB) |
| Soft-deleted but still on disk | 318 (94 MB) |

---

## Layer 1: Codex (The Agent That Doesn't Use Tools)

### CRITICAL: 98.3% Zero Tool Calls

57 of 58 iterations had ZERO tool calls. Codex was generating code in markdown blocks inside its response text instead of actually using the sandbox (writing files, running commands). The one iteration that used tools (#58) made 120 tool calls — and that was after we fixed the event parsers.

**Root cause:** The parser was looking for event types that don't exist (`tool_call`, `session_start`). The real Codex wire format uses `item.completed` with `item.type: "command_execution"`. We fixed the parsers (commit `a4d3ebc`), but the model behavior question remains — WHY wasn't Codex using tools in the first place?

**Impact:** When Codex writes code in response text instead of files, it:
- Can't run tests or typecheck to verify its work
- Can't iterate on failures within the session
- Produces output that looks like it worked but didn't actually change anything
- Results in `filesModified: []` on every iteration, even "successes"

**Status:** Parser fixed. Model behavior still questionable — need to verify the `--full-auto` or sandbox config is encouraging tool use.

### CRITICAL: Timeout Without Data (codexOutputLength: 38)

8 iterations returned exactly 38 bytes of output. 600 seconds of compute, zero learnings. The timeout handler was killing the process and returning `events: []`.

**Status:** FIXED (commit `47c02fe`). Timeout handler now preserves partial data from accumulated stdout.

### HIGH: Final Message Never Captured on Failures

Every failed iteration had `codexFinalMessageLength: 0`. When Codex times out, there's no summary of what it tried or where it got stuck. This means retries are blind.

**Status:** PARTIALLY FIXED. The structured output schema (commit `89ee3e4`) will force Codex to produce structured JSON on completion. But timeouts still won't produce a final message since the schema constraint only applies to the final response.

### HIGH: Validation Output Truncation Hides Actual Errors

Validation output is capped at 2000 chars. Turbo's verbose logging (package scopes, cache hits) consumes most of that budget. The actual TypeScript errors are always past the truncation point.

**Example from story-mlde2057:** Seven consecutive failures all show the same truncated output — "Packages in scope: @atproto-agent/agent, @atproto-agent/cli..." but never the actual type error.

**Status:** OPEN. Need to strip turbo boilerplate before capturing, or capture stderr only, or increase limit.

---

## Layer 2: Ralph (The Loop That Can't Learn)

### CRITICAL: Retries Repeat the Same Mistakes

`story-mlde2057` (Pi session persistence) failed 7 times before succeeding on attempt 8. Each retry added ~400-600 chars to the prompt but added zero signal — just more truncated turbo output. The retries couldn't learn because:

1. `codexFinalMessageLength: 0` — no insight into what the previous attempt tried
2. Validation output truncated — couldn't see the actual type error
3. `filesModified: []` — no record of what files were touched
4. No session transcript injection into retry prompts

**Status:** Session transcript injection IMPLEMENTED (commit `47c02fe`) but hasn't been tested under real conditions yet. Structured output schema will help future iterations but doesn't retroactively help.

### HIGH: Prompt Bloat (15k-31k chars, mostly noise)

Prompts grew from 15k to 31k chars across retries. Breakdown of a typical 30k prompt:
- Story description + acceptance criteria: ~1k (THE ACTUAL TASK)
- AGENTS.md verbatim copy: ~8-10k (ASCII art, skill tables, workflow diagrams)
- progress.txt / failure context: ~5-8k (duplicated, truncated)
- Validation output from prior failures: ~2-4k (same truncated turbo logs repeated)
- Project structure / rules: ~2-3k

Signal-to-noise ratio: ~3-5% actual task, 95-97% context padding.

**Status:** OPEN. Needs prompt compression — strip AGENTS.md to essentials, deduplicate failure context.

### HIGH: No Early Termination on Hopeless Stories

`e2e-test-harness` failed 3 times (never succeeded) and was abandoned. `pre-commit-hooks` failed 2 times and was abandoned. But there's no auto-skip after N failures. The system will happily burn 600s * N on a story that's never going to pass.

**Status:** OPEN. Need max-retry-per-story limit with auto-skip and human flag.

### MEDIUM: Intervention Required to Unstick

Joel had to manually inject `[INTERVENTION] Story 1 is taking too long. SKIP reading PI-POC.md, O11Y.md, and skills.` because the agent was wasting time reading reference docs instead of doing the work.

**Status:** OPEN. Prompt needs to be more directive about what NOT to do.

---

## Layer 3: OpenClaw Gateway (Memory Hog, Restart Storm)

### CRITICAL: 11.9 GB Peak Memory (74% of system RAM)

The gateway process peaked at 11.9 GB on a 16 GB machine. It touched swap (47.1 MB). Current restart is at 540 MB after 14 minutes and climbing.

**Root causes:**
- Session files grow unbounded (one session hit 35 MB)
- Orphaned child processes accumulate memory after restarts
- No memory limits or backpressure

**Status:** OPEN. Needs process cleanup on restart and session size limits.

### HIGH: 14 Restarts in 24 Hours

Gateway restarted 14 times in 24 hours. Worst burst: 4 restarts in 19 minutes (flapping). Each restart leaves orphaned processes (39 reported by systemd).

**Root cause:** SIGTERM doesn't propagate to child processes. The gateway catches SIGTERM and shuts down, but spawned codex processes keep running.

**Status:** OPEN. Need process group kill on shutdown.

### HIGH: 750 Orphaned Session Files (144 MB)

Sessions directory has 750 active `.jsonl` files but the index only references 18. Soft-deleted files (318, 94 MB) are still on disk. No garbage collection.

**Status:** OPEN. Need session GC and actual file deletion.

### MEDIUM: 237 Health Check Cycles Per Day (All Failing)

Health watchdog fires every 5 minutes, tries to read `pending-alert.txt` which doesn't exist, generates ENOENT errors, queries hivemind (2-3s round trip), produces nothing useful.

**Status:** OPEN. Either create the file or stop checking for it.

### MEDIUM: 98 "read tool called without path" Errors Per Day

The agent keeps calling the read tool without specifying a file path. Wasted API tokens and noisy logs.

**Status:** OPEN.

---

## Layer 4: Claude Code Sessions (The Human Layer)

### Context Window Exhaustion

This is the fourth session context on this work in ~24 hours. Previous sessions compacted due to context limits. Key context (what was already implemented, what was tested) gets lost across compactions and new sessions.

### Plan Mode Friction

Plan mode was used for the timeout fix plan, but the user rejected ExitPlanMode ("wanted to just go"). The planning vs doing tension is real — sometimes the plan IS the implementation and the ceremony slows things down.

### Handoff Quality

When sessions compact or restart, the summary captures WHAT was done but loses the nuance of WHY certain approaches were chosen. The `buildPreviousAttemptContext` function we wrote for Ralph retries is literally the same problem we have at the Claude Code layer — continuity across context boundaries.

---

## What's Been Fixed (This Session + Previous)

| Fix | Commit | Impact |
|-----|--------|--------|
| Event parsers match actual Codex wire format | `a4d3ebc` | Tool calls now visible (120 vs 0) |
| Timeout handler preserves partial data | `47c02fe` | No more codexOutputLength:38 on timeouts |
| Session transcript injection on retry | `47c02fe` | Retries get action sequence from previous attempt |
| buildPreviousAttemptContext | `47c02fe` | Failed session transcripts fed into retry prompts |
| Structured output schema | `89ee3e4` | Codex returns JSON with learnings, not markdown |
| codex-exec skill created | (skill) | Wire format documented for future reference |

---

## What's Still Broken (Priority Order)

### Tier 1 — Fix These and Sessions Will Actually Complete

1. **Validation output capture** — Strip turbo boilerplate, capture actual errors, increase limit to 8k+ chars. This alone would have prevented the 7-failure story-mlde2057 spiral.

2. **Prompt compression** — Strip AGENTS.md to essential rules (~1k, not ~10k). Deduplicate failure context across retries. Get prompts under 15k chars.

3. **Early termination** — Max 3 retries per story, then auto-skip and flag. Stop burning 600s * 7 on hopeless stories.

4. **Gateway process cleanup** — Kill child processes on SIGTERM. Stop orphan accumulation and memory bloat.

### Tier 2 — Reliability and Efficiency

5. **Session garbage collection** — Delete soft-deleted files, prune unreferenced sessions, cap session size at 5 MB.

6. **Health watchdog cleanup** — Fix or remove the pending-alert.txt check. Reduce watchdog frequency to every 15 minutes.

7. **Timeout prediction** — If no tool calls or file changes after 120s, kill early instead of waiting 600s.

8. **filesModified tracking** — Parse git diff from codex events to populate this field. Essential for understanding what iterations actually did.

### Tier 3 — Quality of Life

9. **Log rotation** for gateway logs (47 MB in 3 days)
10. **Slack websocket reconnect** instead of pong timeout warnings
11. **Missing iteration numbers** — close logging gaps

---

## The Path to "Sessions That Actually Complete"

The fundamental issue: **the system is blind when things go wrong**. Failures produce no final message, no file list, truncated validation that hides the error, and zero tool call data. Retries inherit this blindness and repeat the same mistakes.

The fix is layered:
1. **See what happened** (validation capture, file tracking, structured output) ← mostly done
2. **Learn from failures** (transcript injection, previous attempt context) ← implemented but untested
3. **Stop wasting compute** (early termination, timeout prediction, prompt compression) ← open
4. **Keep the system healthy** (process cleanup, session GC, memory limits) ← open

After the fixes in this session, the next Ralph loop will be the first one with structured output AND session transcript injection AND working event parsers. That's a fundamentally different animal than what's been running. But the validation truncation and prompt bloat need to be fixed too, or we'll still get the spiral.
