# Meta-Loop Design

## The Real Game

The real product is the agent orchestration system. Building support agents, data pipelines, whatever — these are testing grounds. The actual game is building autonomous agent loops that get better at getting better.

## Core Principles

### 1. Oracle Context™

The human (Joel) is the Oracle. The Oracle provides:
- **Goals** — What are we trying to achieve?
- **Architecture** — How should the pieces fit together?
- **Wisdom** — What's the right tradeoff here?
- **Taste** — Is this good enough? What's "excellent"?

**Loops STOP and ping the Oracle for these.**

Loops NEVER ping for:
- Research they could do themselves
- Questions answerable from code/docs/data
- Stuff they're too lazy to look up

The Oracle's time is sacred. Come with answers, not questions. Come with proposals, not blank slates.

### 2. Non-Spammy Notifications

Don't ping for every little thing. Be smart about interrupts:

| Ping When | Don't Ping When |
|-----------|-----------------|
| Blocked on Oracle Context | Progress updates |
| Critical failure | Minor completions |
| Decision needs taste | Things that can wait |
| Ambiguous requirements | Batchable updates |

**Batch when possible:** "Here's what I did, here's what's next, here's where I need you"

### 3. Relentless Memory (Hivemind)

Use swarm CLI and hivemind constantly:

```bash
# Before working
swarm memory find "similar task patterns"

# During work
swarm memory store "discovered X requires Y" --tags "gotcha,project"

# After work
swarm memory store "session summary: implemented X, learned Y" --tags "handoff"
```

Memory is how the swarm learns. Every agent leaves the codebase smarter than they found it.

### 4. Context Sharing

Agents don't work in isolation:
- Share learnings across sessions
- Pass context to spawned workers (AGENTS.md, progress.txt)
- Read what other agents discovered
- Build on prior work, don't repeat it

### 5. Comprehensive Logging & O11y

Everything observable via `.ralph-iterations.jsonl`:

**Per-iteration fields (as of 2026-02-09):**
- `startedAt` / `completedAt` — precise timing
- `stderrStats` — real Codex activity metrics:
  - `toolCalls` — how many tools Codex invoked
  - `fileWrites` — files actually modified
  - `testRuns` — test executions
  - `errorsHit` — errors encountered
  - `timeToFirstToolCallMs` — latency to start working
- `verificationRejectReason` — if output verifier caught lazy/mock code
- `ghIssue` — auto-linked GitHub issue number (when `Closes #N` in commit)
- `failureCategory` — typed: `type_error`, `test_failure`, `build_error`, `timeout`, `verification_rejected`
- `model`, `sandbox` — configuration used
- `iterationNumber` — global iteration counter

**Key diagnostic patterns:**
- `toolCalls == 0` on timeout → Codex thinking loop, not coding
- `fileWrites == 0` on failure → never wrote code
- Same `failureCategory` 3x → structural problem, needs redesign
- `verificationRejectReason` set → caught mock/placeholder code

**Event files** in `~/.openclaw/ralph-events/` for real-time monitoring (auto-cleaned after 24h).

**Diagnostic events** via OpenClaw plugin SDK (`ralph:loop:{start|iteration|complete|error}`) visible in gateway diagnostic stream.

The coordinator (Grimlock) monitors the swarm using these signals to intervene intelligently — not just "is it running?" but "is it actually writing good code?"

### 6. Meta-Loops

The loop that improves the loop:

```
while not_excellent(work):
    result = do_work()
    learnings = extract_learnings(result)
    
    if learnings.improve_tooling:
        apply_to_ralph_plugin(learnings)
    
    if learnings.refine_task:
        update_task_definition()
    
    if needs_oracle_context(result):
        oracle_input = ping_oracle()
        incorporate(oracle_input)
```

Every task is also an opportunity to improve the tasking system itself.

## Implementation Ideas

### Nested prd.json

```
ralph-project/
├── prd.json              # Actual work stories
├── meta-prd.json         # Stories about improving Ralph itself
└── progress.txt          # Shared learnings
```

### Story Types

```json
{
  "id": "story-abc",
  "title": "Do the thing",
  "type": "task",           // or "meta" for plugin improvements
  "oracle_gates": [         // When to stop and ask
    "architecture_unclear",
    "taste_decision"
  ]
}
```

### Auto-Capture Meta Stories

After each iteration, analyze:
- What friction was encountered?
- What would have made this easier?
- What pattern could be extracted?

Generate meta-stories automatically from friction.

## Dogfooding

We build this by using it:
1. Run the gold data loops manually
2. Note every friction point
3. Turn frictions into meta-stories
4. Implement improvements
5. Run again with improved tooling
6. Repeat until excellent
