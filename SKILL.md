# Ralph Codex — OpenClaw Plugin

Autonomous AI coding loops using Codex CLI. Spawn fresh AI sessions for each task, validate with tests, commit on success, repeat until done. 26 tools.

## Quick Reference

### Project Setup
```
ralph_init(workdir="/path/to/project", projectName="My App")
ralph_add_story(workdir, title="Add login", description="OAuth with Google", priority=1, validationCommand="npm test")
```

### Run Iterations
```
ralph_status(workdir)                           # Check what's pending
ralph_iterate(workdir)                          # Run one story
ralph_iterate(workdir, dryRun=true)             # Preview prompt + config
ralph_loop(workdir, maxIterations=10)           # Async loop (returns job ID)
ralph_loop_status(jobId="ralph-abc123")         # Check loop progress
ralph_loop_cancel(jobId="ralph-abc123")         # Stop a loop
```

### Observability
```
ralph_iterations(workdir)                       # Last 20 iterations
ralph_iterations(workdir, onlyFailed=true)      # Failed iterations only
ralph_iterations(workdir, showPrompt="story-x") # Retrieve full prompt
ralph_cursor(action="set", label="after fix")   # Timestamp bookmark
ralph_cursor(action="since")                    # Get epoch for filtering
```

### Session Management
```
ralph_sessions(limit=20)                        # List recent Codex sessions
ralph_session_show(sessionId)                   # View session details
ralph_session_resume(sessionId, message)        # Continue a session
```

### Orchestration Patterns
```
ralph_patterns()                                # List all patterns
ralph_worker_prompt(task="...", role="reviewer") # Generate worker prompt
```

### Repo Analysis (Autopsy)
```
autopsy_clone(repo="owner/repo")                # Clone for analysis
autopsy_search(repo, pattern="async function")  # Ripgrep search
autopsy_ast(repo, pattern="function $NAME($$$)")# AST structural search
autopsy_hotspots(repo)                          # Most changed files
autopsy_secrets(repo)                           # Scan for leaked secrets
```

---

## Core Concept: The Ralph Pattern

Traditional AI coding sessions accumulate context and drift. Ralph keeps things clean:

1. **Fresh context per iteration** — Each task gets a clean Codex session
2. **Persistent state via git** — Completed work lives in commits, not context
3. **Aggressive learning** — 4 hivemind queries per iteration (16 results), structured learning validation
4. **Failure propagation** — Recurring failure patterns get escalated in prompts
5. **Validation gates** — Tests must pass before moving on

---

## Workflow

### 1. Initialize Project

```
ralph_init(workdir="~/Code/myproject", projectName="My Project")
```

Creates `prd.json` and `progress.txt`.

### 2. Add Stories

Stories should be **small and testable**. Each should fit in one AI context window.

```
ralph_add_story(
  workdir="~/Code/myproject",
  title="Add login form",
  description="Create a React login form with email/password fields.",
  priority=1,
  validationCommand="npm run typecheck && npm test -- --testPathPattern=login",
  acceptanceCriteria='["Email validation works", "Password min 8 chars"]'
)
```

### 3. Run

```
ralph_loop(workdir="~/Code/myproject", maxIterations=10, stopOnFailure=true)
```

Each iteration:
1. Pulls hivemind context (story relevance, failure patterns, project learnings, tech gotchas)
2. Builds prompt with failure pattern analysis and structured context
3. Persists full prompt to disk (SHA-256 hash for dedup)
4. Spawns fresh Codex session
5. Validates, commits on success
6. Validates learning quality — lazy responses get flagged
7. Writes iteration log entry

### 4. Monitor

```
ralph_loop_status()                             # Check all running loops
ralph_iterations(workdir, onlyFailed=true)      # What's failing?
ralph_iterations(workdir, showPrompt="story-x") # What prompt was sent?
```

---

## Learning System

### Pre-Iteration: Aggressive Context Pull
`aggressiveHivemindPull()` runs 4 queries per iteration:
- Story title relevance (5 results)
- Project failure patterns (5 results)
- Project learnings (3 results)
- Technology gotchas from description (3 results)

### Post-Iteration: Quality Validation
`validateLearnings()` checks for:
- Lazy patterns: "None", "N/A", vague one-liners
- Minimum 50 chars of substantive learning content
- Lazy responses recorded in hivemind as quality warnings

### Failure Pattern Propagation
`buildFailurePatternContext()` reads `.ralph-iterations.jsonl`:
- Groups failures by category (type_error, test_failure, lint_error, build_error, timeout)
- Categories with 2+ occurrences get escalation blocks in prompts
- Tool frequency analysis for failed vs successful iterations

### Structured Agent Learnings
Prompt demands structured output:
```
## Learnings
### Technical Discovery
<specific codebase/type/API findings>
### Gotcha for Next Iteration
<pitfalls the next agent should avoid>
### Files Context
<which files matter and why>
```

---

## Configuration

Plugin config in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-codex-ralph": {
        "enabled": true,
        "config": {
          "model": "gpt-5.3-codex",
          "maxIterations": 20,
          "sandbox": "danger-full-access",
          "autoCommit": true,
          "debug": false
        }
      }
    }
  }
}
```

---

## File Layout

```
~/.openclaw/
  ralph-events/              # Event files (JSON, auto-cleaned >24h)
  ralph-iterations/
    prompts/                 # Full prompt text (auto-cleaned >7d)
  ralph-cursor.json          # Timestamp bookmarks

{workdir}/
  prd.json                   # Stories and metadata
  progress.txt               # Human-readable progress log
  .ralph-context.json        # Machine-readable inter-story context
  .ralph-iterations.jsonl    # Per-project iteration log
  AGENTS.md                  # Project guidelines (included in prompts)
```

---

## Failure Categories

| Category | Detected By |
|----------|------------|
| `type_error` | `error ts`, `ts(`, `not assignable`, `cannot find name` |
| `test_failure` | `assert`, `expect(`, `test fail`, `tests failed` |
| `lint_error` | `eslint`, `prettier`, `lint` |
| `build_error` | `build fail`, `bundle`, `esbuild`, `webpack`, `rollup`, `vite` |
| `timeout` | `timeout`, `exceeded`, `timed out` |
| `unknown` | fallback |

---

## Tips

1. **Write granular stories** — one feature per story, testable in isolation
2. **Specific validation** — `npm test -- --testPathPattern=auth` beats `npm test`
3. **Use AGENTS.md** — project context helps every iteration
4. **Dry run first** — `ralph_iterate(workdir, dryRun=true)` previews prompt + config
5. **Browse iteration history** — `ralph_iterations` for timing, tools, failure patterns
6. **Set cursors** — bookmark timestamps, then filter with `sinceEpoch`
7. **Check prompts** — `ralph_iterations showPrompt=<storyId>` to see what was actually sent
