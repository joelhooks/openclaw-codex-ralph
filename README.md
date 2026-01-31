# openclaw-codex-ralph

A [Moltbot/Clawdbot](https://github.com/anthropics/clawdbot) plugin for running autonomous AI coding loops using [OpenAI Codex CLI](https://github.com/openai/codex).

Based on the [Ralph pattern](https://github.com/snarktank/ralph) - spawn fresh AI sessions for each task, validate with tests, commit on success, repeat until done.

## Why Ralph?

Traditional AI coding sessions accumulate context and can drift. Ralph takes a different approach:

- **Fresh context per iteration** - Each task gets a clean AI session
- **Persistent state via git** - Completed work lives in commits, not context
- **Progress tracking** - `progress.txt` carries learnings forward
- **Validation gates** - Typecheck/tests must pass before moving on
- **Granular tasks** - Stories should fit in a single context window

## Installation

### 1. Install the plugin

Add to your `~/.moltbot/moltbot.json`:

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
          "model": "o3",
          "sandbox": "workspace-write",
          "autoCommit": true
        }
      }
    }
  }
}
```

### 2. Restart Moltbot

```bash
moltbot gateway restart
```

### 3. Verify installation

```bash
moltbot plugins list | grep ralph
```

## Requirements

- [Codex CLI](https://github.com/openai/codex) installed and authenticated
- Moltbot/Clawdbot running

## Usage

### Initialize a project

```
ralph_init workdir="/path/to/project" projectName="My Project"
```

Creates:
- `prd.json` - Product requirements with stories
- `progress.txt` - Accumulated learnings

### Add stories

```
ralph_add_story workdir="/path/to/project" title="Add user login" description="Implement OAuth login flow with Google" priority=1 validationCommand="npm test"
```

Stories are processed in priority order (lower = higher priority).

### Check status

```
ralph_status workdir="/path/to/project"
```

Shows pending/completed stories and next task.

### Run single iteration

```
ralph_iterate workdir="/path/to/project"
```

Picks the next story, spawns Codex, validates, commits on success.

### Run full loop

```
ralph_loop workdir="/path/to/project" maxIterations=10
```

Keeps iterating until all stories pass or limit reached.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `o3` | Codex model to use |
| `maxIterations` | `20` | Max loop iterations |
| `sandbox` | `workspace-write` | Codex sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) |
| `autoCommit` | `true` | Auto-commit after successful iterations |
| `debug` | `false` | Enable debug logging |

## prd.json Format

```json
{
  "version": "1.0",
  "projectName": "My Project",
  "description": "Project description",
  "stories": [
    {
      "id": "story-abc123",
      "title": "Add user login",
      "description": "Implement OAuth login with Google...",
      "priority": 1,
      "passes": false,
      "validationCommand": "npm test",
      "acceptanceCriteria": [
        "User can click 'Sign in with Google'",
        "User is redirected back after auth"
      ]
    }
  ],
  "metadata": {
    "createdAt": "2024-01-15T10:00:00Z",
    "lastIteration": "2024-01-15T12:30:00Z",
    "totalIterations": 5
  }
}
```

## Tips

### Write granular stories

Each story should fit in a single AI context window. Break down large features:

❌ "Implement the entire auth system"

✅ "Add login form component"
✅ "Implement OAuth redirect handler"
✅ "Add session persistence"

### Use AGENTS.md

Create an `AGENTS.md` file in your project root with:
- Coding conventions
- Project-specific patterns
- Common gotchas

The plugin includes this context in each iteration.

### Validation commands

Be specific with validation:

```
validationCommand: "npm run typecheck && npm test -- --testPathPattern=auth"
```

## Progress Events

The plugin emits diagnostic events during loop execution:

```typescript
// Before each iteration
{
  type: "ralph:iteration:start",
  plugin: "openclaw-codex-ralph",
  data: {
    iteration: 1,
    maxIterations: 10,
    storyId: "story-abc",
    storyTitle: "Add login form",
    workdir: "/path/to/project"
  }
}

// After each iteration
{
  type: "ralph:iteration:complete",
  plugin: "openclaw-codex-ralph",
  data: {
    iteration: 1,
    success: true,
    toolCalls: 12,
    filesModified: ["src/login.tsx", "src/api/auth.ts"],
    duration: 45000,
    storiesCompleted: 1
  }
}
```

For real-time progress in moltbot, you can also call `ralph_iterate` repeatedly instead of `ralph_loop` - this gives natural progress updates between iterations.

## Inspiration

- [Ralph](https://github.com/snarktank/ralph) - The original autonomous AI agent loop pattern
- [Tips for AI Coding with Ralph Wiggum](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum) - Practical guidance on the pattern
- [Codex CLI](https://github.com/openai/codex) - OpenAI's coding-focused CLI

## License

MIT
