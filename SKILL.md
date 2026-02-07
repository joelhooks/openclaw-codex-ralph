# Ralph Codex Skill

Autonomous AI coding loops using Codex CLI. Spawn fresh AI sessions for each task, validate with tests, commit on success, repeat until done.

## Quick Reference

### Project Setup
```
ralph_init(workdir="/path/to/project", projectName="My App")
ralph_add_story(workdir, title="Add login", description="OAuth with Google", priority=1, validationCommand="npm test")
```

### Run Iterations
```
ralph_status(workdir)           # Check what's pending
ralph_iterate(workdir)          # Run one story
ralph_loop(workdir, maxIterations=10)  # Run until done
```

### Session Management
```
ralph_sessions(limit=20)        # List recent Codex sessions
ralph_session_show(sessionId)   # View session details
ralph_session_resume(sessionId, message)  # Continue a session
```

### Orchestration Patterns
```
ralph_patterns()                # List all patterns
ralph_worker_prompt(task="...", role="reviewer")  # Generate worker prompt
```

---

## Core Concept: The Ralph Pattern

Traditional AI coding sessions accumulate context and drift. Ralph keeps things clean:

1. **Fresh context per iteration** — Each task gets a clean Codex session
2. **Persistent state via git** — Completed work lives in commits, not context
3. **Progress tracking** — `progress.txt` carries learnings forward
4. **Validation gates** — Tests must pass before moving on
5. **Granular tasks** — Stories should fit in a single context window

---

## Workflow

### 1. Initialize Project

```
ralph_init(workdir="~/Code/myproject", projectName="My Project")
```

Creates:
- `prd.json` — Product requirements with stories
- `progress.txt` — Accumulated learnings

### 2. Add Stories

Stories should be **small and testable**. Each should fit in one AI context window.

❌ Bad: "Implement the entire auth system"
✅ Good: "Add login form component"
✅ Good: "Implement OAuth redirect handler"
✅ Good: "Add session persistence"

```
ralph_add_story(
  workdir="~/Code/myproject",
  title="Add login form",
  description="Create a React login form with email/password fields. Use shadcn/ui components. Form should validate inputs and show errors.",
  priority=1,
  validationCommand="npm run typecheck && npm test -- --testPathPattern=login",
  acceptanceCriteria='["Email validation works", "Password min 8 chars", "Submit disabled while invalid"]'
)
```

Priority: lower = higher priority. Stories run in priority order.

### 3. Check Status

```
ralph_status(workdir="~/Code/myproject")
```

Returns:
- Total/completed/pending counts
- Next story to run
- All stories with status

### 4. Run Iterations

**Single iteration** (recommended for visibility):
```
ralph_iterate(workdir="~/Code/myproject")
```

**Full loop** (hands-off):
```
ralph_loop(workdir="~/Code/myproject", maxIterations=10, stopOnFailure=true)
```

Each iteration:
1. Picks highest-priority pending story
2. Spawns fresh Codex with story context + progress
3. Runs validation command
4. If passes: marks done, commits, updates progress
5. If fails: logs failure details to progress

### 5. Edit Stories

```
ralph_edit_story(workdir, storyId="story-abc", priority=5)  # Reprioritize
ralph_edit_story(workdir, storyId="story-abc", passes=false)  # Reset to retry
```

---

## prd.json Format

```json
{
  "version": "1.0",
  "projectName": "My Project",
  "description": "Project description",
  "stories": [
    {
      "id": "story-abc123",
      "title": "Add login form",
      "description": "Create a React login form...",
      "priority": 1,
      "passes": false,
      "validationCommand": "npm test -- --testPathPattern=login",
      "acceptanceCriteria": ["Email validation works", "Password min 8 chars"]
    }
  ],
  "metadata": {
    "createdAt": "2024-01-15T10:00:00Z",
    "lastIteration": "2024-01-15T12:30:00Z",
    "totalIterations": 5
  }
}
```

---

## AGENTS.md Context

If the project has an `AGENTS.md` file, it's included in every iteration. Put:
- Coding conventions
- Project-specific patterns
- Common gotchas
- File structure guidance

---

## Orchestration Patterns

For complex work, use orchestration patterns:

### Triangulated Review
Fan out 2-4 reviewers with different lenses, merge findings:
- Clarity/structure
- Correctness/completeness
- Risks/failure modes
- Consistency/style

### Review → Fix
Serial chain: reviewer → implementer → verifier

### Scout → Act → Verify
1. Scout gathers context (read-only)
2. Orchestrator chooses approach
3. Implementer executes
4. Verifier checks

### Generate Worker Prompts
```
ralph_worker_prompt(
  task="Review auth flow for security issues",
  role="reviewer",
  scope="read-only",
  lens="security"
)
```

---

## Session Management

### List Recent Sessions
```
ralph_sessions(limit=20, date="2024/01/15")
```

### View Session Details
```
ralph_session_show(sessionId="abc123", ranges="1...5")
```

Shows messages with optional range filter.

### Resume Session
```
ralph_session_resume(sessionId="abc123", message="Fix the failing test")
```

---

## Repo Analysis (Autopsy Tools)

Analyze any GitHub repo locally with powerful tools:

### Clone for Analysis
```
autopsy_clone(repo="owner/repo")  # or full URL
autopsy_clone(repo="owner/repo", refresh=true)  # Force update
```

### Structure & Navigation
```
autopsy_structure(repo, depth=4)
autopsy_find(repo, pattern="config", extension="ts")
autopsy_file(repo, path="src/index.ts", startLine=1, endLine=50)
```

### Code Search
```
autopsy_search(repo, pattern="async function", fileGlob="*.ts", context=3)
autopsy_ast(repo, pattern="function $NAME($$$)", lang="ts")  # Structural search
```

### Analysis
```
autopsy_deps(repo)       # Dependencies (package.json, requirements.txt, etc.)
autopsy_hotspots(repo)   # Most changed files, largest files, TODO counts
autopsy_stats(repo)      # Line counts by language (tokei)
autopsy_blame(repo, path="src/auth.ts", startLine=10, endLine=30)
autopsy_exports(repo)    # Map all TypeScript exports
autopsy_secrets(repo)    # Scan for leaked secrets (gitleaks)
```

### Cleanup
```
autopsy_cleanup(repo="owner/repo")  # Remove one
autopsy_cleanup(repo="all")         # Clear cache
```

---

## Configuration

Plugin config in `moltbot.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-codex-ralph": {
        "enabled": true,
        "config": {
          "model": "o3",
          "maxIterations": 20,
          "sandbox": "workspace-write",
          "autoCommit": true,
          "debug": false
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `gpt-5.2-codex` | Codex model to use |
| `maxIterations` | `20` | Max loop iterations |
| `sandbox` | `workspace-write` | Codex sandbox mode |
| `autoCommit` | `true` | Auto-commit on success |
| `debug` | `false` | Debug logging |

---

## Tips

1. **Write granular stories** — One feature per story, testable in isolation
2. **Specific validation** — `npm test -- --testPathPattern=auth` beats `npm test`
3. **Use AGENTS.md** — Project context helps every iteration
4. **Monitor progress.txt** — See what Codex learned/failed
5. **Dry run first** — `ralph_iterate(workdir, dryRun=true)` to preview
6. **Single iterations** — Better visibility than `ralph_loop`

---

## Learning Capture SOP (Hivemind Integration)

Ralph integrates with the `swarm memory` hivemind for persistent cross-session learning. This happens automatically — no configuration needed.

### How It Works

1. **Pre-iteration context query** — Before each iteration, Ralph queries hivemind with the current story title to retrieve relevant prior learnings. These are injected into the Codex prompt as a "Prior Learnings" section.

2. **Post-success learning capture** — After a story completes and is committed, Ralph stores a summary in hivemind:
   - Story title + files modified + Codex summary
   - Tags: `ralph,learning,{projectName}`

3. **Failure pattern storage** — On validation failure, Ralph stores the failure pattern:
   - Story title + files + error output (truncated to 500 chars) + failure category
   - Tags: `ralph,failure,{failureCategory},{projectName}`

### Requirements

- `swarm` CLI must be in PATH (checked once, cached)
- All hivemind calls are wrapped in try/catch — failures never break the loop
- Timeout: 15 seconds per hivemind call

### Querying Learnings Manually

```bash
# Find all learnings for a project
swarm memory find "ralph learning MyProject" --limit 20

# Find failure patterns
swarm memory find "ralph failure MyProject" --limit 10

# Find specific failure types
swarm memory find "ralph failure type_error MyProject"
```

---

## Event Monitoring

Ralph emits event files to `~/.openclaw/ralph-events/` for monitoring by HEARTBEAT.md or external tools.

### Event Types

| Event | When | Key Fields |
|-------|------|------------|
| `loop_start` | Loop begins | `jobId`, `totalStories`, `workdir` |
| `story_complete` | Story passes validation + commits | `storyId`, `storyTitle`, `filesModified`, `commitHash`, `duration`, `summary` |
| `story_failed` | Story fails validation | `storyId`, `storyTitle`, `error`, `category`, `duration` |
| `loop_complete` | Loop finishes (all done or max iterations) | `storiesCompleted`, `totalStories`, `duration`, `results[]` |
| `loop_error` | Loop stops on error/cancellation | `error`, `storiesCompleted`, `lastStory` |

### Event File Format

Files are JSON, named `{timestamp}-{type}-{jobId}.json`. Located in `~/.openclaw/ralph-events/`.

Old events (>24h) are auto-cleaned at loop start.

### Monitoring in HEARTBEAT.md

```bash
# Check for recent events
ls -lt ~/.openclaw/ralph-events/ | head -5

# Read latest event
cat $(ls -t ~/.openclaw/ralph-events/*.json | head -1) | jq .
```

See `docs/EVENTS.md` in the plugin repo for full schema documentation.

---

## Failure Categories

Ralph classifies validation failures to enable smarter iteration and pattern detection.

| Category | Detected By | Examples |
|----------|------------|---------|
| `type_error` | `error ts`, `ts(`, `not assignable`, `cannot find name` | TypeScript compilation errors |
| `test_failure` | `assert`, `expect(`, `test fail`, `tests failed` | Jest/Vitest/Mocha assertion failures |
| `lint_error` | `eslint`, `prettier`, `lint` | Linting and formatting errors |
| `build_error` | `build fail`, `bundle`, `esbuild`, `webpack`, `rollup`, `vite` | Build/bundling failures |
| `timeout` | `timeout`, `exceeded`, `timed out` | Command or iteration timeout |
| `unknown` | (fallback) | Everything else |

Categories are stored in:
- **Ralph events** (`story_failed` events include `category` field)
- **Hivemind** (tagged with category for searchability)
- **Structured context** (`.ralph-context.json` failures include category)

### Structured Context (.ralph-context.json)

In addition to `progress.txt` (human-readable), Ralph maintains `.ralph-context.json` for machine consumption:

```json
{
  "stories": [
    {
      "id": "story-abc",
      "title": "Add login form",
      "status": "completed",
      "filesModified": ["src/login.tsx"],
      "learnings": "Used shadcn/ui form components..."
    }
  ],
  "failures": [
    {
      "storyId": "story-def",
      "category": "type_error",
      "error": "Type 'string' is not assignable to type 'number'..."
    }
  ]
}
```

This structured context is automatically included in iteration prompts, giving Codex awareness of recent successes and failure patterns.

---

## Progress Reporting via OpenClaw Messaging

**Workers MUST report progress to the coordinator in real-time using OpenClaw CLI.**

This keeps the human (and coordinator agent) informed without waiting for commits or loop completion.

### Required Messages

```bash
# Starting a story
openclaw message "🚀 Starting: [story-id] - [title]"

# Story completed successfully
openclaw message "✅ Completed: [story-id] - [brief summary of changes]"

# Hit a blocker
openclaw message "🚫 Blocked: [story-id] - [what's blocking and why]"

# Tests failing
openclaw message "❌ Tests failing: [story-id] - [failure summary]"

# Need human input
openclaw message "🙋 Need input: [story-id] - [question for human]"
```

### Why This Matters

1. **Real-time visibility** — Don't wait for loop completion to know what's happening
2. **Early blocker detection** — Coordinator can intervene before wasting iterations
3. **Human-in-the-loop** — Easy to ask questions or flag issues
4. **Audit trail** — Messages persist in chat history

### Example Flow

```
🚀 Starting: gh-24 - Install Vitest and create root config
✅ Completed: gh-24 - Added vitest 3.0, created vitest.config.ts with coverage
🚀 Starting: gh-25 - Create first unit test for identity.ts
❌ Tests failing: gh-25 - identity.ts has no exports, need to check module structure
🙋 Need input: gh-25 - Should identity.ts export a class or functions?
```

**Don't commit silently — communicate!**
