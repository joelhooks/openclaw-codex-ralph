# Learning Capture SOP

Standard operating procedure for the Ralph-Codex hivemind integration. Each loop iteration captures learnings, failures, and context to make subsequent iterations smarter.

## Overview

Ralph integrates with the `swarm memory` CLI (hivemind) at three points in every iteration:

1. **Pre-iteration query** — Before spawning Codex, query hivemind for prior learnings relevant to the current story
2. **Post-success capture** — After a successful commit, store what was learned
3. **Failure pattern storage** — After validation failure, store the failure with categorization

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Ralph Loop                         │
│                                                     │
│  ┌──────────┐   ┌──────────┐   ┌────────────────┐  │
│  │ Hivemind │──▶│  Codex   │──▶│  Validation    │  │
│  │  Query   │   │ Session  │   │                │  │
│  └──────────┘   └──────────┘   └───────┬────────┘  │
│       ▲                                │            │
│       │         ┌──────────────────────┤            │
│       │         ▼                      ▼            │
│  ┌────┴─────────────┐    ┌─────────────────────┐   │
│  │ Hivemind Store   │    │ Hivemind Store      │   │
│  │ (success)        │    │ (failure + category)│   │
│  └──────────────────┘    └─────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ .ralph-context.json (structured inter-story) │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Pre-Iteration: Context Query

Before each Codex spawn, Ralph queries hivemind for memories related to the current story:

```typescript
const hivemindCtx = hivemindFind(story.title);
```

This calls `swarm memory find "{storyTitle}" --limit 3` with a 15-second timeout. Results are injected into the Codex prompt under a `## Prior Learnings (from hivemind)` section, trimmed to 1500 chars max.

**Why:** If a similar story was attempted before (or a related pattern was discovered), the Codex session starts with that knowledge instead of rediscovering it.

## Post-Success: Learning Capture

After a story commits successfully:

```typescript
hivemindStore(
  `Ralph completed: ${story.title}. Files: ${files}. Summary: ${summary}`,
  `ralph,learning,${projectName}`
);
```

**Tags:** `ralph,learning,{projectName}`

Additionally, the structured context file (`.ralph-context.json`) is updated with the story completion details and learnings.

## Failure Pattern Storage

After validation fails:

```typescript
const failureCategory = categorizeFailure(validation.output);
hivemindStore(
  `Ralph failure [${failureCategory}]: ${story.title}. Files: ${files}. Error: ${errorOutput}`,
  `ralph,failure,${failureCategory},${projectName}`
);
```

**Tags:** `ralph,failure,{category},{projectName}`

The failure category is included so future queries can surface relevant failure patterns.

## Failure Categories

| Category | Triggers | Example |
|---|---|---|
| `type_error` | `error TS`, `ts(`, `not assignable`, `cannot find name` | TypeScript compilation errors |
| `test_failure` | `assert`, `expect(`, `test fail`, `tests failed` | Test assertion failures |
| `lint_error` | `eslint`, `prettier`, `lint` | Linting/formatting errors |
| `build_error` | `build fail`, `esbuild`, `webpack`, `rollup`, `vite` | Build tool failures |
| `timeout` | `timeout`, `exceeded 10 minutes`, `timed out` | Process timeouts |
| `unknown` | None of the above | Uncategorized failures |

## Structured Context (.ralph-context.json)

In addition to hivemind (which persists across projects/sessions), Ralph maintains a local `.ralph-context.json` file in each project directory. This provides fast, structured inter-story context:

```json
{
  "stories": [
    {
      "id": "story-abc",
      "title": "Add user auth",
      "status": "completed",
      "filesModified": ["src/auth.ts", "src/middleware.ts"],
      "learnings": "Used passport.js with JWT strategy..."
    }
  ],
  "failures": [
    {
      "storyId": "story-def",
      "category": "type_error",
      "error": "Property 'user' does not exist on type 'Request'"
    }
  ]
}
```

The `buildStructuredContextSnippet` function reads this file and generates a compact summary injected into the prompt under `## Structured Context (machine-generated)`.

The `readStoryContext` function combines PROGRESS.md, recent ralph events, and structured context into a comprehensive inter-story context string.

## Swarm CLI Availability

All hivemind operations check for `swarm` CLI availability first via `which swarm`. If the CLI is not installed, all operations gracefully no-op. The availability check is cached for the process lifetime.

## Safety Guarantees

- **All hivemind operations are wrapped in try/catch** — failures never break the loop
- **Timeouts are enforced** — 15 seconds max per hivemind operation
- **Output is truncated** — information stored is capped at 1000 chars
- **Tags are sanitized** — quotes stripped from tag values
- **Context is trimmed** — hivemind context in prompts capped at 1500 chars

## Manual Operations

Query learnings for a project:
```bash
swarm memory find "ralph" --limit 10
swarm memory find "ralph,learning" --limit 5
```

Query failure patterns:
```bash
swarm memory find "ralph failure type_error" --limit 5
swarm memory find "ralph,failure" --limit 10
```

Store a manual learning:
```bash
swarm memory store "Important: the auth service requires X" --tags "ralph,learning,myproject"
```

## Event Notifications

See [EVENTS.md](./EVENTS.md) for the full event notification system documentation, including event types, schemas, and monitoring integration.
