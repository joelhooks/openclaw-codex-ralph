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
