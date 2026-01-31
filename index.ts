/**
 * Ralph-Codex Plugin
 *
 * Autonomous AI coding loops using Codex. Each iteration spawns a fresh
 * Codex session to implement one story from prd.json, validates with
 * typecheck/tests, commits on success, and repeats until done.
 *
 * Based on: https://github.com/snarktank/ralph
 */
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emitDiagnosticEvent } from "clawdbot/plugin-sdk";
import { execFileSync, execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, basename } from "path";
import { homedir } from "os";
import { autopsyTools } from "./autopsy.js";

// ============================================================================
// Types
// ============================================================================

interface Story {
  id: string;
  title: string;
  description: string;
  priority: number;
  passes: boolean;
  validationCommand?: string;
  acceptanceCriteria?: string[];
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
  stoppedReason: "complete" | "limit" | "failure" | "error";
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
}

const DEFAULT_CONFIG: PluginConfig = {
  model: "gpt-5.2-codex",
  maxIterations: 20,
  sandbox: "workspace-write",
  autoCommit: true,
  debug: false,
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

function readAgentsMd(workdir: string): string {
  const agentsPath = join(resolvePath(workdir), "AGENTS.md");
  if (!existsSync(agentsPath)) return "";
  return readFileSync(agentsPath, "utf-8");
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
  if (!command) {
    // Default: try typecheck then test
    command = "npm run typecheck 2>/dev/null || tsc --noEmit; npm test 2>/dev/null || true";
  }
  try {
    const output = execSync(command, {
      cwd: resolvePath(workdir),
      encoding: "utf-8",
      timeout: 300000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { success: false, output: err.stdout || err.stderr || err.message || "Validation failed" };
  }
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

function buildIterationPrompt(prd: PRD, story: Story, progress: string, agentsMd: string): string {
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

  if (agentsMd) {
    parts.push(`\n## Project Guidelines (AGENTS.md)`);
    parts.push(agentsMd);
  }

  if (progress) {
    parts.push(`\n## Previous Progress`);
    // Only include last ~2000 chars to avoid context bloat
    const trimmedProgress = progress.length > 2000 ? "...\n" + progress.slice(-2000) : progress;
    parts.push(trimmedProgress);
  }

  parts.push(`\n## Instructions`);
  parts.push(`1. Implement ONLY this story - nothing more`);
  parts.push(`2. Make minimal, focused changes`);
  parts.push(`3. Ensure the validation command passes`);
  parts.push(`4. Do not modify prd.json or progress.txt directly`);
  parts.push(`5. When done, summarize what you changed and any learnings`);

  return parts.join("\n");
}

interface CodexEvent {
  type: string;
  message?: string;
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  output?: string;
  error?: string;
}

interface CodexIterationResult {
  success: boolean;
  output: string;
  finalMessage: string;
  events: CodexEvent[];
  toolCalls: number;
  filesModified: string[];
  sessionId?: string;
}

async function runCodexIteration(
  workdir: string,
  prompt: string,
  cfg: PluginConfig
): Promise<CodexIterationResult> {
  return new Promise((resolve) => {
    const resolvedWorkdir = resolvePath(workdir);
    const outputFile = join(resolvedWorkdir, `.ralph-last-message-${Date.now()}.txt`);

    const args = [
      "exec",
      "--full-auto",
      "--sandbox", cfg.sandbox,
      "--json",
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
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number | null) => {
      // Parse JSONL events
      const events: CodexEvent[] = [];
      const lines = stdout.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as CodexEvent;
          events.push(event);
        } catch {
          // Not JSON, skip
        }
      }

      // Extract useful info from events
      const toolCalls = events.filter((e) => e.type === "tool_call" || e.type === "function_call").length;
      const filesModified: string[] = [];
      let sessionId: string | undefined;

      for (const event of events) {
        // Extract session ID from session_start or similar events
        if (event.type === "session_start" || event.type === "session_meta") {
          const payload = event as unknown as { session_id?: string; id?: string; payload?: { id?: string } };
          sessionId = payload.session_id || payload.id || payload.payload?.id;
        }
        if (event.type === "tool_call" && event.tool === "write_file" && event.args?.path) {
          filesModified.push(String(event.args.path));
        }
        if (event.type === "tool_call" && event.tool === "edit_file" && event.args?.path) {
          filesModified.push(String(event.args.path));
        }
      }

      // Read final message from output file
      let finalMessage = "";
      try {
        if (existsSync(outputFile)) {
          finalMessage = readFileSync(outputFile, "utf-8");
          // Clean up temp file
          try { execSync(`rm "${outputFile}"`, { encoding: "utf-8" }); } catch { /* ignore */ }
        }
      } catch {
        finalMessage = "";
      }

      const output = finalMessage || stdout.slice(0, 5000);

      resolve({
        success: code === 0,
        output,
        finalMessage,
        events,
        toolCalls,
        filesModified: [...new Set(filesModified)],
        sessionId,
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

    // Timeout after 10 minutes
    setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        success: false,
        output: "Timeout: iteration exceeded 10 minutes",
        finalMessage: "",
        events: [],
        toolCalls: 0,
        filesModified: [],
      });
    }, 600000);
  });
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function executeRalphInit(params: { workdir: string; projectName: string; description?: string }) {
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

  const progressPath = join(dir, "progress.txt");
  if (!existsSync(progressPath)) {
    writeFileSync(progressPath, `# Progress Log for ${params.projectName}\n\nInitialized: ${new Date().toISOString()}\n`);
  }

  return {
    success: true,
    message: `Initialized Ralph project: ${params.projectName}`,
    files: ["prd.json", "progress.txt"],
  };
}

async function executeRalphAddStory(params: {
  workdir: string;
  title: string;
  description: string;
  priority?: number;
  validationCommand?: string;
  acceptanceCriteria?: string;
}) {
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

async function executeRalphIterate(
  params: { workdir: string; model?: string; dryRun?: boolean },
  cfg: PluginConfig
): Promise<IterationResult | { dryRun: true; story: { id: string; title: string }; promptLength: number; model: string; sandbox: string } | { success: true; message: string; storiesCompleted: number } | { error: string }> {
  const workdir = params.workdir;
  const model = params.model || cfg.model;
  const dryRun = params.dryRun;

  const startTime = Date.now();

  const prd = readPRD(workdir);
  if (!prd) {
    return { error: "No prd.json found" };
  }

  const story = getNextStory(prd);
  if (!story) {
    return { success: true, message: "All stories complete!", storiesCompleted: prd.stories.length };
  }

  const progress = readProgress(workdir);
  const agentsMd = readAgentsMd(workdir);
  const prompt = buildIterationPrompt(prd, story, progress, agentsMd);

  if (dryRun) {
    return {
      dryRun: true,
      story: { id: story.id, title: story.title },
      promptLength: prompt.length,
      model,
      sandbox: cfg.sandbox,
    };
  }

  // Run Codex
  const codexResult = await runCodexIteration(workdir, prompt, { ...cfg, model });

  // Run validation
  const validation = runValidation(workdir, story.validationCommand);

  const result: IterationResult = {
    success: codexResult.success && validation.success,
    storyId: story.id,
    storyTitle: story.title,
    validationPassed: validation.success,
    codexOutput: codexResult.output.slice(0, 2000),
    codexFinalMessage: codexResult.finalMessage.slice(0, 2000),
    toolCalls: codexResult.toolCalls,
    filesModified: codexResult.filesModified,
    duration: Date.now() - startTime,
  };

  if (result.success) {
    // Mark story as passed
    story.passes = true;
    prd.metadata = prd.metadata || { createdAt: new Date().toISOString() };
    prd.metadata.lastIteration = new Date().toISOString();
    prd.metadata.totalIterations = (prd.metadata.totalIterations || 0) + 1;
    writePRD(workdir, prd);

    // Append to progress with final message
    const progressEntry = [
      `Completed: ${story.title}`,
      `Files modified: ${codexResult.filesModified.join(", ") || "none"}`,
      `Tool calls: ${codexResult.toolCalls}`,
      `Validation: ${story.validationCommand || "default"}`,
      `Summary: ${codexResult.finalMessage.slice(0, 800)}`,
    ].join("\n");
    appendProgress(workdir, progressEntry);

    // Git commit
    if (cfg.autoCommit) {
      const hash = gitCommit(workdir, `ralph: ${story.title}`);
      result.commitHash = hash || undefined;
    }
  } else {
    // Log failure with details
    const failureEntry = [
      `Failed: ${story.title}`,
      `Codex success: ${codexResult.success}`,
      `Validation success: ${validation.success}`,
      `Files touched: ${codexResult.filesModified.join(", ") || "none"}`,
      `Validation output: ${validation.output.slice(0, 500)}`,
      `Codex message: ${codexResult.finalMessage.slice(0, 500)}`,
    ].join("\n");
    appendProgress(workdir, failureEntry);
  }

  return result;
}

async function executeRalphLoop(
  params: { workdir: string; maxIterations?: number; model?: string; stopOnFailure?: boolean },
  cfg: PluginConfig
): Promise<LoopResult> {
  const workdir = params.workdir;
  const maxIterations = params.maxIterations || cfg.maxIterations;
  const model = params.model || cfg.model;
  const stopOnFailure = params.stopOnFailure;

  const loopCfg = { ...cfg, model };

  const loopResult: LoopResult = {
    success: false,
    iterationsRun: 0,
    storiesCompleted: 0,
    remainingStories: 0,
    results: [],
    stoppedReason: "complete",
  };

  for (let i = 0; i < maxIterations; i++) {
    const prd = readPRD(workdir);
    if (!prd) {
      loopResult.stoppedReason = "error";
      break;
    }

    const story = getNextStory(prd);
    if (!story) {
      loopResult.success = true;
      loopResult.stoppedReason = "complete";
      break;
    }

    loopResult.iterationsRun++;

    // Emit progress event - starting iteration
    emitDiagnosticEvent({
      type: "ralph:iteration:start",
      plugin: "openclaw-codex-ralph",
      data: {
        iteration: loopResult.iterationsRun,
        maxIterations,
        storyId: story.id,
        storyTitle: story.title,
        workdir,
      },
    });

    const progress = readProgress(workdir);
    const agentsMd = readAgentsMd(workdir);
    const prompt = buildIterationPrompt(prd, story, progress, agentsMd);

    const startTime = Date.now();
    const codexResult = await runCodexIteration(workdir, prompt, loopCfg);
    const validation = runValidation(workdir, story.validationCommand);

    const iterResult: IterationResult = {
      success: codexResult.success && validation.success,
      storyId: story.id,
      storyTitle: story.title,
      validationPassed: validation.success,
      codexOutput: codexResult.output.slice(0, 500),
      codexFinalMessage: codexResult.finalMessage.slice(0, 500),
      toolCalls: codexResult.toolCalls,
      filesModified: codexResult.filesModified,
      duration: Date.now() - startTime,
    };

    if (iterResult.success) {
      story.passes = true;
      prd.metadata = prd.metadata || { createdAt: new Date().toISOString() };
      prd.metadata.lastIteration = new Date().toISOString();
      prd.metadata.totalIterations = (prd.metadata.totalIterations || 0) + 1;
      writePRD(workdir, prd);
      loopResult.storiesCompleted++;

      const progressEntry = [
        `Completed: ${story.title}`,
        `Files: ${codexResult.filesModified.join(", ") || "none"}`,
        `Summary: ${codexResult.finalMessage.slice(0, 400)}`,
      ].join("\n");
      appendProgress(workdir, progressEntry);

      if (cfg.autoCommit) {
        const hash = gitCommit(workdir, `ralph: ${story.title}`);
        iterResult.commitHash = hash || undefined;
      }
    } else {
      const failEntry = [
        `Failed: ${story.title}`,
        `Validation: ${validation.output.slice(0, 300)}`,
        `Codex: ${codexResult.finalMessage.slice(0, 300)}`,
      ].join("\n");
      appendProgress(workdir, failEntry);

      if (stopOnFailure) {
        loopResult.stoppedReason = "failure";
        loopResult.results.push(iterResult);
        break;
      }
    }

    loopResult.results.push(iterResult);

    // Emit progress event - iteration complete
    emitDiagnosticEvent({
      type: "ralph:iteration:complete",
      plugin: "openclaw-codex-ralph",
      data: {
        iteration: loopResult.iterationsRun,
        maxIterations,
        storyId: story.id,
        storyTitle: story.title,
        success: iterResult.success,
        toolCalls: iterResult.toolCalls,
        filesModified: iterResult.filesModified,
        duration: iterResult.duration,
        storiesCompleted: loopResult.storiesCompleted,
        workdir,
      },
    });
  }

  // Final status
  const finalPrd = readPRD(workdir);
  if (finalPrd) {
    loopResult.remainingStories = finalPrd.stories.filter((s) => !s.passes).length;
    if (loopResult.remainingStories === 0) {
      loopResult.success = true;
    }
  }

  if (loopResult.iterationsRun >= maxIterations && loopResult.remainingStories > 0) {
    loopResult.stoppedReason = "limit";
  }

  return loopResult;
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
      sandbox: { type: "string", default: "workspace-write" },
      autoCommit: { type: "boolean", default: true },
      debug: { type: "boolean", default: false },
    },
    additionalProperties: false,
  },

  register(api: MoltbotPluginApi) {
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
        const result = await executeRalphInit(params as Parameters<typeof executeRalphInit>[0]);
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
        const result = await executeRalphAddStory(params as Parameters<typeof executeRalphAddStory>[0]);
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

    // ralph_loop
    api.registerTool({
      name: "ralph_loop",
      label: "Ralph Loop",
      description: "Run the full Ralph loop until all stories pass or max iterations reached.",
      parameters: {
        type: "object",
        properties: {
          workdir: { type: "string", description: "Project directory (required)" },
          maxIterations: { type: "number", description: "Max iterations (default: from config)" },
          model: { type: "string", description: "Override model for iterations" },
          stopOnFailure: { type: "boolean", description: "Stop loop on first failure (default: false)" },
        },
        required: ["workdir"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await executeRalphLoop(params as Parameters<typeof executeRalphLoop>[0], cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

    console.log(`[openclaw-codex-ralph] Registered 24 tools (model: ${cfg.model}, sandbox: ${cfg.sandbox})`);
  },
};

export default ralphCodexPlugin;
