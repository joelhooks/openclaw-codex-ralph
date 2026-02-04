# Ralph Event System

Ralph emits structured JSON event files for monitoring, debugging, and integration with external tools like HEARTBEAT.md.

## Event File Location

```
~/.openclaw/ralph-events/
```

Events are stored as individual JSON files named:
```
{unix_timestamp}-{event_type}-{job_id}.json
```

Example: `1706889600000-story_complete-ralph-abc123.json`

## Automatic Cleanup

Old event files (>24 hours) are automatically cleaned up at the start of each loop run via `cleanupOldEvents()`. This prevents unbounded disk growth.

## Event Types

### `loop_start`

Emitted when a ralph loop begins.

```json
{
  "timestamp": "2024-02-04T10:00:00.000Z",
  "type": "loop_start",
  "jobId": "ralph-abc123",
  "totalStories": 5,
  "workdir": "/path/to/project"
}
```

### `story_complete`

Emitted when a story passes validation and is committed.

```json
{
  "timestamp": "2024-02-04T10:15:00.000Z",
  "type": "story_complete",
  "jobId": "ralph-abc123",
  "storyId": "story-xyz",
  "storyTitle": "Add login form",
  "filesModified": ["src/login.tsx", "src/login.test.tsx"],
  "commitHash": "a1b2c3d",
  "duration": 180000,
  "summary": "Created login form with email/password fields using shadcn/ui...",
  "workdir": "/path/to/project"
}
```

### `story_failed`

Emitted when a story fails validation.

```json
{
  "timestamp": "2024-02-04T10:30:00.000Z",
  "type": "story_failed",
  "jobId": "ralph-abc123",
  "storyId": "story-xyz",
  "storyTitle": "Add OAuth handler",
  "error": "error TS2345: Argument of type 'string' is not assignable...",
  "category": "type_error",
  "duration": 120000,
  "workdir": "/path/to/project"
}
```

**Failure categories:** `type_error`, `test_failure`, `lint_error`, `build_error`, `timeout`, `unknown`

### `loop_complete`

Emitted when a loop finishes (all stories done or max iterations reached).

```json
{
  "timestamp": "2024-02-04T11:00:00.000Z",
  "type": "loop_complete",
  "jobId": "ralph-abc123",
  "storiesCompleted": 4,
  "totalStories": 5,
  "duration": 3600000,
  "results": [
    { "storyTitle": "Add login form", "success": true, "duration": 180000 },
    { "storyTitle": "Add OAuth handler", "success": false, "duration": 120000 }
  ],
  "workdir": "/path/to/project"
}
```

### `loop_error`

Emitted when a loop stops due to an error or cancellation.

```json
{
  "timestamp": "2024-02-04T10:45:00.000Z",
  "type": "loop_error",
  "jobId": "ralph-abc123",
  "error": "Story failed: Add OAuth handler",
  "storiesCompleted": 3,
  "lastStory": { "id": "story-xyz", "title": "Add OAuth handler" },
  "workdir": "/path/to/project"
}
```

## Common Fields

All events include:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string (ISO 8601) | When the event was emitted |
| `type` | string | Event type identifier |
| `jobId` | string | Ralph job ID (format: `ralph-{base36ts}-{random}`) |

## Monitoring in HEARTBEAT.md

Add this to your `HEARTBEAT.md` to check ralph status during heartbeats:

```markdown
## Ralph Loop Monitoring

Check for recent ralph events:
- Look in `~/.openclaw/ralph-events/` for recent files
- If a `story_failed` event exists, check the `category` field
- If a `loop_complete` event exists, report results
- Clean up: events older than 24h are auto-cleaned
```

### Quick Shell Commands

```bash
# List recent events (newest first)
ls -lt ~/.openclaw/ralph-events/ | head -10

# Read the most recent event
cat "$(ls -t ~/.openclaw/ralph-events/*.json 2>/dev/null | head -1)" | jq .

# Find all failures
grep -l '"type":"story_failed"' ~/.openclaw/ralph-events/*.json 2>/dev/null

# Count events by type
for f in ~/.openclaw/ralph-events/*.json; do jq -r .type "$f"; done 2>/dev/null | sort | uniq -c

# Watch for new events in real-time
inotifywait -m ~/.openclaw/ralph-events/ -e create 2>/dev/null
```

## Structured Context (.ralph-context.json)

In addition to events, Ralph maintains a structured context file in the project working directory:

```
{workdir}/.ralph-context.json
```

This file tracks story completions and failures for machine consumption, enabling smarter iteration prompts. It is automatically read at the start of each iteration and included in the Codex prompt.

### Schema

```json
{
  "stories": [
    {
      "id": "story-abc",
      "title": "Story title",
      "status": "completed | failed",
      "filesModified": ["file1.ts", "file2.ts"],
      "learnings": "Summary of what was done or what failed"
    }
  ],
  "failures": [
    {
      "storyId": "story-abc",
      "category": "type_error | test_failure | lint_error | build_error | timeout | unknown",
      "error": "Truncated error output (max 500 chars)"
    }
  ]
}
```

The failures array is auto-pruned to the last 20 entries to prevent unbounded growth.

## Diagnostic Events (OpenClaw Plugin SDK)

In addition to file-based events, Ralph emits diagnostic events via the OpenClaw plugin SDK (`emitDiagnosticEvent`). These are visible in the OpenClaw gateway's diagnostic stream and follow the pattern `ralph:loop:{start|iteration|complete|error}`.
