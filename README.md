# openclaw-codex-ralph

An [OpenClaw](https://github.com/joelhooks/openclaw) plugin for autonomous AI coding loops using [Codex CLI](https://github.com/openai/codex).

Based on the [Ralph pattern](https://github.com/snarktank/ralph) — spawn fresh AI sessions for each task, validate with tests, commit on success, repeat until done.

## What It Does

- **26 tools** registered as an OpenClaw plugin
- **Fresh Codex sessions** per iteration — no context drift
- **Hivemind integration** — aggressive multi-query learning pulls (4 queries, 16 results per iteration)
- **Learning enforcement** — validates agent output quality, flags lazy "Learnings: None" responses
- **Failure pattern propagation** — recurring failures get escalated in prompts with root cause demands
- **Iteration logging** — per-project JSONL log + centralized prompt persistence with SHA-256 hashes
- **Repo autopsy tools** — deep analysis of any GitHub repo (search, AST, blame, hotspots, secrets)

## Installation

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-codex-ralph"
      ]
    },
    "entries": {
      "openclaw-codex-ralph": {
        "enabled": true,
        "config": {
          "model": "gpt-5.3-codex",
          "sandbox": "danger-full-access",
          "autoCommit": true
        }
      }
    }
  }
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

Verify:

```bash
# Should show 26 tools registered
openclaw gateway restart 2>&1 | grep ralph
```

## Requirements

- [Codex CLI](https://github.com/openai/codex) installed and authenticated
- [OpenClaw](https://github.com/joelhooks/openclaw) running
- `swarm` CLI in PATH (for hivemind learning capture — optional but recommended)

## Tools (26)

### Core Loop
| Tool | Description |
|------|-------------|
| `ralph_init` | Initialize project with prd.json + progress.txt |
| `ralph_add_story` | Add story to prd.json |
| `ralph_status` | Check pending/completed stories |
| `ralph_edit_story` | Edit story priority, description, status |
| `ralph_iterate` | Run single iteration (pick story, spawn Codex, validate, commit) |
| `ralph_loop` | Start async loop in background (returns job ID immediately) |
| `ralph_loop_status` | Check running/completed loop jobs |
| `ralph_loop_cancel` | Cancel a running loop |

### Observability
| Tool | Description |
|------|-------------|
| `ralph_iterations` | Browse iteration history — timing, tools, prompts, session cross-refs |
| `ralph_cursor` | Timestamp bookmarks for scoping log/session searches |

### Sessions
| Tool | Description |
|------|-------------|
| `ralph_sessions` | List recent Codex sessions |
| `ralph_session_show` | View session messages with range filters |
| `ralph_session_resume` | Continue a previous session |

### Orchestration
| Tool | Description |
|------|-------------|
| `ralph_patterns` | List orchestration patterns (triangulated review, scout-act-verify, etc.) |
| `ralph_worker_prompt` | Generate worker prompt with standard preamble |

### Autopsy (Repo Analysis)
| Tool | Description |
|------|-------------|
| `autopsy_clone` | Clone/update GitHub repo for analysis |
| `autopsy_structure` | Directory tree |
| `autopsy_search` | Ripgrep search with regex |
| `autopsy_ast` | AST-grep structural code search |
| `autopsy_find` | Fast file finding with fd |
| `autopsy_file` | Read file with optional line range |
| `autopsy_deps` | Dependency analysis |
| `autopsy_hotspots` | Most changed/largest files, TODOs |
| `autopsy_stats` | Line counts by language (tokei) |
| `autopsy_blame` | Git blame |
| `autopsy_exports` | Map TypeScript public API |
| `autopsy_secrets` | Scan for leaked secrets (gitleaks) |
| `autopsy_cleanup` | Remove cloned repo from cache |

## How It Works

### The Iteration Loop

```
prd.json → pick next story → build prompt → spawn Codex → validate → commit
                ↑                                              │
                └──────── update prd.json, progress.txt ───────┘
```

Each iteration:
1. Reads `prd.json` for the highest-priority pending story
2. Pulls hivemind context (4 queries: story relevance, failure patterns, project learnings, tech gotchas)
3. Builds prompt with story, AGENTS.md, progress, structured context, failure pattern analysis
4. Persists full prompt to `~/.openclaw/ralph-iterations/prompts/` (SHA-256 hash for dedup)
5. Spawns fresh Codex session
6. Runs validation command
7. On success: commits, stores learning in hivemind, validates learning quality
8. On failure: categorizes failure, stores pattern, propagates to next iteration
9. Writes JSONL log entry to `{workdir}/.ralph-iterations.jsonl`

### Learning System

Ralph aggressively captures and applies learnings between iterations:

**Pre-iteration:** `aggressiveHivemindPull()` runs 4 targeted queries (16 results total) covering story relevance, failure patterns, project learnings, and technology gotchas.

**Post-iteration:** `validateLearnings()` checks agent output for lazy patterns ("Learnings: None", vague one-liners). Lazy responses get recorded in hivemind as quality warnings.

**Failure propagation:** `buildFailurePatternContext()` reads the iteration log for recurring failure categories. If the same category hits 2+ times, the prompt gets an escalation block demanding root cause analysis.

**Structured context:** `.ralph-context.json` carries forward completed stories (with learnings) and failures (with categories, tool names, error details).

### Iteration Log

Per-project JSONL at `{workdir}/.ralph-iterations.jsonl`:

```json
{
  "timestamp": "2026-02-08T03:00:00.000Z",
  "epoch": 1738983600000,
  "jobId": "ralph-abc123",
  "storyId": "story-xyz",
  "storyTitle": "Add user auth",
  "codexSessionId": "session-456",
  "codexSessionFile": "~/.codex/sessions/2026/02/08/session-456.jsonl",
  "commitHash": "a1b2c3d",
  "promptHash": "e4f5a6b7c8d9e0f1",
  "promptFile": "~/.openclaw/ralph-iterations/prompts/1738983600-ralph-abc123-story-xyz.md",
  "success": true,
  "validationPassed": true,
  "duration": 45000,
  "toolCalls": 12,
  "toolNames": ["file_edit", "shell", "write_file"],
  "filesModified": ["src/auth.ts", "src/auth.test.ts"],
  "model": "gpt-5.3-codex",
  "sandbox": "danger-full-access"
}
```

Browse with:
```
ralph_iterations workdir="/path/to/project"
ralph_iterations workdir="/path/to/project" onlyFailed=true
ralph_iterations workdir="/path/to/project" showPrompt="story-xyz"
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `gpt-5.2-codex` | Codex model to use |
| `maxIterations` | `20` | Max loop iterations |
| `sandbox` | `danger-full-access` | Codex sandbox mode |
| `autoCommit` | `true` | Auto-commit on success |
| `debug` | `false` | Debug logging |

## Tips

- **Write granular stories** — one feature per story, testable in isolation
- **Specific validation** — `npm test -- --testPathPattern=auth` beats `npm test`
- **Use AGENTS.md** — project context helps every iteration
- **Dry run first** — `ralph_iterate(workdir, dryRun=true)` to preview prompt and config
- **Use async loops** — `ralph_loop` returns immediately, check with `ralph_loop_status`
- **Browse iteration history** — `ralph_iterations` shows timing, tools, failure patterns
- **Set cursors** — `ralph_cursor action=set label="after fix"` then filter with `sinceEpoch`

## File Layout

```
~/.openclaw/
  ralph-events/              # Event notification files (JSON, auto-cleaned >24h)
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

## Inspiration

- [Ralph](https://github.com/snarktank/ralph) — The original autonomous AI agent loop pattern
- [Tips for AI Coding with Ralph Wiggum](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum) — Practical guidance on the pattern
- [Codex CLI](https://github.com/openai/codex) — OpenAI's coding-focused CLI

## License

MIT
