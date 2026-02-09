/**
 * Ralph-Codex Plugin
 *
 * Autonomous AI coding loops using Codex. Each iteration spawns a fresh
 * Codex session to implement one story from prd.json, validates with
 * typecheck/tests, commits on success, and repeats until done.
 *
 * Based on: https://github.com/snarktank/ralph
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emitDiagnosticEvent } from "openclaw/plugin-sdk";
import { execFileSync, execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync, appendFileSync } from "fs";
import { join, resolve, basename, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { autopsyTools } from "./autopsy.js";
import { VALIDATION_OUTPUT_LIMIT, captureValidation } from "./validation-helpers.js";
import { deduplicateFailureContext } from "./prompt-helpers.js";
import { generateCodebaseMap, enrichMapFromSession } from "./context-generator.js";
import { processRegistry, monitorProgress, getActualFilesModified } from "./process-helpers.js";
import { StoryRetryTracker, DEFAULT_MAX_RETRIES, shouldSkipStory, formatSkippedSummary } from "./loop-guards.js";
import { createStderrMonitor, formatIterationBehavior, type MonitorStats } from "./loop-monitor.js";
import { verifyOutput } from "./output-verifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types
// ============================================================================

interface RalphIterationOutput {
  success: boolean;
  summary: string;
  files_modified: string[];
  learnings: {
    technical_discovery: string;
    gotcha_for_next_iteration: string;
    files_context: string;
  };
  validation_passed: boolean;
  error_output?: string;
}

interface Story {
  id: string;
  title: string;
  description: string;
  priority: number;
  passes: boolean;
  validationCommand?: string;
  acceptanceCriteria?: string[];
  issueNumber?: number;
}

interface PRD {
  version: string;
  projectName: string;
  description?: string;
  stories: Story[];
  metadata?: {
    createdAt: string;
    lastIteration?: string;
    totalIterations?: number;
    trackingIssue?: number;
  };
}

interface IterationResult {
  success: boolean;
  storyId: string;
  storyTitle: string;
  validationPassed: boolean;
  commitHash?: string;
  sessionId?: string;
  error?: string;
  codexOutput?: string;
  codexFinalMessage?: string;
  toolCalls?: number;
  filesModified?: string[];
  duration: number;
  verificationPassed?: boolean;
  verificationWarnings?: string[];
  issueNumber?: number;
  issueCommented?: boolean;
}

// ============================================================================
// Orchestration Constants (from codex-orchestration skill)
// ============================================================================

const WORKER_PREAMBLE = `CONTEXT: WORKER
ROLE: You are a sub-agent run by the ORCHESTRATOR. Do only the assigned task.
RULES: No extra scope, no other workers.
Your final output will be provided back to the ORCHESTRATOR.`;

const ORCHESTRATION_PATTERNS = {
  "triangulated-review": {
    name: "Triangulated Review",
    description: "Fan-out 2-4 reviewers with different lenses, then merge findings",
    lenses: ["clarity/structure", "correctness/completeness", "risks/failure modes", "consistency/style"],
  },
  "review-fix": {
    name: "Review → Fix",
    description: "Serial chain: reviewer → implementer → verifier",
    steps: ["Review and rank issues", "Implement top fixes", "Verify changes"],
  },
  "scout-act-verify": {
    name: "Scout → Act → Verify",
    description: "Gather context first, then execute, then validate",
    steps: ["Scout gathers context", "Orchestrator chooses approach", "Implementer executes", "Verifier checks"],
  },
  "split-sections": {
    name: "Split by Sections",
    description: "Parallel work on distinct slices, merge for consistency",
  },
  "options-sprint": {
    name: "Options Sprint",
    description: "Generate 2-3 good alternatives, select and refine one",
  },
} as const;

interface LoopResult {
  success: boolean;
  iterationsRun: number;
  storiesCompleted: number;
  remainingStories: number;
  results: IterationResult[];
  stoppedReason: "complete" | "limit" | "failure" | "error" | "cancelled";
}

// ============================================================================
// Job Store for Async Loops
// ============================================================================

interface LoopJob {
  id: string;
  workdir: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  currentIteration: number;
  maxIterations: number;
  currentStory?: { id: string; title: string };
  storiesCompleted: number;
  totalStories: number;
  results: IterationResult[];
  error?: string;
  abortController?: AbortController;
  model?: string;
  sandbox?: string;
  ghIssues?: boolean;
}

const activeJobs = new Map<string, LoopJob>();

function generateJobId(): string {
  return `ralph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emitLoopProgress(job: LoopJob, event: "start" | "iteration" | "complete" | "error") {
  emitDiagnosticEvent({
    type: `ralph:loop:${event}`,
    plugin: "openclaw-codex-ralph",
    data: {
      jobId: job.id,
      workdir: job.workdir,
      status: job.status,
      iteration: job.currentIteration,
      maxIterations: job.maxIterations,
      currentStory: job.currentStory,
      storiesCompleted: job.storiesCompleted,
      totalStories: job.totalStories,
      elapsedMs: Date.now() - job.startedAt,
      error: job.error,
      model: job.model,
      sandbox: job.sandbox,
      ghIssues: job.ghIssues,
    },
  });
}

// ============================================================================
// Event Notification System
// ============================================================================

const RALPH_EVENTS_DIR = join(homedir(), ".openclaw", "ralph-events");
const RALPH_CURSOR_FILE = join(homedir(), ".openclaw", "ralph-cursor.json");
const RALPH_ITERATIONS_DIR = join(homedir(), ".openclaw", "ralph-iterations");
const RALPH_PROMPTS_DIR = join(RALPH_ITERATIONS_DIR, "prompts");

interface RalphEvent {
  timestamp: string;
  jobId: string;
  type: string;
  storyId?: string;
  storyTitle?: string;
  summary?: string;
  filesModified?: string[];
  duration?: number;
  commitHash?: string;
  error?: string;
  failureCategory?: FailureCategory;
  workdir?: string;
  totalStories?: number;
  storiesCompleted?: number;
  lastStory?: { id: string; title: string };
  results?: Array<{ storyTitle: string; success: boolean; duration: number }>;
  codexSessionId?: string;
  issueNumber?: number;
  verificationRejectReason?: string;
}

function writeRalphEvent(type: string, data: Partial<RalphEvent> & { jobId: string }): void {
  try {
    mkdirSync(RALPH_EVENTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const event: RalphEvent = {
      timestamp,
      type,
      ...data,
    };
    const safeTimestamp = Date.now();
    const filename = `${safeTimestamp}-${type}-${data.jobId}.json`;
    writeFileSync(join(RALPH_EVENTS_DIR, filename), JSON.stringify(event, null, 2));
  } catch (err) {
    // Don't let event writing failures break the loop
    console.error(`[openclaw-codex-ralph] Failed to write event: ${err}`);
  }
}

function cleanupOldEvents(maxAgeMs: number = 86400000): void {
  try {
    if (!existsSync(RALPH_EVENTS_DIR)) return;
    const now = Date.now();
    const files = readdirSync(RALPH_EVENTS_DIR);
    for (const file of files) {
      const filePath = join(RALPH_EVENTS_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch {
        // skip files we can't stat/delete
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

// ============================================================================
// Iteration Log (per-project JSONL + centralized prompt persistence)
// ============================================================================

interface IterationLogEntry {
  timestamp: string;
  epoch: number;
  jobId: string;
  iterationNumber: number;
  storyId: string;
  storyTitle: string;
  codexSessionId?: string;
  codexSessionFile?: string;
  commitHash?: string;
  promptHash: string;
  promptFile: string;
  promptLength: number;
  success: boolean;
  validationPassed: boolean;
  failureCategory?: FailureCategory;
  duration: number;
  codexOutputLength: number;
  codexFinalMessageLength: number;
  toolCalls: number;
  toolNames: string[];
  filesModified: string[];
  validationOutput?: string;
  verificationPassed?: boolean;
  verificationWarnings?: string[];
  verificationRejectReason?: string;
  model: string;
  sandbox: string;
  startedAt?: string;
  completedAt?: string;
  stderrStats?: MonitorStats;
}

function persistPrompt(jobId: string, storyId: string, prompt: string): { path: string; hash: string } {
  try {
    mkdirSync(RALPH_PROMPTS_DIR, { recursive: true });
    const hash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    const filename = `${Date.now()}-${jobId}-${storyId}.md`;
    const filepath = join(RALPH_PROMPTS_DIR, filename);
    writeFileSync(filepath, prompt);
    return { path: filepath, hash };
  } catch (err) {
    console.error(`[openclaw-codex-ralph] Failed to persist prompt: ${err}`);
    return { path: "", hash: "" };
  }
}

function appendIterationLog(workdir: string, entry: IterationLogEntry): void {
  try {
    const logPath = join(resolvePath(workdir), ".ralph-iterations.jsonl");
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`[openclaw-codex-ralph] Failed to append iteration log: ${err}`);
  }
}

function readIterationLog(
  workdir: string,
  options?: { sinceEpoch?: number; storyId?: string; jobId?: string; limit?: number; onlyFailed?: boolean }
): IterationLogEntry[] {
  const logPath = join(resolvePath(workdir), ".ralph-iterations.jsonl");
  if (!existsSync(logPath)) return [];

  try {
    const lines = readFileSync(logPath, "utf-8").split("\n").filter((l) => l.trim());
    let entries: IterationLogEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as IterationLogEntry);
      } catch {
        // skip malformed lines
      }
    }

    if (options?.sinceEpoch) {
      entries = entries.filter((e) => e.epoch >= options.sinceEpoch!);
    }
    if (options?.storyId) {
      entries = entries.filter((e) => e.storyId === options.storyId);
    }
    if (options?.jobId) {
      entries = entries.filter((e) => e.jobId === options.jobId);
    }
    if (options?.onlyFailed) {
      entries = entries.filter((e) => !e.success);
    }

    const limit = options?.limit ?? 20;
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

function resolveSessionFile(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  try {
    const sessions = listSessions(undefined, 100);
    const match = sessions.find((s) => s.id === sessionId || s.id.startsWith(sessionId));
    return match?.file;
  } catch {
    return undefined;
  }
}

function extractToolNames(events: CodexEvent[]): string[] {
  const names = new Set<string>();
  for (const event of events) {
    if (!event.item) continue;
    if (event.type === "item.completed" || event.type === "item.started") {
      if (event.item.type === "command_execution" && event.item.command) {
        // Extract the base command name from the full command string
        // e.g. '/usr/bin/zsh -lc "cd /foo && pnpm test"' → 'pnpm test'
        const cmd = event.item.command;
        const shellMatch = cmd.match(/-lc\s+"(?:cd\s+[^&]+&&\s*)?(.+?)"/);
        const baseCmd = shellMatch ? shellMatch[1]! : cmd;
        const firstWord = baseCmd.trim().split(/\s+/).slice(0, 2).join(" ");
        names.add(firstWord);
      } else if (event.item.type === "file_change" && event.item.path) {
        names.add("file_change");
      } else if (event.item.type === "mcp_tool_call") {
        names.add("mcp_tool_call");
      }
    }
  }
  return [...names];
}

function cleanupOldPrompts(maxAgeMs: number = 7 * 86400000): void {
  try {
    if (!existsSync(RALPH_PROMPTS_DIR)) return;
    const now = Date.now();
    const files = readdirSync(RALPH_PROMPTS_DIR);
    for (const file of files) {
      const filePath = join(RALPH_PROMPTS_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch {
        // skip files we can't stat/delete
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

// ============================================================================
// Fix Cursor (timestamp bookmarks for log/transcript scoping)
// ============================================================================

interface CursorEntry {
  timestamp: string;
  epoch: number;
  label: string;
  details?: string;
}

interface CursorFile {
  entries: CursorEntry[];
}

function readCursor(): CursorFile {
  try {
    if (!existsSync(RALPH_CURSOR_FILE)) return { entries: [] };
    return JSON.parse(readFileSync(RALPH_CURSOR_FILE, "utf-8"));
  } catch {
    return { entries: [] };
  }
}

function writeCursorEntry(label: string, details?: string): CursorEntry {
  const cursor = readCursor();
  const entry: CursorEntry = {
    timestamp: new Date().toISOString(),
    epoch: Date.now(),
    label,
    details,
  };
  cursor.entries.push(entry);
  // Keep last 50 entries
  if (cursor.entries.length > 50) {
    cursor.entries = cursor.entries.slice(-50);
  }
  mkdirSync(join(homedir(), ".openclaw"), { recursive: true });
  writeFileSync(RALPH_CURSOR_FILE, JSON.stringify(cursor, null, 2));
  return entry;
}

function getLastCursor(): CursorEntry | null {
  const cursor = readCursor();
  return cursor.entries.length > 0 ? cursor.entries[cursor.entries.length - 1]! : null;
}

// ============================================================================
// Failure Categorization
// ============================================================================

type FailureCategory = "type_error" | "test_failure" | "lint_error" | "build_error" | "timeout" | "verification_rejected" | "unknown";

function categorizeFailure(output: string): FailureCategory {
  const lower = output.toLowerCase();
  if (lower.includes("timeout") || lower.includes("exceeded 10 minutes") || lower.includes("timed out")) return "timeout";
  if (lower.includes("error ts") || lower.includes("ts(") || (lower.includes("type") && lower.includes("not assignable")) || lower.includes("cannot find name")) return "type_error";
  if (lower.includes("eslint") || lower.includes("prettier") || lower.includes("lint")) return "lint_error";
  if (lower.includes("assert") || lower.includes("expect(") || lower.includes("test fail") || lower.includes("tests failed") || lower.includes("test suites failed")) return "test_failure";
  if (lower.includes("build fail") || lower.includes("bundle") || lower.includes("esbuild") || lower.includes("webpack") || lower.includes("rollup") || lower.includes("vite")) return "build_error";
  return "unknown";
}

// ============================================================================
// Structured Inter-Story Context (.ralph-context.json)
// ============================================================================

interface RalphContextStory {
  id: string;
  title: string;
  status: "completed" | "failed";
  filesModified: string[];
  learnings: string;
}

interface RalphContextFailure {
  storyId: string;
  storyTitle?: string;
  category: FailureCategory;
  error: string;
  toolNames?: string[];
  iterationNumber?: number;
}

interface RalphContext {
  stories: RalphContextStory[];
  failures: RalphContextFailure[];
}

function readRalphContext(workdir: string): RalphContext {
  const contextPath = join(resolvePath(workdir), ".ralph-context.json");
  if (!existsSync(contextPath)) return { stories: [], failures: [] };
  try {
    return JSON.parse(readFileSync(contextPath, "utf-8"));
  } catch {
    return { stories: [], failures: [] };
  }
}

function writeRalphContext(workdir: string, context: RalphContext): void {
  const contextPath = join(resolvePath(workdir), ".ralph-context.json");
  writeFileSync(contextPath, JSON.stringify(context, null, 2));
}

function addContextStory(workdir: string, entry: RalphContextStory): void {
  const ctx = readRalphContext(workdir);
  // Replace existing entry for the same story id, or append
  const idx = ctx.stories.findIndex((s) => s.id === entry.id);
  if (idx >= 0) {
    ctx.stories[idx] = entry;
  } else {
    ctx.stories.push(entry);
  }
  writeRalphContext(workdir, ctx);
}

function addContextFailure(workdir: string, failure: RalphContextFailure): void {
  const ctx = readRalphContext(workdir);
  ctx.failures.push(failure);
  // Keep only last 20 failures to avoid bloat
  if (ctx.failures.length > 20) {
    ctx.failures = ctx.failures.slice(-20);
  }
  writeRalphContext(workdir, ctx);
}

function buildStructuredContextSnippet(workdir: string): string {
  const ctx = readRalphContext(workdir);
  if (ctx.stories.length === 0 && ctx.failures.length === 0) return "";

  const parts: string[] = [];

  // Add failure category frequencies
  const catCounts: Record<string, number> = {};
  for (const f of ctx.failures) {
    catCounts[f.category] = (catCounts[f.category] || 0) + 1;
  }
  const catSummary = Object.entries(catCounts).map(([k, v]) => `${k}: ${v}`).join(", ");
  if (catSummary) {
    parts.unshift("Failure frequency: " + catSummary);
  }

  // Recent completed stories (last 10)
  const completed = ctx.stories.filter((s) => s.status === "completed").slice(-10);
  if (completed.length > 0) {
    parts.push("Recent completions:");
    for (const s of completed) {
      parts.push(`  - ${s.title}: ${s.learnings.slice(0, 500)}`);
    }
  }

  // Recent failures (last 10)
  const failures = ctx.failures.slice(-10);
  if (failures.length > 0) {
    parts.push("Recent failures:");
    for (const f of failures) {
      parts.push(`  - [${f.category}] Story ${f.storyId}: ${f.error.slice(0, 400)}`);
    }
  }

  return parts.join("\n");
}

function buildFailurePatternContext(workdir: string): string {
  const entries = readIterationLog(workdir, { onlyFailed: true, limit: 20 });
  if (entries.length === 0) return "";

  const parts: string[] = [];

  // Group by failure category
  const byCategory: Record<string, IterationLogEntry[]> = {};
  for (const entry of entries) {
    const cat = entry.failureCategory || "unknown";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat]!.push(entry);
  }

  // Generate escalation blocks for categories with 2+ occurrences
  for (const [category, failures] of Object.entries(byCategory)) {
    if (failures.length >= 2) {
      const stories = [...new Set(failures.map((f) => f.storyTitle))].slice(0, 5);
      const tools = [...new Set(failures.flatMap((f) => f.toolNames))].slice(0, 10);
      const lastError = failures[failures.length - 1]?.validationOutput?.slice(0, 300) || "no output captured";

      parts.push([
        `⚠️ REPEATED FAILURE: ${category} (${failures.length} occurrences)`,
        `  Stories affected: ${stories.join(", ")}`,
        `  Tools used: ${tools.join(", ") || "unknown"}`,
        `  Last error: ${lastError}`,
        `  ACTION REQUIRED: This pattern is recurring. Address the ROOT CAUSE, not just the symptom.`,
      ].join("\n"));
    }
  }

  // Tool frequency analysis: what tools do failed iterations use?
  const failedToolFreq: Record<string, number> = {};
  for (const entry of entries) {
    for (const tool of entry.toolNames) {
      failedToolFreq[tool] = (failedToolFreq[tool] || 0) + 1;
    }
  }

  const topFailTools = Object.entries(failedToolFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool, count]) => `${tool} (${count}x)`);

  if (topFailTools.length > 0) {
    parts.push(`Tools in failed iterations: ${topFailTools.join(", ")}`);
  }

  const result = parts.join("\n\n");
  return result.length > 2000 ? result.slice(0, 2000) + "\n..." : result;
}

/**
 * Read inter-story context: combines PROGRESS.md content with recent ralph events.
 * Gives each Codex iteration awareness of what happened in prior iterations.
 */
function readStoryContext(workdir: string): string {
  const parts: string[] = [];

  // Include tail of progress log
  const progress = readProgress(workdir);
  if (progress) {
    const trimmed = progress.length > 1500 ? progress.slice(-1500) : progress;
    parts.push("## Recent Progress\n" + trimmed);
  }

  // Include recent ralph events (last 10)
  try {
    if (existsSync(RALPH_EVENTS_DIR)) {
      const files = readdirSync(RALPH_EVENTS_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .slice(-10);
      const eventSummaries: string[] = [];
      for (const file of files) {
        try {
          const event = JSON.parse(readFileSync(join(RALPH_EVENTS_DIR, file), "utf-8")) as RalphEvent;
          if (event.type === "story_complete") {
            eventSummaries.push(`✅ ${event.storyTitle}: ${event.summary?.slice(0, 150) || "completed"}`);
          } else if (event.type === "story_failed") {
            const cat = event.failureCategory ? ` [${event.failureCategory}]` : "";
            eventSummaries.push(`❌ ${event.storyTitle}${cat}: ${event.error?.slice(0, 150) || "failed"}`);
          }
        } catch {
          // skip malformed event files
        }
      }
      if (eventSummaries.length > 0) {
        parts.push("## Recent Events\n" + eventSummaries.join("\n"));
      }
    }
  } catch {
    // ignore event reading errors
  }

  // Include structured context from .ralph-context.json
  const structured = buildStructuredContextSnippet(workdir);
  if (structured) {
    parts.push("## Structured Context\n" + structured);
  }

  return parts.join("\n\n");
}

// ============================================================================
// Hivemind Integration (Learning Capture)
// ============================================================================

let _swarmAvailable: boolean | null = null;

function isSwarmAvailable(): boolean {
  if (_swarmAvailable !== null) return _swarmAvailable;
  try {
    execSync("which swarm", { encoding: "utf-8", stdio: "pipe" });
    _swarmAvailable = true;
  } catch {
    _swarmAvailable = false;
  }
  return _swarmAvailable;
}

function hivemindStore(information: string, tags: string): void {
  if (!isSwarmAvailable()) return;
  try {
    // Use -- to prevent information from being parsed as flags
    const safeInfo = information.replace(/"/g, '\\"').replace(/\n/g, " ").slice(0, 1000);
    const safeTags = tags.replace(/"/g, "");
    execSync(`swarm memory store "${safeInfo}" --tags "${safeTags}"`, {
      encoding: "utf-8",
      timeout: 15000,
      stdio: "pipe",
    });
  } catch {
    // Hivemind failures must never break the loop
  }
}

function hivemindFind(query: string, limit: number = 3): string {
  if (!isSwarmAvailable()) return "";
  try {
    const safeQuery = query.replace(/"/g, '\\"').replace(/\n/g, " ");
    const result = execSync(`swarm memory find "${safeQuery}" --limit ${limit}`, {
      encoding: "utf-8",
      timeout: 15000,
      stdio: "pipe",
    });
    return result.trim();
  } catch {
    return "";
  }
}

/**
 * Aggressively pulls context from hivemind using multiple targeted queries.
 * Returns structured sections of learnings, failures, and gotchas.
 */
function aggressiveHivemindPull(story: Story, prd: PRD, workdir: string): string {
  const parts: string[] = [];

  // Query 1: Direct story relevance (5 results)
  const storyContext = hivemindFind(story.title, 5);
  if (storyContext) parts.push("### Story-Relevant Learnings\n" + storyContext);

  // Query 2: Project failure patterns (5 results)
  const failureContext = hivemindFind(`ralph failure ${prd.projectName}`, 5);
  if (failureContext) parts.push("### Prior Failure Patterns\n" + failureContext);

  // Query 3: Project-specific learnings (3 results)
  const projectContext = hivemindFind(`ralph learning ${prd.projectName}`, 3);
  if (projectContext) parts.push("### Project Learnings\n" + projectContext);

  // Query 4: Technology-specific gotchas based on story description keywords
  const descWords = (story.description || story.title || "").split(/\s+/).slice(0, 5).join(" ");
  const techContext = hivemindFind(`${descWords} gotcha`, 3);
  if (techContext) parts.push("### Technology Gotchas\n" + techContext);

  // Query 5: Recent iteration behavior insights (how did the last agent perform?)
  const behaviorContext = hivemindFind(`ralph session-insight ${prd.projectName}`, 2);
  if (behaviorContext) parts.push("### Recent Iteration Behavior\n" + behaviorContext);

  const combined = parts.join("\n\n");
  // Cap at 3000 chars to avoid context bloat
  return combined.length > 3000 ? combined.slice(0, 3000) + "\n..." : combined;
}

// ============================================================================
// Session Types (codexmonitor port)
// ============================================================================

interface SessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  model_provider?: string;
  cli_version?: string;
}

interface SessionEvent {
  timestamp: string;
  type: string;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    id?: string;
    [key: string]: unknown;
  };
}

interface SessionInfo {
  id: string;
  file: string;
  timestamp: string;
  cwd: string;
  model?: string;
  messageCount: number;
}

// ============================================================================
// Config
// ============================================================================

interface PluginConfig {
  model: string;
  maxIterations: number;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  autoCommit: boolean;
  debug: boolean;
  ghIssues: boolean;
}

const DEFAULT_CONFIG: PluginConfig = {
  model: "gpt-5.2-codex",
  maxIterations: 20,
  sandbox: "danger-full-access",
  autoCommit: true,
  debug: false,
  ghIssues: false,
};

// ============================================================================
// Helpers
// ============================================================================

function resolvePath(workdir: string): string {
  if (workdir.startsWith("~")) {
    return join(process.env.HOME || "", workdir.slice(1));
  }
  return resolve(workdir);
}

function readPRD(workdir: string): PRD | null {
  const prdPath = join(resolvePath(workdir), "prd.json");
  if (!existsSync(prdPath)) return null;
  try {
    return JSON.parse(readFileSync(prdPath, "utf-8"));
  } catch {
    return null;
  }
}

function writePRD(workdir: string, prd: PRD): void {
  const prdPath = join(resolvePath(workdir), "prd.json");
  writeFileSync(prdPath, JSON.stringify(prd, null, 2));
}

function readProgress(workdir: string): string {
  const progressPath = join(resolvePath(workdir), "progress.txt");
  if (!existsSync(progressPath)) return "";
  return readFileSync(progressPath, "utf-8");
}

function appendProgress(workdir: string, entry: string): void {
  const progressPath = join(resolvePath(workdir), "progress.txt");
  const existing = existsSync(progressPath) ? readFileSync(progressPath, "utf-8") : "";
  const timestamp = new Date().toISOString();
  writeFileSync(progressPath, `${existing}\n---\n[${timestamp}]\n${entry}\n`);
}

function getNextStory(prd: PRD): Story | null {
  const pending = prd.stories
    .filter((s) => !s.passes)
    .sort((a, b) => a.priority - b.priority);
  return pending[0] ?? null;
}

// ============================================================================
// Session Helpers (codexmonitor port)
// ============================================================================

function getCodexSessionsDir(): string {
  return join(homedir(), ".codex", "sessions");
}

function listSessionDates(limit = 7): string[] {
  const sessionsDir = getCodexSessionsDir();
  if (!existsSync(sessionsDir)) return [];

  const dates: string[] = [];
  try {
    const years = readdirSync(sessionsDir).filter((f) => /^\d{4}$/.test(f)).sort().reverse();
    for (const year of years) {
      const yearDir = join(sessionsDir, year);
      const months = readdirSync(yearDir).filter((f) => /^\d{2}$/.test(f)).sort().reverse();
      for (const month of months) {
        const monthDir = join(yearDir, month);
        const days = readdirSync(monthDir).filter((f) => /^\d{2}$/.test(f)).sort().reverse();
        for (const day of days) {
          dates.push(`${year}/${month}/${day}`);
          if (dates.length >= limit) return dates;
        }
      }
    }
  } catch {
    // ignore
  }
  return dates;
}

function listSessions(date?: string, limit = 20): SessionInfo[] {
  const sessionsDir = getCodexSessionsDir();
  if (!existsSync(sessionsDir)) return [];

  const sessions: SessionInfo[] = [];
  const dates = date ? [date] : listSessionDates(7);

  for (const d of dates) {
    const dayDir = join(sessionsDir, d);
    if (!existsSync(dayDir)) continue;

    try {
      const files = readdirSync(dayDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
      for (const file of files) {
        if (sessions.length >= limit) break;
        const filePath = join(dayDir, file);
        const info = parseSessionFile(filePath);
        if (info) sessions.push(info);
      }
    } catch {
      // ignore
    }
    if (sessions.length >= limit) break;
  }

  return sessions;
}

function parseSessionFile(filePath: string): SessionInfo | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    let meta: SessionMeta | null = null;
    let messageCount = 0;

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as SessionEvent;
        if (event.type === "session_meta" && event.payload) {
          meta = event.payload as unknown as SessionMeta;
        }
        if (event.type === "response_item" && event.payload?.role === "user") {
          messageCount++;
        }
      } catch {
        // skip malformed lines
      }
    }

    if (!meta) return null;

    return {
      id: meta.id,
      file: filePath,
      timestamp: meta.timestamp,
      cwd: meta.cwd,
      model: meta.model_provider,
      messageCount,
    };
  } catch {
    return null;
  }
}

function getSessionById(sessionId: string): { info: SessionInfo; events: SessionEvent[] } | null {
  const sessions = listSessions(undefined, 100);
  const session = sessions.find((s) => s.id === sessionId || s.id.startsWith(sessionId));
  if (!session) return null;

  try {
    const content = readFileSync(session.file, "utf-8");
    const events: SessionEvent[] = [];
    for (const line of content.split("\n").filter((l) => l.trim())) {
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // skip
      }
    }
    return { info: session, events };
  } catch {
    return null;
  }
}

function extractSessionMessages(events: SessionEvent[], ranges?: string): Array<{ role: string; content: string; index: number }> {
  const messages: Array<{ role: string; content: string; index: number }> = [];
  let index = 0;

  for (const event of events) {
    if (event.type === "response_item" && event.payload?.content) {
      const role = event.payload.role || "unknown";
      const contentParts = event.payload.content;
      const text = contentParts
        .filter((c) => c.type === "input_text" || c.type === "output_text")
        .map((c) => c.text || "")
        .join("\n");
      if (text.trim()) {
        messages.push({ role, content: text.slice(0, 2000), index });
        index++;
      }
    }
  }

  if (ranges) {
    // Parse ranges like "1...3,5...7"
    const rangeSet = new Set<number>();
    for (const part of ranges.split(",")) {
      const match = part.match(/(\d+)\.\.\.(\d+)/);
      if (match && match[1] && match[2]) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        for (let i = start; i <= end; i++) rangeSet.add(i);
      } else {
        const num = parseInt(part.trim(), 10);
        if (!isNaN(num)) rangeSet.add(num);
      }
    }
    return messages.filter((m) => rangeSet.has(m.index));
  }

  return messages;
}

function runValidation(workdir: string, command?: string): { success: boolean; output: string } {
  const result = captureValidation(resolvePath(workdir), command);
  return { success: result.success, output: result.output };
}

function gitCommit(workdir: string, message: string): string | null {
  const cwd = resolvePath(workdir);
  try {
    execSync("git add -A", { cwd, encoding: "utf-8" });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd, encoding: "utf-8" });
    const hash = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf-8" }).trim();
    return hash;
  } catch {
    return null;
  }
}

function extractActionSequence(events: SessionEvent[]): string {
  const actions: string[] = [];

  for (const event of events) {
    // Codex session JSONL uses same wire format as --json output
    // Try both the raw event format (CodexEvent-like) and the session format
    const ev = event as unknown as CodexEvent;

    if (!ev.item) continue;

    // Command executions — the meat of what we want
    if ((ev.type === "item.completed" || ev.type === "item.started") && ev.item.type === "command_execution") {
      const cmd = ev.item.command || "unknown";
      // Extract the meaningful part from shell wrapper
      const shellMatch = cmd.match(/-lc\s+"(?:cd\s+[^&]+&&\s*)?(.+?)"/);
      const displayCmd = shellMatch ? shellMatch[1]! : cmd;
      actions.push(`→ exec: ${displayCmd.slice(0, 120)}`);

      // If completed with error output, capture it
      if (ev.type === "item.completed" && ev.item.exit_code && ev.item.exit_code !== 0) {
        const output = ev.item.aggregated_output || "";
        // Get last meaningful line of error output
        const errorLines = output.split("\n").filter(l => l.trim()).slice(-3).join(" | ");
        if (errorLines) {
          actions.push(`  ✗ exit=${ev.item.exit_code}: ${errorLines.slice(0, 200)}`);
        }
      }
    }

    // File changes
    if ((ev.type === "item.completed" || ev.type === "item.started") && ev.item.type === "file_change" && ev.item.path) {
      actions.push(`→ write: ${ev.item.path}`);
    }

    // Reasoning steps (condensed)
    if (ev.type === "item.completed" && ev.item.type === "reasoning" && ev.item.text) {
      const summary = ev.item.text.split("\n")[0]?.slice(0, 100) || "";
      if (summary) actions.push(`  💭 ${summary}`);
    }
  }

  if (actions.length === 0) return "";

  // Cap at ~40 actions to avoid context bloat
  const trimmed = actions.length > 40
    ? [...actions.slice(0, 20), `  ... (${actions.length - 40} actions omitted)`, ...actions.slice(-20)]
    : actions;
  return trimmed.join("\n");
}

function buildPreviousAttemptContext(workdir: string, storyId: string): string {
  // Read iteration log for this story, get the most recent failed entries
  const entries = readIterationLog(workdir, { storyId, onlyFailed: true, limit: 3 });
  if (entries.length === 0) return "";

  const lastFailed = entries[entries.length - 1]!;
  const parts: string[] = [];

  parts.push(`Previous attempt failed (${lastFailed.failureCategory || "unknown"}, ${Math.round(lastFailed.duration / 1000)}s)`);
  parts.push(`Tools used: ${lastFailed.toolNames.join(", ") || "none"}`);
  parts.push(`Files touched: ${lastFailed.filesModified.join(", ") || "none"}`);

  // Try to read session transcript for granular action sequence
  if (lastFailed.codexSessionId) {
    const session = getSessionById(lastFailed.codexSessionId);
    if (session) {
      const actionLog = extractActionSequence(session.events);
      if (actionLog) {
        parts.push("\nAction sequence from previous attempt:");
        parts.push(actionLog);
      }
    }
  }

  // Include validation output (already captured in iteration log)
  if (lastFailed.validationOutput) {
    parts.push("\nValidation error:");
    parts.push(lastFailed.validationOutput.slice(0, 1000));
  }

  // If multiple failures, show the pattern
  if (entries.length > 1) {
    const cats = entries.map(e => e.failureCategory || "unknown");
    parts.push(`\n⚠️ This story has failed ${entries.length} times: ${cats.join(" → ")}`);
  }

  const result = parts.join("\n");
  return result.length > 3000 ? result.slice(0, 3000) + "\n..." : result;
}

function buildIterationPrompt(prd: PRD, story: Story, progress: string, hivemindContext?: string, structuredContext?: string, failurePatternContext?: string, previousAttemptContext?: string, codebaseMap?: string, previousBehavior?: string, issueContext?: string): string {
  const parts: string[] = [];

  parts.push(`# Project: ${prd.projectName}`);
  if (prd.description) parts.push(prd.description);

  parts.push(`\n## Current Task`);
  parts.push(`Story: ${story.title} (ID: ${story.id})`);
  parts.push(`Priority: ${story.priority}`);
  parts.push(`\n### Description`);
  parts.push(story.description);

  if (story.acceptanceCriteria?.length) {
    parts.push(`\n### Acceptance Criteria`);
    story.acceptanceCriteria.forEach((c, i) => parts.push(`${i + 1}. ${c}`));
  }

  if (story.validationCommand) {
    parts.push(`\n### Validation`);
    parts.push(`Run: \`${story.validationCommand}\``);
  }

  // NOTE: AGENTS.md is NOT injected here — Codex auto-loads it from the repo directory.
  // Double-injecting caused 31k+ char prompts that exceeded the model context window,
  // making the model exit immediately with 0 tool calls (~8s duration).

  if (codebaseMap) {
    parts.push(`\n${codebaseMap}`);
  }

  if (progress) {
    parts.push(`\n## Previous Progress`);
    // Only include last ~2000 chars to avoid context bloat
    const trimmedProgress = progress.length > 2000 ? "...\n" + progress.slice(-2000) : progress;
    parts.push(trimmedProgress);
  }

  if (previousAttemptContext) {
    parts.push(`\n## Previous Attempt (CRITICAL — read this before coding)
You are retrying a story that previously failed. Study what was tried and where it broke. Do NOT repeat the same approach if it failed — try a different strategy.

${previousAttemptContext}`);
  }

  if (structuredContext) {
    parts.push(`\n## Structured Context (machine-generated)`);
    parts.push(structuredContext);
  }

  if (failurePatternContext) {
    parts.push(`\n## Failure Pattern Analysis (from iteration log)\nThese patterns have been detected across recent iterations. You MUST acknowledge and address them.\n` + failurePatternContext);
  }

  if (hivemindContext) {
    parts.push(`\n## Prior Learnings (from hivemind)`);
    // Trim to avoid context bloat
    const trimmed = hivemindContext.length > 1500 ? hivemindContext.slice(0, 1500) + "\n..." : hivemindContext;
    parts.push(trimmed);
  }

  if (previousBehavior) {
    parts.push(`\n${previousBehavior}`);
  }

  if (issueContext) {
    parts.push(`\n## GitHub Issue #${story.issueNumber || "?"}\n${issueContext.slice(0, 1500)}`);
  }

  parts.push(`\n## RULES (non-negotiable)

1. **TDD is the law** — Write failing tests FIRST, then implement. No exceptions.
2. **Implement ONLY this story** — No scope creep, no drive-by refactors.
3. **Validation MUST pass** — Run the validation command. If it fails, fix it.
4. **Do NOT modify** prd.json, progress.txt, .ralph-context.json, or .ralph-iterations.jsonl.
5. **MANDATORY: Review Prior Learnings** — Read the "Prior Learnings" section above BEFORE writing any code.
   If a failure pattern matches your current story, explicitly state: "Prior failure pattern detected: [pattern]. Mitigation: [your approach]."
6. **MANDATORY: Store learnings in hivemind** — After completing work, run:
   \`swarm memory store "<specific, actionable learning>" --tags "ralph,learning,${prd.projectName}"\`

   QUALITY REQUIREMENTS for learnings:
   - Minimum 50 characters of substantive content
   - Must reference specific files, types, or patterns
   - Bad: "learned about types" or "None" or "N/A"
   - Good: "UserProfile type requires optional email when source is OAuth — fixes TS2322 on auth.ts:45"
   - Good: "The validation command exits non-zero on warnings, not just errors — use --quiet flag"

   Your iteration WILL BE FLAGGED as low-quality if learnings are vague or missing.
7. **Report progress** — After completing work, run:
   \`openclaw system event --mode now --text "Ralph: completed ${story.title}"\`
8. **Your summary MUST include a structured learnings block:**
   \`\`\`
   ## Learnings
   ### Technical Discovery
   <what you discovered about the codebase, types, APIs>
   ### Gotcha for Next Iteration
   <specific pitfalls the next agent should avoid>
   ### Files Context
   <which files matter and why, for the next story>
   \`\`\`
   Every section must have substantive content. "None" is NEVER acceptable.
9. **TRUST AND ENRICH THE CODEBASE MAP** — The Codebase Reference above has your file tree, types, and imports.
   Do NOT spend time re-exploring with cat/rg/find for files already listed above.
   If the codebase map covers your area, go straight to writing a failing test.
   If you discover new types, files, or patterns NOT in the map, note them in your learnings so the map can be enriched.
10. **USE HIVEMIND** — Before implementing, run: \`swarm memory find "<your story topic>"\`
    After completing, run: \`swarm memory store "<specific learning>" --tags "ralph,learning,${prd.projectName}"\``);

  return parts.join("\n");
}

interface LearningValidation {
  valid: boolean;
  reason?: string;
  extractedLearnings: string;
}

function validateLearnings(finalMessage: string, structured?: RalphIterationOutput): LearningValidation {
  // Structured output path — check JSON learnings directly
  if (structured?.learnings) {
    const { technical_discovery, gotcha_for_next_iteration, files_context } = structured.learnings;
    const totalLength = (technical_discovery || "").length + (gotcha_for_next_iteration || "").length + (files_context || "").length;
    if (totalLength >= 50) {
      const extracted = [
        technical_discovery && `Technical Discovery: ${technical_discovery}`,
        gotcha_for_next_iteration && `Gotcha: ${gotcha_for_next_iteration}`,
        files_context && `Files Context: ${files_context}`,
      ].filter(Boolean).join("\n");
      return { valid: true, extractedLearnings: extracted };
    }
    return { valid: false, reason: `Structured learnings too short (${totalLength} chars, minimum 50)`, extractedLearnings: "" };
  }

  // Fallback: regex-based validation for free-form text
  const lazyPatterns = [
    /learnings?:\s*(\n\s*-\s*)?none/i,
    /nothing\s*(new|notable|to\s*report)/i,
    /no\s*(new\s*)?learnings/i,
    /learnings?:\s*n\/a/i,
    /learnings?:\s*-?\s*$/im,
    /##\s*learnings?\s*\n\s*(none|n\/a|\s*$)/im,
  ];

  for (const pattern of lazyPatterns) {
    if (pattern.test(finalMessage)) {
      return { valid: false, reason: "Lazy learning pattern detected", extractedLearnings: "" };
    }
  }

  const extracted = extractStructuredLearnings(finalMessage);
  if (extracted.length < 50) {
    return { valid: false, reason: `Learning content too short (${extracted.length} chars, minimum 50)`, extractedLearnings: extracted };
  }

  return { valid: true, extractedLearnings: extracted };
}

function extractStructuredLearnings(finalMessage: string, structured?: RalphIterationOutput): string {
  // Structured output path — return JSON learnings directly
  if (structured?.learnings) {
    const parts: string[] = [];
    if (structured.learnings.technical_discovery) parts.push(`Technical Discovery: ${structured.learnings.technical_discovery}`);
    if (structured.learnings.gotcha_for_next_iteration) parts.push(`Gotcha: ${structured.learnings.gotcha_for_next_iteration}`);
    if (structured.learnings.files_context) parts.push(`Files Context: ${structured.learnings.files_context}`);
    if (parts.length > 0) return parts.join("\n");
  }

  // Fallback: regex-based extraction for free-form text
  const sectionPatterns = [
    /## Learnings\s*\n([\s\S]*?)(?=\n## [^#]|\n---|\Z)/i,
    /### Technical Discovery\s*\n([\s\S]*?)(?=\n### |\n## |\n---|\Z)/i,
    /### Gotcha[s]? for Next Iteration\s*\n([\s\S]*?)(?=\n### |\n## |\n---|\Z)/i,
    /### Files Context\s*\n([\s\S]*?)(?=\n### |\n## |\n---|\Z)/i,
  ];

  const parts: string[] = [];
  for (const pattern of sectionPatterns) {
    const match = finalMessage.match(pattern);
    if (match && match[1]?.trim()) {
      parts.push(match[1].trim());
    }
  }

  if (parts.length > 0) {
    return parts.join("\n");
  }

  const fallbackPatterns = [
    /learnings?:\s*\n?([\s\S]{50,}?)(?=\n## |\n---|\n\n\n)/i,
    /(?:what i learned|key takeaway|lesson)s?:\s*\n?([\s\S]{50,}?)(?=\n## |\n---|\n\n\n)/i,
  ];

  for (const pattern of fallbackPatterns) {
    const match = finalMessage.match(pattern);
    if (match && match[1]?.trim()) {
      return match[1].trim();
    }
  }

  return "";
}

interface CodexEvent {
  type: string;               // thread.started, turn.started, turn.completed, item.started, item.completed, error
  thread_id?: string;         // on thread.started
  item?: {
    id?: string;
    type?: string;            // command_execution, file_change, agent_message, reasoning, mcp_tool_call
    command?: string;         // for command_execution
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    text?: string;            // for agent_message / reasoning
    path?: string;            // for file_change
    new_content?: string;     // for file_change
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  error?: string;
}

interface CodexIterationResult {
  success: boolean;
  output: string;
  finalMessage: string;
  structuredResult?: RalphIterationOutput;
  events: CodexEvent[];
  toolCalls: number;
  filesModified: string[];
  sessionId?: string;
  stderrInsights?: string;
  stderrStats?: MonitorStats;
}

function parseCodexOutput(stdout: string, outputFile: string): {
  events: CodexEvent[];
  toolCalls: number;
  filesModified: string[];
  sessionId?: string;
  finalMessage: string;
  structuredResult?: RalphIterationOutput;
} {
  const events: CodexEvent[] = [];
  const lines = stdout.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try { events.push(JSON.parse(line) as CodexEvent); } catch { /* skip */ }
  }

  // Codex --json wire format:
  //   thread.started  → { thread_id }
  //   item.started    → { item: { type, command?, path? } }
  //   item.completed  → { item: { type, command?, aggregated_output?, exit_code?, text?, path? } }
  //   turn.completed  → { usage: { input_tokens, output_tokens } }

  let toolCalls = 0;
  const filesModified: string[] = [];
  let sessionId: string | undefined;
  let lastAgentMessage = "";

  for (const event of events) {
    // Session/thread ID
    if (event.type === "thread.started" && event.thread_id) {
      sessionId = event.thread_id;
    }

    if (!event.item) continue;

    if (event.type === "item.completed" || event.type === "item.started") {
      // Command executions = tool calls
      if (event.item.type === "command_execution") {
        toolCalls++;
      }
      // File changes
      if (event.item.type === "file_change" && event.item.path) {
        filesModified.push(event.item.path);
      }
      // MCP tool calls
      if (event.item.type === "mcp_tool_call") {
        toolCalls++;
      }
      // Agent messages — track the last one as potential final message
      if (event.item.type === "agent_message" && event.item.text) {
        lastAgentMessage = event.item.text;
      }
    }
  }

  // Prefer the -o output file, fall back to last agent_message from JSONL
  let finalMessage = "";
  try {
    if (existsSync(outputFile)) {
      finalMessage = readFileSync(outputFile, "utf-8");
      try { unlinkSync(outputFile); } catch { /* ignore */ }
    }
  } catch { /* skip */ }

  if (!finalMessage && lastAgentMessage) {
    finalMessage = lastAgentMessage;
  }

  // Try to parse structured output (when --output-schema was used)
  let structuredResult: RalphIterationOutput | undefined;
  if (finalMessage) {
    try {
      const parsed = JSON.parse(finalMessage);
      if (typeof parsed === "object" && parsed !== null && "success" in parsed && "summary" in parsed && "learnings" in parsed) {
        structuredResult = parsed as RalphIterationOutput;
      }
    } catch { /* not structured JSON — free-form text, use regex fallback */ }
  }

  return { events, toolCalls, filesModified: [...new Set(filesModified)], sessionId, finalMessage, structuredResult };
}

async function runCodexIteration(
  workdir: string,
  prompt: string,
  cfg: PluginConfig
): Promise<CodexIterationResult> {
  return new Promise((resolve) => {
    const resolvedWorkdir = resolvePath(workdir);
    const outputFile = join(resolvedWorkdir, `.ralph-last-message-${Date.now()}.txt`);
    const schemaFile = join(__dirname, "ralph-iteration-schema.json");

    const args = [
      "exec",
      "--sandbox", cfg.sandbox,
      "--json",
      "--output-schema", schemaFile,
      "-o", outputFile,
      "-C", resolvedWorkdir,
      "-m", cfg.model,
      prompt,
    ];

    if (cfg.debug) {
      console.log(`[openclaw-codex-ralph] Running: codex ${args.slice(0, 5).join(" ")}...`);
    }

    const child = spawn("codex", args, {
      cwd: resolvedWorkdir,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.bun/bin:${process.env.HOME}/.local/bin:${process.env.PATH}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    processRegistry.register(child, "codex-iteration");

    const progressMonitor = monitorProgress(child.stdout!, {
      stallTimeoutMs: 120000,
      onStall: () => {
        if (!child.killed) child.kill("SIGTERM");
      },
    });

    const stderrMonitor = createStderrMonitor(child.stderr!);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number | null) => {
      progressMonitor.cancel();
      stderrMonitor.stop();
      const parsed = parseCodexOutput(stdout, outputFile);
      const output = parsed.finalMessage || stdout.slice(0, 5000);

      const gitFiles = code === 0 ? getActualFilesModified(resolvedWorkdir) : [];
      const allFilesModified = [...new Set([...gitFiles, ...parsed.filesModified])];

      resolve({
        success: code === 0,
        output,
        finalMessage: parsed.finalMessage,
        structuredResult: parsed.structuredResult,
        events: parsed.events,
        toolCalls: parsed.toolCalls,
        filesModified: allFilesModified,
        sessionId: parsed.sessionId,
        stderrInsights: stderrMonitor.getInsights(),
        stderrStats: stderrMonitor.getStats(),
      });
    });

    child.on("error", (err: Error) => {
      resolve({
        success: false,
        output: `Spawn error: ${err.message}`,
        finalMessage: "",
        events: [],
        toolCalls: 0,
        filesModified: [],
        sessionId: undefined,
      });
    });

    // Timeout after 10 minutes — preserve partial data from accumulated stdout
    setTimeout(() => {
      progressMonitor.cancel();
      stderrMonitor.stop();
      child.kill("SIGTERM");
      const partial = parseCodexOutput(stdout, outputFile);
      const output = "Timeout: iteration exceeded 10 minutes\n" + (partial.finalMessage || stdout.slice(0, 5000));

      resolve({
        success: false,
        output,
        finalMessage: partial.finalMessage,
        structuredResult: partial.structuredResult,
        events: partial.events,
        toolCalls: partial.toolCalls,
        filesModified: partial.filesModified,
        sessionId: partial.sessionId,
        stderrInsights: stderrMonitor.getInsights(),
        stderrStats: stderrMonitor.getStats(),
      });
    }, 600000);
  });
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function executeRalphInit(params: { workdir: string; projectName: string; description?: string }, cfg: PluginConfig) {
  const dir = resolvePath(params.workdir);
  if (!existsSync(dir)) {
    return { error: `Directory does not exist: ${dir}` };
  }

  const prdPath = join(dir, "prd.json");
  if (existsSync(prdPath)) {
    return { error: "prd.json already exists. Use ralph_add_story to add stories." };
  }

  const prd: PRD = {
    version: "1.0",
    projectName: params.projectName,
    description: params.description,
    stories: [],
    metadata: {
      createdAt: new Date().toISOString(),
      totalIterations: 0,
    },
  };

  writePRD(params.workdir, prd);

  // Create tracking issue if ghIssues enabled
  if (cfg.ghIssues) {
    const { createTrackingIssue } = await import("./gh-issues.js");
    const trackingNum = createTrackingIssue(dir, prd);
    if (trackingNum && prd.metadata) {
      prd.metadata.trackingIssue = trackingNum;
      writePRD(params.workdir, prd);
    }
  }

  const progressPath = join(dir, "progress.txt");
  if (!existsSync(progressPath)) {
    writeFileSync(progressPath, `# Progress Log for ${params.projectName}\n\nInitialized: ${new Date().toISOString()}\n`);
  }

  return {
    success: true,
    message: `Initialized Ralph project: ${params.projectName}`,
    files: ["prd.json", "progress.txt"],
    trackingIssue: prd.metadata?.trackingIssue,
  };
}

async function executeRalphAddStory(params: {
  workdir: string;
  title: string;
  description: string;
  priority?: number;
  validationCommand?: string;
  acceptanceCriteria?: string;
}, cfg: PluginConfig) {
  const prd = readPRD(params.workdir);
  if (!prd) {
    return { error: "No prd.json found. Run ralph_init first." };
  }

  const id = `story-${Date.now().toString(36)}`;
  const story: Story = {
    id,
    title: params.title,
    description: params.description,
    priority: params.priority ?? 10,
    passes: false,
    validationCommand: params.validationCommand,
  };

  if (params.acceptanceCriteria) {
    try {
      story.acceptanceCriteria = JSON.parse(params.acceptanceCriteria);
    } catch {
      story.acceptanceCriteria = [params.acceptanceCriteria];
    }
  }

  // Create GH issue for the story if ghIssues enabled
  if (cfg.ghIssues) {
    const { createStoryIssue } = await import("./gh-issues.js");
    const issueNum = createStoryIssue(resolvePath(params.workdir), story, prd);
    if (issueNum) {
      story.issueNumber = issueNum;
    }
  }

  prd.stories.push(story);
  writePRD(params.workdir, prd);

  return {
    success: true,
    storyId: id,
    message: `Added story: ${params.title}`,
    totalStories: prd.stories.length,
    pendingStories: prd.stories.filter((s) => !s.passes).length,
  };
}

async function executeRalphStatus(params: { workdir: string }) {
  const prd = readPRD(params.workdir);
  if (!prd) {
    return { error: "No prd.json found. Run ralph_init first." };
  }

  const pending = prd.stories.filter((s) => !s.passes);
  const completed = prd.stories.filter((s) => s.passes);
  const next = getNextStory(prd);

  return {
    projectName: prd.projectName,
    totalStories: prd.stories.length,
    completed: completed.length,
    pending: pending.length,
    totalIterations: prd.metadata?.totalIterations ?? 0,
    lastIteration: prd.metadata?.lastIteration,
    nextStory: next ? { id: next.id, title: next.title, priority: next.priority } : null,
    stories: prd.stories.map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      passes: s.passes,
    })),
  };
}

async function executeRalphEditStory(params: {
  workdir: string;
  storyId: string;
  title?: string;
  description?: string;
  priority?: number;
  passes?: boolean;
  validationCommand?: string;
}) {
  const prd = readPRD(params.workdir);
  if (!prd) {
    return { error: "No prd.json found. Run ralph_init first." };
  }

  const story = prd.stories.find((s) => s.id === params.storyId);
  if (!story) {
    return { error: `Story not found: ${params.storyId}` };
  }

  if (params.title !== undefined) story.title = params.title;
  if (params.description !== undefined) story.description = params.description;
  if (params.priority !== undefined) story.priority = params.priority;
  if (params.passes !== undefined) story.passes = params.passes;
  if (params.validationCommand !== undefined) story.validationCommand = params.validationCommand;

  writePRD(params.workdir, prd);

  return {
    success: true,
    message: `Updated story: ${story.title}`,
    story: {
      id: story.id,
      title: story.title,
      priority: story.priority,
      passes: story.passes,
    },
  };
}

// ============================================================================
// Shared Helpers (used by all 3 loop variants)
// ============================================================================

function sendOpenclawEvent(msg: string): void {
  try {
    const child = spawn("openclaw", ["system", "event", "--mode", "now", "--text", msg], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch { /* non-fatal */ }
}

type IterationContextResult =
  | { allDone: true; prd: PRD }
  | { error: string }
  | { prd: PRD; story: Story; prompt: string; promptFile: string; promptHash: string; jobId: string };

async function buildIterationContext(
  workdir: string,
  cfg: PluginConfig,
  jobId: string,
  previousStderrStats?: MonitorStats
): Promise<IterationContextResult> {
  const prd = readPRD(workdir);
  if (!prd) return { error: "No prd.json found" };

  const story = getNextStory(prd);
  if (!story) return { allDone: true, prd };

  const progress = readProgress(workdir);
  const codebaseMap = generateCodebaseMap(workdir);
  const hivemindContext = aggressiveHivemindPull(story, prd, workdir);
  const structuredCtx = buildStructuredContextSnippet(workdir);
  const failurePatterns = buildFailurePatternContext(workdir);
  const prevAttemptCtx = buildPreviousAttemptContext(workdir, story.id);
  const prevBehavior = previousStderrStats ? formatIterationBehavior(previousStderrStats) : undefined;

  let ghIssueCtx: string | undefined;
  if (cfg.ghIssues && story.issueNumber) {
    const { readIssueContext } = await import("./gh-issues.js");
    ghIssueCtx = readIssueContext(resolvePath(workdir), story.issueNumber) || undefined;
  }

  const prompt = buildIterationPrompt(
    prd, story, progress,
    hivemindContext || undefined, structuredCtx || undefined,
    failurePatterns || undefined, prevAttemptCtx || undefined,
    codebaseMap, prevBehavior || undefined, ghIssueCtx
  );

  const { path: promptFile, hash: promptHash } = persistPrompt(jobId, story.id, prompt);

  return { prd, story, prompt, promptFile, promptHash, jobId };
}

interface RunResult {
  iterResult: IterationResult;
  codexResult: CodexIterationResult;
  validation: { success: boolean; output: string };
  rejectReason?: string;
  startTime: number;
}

async function runAndValidateIteration(
  workdir: string,
  prompt: string,
  story: Story,
  cfg: PluginConfig,
  outputTruncation: number,
  jobId: string,
  prd: PRD
): Promise<RunResult> {
  const startTime = Date.now();
  const codexResult = await runCodexIteration(workdir, prompt, cfg);
  const validation = runValidation(workdir, story.validationCommand);

  const iterResult: IterationResult = {
    success: codexResult.success && validation.success,
    storyId: story.id,
    storyTitle: story.title,
    validationPassed: validation.success,
    codexOutput: codexResult.output.slice(0, outputTruncation),
    codexFinalMessage: codexResult.finalMessage.slice(0, outputTruncation),
    toolCalls: codexResult.toolCalls,
    filesModified: codexResult.filesModified,
    duration: Date.now() - startTime,
  };

  let rejectReason: string | undefined;
  if (iterResult.success) {
    const verification = verifyOutput({
      workdir: resolvePath(workdir),
      story,
      codexResult,
      validationOutput: validation.output,
    });
    iterResult.verificationPassed = verification.passed;
    iterResult.verificationWarnings = verification.warnings.length > 0 ? verification.warnings : undefined;

    if (!verification.passed) {
      iterResult.success = false;
      rejectReason = verification.rejectReason;
      console.warn(`[openclaw-codex-ralph] ❌ Verification rejected: ${story.title} — ${verification.rejectReason}`);
      hivemindStore(
        `Ralph verification rejected: "${story.title}" in ${prd.projectName}. Reason: ${verification.rejectReason}. Checks: ${verification.checks.map(c => `[${c.severity}] ${c.name}: ${c.message}`).join("; ")}`,
        `ralph,verification,rejected,${prd.projectName}`
      );
      writeRalphEvent("story_verification_rejected", {
        jobId,
        storyId: story.id,
        storyTitle: story.title,
        error: verification.rejectReason || "Verification failed",
        failureCategory: "verification_rejected",
        duration: iterResult.duration,
        workdir,
        codexSessionId: codexResult.sessionId,
        verificationRejectReason: verification.rejectReason,
      });
      emitDiagnosticEvent({
        type: "ralph:story:verification_rejected",
        plugin: "openclaw-codex-ralph",
        data: { jobId, storyId: story.id, storyTitle: story.title, duration: iterResult.duration, rejectReason: verification.rejectReason },
      });
    } else if (verification.warnings.length > 0) {
      console.warn(`[openclaw-codex-ralph] ⚠️ Verification warnings for: ${story.title} — ${verification.warnings.join("; ")}`);
      hivemindStore(
        `Ralph verification warnings: "${story.title}" in ${prd.projectName}. Warnings: ${verification.warnings.join("; ")}`,
        `ralph,verification,warning,${prd.projectName}`
      );
    }
  }

  return { iterResult, codexResult, validation, rejectReason, startTime };
}

interface SuccessContext {
  workdir: string;
  prd: PRD;
  story: Story;
  iterResult: IterationResult;
  codexResult: CodexIterationResult;
  jobId: string;
  cfg: PluginConfig;
}

async function handleIterationSuccess(ctx: SuccessContext): Promise<void> {
  const { workdir, prd, story, iterResult, codexResult, jobId, cfg } = ctx;

  story.passes = true;
  prd.metadata = prd.metadata || { createdAt: new Date().toISOString() };
  prd.metadata.lastIteration = new Date().toISOString();
  prd.metadata.totalIterations = (prd.metadata.totalIterations || 0) + 1;
  writePRD(workdir, prd);

  const summary = codexResult.structuredResult?.summary || codexResult.finalMessage.slice(0, 800);
  const progressEntry = [
    `Completed: ${story.title}`,
    `Files: ${codexResult.filesModified.join(", ") || "none"}`,
    `Summary: ${summary}`,
  ].join("\n");

  const learningCheck = validateLearnings(codexResult.finalMessage, codexResult.structuredResult);
  if (!learningCheck.valid) {
    console.warn(`[openclaw-codex-ralph] ⚠️ Low-quality learnings for: ${story.title} — ${learningCheck.reason}`);
    appendProgress(workdir, progressEntry + `\n⚠️ LAZY LEARNINGS: ${learningCheck.reason}`);
    hivemindStore(
      `LAZY AGENT WARNING: Story "${story.title}" in ${prd.projectName} produced ${learningCheck.reason}. This is a recurring quality issue — agents must provide structured learnings.`,
      `ralph,laziness,quality,${prd.projectName}`
    );
  } else {
    appendProgress(workdir, progressEntry);
  }

  if (cfg.autoCommit) {
    const issueRef = story.issueNumber ? ` (#${story.issueNumber})` : "";
    const hash = gitCommit(workdir, `ralph: ${story.title}${issueRef}`);
    iterResult.commitHash = hash || undefined;
  }

  if (codexResult.sessionId) {
    const sessionFile = resolveSessionFile(codexResult.sessionId);
    if (sessionFile) enrichMapFromSession(resolvePath(workdir), sessionFile);
  }

  if (cfg.ghIssues && story.issueNumber) {
    const { closeIssue, updateTrackingChecklist } = await import("./gh-issues.js");
    const closeSummary = codexResult.structuredResult?.summary || codexResult.finalMessage.slice(0, 400);
    closeIssue(resolvePath(workdir), story.issueNumber,
      `✅ **Completed** by Ralph loop\n\nCommit: ${iterResult.commitHash || "n/a"}\nFiles: ${codexResult.filesModified.join(", ")}\n\n${closeSummary}`
    );
    iterResult.issueNumber = story.issueNumber;
    iterResult.issueCommented = true;
    if (prd.metadata?.trackingIssue) {
      updateTrackingChecklist(resolvePath(workdir), prd.metadata.trackingIssue, prd);
    }
  }

  if (iterResult.commitHash) {
    hivemindStore(
      `Ralph completed: ${story.title}. Files: ${codexResult.filesModified.join(", ")}. Summary: ${codexResult.structuredResult?.summary || codexResult.finalMessage.slice(0, 300)}`,
      `ralph,learning,${prd.projectName}`
    );
  }

  const learnings = extractStructuredLearnings(codexResult.finalMessage, codexResult.structuredResult);
  if (learnings && learnings.length >= 50) {
    hivemindStore(
      `Learnings from "${story.title}": ${learnings}`,
      `ralph,success,learning,${prd.projectName},${story.id}`
    );
  }

  hivemindStore(
    `Ralph success pattern: "${story.title}" in ${prd.projectName}. ` +
    `Tool calls: ${codexResult.toolCalls}. Files: ${codexResult.filesModified.length}. ` +
    `Duration: ${Math.round(iterResult.duration / 1000)}s. ` +
    `Validation: ${story.validationCommand || "default"}. ` +
    `Key tools: ${extractToolNames(codexResult.events).join(", ")}`,
    `ralph,success-pattern,${prd.projectName}`
  );

  addContextStory(workdir, {
    id: story.id,
    title: story.title,
    status: "completed",
    filesModified: codexResult.filesModified,
    learnings: learnings || codexResult.finalMessage.slice(0, 500),
  });

  if (codexResult.stderrInsights) {
    hivemindStore(
      `Iteration behavior for "${story.title}": ${codexResult.stderrInsights}`,
      `ralph,session-insight,${prd.projectName}`
    );
  }

  writeRalphEvent("story_complete", {
    jobId,
    storyId: story.id,
    storyTitle: story.title,
    filesModified: codexResult.filesModified,
    commitHash: iterResult.commitHash,
    duration: iterResult.duration,
    summary: codexResult.structuredResult?.summary || codexResult.finalMessage.slice(0, 500),
    workdir,
    codexSessionId: codexResult.sessionId,
  });
  emitDiagnosticEvent({
    type: "ralph:story:complete",
    plugin: "openclaw-codex-ralph",
    data: {
      jobId,
      storyId: story.id,
      storyTitle: story.title,
      duration: iterResult.duration,
      commitHash: iterResult.commitHash,
      filesModified: codexResult.filesModified,
      toolCalls: codexResult.toolCalls,
    },
  });
  sendOpenclawEvent(`✅ Story complete: ${story.title}${iterResult.commitHash ? ` (${iterResult.commitHash})` : ""}`);
}

interface FailureContext {
  workdir: string;
  prd: PRD;
  story: Story;
  iterResult: IterationResult;
  codexResult: CodexIterationResult;
  validation: { success: boolean; output: string };
  rejectReason?: string;
  jobId: string;
  cfg: PluginConfig;
  iterationNumber: number;
  retryCount?: number;
}

async function handleIterationFailure(ctx: FailureContext): Promise<FailureCategory> {
  const { workdir, prd, story, iterResult, codexResult, validation, rejectReason, jobId, cfg, iterationNumber, retryCount } = ctx;

  const failureCategory: FailureCategory = iterResult.verificationPassed === false
    ? "verification_rejected"
    : categorizeFailure(validation.output);

  const failEntry = [
    `Failed: ${story.title} [${failureCategory}]`,
    `Validation: ${validation.output.slice(0, 300)}`,
    `Codex: ${codexResult.structuredResult?.summary || codexResult.finalMessage.slice(0, 300)}`,
  ].join("\n");
  appendProgress(workdir, failEntry);

  if (failureCategory !== "verification_rejected") {
    hivemindStore(
      `Ralph failure [${failureCategory}]: ${story.title}. Files: ${codexResult.filesModified.join(", ")}. Error: ${validation.output.slice(0, 500)}`,
      `ralph,failure,${failureCategory},${prd.projectName}`
    );
  }

  if (cfg.ghIssues && story.issueNumber) {
    const { commentOnIssue, labelIssue } = await import("./gh-issues.js");
    const attemptStr = retryCount !== undefined ? ` (attempt ${retryCount}/${DEFAULT_MAX_RETRIES})` : "";
    commentOnIssue(resolvePath(workdir), story.issueNumber,
      `❌ **Iteration failed**${attemptStr}\n\nCategory: \`${failureCategory}\`\n\`\`\`\n${validation.output?.slice(0, 500) || "no output"}\n\`\`\``
    );
    labelIssue(resolvePath(workdir), story.issueNumber, [`ralph-${failureCategory}`]);
  }

  if (codexResult.stderrInsights) {
    hivemindStore(
      `Iteration behavior (FAILED) for "${story.title}": ${codexResult.stderrInsights}`,
      `ralph,session-insight,failure,${prd.projectName}`
    );
  }

  addContextStory(workdir, {
    id: story.id,
    title: story.title,
    status: "failed",
    filesModified: codexResult.filesModified,
    learnings: `[${failureCategory}] ${validation.output.slice(0, 300)}`,
  });
  addContextFailure(workdir, {
    storyId: story.id,
    storyTitle: story.title,
    category: failureCategory,
    error: rejectReason ? `[verification_rejected] ${rejectReason}` : validation.output.slice(0, 500),
    toolNames: extractToolNames(codexResult.events),
    iterationNumber,
  });

  writeRalphEvent("story_failed", {
    jobId,
    storyId: story.id,
    storyTitle: story.title,
    error: validation.output.slice(0, 500),
    failureCategory,
    duration: iterResult.duration,
    workdir,
    codexSessionId: codexResult.sessionId,
  });
  emitDiagnosticEvent({
    type: "ralph:story:failed",
    plugin: "openclaw-codex-ralph",
    data: { jobId, storyId: story.id, storyTitle: story.title, duration: iterResult.duration, failureCategory },
  });
  sendOpenclawEvent(`❌ Story failed: ${story.title} [${failureCategory}]`);

  return failureCategory;
}

function writeIterationLogEntry(workdir: string, opts: {
  jobId: string;
  iterationNumber: number;
  story: Story;
  codexResult: CodexIterationResult;
  iterResult: IterationResult;
  validation: { success: boolean; output: string };
  promptHash: string;
  promptFile: string;
  promptLength: number;
  rejectReason?: string;
  failureCategory?: FailureCategory;
  model: string;
  sandbox: string;
  startTime: number;
}): void {
  appendIterationLog(workdir, {
    timestamp: new Date().toISOString(),
    epoch: Date.now(),
    jobId: opts.jobId,
    iterationNumber: opts.iterationNumber,
    storyId: opts.story.id,
    storyTitle: opts.story.title,
    codexSessionId: opts.codexResult.sessionId,
    codexSessionFile: opts.codexResult.sessionId ? resolveSessionFile(opts.codexResult.sessionId) : undefined,
    commitHash: opts.iterResult.commitHash,
    promptHash: opts.promptHash,
    promptFile: opts.promptFile,
    promptLength: opts.promptLength,
    success: opts.iterResult.success,
    validationPassed: opts.validation.success,
    failureCategory: opts.failureCategory,
    duration: opts.iterResult.duration,
    codexOutputLength: opts.codexResult.output.length,
    codexFinalMessageLength: opts.codexResult.finalMessage.length,
    toolCalls: opts.codexResult.toolCalls,
    toolNames: extractToolNames(opts.codexResult.events),
    filesModified: opts.codexResult.filesModified,
    validationOutput: !opts.validation.success ? opts.validation.output.slice(0, VALIDATION_OUTPUT_LIMIT) : undefined,
    verificationPassed: opts.iterResult.verificationPassed,
    verificationWarnings: opts.iterResult.verificationWarnings,
    verificationRejectReason: opts.rejectReason,
    model: opts.model,
    sandbox: opts.sandbox,
    startedAt: new Date(opts.startTime).toISOString(),
    completedAt: new Date().toISOString(),
    stderrStats: opts.codexResult.stderrStats,
  });
}

// ============================================================================
// Loop Entry Points (thin wrappers around shared helpers)
// ============================================================================

async function executeRalphIterate(
  params: { workdir: string; model?: string; dryRun?: boolean },
  cfg: PluginConfig
): Promise<IterationResult | { dryRun: true; story: { id: string; title: string }; promptLength: number; promptFile: string; promptHash: string; model: string; sandbox: string } | { success: true; message: string; storiesCompleted: number } | { error: string }> {
  const workdir = params.workdir;
  const model = params.model || cfg.model;
  const iterateJobId = `iterate-${Date.now().toString(36)}`;
  const iterateCfg = { ...cfg, model };

  const ctx = await buildIterationContext(workdir, cfg, iterateJobId);
  if ("error" in ctx) return { error: ctx.error };
  if ("allDone" in ctx) return { success: true, message: "All stories complete!", storiesCompleted: ctx.prd.stories.length };

  const { prd, story, prompt, promptFile, promptHash } = ctx;

  if (params.dryRun) {
    return { dryRun: true, story: { id: story.id, title: story.title }, promptLength: prompt.length, promptFile, promptHash, model, sandbox: cfg.sandbox };
  }

  const run = await runAndValidateIteration(workdir, prompt, story, iterateCfg, 2000, iterateJobId, prd);

  if (run.iterResult.success) {
    await handleIterationSuccess({ workdir, prd, story, iterResult: run.iterResult, codexResult: run.codexResult, jobId: iterateJobId, cfg });
  } else {
    const failCat = await handleIterationFailure({
      workdir, prd, story, iterResult: run.iterResult, codexResult: run.codexResult, validation: run.validation,
      rejectReason: run.rejectReason, jobId: iterateJobId, cfg, iterationNumber: prd.metadata?.totalIterations || 1,
    });
    run.iterResult.error = run.validation.output.slice(0, 500);
  }

  const failCat = run.iterResult.success ? undefined : (run.iterResult.verificationPassed === false ? "verification_rejected" as FailureCategory : categorizeFailure(run.validation.output));
  writeIterationLogEntry(workdir, {
    jobId: iterateJobId, iterationNumber: prd.metadata?.totalIterations || 1, story, codexResult: run.codexResult,
    iterResult: run.iterResult, validation: run.validation, promptHash, promptFile, promptLength: prompt.length,
    rejectReason: run.rejectReason, failureCategory: failCat, model, sandbox: cfg.sandbox, startTime: run.startTime,
  });

  return run.iterResult;
}

// Legacy synchronous loop (kept for backward compatibility with ralph_iterate)
async function executeRalphLoopSync(
  params: { workdir: string; maxIterations?: number; model?: string; stopOnFailure?: boolean },
  cfg: PluginConfig
): Promise<LoopResult> {
  const workdir = params.workdir;
  const maxIterations = params.maxIterations || cfg.maxIterations;
  const model = params.model || cfg.model;
  const stopOnFailure = params.stopOnFailure;
  const loopCfg = { ...cfg, model };
  const retryTracker = new StoryRetryTracker(DEFAULT_MAX_RETRIES);

  const loopResult: LoopResult = {
    success: false, iterationsRun: 0, storiesCompleted: 0, remainingStories: 0, results: [], stoppedReason: "complete",
  };

  let lastStderrStats: MonitorStats | undefined;
  sendOpenclawEvent(`🚀 Ralph sync loop started: max ${maxIterations} iterations`);

  for (let i = 0; i < maxIterations; i++) {
    const syncJobId = `sync-${Date.now().toString(36)}-${i}`;
    const ctx = await buildIterationContext(workdir, cfg, syncJobId, lastStderrStats);

    if ("error" in ctx) { loopResult.stoppedReason = "error"; break; }
    if ("allDone" in ctx) { loopResult.success = true; loopResult.stoppedReason = "complete"; break; }

    const { prd, story, prompt, promptFile, promptHash } = ctx;

    if (shouldSkipStory(story.id, workdir, DEFAULT_MAX_RETRIES)) {
      appendProgress(workdir, `Skipped: ${story.title} — exceeded ${DEFAULT_MAX_RETRIES} retries, needs human review`);
      continue;
    }

    loopResult.iterationsRun++;

    const run = await runAndValidateIteration(workdir, prompt, story, loopCfg, 500, syncJobId, prd);
    lastStderrStats = run.codexResult.stderrStats;

    if (run.iterResult.success) {
      await handleIterationSuccess({ workdir, prd, story, iterResult: run.iterResult, codexResult: run.codexResult, jobId: syncJobId, cfg });
      loopResult.storiesCompleted++;
    }

    retryTracker.recordAttempt(story.id, run.iterResult.success);

    if (!run.iterResult.success) {
      const failCat = await handleIterationFailure({
        workdir, prd, story, iterResult: run.iterResult, codexResult: run.codexResult, validation: run.validation,
        rejectReason: run.rejectReason, jobId: syncJobId, cfg, iterationNumber: i + 1,
        retryCount: retryTracker.getFailCount(story.id),
      });

      if (stopOnFailure) {
        writeIterationLogEntry(workdir, {
          jobId: syncJobId, iterationNumber: i + 1, story, codexResult: run.codexResult,
          iterResult: run.iterResult, validation: run.validation, promptHash, promptFile, promptLength: prompt.length,
          rejectReason: run.rejectReason, failureCategory: failCat, model, sandbox: cfg.sandbox, startTime: run.startTime,
        });
        loopResult.stoppedReason = "failure";
        loopResult.results.push(run.iterResult);
        break;
      }
    }

    const failCat = run.iterResult.success ? undefined : (run.iterResult.verificationPassed === false ? "verification_rejected" as FailureCategory : categorizeFailure(run.validation.output));
    writeIterationLogEntry(workdir, {
      jobId: syncJobId, iterationNumber: i + 1, story, codexResult: run.codexResult,
      iterResult: run.iterResult, validation: run.validation, promptHash, promptFile, promptLength: prompt.length,
      rejectReason: run.rejectReason, failureCategory: failCat, model, sandbox: cfg.sandbox, startTime: run.startTime,
    });

    loopResult.results.push(run.iterResult);
  }

  const finalPrd = readPRD(workdir);
  if (finalPrd) {
    loopResult.remainingStories = finalPrd.stories.filter((s) => !s.passes).length;
    if (loopResult.remainingStories === 0) loopResult.success = true;
  }
  if (loopResult.iterationsRun >= maxIterations && loopResult.remainingStories > 0) loopResult.stoppedReason = "limit";

  return loopResult;
}

// Async job-based loop - returns immediately, runs in background
async function executeRalphLoopAsync(
  job: LoopJob,
  params: { stopOnFailure?: boolean },
  cfg: PluginConfig
): Promise<void> {
  const workdir = job.workdir;
  const maxIterations = job.maxIterations;
  const stopOnFailure = params.stopOnFailure;
  const loopCfg = { ...cfg };
  const retryTracker = new StoryRetryTracker(DEFAULT_MAX_RETRIES);

  emitLoopProgress(job, "start");
  cleanupOldEvents();
  cleanupOldPrompts();
  writeRalphEvent("loop_start", { jobId: job.id, totalStories: job.totalStories, workdir });
  sendOpenclawEvent(`🚀 Ralph loop started: ${job.totalStories} stories, max ${maxIterations} iterations`);

  let lastStderrStats: MonitorStats | undefined;

  try {
    for (let i = 0; i < maxIterations; i++) {
      if (job.status === "cancelled") {
        writeRalphEvent("loop_error", { jobId: job.id, error: "Loop cancelled", storiesCompleted: job.storiesCompleted, lastStory: job.currentStory ? { id: job.currentStory.id, title: job.currentStory.title } : undefined, workdir });
        emitLoopProgress(job, "complete");
        return;
      }

      const ctx = await buildIterationContext(workdir, cfg, job.id, lastStderrStats);

      if ("error" in ctx) {
        job.status = "failed"; job.error = ctx.error; job.completedAt = Date.now();
        emitLoopProgress(job, "error");
        return;
      }
      if ("allDone" in ctx) {
        job.status = "completed"; job.completedAt = Date.now();
        job.totalStories = ctx.prd.stories.length;
        writeRalphEvent("loop_complete", { jobId: job.id, storiesCompleted: job.storiesCompleted, totalStories: job.totalStories, duration: Date.now() - job.startedAt, results: job.results.map((r) => ({ storyTitle: r.storyTitle, success: r.success, duration: r.duration })), workdir });
        emitLoopProgress(job, "complete");
        return;
      }

      const { prd, story, prompt, promptFile, promptHash } = ctx;
      job.totalStories = prd.stories.length;

      if (shouldSkipStory(story.id, workdir, DEFAULT_MAX_RETRIES)) {
        appendProgress(workdir, `Skipped: ${story.title} — exceeded ${DEFAULT_MAX_RETRIES} retries, needs human review`);
        continue;
      }

      job.currentIteration = i + 1;
      job.currentStory = { id: story.id, title: story.title };
      emitLoopProgress(job, "iteration");

      const run = await runAndValidateIteration(workdir, prompt, story, loopCfg, 500, job.id, prd);
      lastStderrStats = run.codexResult.stderrStats;

      job.results.push(run.iterResult);

      if (run.iterResult.success) {
        await handleIterationSuccess({ workdir, prd, story, iterResult: run.iterResult, codexResult: run.codexResult, jobId: job.id, cfg });
        job.storiesCompleted++;
        emitLoopProgress(job, "iteration");
      }

      retryTracker.recordAttempt(story.id, run.iterResult.success);

      if (!run.iterResult.success) {
        const failCat = await handleIterationFailure({
          workdir, prd, story, iterResult: run.iterResult, codexResult: run.codexResult, validation: run.validation,
          rejectReason: run.rejectReason, jobId: job.id, cfg, iterationNumber: i + 1,
          retryCount: retryTracker.getFailCount(story.id),
        });

        if (stopOnFailure) {
          writeIterationLogEntry(workdir, {
            jobId: job.id, iterationNumber: i + 1, story, codexResult: run.codexResult,
            iterResult: run.iterResult, validation: run.validation, promptHash, promptFile, promptLength: prompt.length,
            rejectReason: run.rejectReason, failureCategory: failCat, model: loopCfg.model, sandbox: cfg.sandbox, startTime: run.startTime,
          });
          job.status = "failed"; job.error = `Story failed: ${story.title}`; job.completedAt = Date.now();
          writeRalphEvent("loop_error", { jobId: job.id, error: job.error, storiesCompleted: job.storiesCompleted, lastStory: job.currentStory ? { id: job.currentStory.id, title: job.currentStory.title } : undefined, workdir });
          emitLoopProgress(job, "error");
          return;
        }

        emitLoopProgress(job, "iteration");
      }

      const failCat = run.iterResult.success ? undefined : (run.iterResult.verificationPassed === false ? "verification_rejected" as FailureCategory : categorizeFailure(run.validation.output));
      writeIterationLogEntry(workdir, {
        jobId: job.id, iterationNumber: i + 1, story, codexResult: run.codexResult,
        iterResult: run.iterResult, validation: run.validation, promptHash, promptFile, promptLength: prompt.length,
        rejectReason: run.rejectReason, failureCategory: failCat, model: loopCfg.model, sandbox: cfg.sandbox, startTime: run.startTime,
      });
    }

    // Reached max iterations
    const finalPrd = readPRD(workdir);
    const remaining = finalPrd ? finalPrd.stories.filter((s) => !s.passes).length : 0;
    job.status = "completed";
    if (remaining > 0) job.error = `Max iterations reached with ${remaining} stories remaining`;
    job.completedAt = Date.now();

    writeRalphEvent("loop_complete", { jobId: job.id, storiesCompleted: job.storiesCompleted, totalStories: job.totalStories, duration: Date.now() - job.startedAt, results: job.results.map((r) => ({ storyTitle: r.storyTitle, success: r.success, duration: r.duration })), workdir });
    emitLoopProgress(job, "complete");

    const passed = job.results.filter(r => r.success).length;
    const failed = job.results.filter(r => !r.success).length;
    const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
    sendOpenclawEvent(`🏁 Ralph loop complete: ${passed} passed, ${failed} failed, ${elapsed}s elapsed. ${remaining === 0 ? 'All stories done!' : `${remaining} stories remaining.`}`);

  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.completedAt = Date.now();
    writeRalphEvent("loop_error", { jobId: job.id, error: job.error, storiesCompleted: job.storiesCompleted, lastStory: job.currentStory ? { id: job.currentStory.id, title: job.currentStory.title } : undefined, workdir });
    emitLoopProgress(job, "error");
  }
}

// Start a loop job in the background - returns immediately
function startLoopJob(
  params: { workdir: string; maxIterations?: number; model?: string; stopOnFailure?: boolean },
  cfg: PluginConfig
): LoopJob {
  const prd = readPRD(params.workdir);
  const totalStories = prd ? prd.stories.length : 0;
  const pendingStories = prd ? prd.stories.filter((s) => !s.passes).length : 0;

  const job: LoopJob = {
    id: generateJobId(),
    workdir: params.workdir,
    status: "running",
    startedAt: Date.now(),
    currentIteration: 0,
    maxIterations: params.maxIterations || cfg.maxIterations,
    storiesCompleted: 0,
    totalStories,
    results: [],
    model: cfg.model,
    sandbox: cfg.sandbox,
    ghIssues: cfg.ghIssues,
  };

  activeJobs.set(job.id, job);

  // Start the loop in the background (fire and forget)
  executeRalphLoopAsync(job, { stopOnFailure: params.stopOnFailure }, { ...cfg, model: params.model || cfg.model })
    .catch((err) => {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = Date.now();
    });

  return job;
}

// ============================================================================
// Plugin Export
// ============================================================================

const ralphCodexPlugin = {
  id: "openclaw-codex-ralph",
  name: "Ralph Codex",
  description: "Autonomous AI coding loops using Codex - fresh sessions per iteration with prd.json tracking",
  configSchema: {
    type: "object",
    properties: {
      model: { type: "string", default: "o3" },
      maxIterations: { type: "number", default: 20 },
      sandbox: { type: "string", default: "danger-full-access" },
      autoCommit: { type: "boolean", default: true },
      debug: { type: "boolean", default: false },
      ghIssues: { type: "boolean", default: false },
    },
    additionalProperties: false,
  },

  register(api: OpenClawPluginApi) {
    const cfg: PluginConfig = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as Partial<PluginConfig>),
    };

    // ralph_init
    api.registerTool({
      name: "ralph_init",
      label: "Ralph Init",
      description: "Initialize a Ralph project with prd.json and progress.txt. Creates the file structure for autonomous coding loops.",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
          projectName: { type: "string", description: "Project name (required)" },
          description: { type: "string", description: "Project description" },
        },
        required: ["workdir", "projectName"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await executeRalphInit(params as Parameters<typeof executeRalphInit>[0], cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    });

    // ralph_add_story
    api.registerTool({
      name: "ralph_add_story",
      label: "Ralph Add Story",
      description: "Add a story/task to the project's prd.json. Stories are processed in priority order (lower = higher priority).",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
          title: { type: "string", description: "Story title (required)" },
          description: { type: "string", description: "Detailed description of what to implement (required)" },
          priority: { type: "number", description: "Priority (1 = highest, default: 10)" },
          validationCommand: { type: "string", description: "Command to validate the story (e.g., 'npm test')" },
          acceptanceCriteria: { type: "string", description: "Acceptance criteria as JSON array of strings" },
        },
        required: ["workdir", "title", "description"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await executeRalphAddStory(params as Parameters<typeof executeRalphAddStory>[0], cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    });

    // ralph_status
    api.registerTool({
      name: "ralph_status",
      label: "Ralph Status",
      description: "Get the current status of the Ralph project - pending stories, completed stories, and next task.",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
        },
        required: ["workdir"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await executeRalphStatus(params as Parameters<typeof executeRalphStatus>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    });

    // ralph_edit_story
    api.registerTool({
      name: "ralph_edit_story",
      label: "Ralph Edit Story",
      description: "Edit an existing story in prd.json",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
          storyId: { type: "string", description: "Story ID to edit (required)" },
          title: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          priority: { type: "number", description: "New priority" },
          passes: { type: "boolean", description: "Mark as passed/failed" },
          validationCommand: { type: "string", description: "New validation command" },
        },
        required: ["workdir", "storyId"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await executeRalphEditStory(params as Parameters<typeof executeRalphEditStory>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    });

    // ralph_link_issues — bulk-create GH issues for existing PRDs
    api.registerTool({
      name: "ralph_link_issues",
      label: "Ralph Link Issues",
      description: "Create GitHub issues for all stories in prd.json that don't have issue numbers yet. Optionally creates a tracking issue.",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
          createTracking: { type: "boolean", description: "Also create a tracking issue if none exists (default: true)" },
        },
        required: ["workdir"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const workdir = params.workdir as string;
        const createTracking = params.createTracking !== false;
        const prd = readPRD(workdir);
        if (!prd) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "No prd.json found. Run ralph_init first." }) }] };
        }

        const { createStoryIssue, createTrackingIssue, updateTrackingChecklist } = await import("./gh-issues.js");
        const dir = resolvePath(workdir);
        let created = 0;

        for (const story of prd.stories) {
          if (!story.issueNumber) {
            const issueNum = createStoryIssue(dir, story, prd);
            if (issueNum) {
              story.issueNumber = issueNum;
              created++;
            }
          }
        }

        if (createTracking && !prd.metadata?.trackingIssue) {
          prd.metadata = prd.metadata || { createdAt: new Date().toISOString() };
          const trackingNum = createTrackingIssue(dir, prd);
          if (trackingNum) {
            prd.metadata.trackingIssue = trackingNum;
          }
        } else if (prd.metadata?.trackingIssue) {
          updateTrackingChecklist(dir, prd.metadata.trackingIssue, prd);
        }

        writePRD(workdir, prd);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              issuesCreated: created,
              trackingIssue: prd.metadata?.trackingIssue,
              stories: prd.stories.map((s) => ({ id: s.id, title: s.title, issueNumber: s.issueNumber })),
            }, null, 2),
          }],
        };
      },
    });

    // ralph_iterate
    api.registerTool({
      name: "ralph_iterate",
      label: "Ralph Iterate",
      description: "Run a single Ralph iteration: pick next story, spawn Codex, validate, commit if successful.",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
          model: { type: "string", description: "Override model for this iteration" },
          dryRun: { type: "boolean", description: "Show what would be done without executing" },
        },
        required: ["workdir"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await executeRalphIterate(params as Parameters<typeof executeRalphIterate>[0], cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    });

    // ralph_loop - NOW ASYNC! Returns job ID immediately
    api.registerTool({
      name: "ralph_loop",
      label: "Ralph Loop (Async)",
      description: "Start a Ralph loop in the background. Returns immediately with a job ID. Use ralph_loop_status to check progress.",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
          maxIterations: { type: "number", description: "Max iterations (default: from config)" },
          model: { type: "string", description: "Override model for iterations" },
          stopOnFailure: { type: "boolean", description: "Stop loop on first failure (default: false)" },
          sync: { type: "boolean", description: "Run synchronously (blocks until complete, legacy behavior)" },
          ghIssues: { type: "boolean", description: "Enable GitHub issue tracking for this loop run" },
        },
        required: ["workdir"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        // Allow per-invocation ghIssues override
        const loopCfg = params.ghIssues !== undefined ? { ...cfg, ghIssues: params.ghIssues as boolean } : cfg;

        // Legacy sync mode for backward compat
        if (params.sync) {
          const result = await executeRalphLoopSync(params as Parameters<typeof executeRalphLoopSync>[0], loopCfg);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        // New async mode - returns immediately
        const job = startLoopJob(params as Parameters<typeof startLoopJob>[0], loopCfg);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              jobId: job.id,
              status: job.status,
              workdir: job.workdir,
              maxIterations: job.maxIterations,
              totalStories: job.totalStories,
              message: "Loop started in background. Use ralph_loop_status to check progress.",
            }, null, 2),
          }],
        };
      },
    });

    // ralph_loop_status - check status of running/completed jobs
    api.registerTool({
      name: "ralph_loop_status",
      label: "Ralph Loop Status",
      description: "Check the status of a running or completed ralph loop job.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Job ID (optional - lists all if not provided)" },
        },
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const jobId = params.jobId as string | undefined;
        
        if (jobId) {
          const job = activeJobs.get(jobId);
          if (!job) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "Job not found", jobId }) }] };
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                jobId: job.id,
                status: job.status,
                workdir: job.workdir,
                currentIteration: job.currentIteration,
                maxIterations: job.maxIterations,
                currentStory: job.currentStory,
                storiesCompleted: job.storiesCompleted,
                totalStories: job.totalStories,
                elapsedMs: Date.now() - job.startedAt,
                completedAt: job.completedAt,
                error: job.error,
                results: job.results.map((r) => ({
                  storyId: r.storyId,
                  storyTitle: r.storyTitle,
                  success: r.success,
                  duration: r.duration,
                  commitHash: r.commitHash,
                })),
              }, null, 2),
            }],
          };
        }

        // List all jobs
        const jobs = Array.from(activeJobs.values()).map((j) => ({
          jobId: j.id,
          status: j.status,
          workdir: j.workdir,
          currentIteration: j.currentIteration,
          maxIterations: j.maxIterations,
          storiesCompleted: j.storiesCompleted,
          totalStories: j.totalStories,
          elapsedMs: Date.now() - j.startedAt,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ jobs, count: jobs.length }, null, 2) }] };
      },
    });

    // ralph_loop_cancel - cancel a running job
    api.registerTool({
      name: "ralph_loop_cancel",
      label: "Ralph Loop Cancel",
      description: "Cancel a running ralph loop job.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Job ID to cancel (required)" },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const jobId = params.jobId as string;
        const job = activeJobs.get(jobId);
        
        if (!job) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Job not found", jobId }) }] };
        }
        
        if (job.status !== "running") {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Job is not running", jobId, status: job.status }) }] };
        }

        job.status = "cancelled";
        job.completedAt = Date.now();
        emitLoopProgress(job, "complete");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              jobId: job.id,
              status: job.status,
              message: "Job cancelled. Will stop after current iteration.",
              storiesCompleted: job.storiesCompleted,
            }, null, 2),
          }],
        };
      },
    });

    // ralph_cursor - timestamp bookmarks for scoping log/transcript searches
    api.registerTool({
      name: "ralph_cursor",
      label: "Ralph Cursor",
      description: "Manage timestamp cursors for scoping log searches. Set a cursor after applying fixes, then use it to search only recent sessions/events.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action: 'set' (create new cursor), 'get' (get last cursor), 'list' (list all cursors), 'since' (get epoch ms of last cursor for use in filters)" },
          label: { type: "string", description: "Label for the cursor (required for 'set')" },
          details: { type: "string", description: "Optional details about what was fixed/changed" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const action = params.action as string;

        if (action === "set") {
          const label = params.label as string;
          if (!label) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "Label required for 'set' action" }) }] };
          }
          const entry = writeCursorEntry(label, params.details as string | undefined);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                message: "Cursor set",
                cursor: entry,
                hint: `Search logs since: ${entry.timestamp} (epoch: ${entry.epoch})`,
              }, null, 2),
            }],
          };
        }

        if (action === "get") {
          const last = getLastCursor();
          if (!last) {
            return { content: [{ type: "text", text: JSON.stringify({ message: "No cursors set yet" }) }] };
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                cursor: last,
                sinceHuman: `${Math.round((Date.now() - last.epoch) / 60000)} minutes ago`,
                hint: `Use epoch ${last.epoch} to filter events/sessions after this point`,
              }, null, 2),
            }],
          };
        }

        if (action === "since") {
          const last = getLastCursor();
          if (!last) {
            return { content: [{ type: "text", text: JSON.stringify({ epoch: 0, message: "No cursor set — returning epoch 0 (search everything)" }) }] };
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                epoch: last.epoch,
                timestamp: last.timestamp,
                label: last.label,
              }, null, 2),
            }],
          };
        }

        if (action === "list") {
          const cursor = readCursor();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                count: cursor.entries.length,
                entries: cursor.entries.map((e) => ({
                  timestamp: e.timestamp,
                  label: e.label,
                  details: e.details,
                  ago: `${Math.round((Date.now() - e.epoch) / 60000)}m`,
                })),
              }, null, 2),
            }],
          };
        }

        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown action: ${action}. Use set, get, list, or since.` }) }] };
      },
    });

    // ========================================================================
    // Session Tools (codexmonitor port)
    // ========================================================================

    // ralph_sessions - list recent codex sessions
    api.registerTool({
      name: "ralph_sessions",
      label: "Ralph Sessions",
      description: "List recent Codex sessions from ~/.codex/sessions. Like codexmonitor list.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date filter (YYYY/MM/DD)" },
          limit: { type: "number", description: "Max sessions to return (default: 20)" },
        },
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const sessions = listSessions(params.date as string | undefined, (params.limit as number) || 20);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: sessions.length,
              sessions: sessions.map((s) => ({
                id: s.id,
                timestamp: s.timestamp,
                cwd: s.cwd,
                model: s.model,
                messages: s.messageCount,
              })),
            }, null, 2),
          }],
        };
      },
    });

    // ralph_session_show - show a specific session
    api.registerTool({
      name: "ralph_session_show",
      label: "Ralph Session Show",
      description: "Show details of a specific Codex session. Like codexmonitor show.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID (full or prefix)" },
          ranges: { type: "string", description: "Message ranges to show (e.g., '1...3,5...7')" },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const session = getSessionById(params.sessionId as string);
        if (!session) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Session not found" }) }] };
        }
        const messages = extractSessionMessages(session.events, params.ranges as string | undefined);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              info: session.info,
              messageCount: messages.length,
              messages: messages.slice(0, 50), // Limit to avoid huge output
            }, null, 2),
          }],
        };
      },
    });

    // ralph_session_resume - resume a codex session
    api.registerTool({
      name: "ralph_session_resume",
      label: "Ralph Session Resume",
      description: "Resume a previous Codex session with a new message.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID to resume" },
          message: { type: "string", description: "Message to continue with" },
        },
        required: ["sessionId", "message"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const sessionId = params.sessionId as string;
        const message = params.message as string;

        try {
          const output = execSync(
            `codex exec resume ${sessionId} "${message.replace(/"/g, '\\"')}"`,
            { encoding: "utf-8", timeout: 300000 }
          );
          return { content: [{ type: "text", text: output.slice(0, 5000) }] };
        } catch (error) {
          const err = error as { message?: string; stdout?: string };
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: err.message, output: err.stdout?.slice(0, 2000) }),
            }],
          };
        }
      },
    });

    // ralph_patterns - show orchestration patterns
    api.registerTool({
      name: "ralph_patterns",
      label: "Ralph Patterns",
      description: "Show available orchestration patterns for task decomposition (from codex-orchestration skill).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Specific pattern to show details for" },
        },
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const patternName = params.pattern as string | undefined;
        if (patternName && ORCHESTRATION_PATTERNS[patternName as keyof typeof ORCHESTRATION_PATTERNS]) {
          const p = ORCHESTRATION_PATTERNS[patternName as keyof typeof ORCHESTRATION_PATTERNS];
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                pattern: patternName,
                ...p,
                workerPreamble: WORKER_PREAMBLE,
              }, null, 2),
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              patterns: Object.entries(ORCHESTRATION_PATTERNS).map(([key, val]) => ({
                id: key,
                name: val.name,
                description: val.description,
              })),
              workerPreamble: WORKER_PREAMBLE,
            }, null, 2),
          }],
        };
      },
    });

    // ralph_worker_prompt - generate a worker prompt
    api.registerTool({
      name: "ralph_worker_prompt",
      label: "Ralph Worker Prompt",
      description: "Generate a worker prompt with the standard preamble for spawning a codex sub-agent.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description for the worker" },
          role: { type: "string", description: "Worker role: reviewer, implementer, verifier, research" },
          scope: { type: "string", description: "Scope constraint: read-only or specific files" },
          lens: { type: "string", description: "Review lens (for reviewer role)" },
          workdir: { type: "string", description: "Working directory" },
        },
        required: ["task"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const task = params.task as string;
        const role = (params.role as string) || "implementer";
        const scope = (params.scope as string) || "read-only";
        const lens = params.lens as string | undefined;
        const workdir = params.workdir as string | undefined;

        let prompt = WORKER_PREAMBLE + "\n";
        prompt += `TASK: ${task}\n`;
        prompt += `SCOPE: ${scope}\n`;
        if (lens) prompt += `LENS: ${lens}\n`;

        // Build the codex command
        const cmdParts = ["codex", "exec", "--full-auto", "--output-last-message", "/tmp/worker-output.txt"];
        if (workdir) cmdParts.push("-C", workdir);
        cmdParts.push(`"${prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              prompt,
              command: cmdParts.join(" "),
              outputFile: "/tmp/worker-output.txt",
            }, null, 2),
          }],
        };
      },
    });

    // ========================================================================
    // Autopsy Tools (repo analysis)
    // ========================================================================

    api.registerTool({
      name: "autopsy_clone",
      label: "Autopsy Clone",
      description: "Clone/update a GitHub repo locally for deep analysis. Returns local path.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
          refresh: { type: "boolean", description: "Force refresh even if cached" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.clone(p.repo as string, p.refresh as boolean) }],
      }),
    });

    api.registerTool({
      name: "autopsy_structure",
      label: "Autopsy Structure",
      description: "Get directory tree of cloned repo",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
          path: { type: "string", description: "Subpath to explore" },
          depth: { type: "number", description: "Max depth (default: 4)" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.structure(p.repo as string, p.path as string, p.depth as number) }],
      }),
    });

    api.registerTool({
      name: "autopsy_search",
      label: "Autopsy Search",
      description: "Ripgrep search in cloned repo - full regex power",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
          pattern: { type: "string", description: "Regex pattern" },
          fileGlob: { type: "string", description: "File glob filter (e.g., '*.ts')" },
          context: { type: "number", description: "Lines of context (default: 2)" },
          maxResults: { type: "number", description: "Max results (default: 50)" },
        },
        required: ["repo", "pattern"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.search(p.repo as string, p.pattern as string, p.fileGlob as string, p.context as number, p.maxResults as number) }],
      }),
    });

    api.registerTool({
      name: "autopsy_ast",
      label: "Autopsy AST",
      description: "AST-grep structural code search",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
          pattern: { type: "string", description: "ast-grep pattern" },
          lang: { type: "string", description: "Language: ts, tsx, js, py, go, rust" },
        },
        required: ["repo", "pattern"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.ast(p.repo as string, p.pattern as string, p.lang as string) }],
      }),
    });

    api.registerTool({
      name: "autopsy_deps",
      label: "Autopsy Dependencies",
      description: "Analyze dependencies (package.json, requirements.txt, go.mod, Cargo.toml)",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.deps(p.repo as string) }],
      }),
    });

    api.registerTool({
      name: "autopsy_hotspots",
      label: "Autopsy Hotspots",
      description: "Find code hotspots - most changed, largest, most TODOs",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.hotspots(p.repo as string) }],
      }),
    });

    api.registerTool({
      name: "autopsy_stats",
      label: "Autopsy Stats",
      description: "Code statistics with tokei - lines, languages, file counts",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.stats(p.repo as string) }],
      }),
    });

    api.registerTool({
      name: "autopsy_secrets",
      label: "Autopsy Secrets",
      description: "Scan for leaked secrets with gitleaks",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.secrets(p.repo as string) }],
      }),
    });

    api.registerTool({
      name: "autopsy_find",
      label: "Autopsy Find",
      description: "Fast file finding with fd",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
          pattern: { type: "string", description: "File name pattern (regex)" },
          type: { type: "string", description: "Type: f=file, d=dir, l=symlink, x=executable" },
          extension: { type: "string", description: "Filter by extension (e.g., 'ts')" },
        },
        required: ["repo", "pattern"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.find(p.repo as string, p.pattern as string, p.type as string, p.extension as string) }],
      }),
    });

    api.registerTool({
      name: "autopsy_file",
      label: "Autopsy File",
      description: "Read a file from cloned repo with optional line range",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
          path: { type: "string", description: "File path within repo" },
          startLine: { type: "number", description: "Start line (1-indexed)" },
          endLine: { type: "number", description: "End line" },
        },
        required: ["repo", "path"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.file(p.repo as string, p.path as string, p.startLine as number, p.endLine as number) }],
      }),
    });

    api.registerTool({
      name: "autopsy_blame",
      label: "Autopsy Blame",
      description: "Git blame for a file - who wrote what",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
          path: { type: "string", description: "File path within repo" },
          startLine: { type: "number", description: "Start line" },
          endLine: { type: "number", description: "End line" },
        },
        required: ["repo", "path"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.blame(p.repo as string, p.path as string, p.startLine as number, p.endLine as number) }],
      }),
    });

    api.registerTool({
      name: "autopsy_exports",
      label: "Autopsy Exports",
      description: "Map public API - all exports from a TypeScript repo",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo (owner/repo or URL)" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.exports(p.repo as string) }],
      }),
    });

    api.registerTool({
      name: "autopsy_cleanup",
      label: "Autopsy Cleanup",
      description: "Remove cloned repo from local cache",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repo to remove, or 'all' to clear cache" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: Record<string, unknown>) => ({
        content: [{ type: "text", text: autopsyTools.cleanup(p.repo as string) }],
      }),
    });

    // ========================================================================
    // Iteration Log Browser
    // ========================================================================

    api.registerTool({
      name: "ralph_iterations",
      label: "Ralph Iterations",
      description: "Browse iteration history for a project. Shows timing, tool names, prompt hashes, session cross-references. Use showPrompt to retrieve full prompt text.",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
          limit: { type: "number", description: "Max entries to return (default: 20)" },
          onlyFailed: { type: "boolean", description: "Only show failed iterations" },
          sinceEpoch: { type: "number", description: "Only show iterations after this epoch (ms)" },
          storyId: { type: "string", description: "Filter by story ID" },
          jobId: { type: "string", description: "Filter by job ID" },
          showPrompt: { type: "string", description: "Story ID — retrieve the most recent persisted prompt for this story" },
        },
        required: ["workdir"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const workdir = params.workdir as string;

        // showPrompt mode: retrieve full prompt text for a story
        if (params.showPrompt) {
          const storyId = params.showPrompt as string;
          const entries = readIterationLog(workdir, { storyId, limit: 1 });
          if (entries.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: `No iterations found for story: ${storyId}` }) }] };
          }
          const entry = entries[entries.length - 1]!;
          let promptText = "";
          try {
            if (entry.promptFile && existsSync(entry.promptFile)) {
              promptText = readFileSync(entry.promptFile, "utf-8");
            } else {
              promptText = `[Prompt file not found: ${entry.promptFile}]`;
            }
          } catch {
            promptText = `[Error reading prompt file: ${entry.promptFile}]`;
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                storyId: entry.storyId,
                storyTitle: entry.storyTitle,
                promptHash: entry.promptHash,
                promptFile: entry.promptFile,
                promptLength: entry.promptLength,
                timestamp: entry.timestamp,
                prompt: promptText,
              }, null, 2),
            }],
          };
        }

        // Browse mode: list iteration entries with filters
        const entries = readIterationLog(workdir, {
          limit: (params.limit as number) || 20,
          onlyFailed: params.onlyFailed as boolean | undefined,
          sinceEpoch: params.sinceEpoch as number | undefined,
          storyId: params.storyId as string | undefined,
          jobId: params.jobId as string | undefined,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: entries.length,
              entries: entries.map((e) => ({
                timestamp: e.timestamp,
                epoch: e.epoch,
                jobId: e.jobId,
                iterationNumber: e.iterationNumber,
                storyId: e.storyId,
                storyTitle: e.storyTitle,
                success: e.success,
                validationPassed: e.validationPassed,
                failureCategory: e.failureCategory,
                duration: e.duration,
                durationHuman: `${Math.round(e.duration / 1000)}s`,
                promptHash: e.promptHash,
                promptLength: e.promptLength,
                codexSessionId: e.codexSessionId,
                codexSessionFile: e.codexSessionFile,
                commitHash: e.commitHash,
                toolCalls: e.toolCalls,
                toolNames: e.toolNames,
                filesModified: e.filesModified,
                codexOutputLength: e.codexOutputLength,
                codexFinalMessageLength: e.codexFinalMessageLength,
                validationOutput: e.validationOutput,
                model: e.model,
                sandbox: e.sandbox,
              })),
            }, null, 2),
          }],
        };
      },
    });

    console.log(`[openclaw-codex-ralph] Registered 27 tools (model: ${cfg.model}, sandbox: ${cfg.sandbox}, ghIssues: ${cfg.ghIssues})`);
  },
};

export default ralphCodexPlugin;
