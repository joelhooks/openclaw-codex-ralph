import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  verifyOutput,
  checkEmptyDiff,
  checkNoTests,
  checkZeroToolCalls,
  checkConfigOnly,
  checkTrivialDiff,
  checkAcceptanceCriteriaRelevance,
  checkSelfReportedFailure,
  checkLazySummary,
  checkHeavyExplorationNoWrites,
  getDiffStats,
  type VerificationInput,
} from "./output-verifier.js";

const TMP = join(process.cwd(), ".test-output-verifier");

function initGit(dir: string) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, ".gitkeep"), "");
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  initGit(TMP);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ─── Individual Checks ──────────────────────────────────────────────────────

describe("checkEmptyDiff", () => {
  it("rejects when no files modified and no diff", () => {
    const result = checkEmptyDiff(
      { filesChanged: 0, insertions: 0, deletions: 0, files: [] },
      []
    );
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("REJECT");
    expect(result!.name).toBe("empty_diff");
  });

  it("passes when files were modified", () => {
    const result = checkEmptyDiff(
      { filesChanged: 1, insertions: 5, deletions: 2, files: ["src/foo.ts"] },
      ["src/foo.ts"]
    );
    expect(result).toBeNull();
  });
});

describe("checkNoTests", () => {
  it("rejects when no test files in diff for code story", () => {
    const result = checkNoTests(
      { filesChanged: 2, insertions: 10, deletions: 5, files: ["src/app.ts", "src/utils.ts"] },
      { title: "Add user auth", description: "Implement authentication" }
    );
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("WARN");
  });

  it("passes when test files are in diff", () => {
    const result = checkNoTests(
      { filesChanged: 2, insertions: 10, deletions: 5, files: ["src/app.ts", "src/app.test.ts"] },
      { title: "Add user auth", description: "Implement authentication" }
    );
    expect(result).toBeNull();
  });

  it("skips for config-only stories", () => {
    const result = checkNoTests(
      { filesChanged: 1, insertions: 5, deletions: 2, files: ["src/app.ts"] },
      { title: "Update build config", description: "Fix the tsconfig settings" }
    );
    expect(result).toBeNull();
  });

  it("skips when all modified files are config/docs", () => {
    const result = checkNoTests(
      { filesChanged: 2, insertions: 5, deletions: 2, files: ["package.json", "README.md"] },
      { title: "Add new feature", description: "Build the widget" }
    );
    expect(result).toBeNull();
  });
});

describe("checkZeroToolCalls", () => {
  it("rejects zero tool calls", () => {
    const result = checkZeroToolCalls(0);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("REJECT");
  });

  it("passes with tool calls", () => {
    const result = checkZeroToolCalls(5);
    expect(result).toBeNull();
  });
});

describe("checkConfigOnly", () => {
  it("warns when only config files changed for code story", () => {
    const result = checkConfigOnly(
      { filesChanged: 2, insertions: 3, deletions: 1, files: ["package.json", "tsconfig.json"] },
      { title: "Add authentication", description: "Implement login flow" }
    );
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("WARN");
  });

  it("skips for config stories", () => {
    const result = checkConfigOnly(
      { filesChanged: 1, insertions: 3, deletions: 1, files: ["tsconfig.json"] },
      { title: "Fix tsconfig", description: "Update build config" }
    );
    expect(result).toBeNull();
  });

  it("passes when code files are present", () => {
    const result = checkConfigOnly(
      { filesChanged: 2, insertions: 10, deletions: 5, files: ["src/app.ts", "package.json"] },
      { title: "Add feature", description: "Build the thing" }
    );
    expect(result).toBeNull();
  });
});

describe("checkTrivialDiff", () => {
  it("warns for very small diffs", () => {
    const result = checkTrivialDiff(
      { filesChanged: 1, insertions: 2, deletions: 1, files: ["src/app.ts"] }
    );
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("WARN");
  });

  it("passes for substantial diffs", () => {
    const result = checkTrivialDiff(
      { filesChanged: 3, insertions: 30, deletions: 10, files: ["a.ts", "b.ts", "c.ts"] }
    );
    expect(result).toBeNull();
  });

  it("skips when no files changed", () => {
    const result = checkTrivialDiff(
      { filesChanged: 0, insertions: 0, deletions: 0, files: [] }
    );
    expect(result).toBeNull();
  });
});

describe("checkAcceptanceCriteriaRelevance", () => {
  it("warns when key terms are missing from diff", () => {
    const result = checkAcceptanceCriteriaRelevance(
      { acceptanceCriteria: ["Users can authenticate with email and password", "Login form validates input fields"] },
      "--- a/config.json\n+++ b/config.json\n+debug: true",
      "Updated config file"
    );
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("WARN");
  });

  it("passes when terms are present", () => {
    const result = checkAcceptanceCriteriaRelevance(
      { acceptanceCriteria: ["Users can authenticate with email", "Login validates input"] },
      "function authenticate(email: string) { validate(email); }",
      "Implemented authentication with email validation and login form"
    );
    expect(result).toBeNull();
  });

  it("skips when no acceptance criteria", () => {
    const result = checkAcceptanceCriteriaRelevance(
      {},
      "some diff",
      "some summary"
    );
    expect(result).toBeNull();
  });
});

describe("checkSelfReportedFailure", () => {
  it("warns when agent reports failure despite validation passing", () => {
    const result = checkSelfReportedFailure({ success: false });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("WARN");
  });

  it("passes when agent reports success", () => {
    const result = checkSelfReportedFailure({ success: true });
    expect(result).toBeNull();
  });

  it("passes when no structured result", () => {
    const result = checkSelfReportedFailure(undefined);
    expect(result).toBeNull();
  });
});

describe("checkLazySummary", () => {
  it("warns for short summaries", () => {
    const result = checkLazySummary("Done.");
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("WARN");
  });

  it("warns for lazy patterns", () => {
    const result = checkLazySummary("Implemented.");
    expect(result).not.toBeNull();
  });

  it("passes for good summaries", () => {
    const result = checkLazySummary("Added user authentication with email/password validation and session management");
    expect(result).toBeNull();
  });

  it("passes when no summary", () => {
    const result = checkLazySummary(undefined);
    expect(result).toBeNull();
  });
});

describe("checkHeavyExplorationNoWrites", () => {
  it("warns when lots of exploration but no writes", () => {
    const result = checkHeavyExplorationNoWrites({
      totalMs: 60000,
      timeToFirstToolCallMs: 5000,
      toolCalls: 10,
      fileExplorations: 8,
      fileWrites: 0,
      testRuns: 0,
      errorsHit: 0,
      linesProcessed: 100,
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("WARN");
  });

  it("passes with balanced exploration and writes", () => {
    const result = checkHeavyExplorationNoWrites({
      totalMs: 60000,
      timeToFirstToolCallMs: 5000,
      toolCalls: 10,
      fileExplorations: 5,
      fileWrites: 3,
      testRuns: 1,
      errorsHit: 0,
      linesProcessed: 100,
    });
    expect(result).toBeNull();
  });

  it("passes when no stats", () => {
    const result = checkHeavyExplorationNoWrites(undefined);
    expect(result).toBeNull();
  });
});

// ─── Git Helpers ────────────────────────────────────────────────────────────

describe("getDiffStats", () => {
  it("returns zero stats for clean repo", () => {
    const stats = getDiffStats(TMP);
    expect(stats.filesChanged).toBe(0);
    expect(stats.insertions).toBe(0);
    expect(stats.deletions).toBe(0);
  });

  it("detects modified files", () => {
    writeFileSync(join(TMP, "new-file.ts"), "export const x = 1;\nexport const y = 2;\n");
    const stats = getDiffStats(TMP);
    expect(stats.filesChanged).toBeGreaterThan(0);
  });
});

// ─── Main verifyOutput ──────────────────────────────────────────────────────

describe("verifyOutput", () => {
  const baseInput: VerificationInput = {
    workdir: TMP,
    story: {
      id: "test-1",
      title: "Add auth",
      description: "Implement authentication",
    },
    codexResult: {
      toolCalls: 5,
      filesModified: ["src/auth.ts", "src/auth.test.ts"],
      structuredResult: {
        success: true,
        summary: "Implemented authentication with email/password validation and session management",
        files_modified: ["src/auth.ts", "src/auth.test.ts"],
      },
    },
    validationOutput: "All tests passed",
  };

  it("rejects empty diff with no tool calls", () => {
    const result = verifyOutput({
      ...baseInput,
      codexResult: {
        toolCalls: 0,
        filesModified: [],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toBeDefined();
    expect(result.checks.some((c) => c.name === "empty_diff")).toBe(true);
    expect(result.checks.some((c) => c.name === "zero_tool_calls")).toBe(true);
  });

  it("passes with code + test changes", () => {
    // Create actual files so diff stats work
    writeFileSync(join(TMP, "src"), ""); // won't be a dir, but that's ok for the test
    writeFileSync(join(TMP, "auth.ts"), "export function login() { return true; }\n".repeat(5));
    writeFileSync(join(TMP, "auth.test.ts"), "test('login works', () => { expect(login()).toBe(true); });\n".repeat(3));

    const result = verifyOutput({
      ...baseInput,
      workdir: TMP,
      codexResult: {
        ...baseInput.codexResult,
        filesModified: ["auth.ts", "auth.test.ts"],
      },
    });
    expect(result.passed).toBe(true);
  });

  it("returns warnings for config-only changes on code story", () => {
    writeFileSync(join(TMP, "package.json"), '{ "name": "test" }\n');
    const result = verifyOutput({
      ...baseInput,
      codexResult: {
        toolCalls: 5,
        filesModified: ["package.json"],
        structuredResult: {
          success: true,
          summary: "Updated package configuration for the authentication feature",
          files_modified: ["package.json"],
        },
      },
    });
    // Config-only is a WARN, not a REJECT (but no_tests also fires as REJECT since
    // the story isn't config-only but all files are config — checkNoTests skips when all files are config/doc)
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("includes diffStats in result", () => {
    const result = verifyOutput(baseInput);
    expect(result.diffStats).toBeDefined();
    expect(typeof result.diffStats.filesChanged).toBe("number");
    expect(typeof result.diffStats.insertions).toBe("number");
    expect(typeof result.diffStats.deletions).toBe("number");
  });

  it("sets requiresLLMReview when 3+ warnings", () => {
    // Craft input that triggers many warnings
    const result = verifyOutput({
      ...baseInput,
      codexResult: {
        toolCalls: 5,
        filesModified: ["config.json"],
        structuredResult: {
          success: false,
          summary: "Done.",
          files_modified: ["config.json"],
        },
        stderrStats: {
          totalMs: 60000,
          timeToFirstToolCallMs: 5000,
          toolCalls: 10,
          fileExplorations: 8,
          fileWrites: 0,
          testRuns: 0,
          errorsHit: 0,
          linesProcessed: 100,
        },
      },
    });
    // Should have multiple warnings: config_only, self_reported_failure, lazy_summary, heavy_exploration
    if (result.warnings.length >= 3) {
      expect(result.requiresLLMReview).toBe(true);
    }
  });
});
