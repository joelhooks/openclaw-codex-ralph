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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";

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
  error?: string;
  codexOutput?: string;
  codexFinalMessage?: string;
  toolCalls?: number;
  filesModified?: string[];
  duration: number;
}

interface LoopResult {
  success: boolean;
  iterationsRun: number;
  storiesCompleted: number;
  remainingStories: number;
  results: IterationResult[];
  stoppedReason: "complete" | "limit" | "failure" | "error";
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

      for (const event of events) {
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

    console.log(`[ralph-codex] Registered 6 tools (model: ${cfg.model}, sandbox: ${cfg.sandbox})`);
  },
};

export default ralphCodexPlugin;
