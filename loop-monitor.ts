/**
 * Real-time stderr monitor for Codex child processes.
 *
 * Attaches to the stderr stream and tracks:
 * - Reasoning time vs action time (tool calls)
 * - Tool call counts and types
 * - Files explored vs files written
 * - Error occurrences
 * - Time-to-first-tool-call
 */

export interface MonitorStats {
  totalMs: number;
  timeToFirstToolCallMs: number | null;
  toolCalls: number;
  fileExplorations: number;   // cat, rg, find, ls, head, tail
  fileWrites: number;         // write, edit, patch, create
  testRuns: number;           // test, vitest, jest, pytest
  errorsHit: number;
  linesProcessed: number;
}

export interface StderrMonitor {
  /** Human-readable summary of what Codex did this iteration */
  getInsights(): string;
  /** Structured stats for injection into next iteration prompt */
  getStats(): MonitorStats;
  /** Stop monitoring (cleanup) */
  stop(): void;
}

const EXPLORE_PATTERNS = /\b(cat|rg|grep|find|ls|head|tail|less|tree|fd)\b/;
const WRITE_PATTERNS = /\b(write|edit|patch|create|mkdir|touch|mv|cp|sed|awk)\b/;
const TEST_PATTERNS = /\b(vitest|jest|pytest|test|npm test|pnpm test|bun test)\b/;
const ERROR_PATTERNS = /\b(error|Error|ERROR|failed|FAILED|exception|panic)\b/;
const TOOL_CALL_PATTERNS = /\b(Running|Executing|command_execution|mcp_tool_call|item\.completed)\b/;

export function createStderrMonitor(stderr: NodeJS.ReadableStream): StderrMonitor {
  const startTime = Date.now();
  let firstToolCallTime: number | null = null;
  let toolCalls = 0;
  let fileExplorations = 0;
  let fileWrites = 0;
  let testRuns = 0;
  let errorsHit = 0;
  let linesProcessed = 0;
  let buffer = "";

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      linesProcessed++;

      // Detect tool calls (any command execution marker)
      if (TOOL_CALL_PATTERNS.test(line)) {
        toolCalls++;
        if (firstToolCallTime === null) {
          firstToolCallTime = Date.now();
        }
      }

      // Categorize activity
      if (EXPLORE_PATTERNS.test(line)) fileExplorations++;
      if (WRITE_PATTERNS.test(line)) fileWrites++;
      if (TEST_PATTERNS.test(line)) testRuns++;
      if (ERROR_PATTERNS.test(line)) errorsHit++;
    }
  };

  stderr.on("data", onData);

  function getStats(): MonitorStats {
    const now = Date.now();
    return {
      totalMs: now - startTime,
      timeToFirstToolCallMs: firstToolCallTime ? firstToolCallTime - startTime : null,
      toolCalls,
      fileExplorations,
      fileWrites,
      testRuns,
      errorsHit,
      linesProcessed,
    };
  }

  function getInsights(): string {
    const stats = getStats();
    const parts: string[] = [];

    const totalSec = Math.round(stats.totalMs / 1000);
    parts.push(`Duration: ${totalSec}s`);

    if (stats.timeToFirstToolCallMs !== null) {
      const ttfc = Math.round(stats.timeToFirstToolCallMs / 1000);
      parts.push(`Time to first tool call: ${ttfc}s`);
    } else {
      parts.push(`No tool calls detected in stderr`);
    }

    parts.push(`Tool calls: ${stats.toolCalls}`);
    parts.push(`File explorations: ${stats.fileExplorations}, writes: ${stats.fileWrites}, test runs: ${stats.testRuns}`);

    if (stats.errorsHit > 0) {
      parts.push(`Errors encountered: ${stats.errorsHit}`);
    }

    // Flag heavy exploration with no writes
    if (stats.fileExplorations > 5 && stats.fileWrites === 0) {
      parts.push(`⚠️ Heavy exploration (${stats.fileExplorations} reads) with no writes — codebase map may need enrichment`);
    }

    return parts.join(". ");
  }

  function stop(): void {
    stderr.removeListener("data", onData);
  }

  return { getInsights, getStats, stop };
}

/**
 * Format previous iteration stats for injection into next prompt.
 * Returns empty string if no meaningful data.
 */
export function formatIterationBehavior(stats: MonitorStats): string {
  if (stats.linesProcessed === 0) return "";

  const parts: string[] = [];
  parts.push("## Previous Iteration Behavior");

  if (stats.timeToFirstToolCallMs !== null) {
    const ttfc = Math.round(stats.timeToFirstToolCallMs / 1000);
    parts.push(`- Time to first tool call: ${ttfc}s${ttfc > 30 ? " (slow — codebase map should reduce exploration)" : ""}`);
  }

  if (stats.fileExplorations > 0) {
    parts.push(`- Explored ${stats.fileExplorations} files before/during work${stats.fileExplorations > 8 ? " (excessive — trust the codebase map)" : ""}`);
  }

  if (stats.fileWrites > 0) {
    parts.push(`- Wrote/edited ${stats.fileWrites} files`);
  }

  if (stats.testRuns > 0) {
    parts.push(`- Ran tests ${stats.testRuns} times`);
  }

  if (stats.errorsHit > 0) {
    parts.push(`- Hit ${stats.errorsHit} errors`);
  }

  const exploreRatio = stats.toolCalls > 0 ? stats.fileExplorations / stats.toolCalls : 0;
  if (exploreRatio > 0.5) {
    parts.push(`- Exploration ratio: ${exploreRatio.toFixed(1)} (high — the codebase reference above has your file tree, types, and imports. Trust it.)`);
  }

  if (parts.length <= 1) return "";
  return parts.join("\n");
}
