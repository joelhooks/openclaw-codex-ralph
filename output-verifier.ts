/**
 * Holistic output verification for Ralph iterations.
 *
 * Runs AFTER validation passes but BEFORE git commit. Catches stories that
 * technically pass (typecheck/tests green) but didn't meaningfully address
 * the work — empty diffs, zero tool calls, config-only when code was expected,
 * trivial changes, lazy summaries, etc.
 *
 * Two severity levels:
 * - REJECT: gates commit, story stays incomplete for retry
 * - WARN: logged/stored, but commit proceeds
 *
 * Budget: <200ms per verification (heuristics only, no LLM calls in v1).
 */

import { execSync } from "node:child_process";
import type { MonitorStats } from "./loop-monitor.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CheckSeverity = "REJECT" | "WARN";

export interface VerificationCheck {
  name: string;
  severity: CheckSeverity;
  message: string;
}

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface VerificationInput {
  workdir: string;
  story: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria?: string[];
  };
  codexResult: {
    toolCalls: number;
    filesModified: string[];
    structuredResult?: {
      success: boolean;
      summary: string;
      files_modified: string[];
    };
    stderrStats?: MonitorStats;
  };
  validationOutput: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  warnings: string[];
  rejectReason?: string;
  diffStats: { filesChanged: number; insertions: number; deletions: number };
  requiresLLMReview: boolean;
}

// ─── Git Helpers ────────────────────────────────────────────────────────────

export function getDiffStats(workdir: string): DiffStats {
  try {
    // Check both staged and unstaged changes
    const raw = execSync("git diff --stat HEAD 2>/dev/null || git diff --stat 2>/dev/null", {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!raw) {
      // Also check for untracked files
      const untracked = execSync("git ls-files --others --exclude-standard", {
        cwd: workdir,
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (untracked) {
        const files = untracked.split("\n").filter(Boolean);
        return { filesChanged: files.length, insertions: 0, deletions: 0, files };
      }

      return { filesChanged: 0, insertions: 0, deletions: 0, files: [] };
    }

    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;

    for (const line of raw.split("\n")) {
      // Match file lines: " src/foo.ts | 10 ++++---"
      const fileMatch = line.match(/^\s*(.+?)\s+\|\s+\d+/);
      if (fileMatch && fileMatch[1]) {
        files.push(fileMatch[1].trim());
      }
      // Match summary line: " 3 files changed, 10 insertions(+), 5 deletions(-)"
      const summaryMatch = line.match(/(\d+)\s+insertion/);
      const delMatch = line.match(/(\d+)\s+deletion/);
      if (summaryMatch && summaryMatch[1]) insertions = parseInt(summaryMatch[1], 10);
      if (delMatch && delMatch[1]) deletions = parseInt(delMatch[1], 10);
    }

    return { filesChanged: files.length, insertions, deletions, files };
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0, files: [] };
  }
}

export function getDiffContent(workdir: string, maxLength = 5000): string {
  try {
    const diff = execSync("git diff HEAD 2>/dev/null || git diff 2>/dev/null", {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return diff.slice(0, maxLength);
  } catch {
    return "";
  }
}

// ─── Config/Doc Detection ───────────────────────────────────────────────────

const CONFIG_EXTENSIONS = new Set([
  ".json", ".yml", ".yaml", ".toml", ".ini", ".env",
  ".config.js", ".config.ts", ".config.mjs", ".config.cjs",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

function isConfigOrDocFile(file: string): boolean {
  const lower = file.toLowerCase();
  for (const ext of CONFIG_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  for (const ext of DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isTestFile(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.includes(".test.") || lower.includes(".spec.") || lower.includes("__tests__");
}

function isConfigOnlyStory(story: { title: string; description: string }): boolean {
  const text = `${story.title} ${story.description}`.toLowerCase();
  return (
    text.includes("config") ||
    text.includes("build") ||
    text.includes("setup") ||
    text.includes("ci/cd") ||
    text.includes("pipeline") ||
    text.includes("deploy") ||
    text.includes("infrastructure") ||
    text.includes("package.json") ||
    text.includes("tsconfig") ||
    text.includes("eslint") ||
    text.includes("prettier") ||
    text.includes("docker")
  );
}

// ─── Individual Checks ──────────────────────────────────────────────────────

export function checkEmptyDiff(
  diffStats: DiffStats,
  filesModified: string[]
): VerificationCheck | null {
  if (filesModified.length === 0 && diffStats.filesChanged === 0) {
    return {
      name: "empty_diff",
      severity: "REJECT",
      message: "No files were modified — the agent produced no changes.",
    };
  }
  return null;
}

export function checkNoTests(
  diffStats: DiffStats,
  story: { title: string; description: string }
): VerificationCheck | null {
  // Skip for config-only stories
  if (isConfigOnlyStory(story)) return null;

  // Skip if all modified files are config/docs (non-code story)
  if (diffStats.files.length > 0 && diffStats.files.every(isConfigOrDocFile)) return null;

  const hasTestFile = diffStats.files.some(isTestFile);
  if (!hasTestFile && diffStats.filesChanged > 0) {
    return {
      name: "no_tests",
      severity: "WARN",
      message: "No test files were modified or created. Consider adding test coverage.",
    };
  }
  return null;
}

export function checkZeroToolCalls(toolCalls: number): VerificationCheck | null {
  if (toolCalls === 0) {
    return {
      name: "zero_tool_calls",
      severity: "REJECT",
      message: "Agent made zero tool calls — likely a no-op session.",
    };
  }
  return null;
}

export function checkConfigOnly(
  diffStats: DiffStats,
  story: { title: string; description: string }
): VerificationCheck | null {
  if (diffStats.filesChanged === 0) return null;
  if (isConfigOnlyStory(story)) return null;

  const allConfig = diffStats.files.every(isConfigOrDocFile);
  if (allConfig) {
    return {
      name: "config_only",
      severity: "WARN",
      message: `Only config/doc files changed (${diffStats.files.join(", ")}) but story describes code work.`,
    };
  }
  return null;
}

export function checkTrivialDiff(diffStats: DiffStats): VerificationCheck | null {
  if (diffStats.filesChanged === 0) return null;
  const totalChanges = diffStats.insertions + diffStats.deletions;
  if (totalChanges > 0 && totalChanges < 5) {
    return {
      name: "trivial_diff",
      severity: "WARN",
      message: `Trivial diff: only ${totalChanges} line(s) changed (${diffStats.insertions} insertions, ${diffStats.deletions} deletions).`,
    };
  }
  return null;
}

export function checkAcceptanceCriteriaRelevance(
  story: { acceptanceCriteria?: string[] },
  diffContent: string,
  summary: string
): VerificationCheck | null {
  if (!story.acceptanceCriteria || story.acceptanceCriteria.length === 0) return null;

  // Extract key nouns (3+ char words) from acceptance criteria
  const allCriteria = story.acceptanceCriteria.join(" ");
  const nouns = allCriteria
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    // Remove extremely common stop words
    .filter((w) => !["should", "must", "when", "then", "that", "this", "with", "from", "have", "been", "will", "given"].includes(w));

  if (nouns.length === 0) return null;

  const searchSpace = `${diffContent} ${summary}`.toLowerCase();
  const matched = nouns.filter((noun) => searchSpace.includes(noun));
  const matchRatio = matched.length / nouns.length;

  if (matchRatio < 0.2 && nouns.length >= 3) {
    return {
      name: "acceptance_criteria_miss",
      severity: "WARN",
      message: `Low acceptance criteria relevance: only ${matched.length}/${nouns.length} key terms found in diff+summary. Missing: ${nouns.filter((n) => !matched.includes(n)).slice(0, 5).join(", ")}`,
    };
  }
  return null;
}

export function checkSelfReportedFailure(
  structuredResult?: { success: boolean }
): VerificationCheck | null {
  if (structuredResult && structuredResult.success === false) {
    return {
      name: "self_reported_failure",
      severity: "WARN",
      message: "Agent self-reported failure (success=false) but validation passed. Possible incomplete work.",
    };
  }
  return null;
}

const LAZY_SUMMARY_PATTERNS = [
  /^done\.?$/i,
  /^completed\.?$/i,
  /^implemented\.?$/i,
  /^fixed\.?$/i,
  /^updated?\.?$/i,
  /^changes? made\.?$/i,
  /^all (done|good|set)\.?$/i,
  /^task complete\.?$/i,
];

export function checkLazySummary(summary?: string): VerificationCheck | null {
  if (!summary) return null;
  if (summary.length < 20) {
    return {
      name: "lazy_summary",
      severity: "WARN",
      message: `Summary too short (${summary.length} chars): "${summary}"`,
    };
  }
  for (const pattern of LAZY_SUMMARY_PATTERNS) {
    if (pattern.test(summary.trim())) {
      return {
        name: "lazy_summary",
        severity: "WARN",
        message: `Lazy summary detected: "${summary.trim()}"`,
      };
    }
  }
  return null;
}

export function checkHeavyExplorationNoWrites(
  stderrStats?: MonitorStats
): VerificationCheck | null {
  if (!stderrStats) return null;
  if (stderrStats.fileExplorations > 5 && stderrStats.fileWrites === 0) {
    return {
      name: "heavy_exploration_no_writes",
      severity: "WARN",
      message: `Agent explored ${stderrStats.fileExplorations} files but wrote to none — possible analysis paralysis.`,
    };
  }
  return null;
}

// ─── Main Entry ─────────────────────────────────────────────────────────────

export function verifyOutput(input: VerificationInput): VerificationResult {
  const { workdir, story, codexResult, validationOutput: _validationOutput } = input;

  const diffStats = getDiffStats(workdir);
  const diffContent = getDiffContent(workdir);
  const summary = codexResult.structuredResult?.summary || "";

  const checks: VerificationCheck[] = [];

  // Run all checks, collecting non-null results
  const maybeChecks = [
    checkEmptyDiff(diffStats, codexResult.filesModified),
    checkNoTests(diffStats, story),
    checkZeroToolCalls(codexResult.toolCalls),
    checkConfigOnly(diffStats, story),
    checkTrivialDiff(diffStats),
    checkAcceptanceCriteriaRelevance(story, diffContent, summary),
    checkSelfReportedFailure(codexResult.structuredResult),
    checkLazySummary(summary),
    checkHeavyExplorationNoWrites(codexResult.stderrStats),
  ];

  for (const check of maybeChecks) {
    if (check) checks.push(check);
  }

  const rejects = checks.filter((c) => c.severity === "REJECT");
  const warns = checks.filter((c) => c.severity === "WARN");

  return {
    passed: rejects.length === 0,
    checks,
    warnings: warns.map((w) => w.message),
    rejectReason: rejects.length > 0
      ? rejects.map((r) => r.message).join("; ")
      : undefined,
    diffStats: {
      filesChanged: diffStats.filesChanged,
      insertions: diffStats.insertions,
      deletions: diffStats.deletions,
    },
    requiresLLMReview: warns.length >= 3,
  };
}
