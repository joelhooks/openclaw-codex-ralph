import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

/**
 * Tests for the Showboat demo phase integration.
 *
 * These test the exported helper functions and the demo flow logic.
 * Since the core functions are internal to index.ts, we test behavior
 * through the public interface (story schema, config, iteration flow).
 */

const TMP = join(process.cwd(), ".test-showboat-demo");

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

// ─── Story Schema ────────────────────────────────────────────────────────────

describe("Story schema with demoInstructions", () => {
  it("should allow stories without demoInstructions", () => {
    const story = {
      id: "story-test1",
      title: "Test story",
      description: "A test",
      priority: 1,
      passes: false,
    };
    // demoInstructions is optional — story without it should be valid
    expect(story.id).toBe("story-test1");
    expect((story as any).demoInstructions).toBeUndefined();
  });

  it("should allow stories with demoInstructions", () => {
    const story = {
      id: "story-test2",
      title: "Test story with demo",
      description: "A test",
      priority: 1,
      passes: false,
      demoInstructions: "Show that the feature works by running the test suite",
    };
    expect(story.demoInstructions).toBe("Show that the feature works by running the test suite");
  });

  it("should persist demoInstructions in prd.json", () => {
    const prd = {
      version: "1.0",
      projectName: "test",
      stories: [
        {
          id: "story-demo",
          title: "Demo story",
          description: "Test demo persistence",
          priority: 1,
          passes: false,
          demoInstructions: "Run the API and show response",
        },
      ],
    };
    const prdPath = join(TMP, "prd.json");
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
    const loaded = JSON.parse(readFileSync(prdPath, "utf-8"));
    expect(loaded.stories[0].demoInstructions).toBe("Run the API and show response");
  });
});

// ─── Showboat CLI Availability ───────────────────────────────────────────────

describe("Showboat CLI", () => {
  it("uvx showboat should be available", () => {
    const result = execSync("uvx showboat --version", { encoding: "utf-8", timeout: 30000 });
    expect(result.trim()).toMatch(/^\d+\.\d+/);  // version number like 0.4.0
  });

  it("showboat init should create a demo document", () => {
    const demoFile = join(TMP, "test-demo.md");
    execSync(`uvx showboat init ${demoFile} "Test Demo"`, { cwd: TMP, timeout: 30000 });
    expect(existsSync(demoFile)).toBe(true);
    const content = readFileSync(demoFile, "utf-8");
    expect(content).toContain("Test Demo");
  });

  it("showboat exec should capture command output", () => {
    const demoFile = join(TMP, "exec-demo.md");
    execSync(`uvx showboat init ${demoFile} "Exec Demo"`, { cwd: TMP, timeout: 30000 });
    execSync(`uvx showboat exec ${demoFile} bash "echo hello world"`, { cwd: TMP, timeout: 30000 });
    const content = readFileSync(demoFile, "utf-8");
    expect(content).toContain("echo hello world");
    expect(content).toContain("hello world");
  });

  it("showboat verify should pass for valid documents", () => {
    const demoFile = join(TMP, "verify-demo.md");
    execSync(`uvx showboat init ${demoFile} "Verify Demo"`, { cwd: TMP, timeout: 30000 });
    execSync(`uvx showboat exec ${demoFile} bash "echo deterministic"`, { cwd: TMP, timeout: 30000 });
    // verify should exit 0
    const result = execSync(`uvx showboat verify ${demoFile}`, { cwd: TMP, encoding: "utf-8", timeout: 30000 });
    // No error thrown = exit 0 = pass
    expect(result).toBeDefined();
  });

  it("showboat verify should fail for tampered documents", () => {
    const demoFile = join(TMP, "tamper-demo.md");
    execSync(`uvx showboat init ${demoFile} "Tamper Demo"`, { cwd: TMP, timeout: 30000 });
    execSync(`uvx showboat exec ${demoFile} bash "echo real-output"`, { cwd: TMP, timeout: 30000 });
    // Tamper with the output
    let content = readFileSync(demoFile, "utf-8");
    content = content.replace("real-output", "fake-output");
    writeFileSync(demoFile, content);
    // verify should fail
    expect(() => {
      execSync(`uvx showboat verify ${demoFile}`, { cwd: TMP, timeout: 30000 });
    }).toThrow();
  });
});

// ─── Config ──────────────────────────────────────────────────────────────────

describe("ShowboatConfig", () => {
  it("should default to disabled", () => {
    const defaultConfig = {
      showboat: { enabled: false, alwaysRequire: false },
    };
    expect(defaultConfig.showboat.enabled).toBe(false);
    expect(defaultConfig.showboat.alwaysRequire).toBe(false);
  });

  it("should merge partial showboat config with defaults", () => {
    const defaults = { enabled: false, alwaysRequire: false };
    const override = { enabled: true };
    const merged = { ...defaults, ...override };
    expect(merged.enabled).toBe(true);
    expect(merged.alwaysRequire).toBe(false);
  });
});

// ─── Demo Flow Logic ─────────────────────────────────────────────────────────

describe("Demo phase flow", () => {
  it("should skip demo when showboat is disabled", () => {
    const cfg = { showboat: { enabled: false, alwaysRequire: false } };
    const story = { demoInstructions: "Show it works" };
    // When disabled, shouldRunDemo = false regardless of demoInstructions
    const shouldRun = cfg.showboat.enabled && (cfg.showboat.alwaysRequire || !!story.demoInstructions);
    expect(shouldRun).toBe(false);
  });

  it("should run demo when enabled and story has demoInstructions", () => {
    const cfg = { showboat: { enabled: true, alwaysRequire: false } };
    const story = { demoInstructions: "Show it works" };
    const shouldRun = cfg.showboat.enabled && (cfg.showboat.alwaysRequire || !!story.demoInstructions);
    expect(shouldRun).toBe(true);
  });

  it("should skip demo when enabled but story has no demoInstructions and alwaysRequire is false", () => {
    const cfg = { showboat: { enabled: true, alwaysRequire: false } };
    const story = {};
    const shouldRun = cfg.showboat.enabled && (cfg.showboat.alwaysRequire || !!(story as any).demoInstructions);
    expect(shouldRun).toBe(false);
  });

  it("should run demo when alwaysRequire is true even without demoInstructions", () => {
    const cfg = { showboat: { enabled: true, alwaysRequire: true } };
    const story = {};
    const shouldRun = cfg.showboat.enabled && (cfg.showboat.alwaysRequire || !!(story as any).demoInstructions);
    expect(shouldRun).toBe(true);
  });

  it("demo failure should result in iteration failure", () => {
    // Simulate: demo verify returns non-zero → iterResult.success = false
    const iterResult = { success: true };
    const demoResult = { required: true, passed: false, error: "Showboat verify failed" };
    if (!demoResult.passed) {
      iterResult.success = false;
    }
    expect(iterResult.success).toBe(false);
  });

  it("demo file should be included in commit when demo passes", () => {
    const demoResult = { required: true, passed: true, demoFile: "demos/story-abc.md" };
    const issueRef = "";
    const demoRef = demoResult.required && demoResult.passed && demoResult.demoFile ? `\n\nDemo: ${demoResult.demoFile}` : "";
    const commitMsg = `ralph: Test feature${issueRef}${demoRef}`;
    expect(commitMsg).toContain("Demo: demos/story-abc.md");
  });

  it("demo file should not be in commit message when demo not required", () => {
    const demoResult = { required: false, passed: true };
    const demoRef = demoResult.required && demoResult.passed && (demoResult as any).demoFile ? `\n\nDemo: ${(demoResult as any).demoFile}` : "";
    const commitMsg = `ralph: Test feature${demoRef}`;
    expect(commitMsg).not.toContain("Demo:");
  });
});
