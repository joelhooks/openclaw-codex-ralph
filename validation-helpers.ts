import { execSync } from "node:child_process";

export const VALIDATION_OUTPUT_LIMIT = 8000;

/**
 * Strips turborepo boilerplate and noise from validation output.
 * Preserves actual error messages containing keywords like "error", "Error", "TS", "FAIL", etc.
 */
export function stripTurboBoilerplate(output: string): string {
  const lines = output.split("\n");
  const filtered: string[] = [];

  for (const line of lines) {
    // Skip turbo metadata lines
    if (
      line.includes("Packages in scope:") ||
      line.includes("Running") ||
      line.includes("Remote caching") ||
      line.includes("cache hit, replaying logs") ||
      line.includes("cache miss, executing") ||
      line.match(/^Tasks:/) ||
      line.match(/^Duration:/) ||
      line.match(/^Cached:/)
    ) {
      continue;
    }

    // Skip package-prefixed lines that are just build noise (tsup/tsc cache output)
    // BUT keep lines that contain actual error indicators
    if (line.match(/^[@\w-]+:[\w-]+:\s*$/)) {
      continue; // Empty prefixed line
    }

    const hasErrorIndicator =
      line.includes("error") ||
      line.includes("Error") ||
      line.includes("TS") ||
      line.includes("FAIL") ||
      line.includes("failed") ||
      line.includes("Cannot find") ||
      line.includes("not assignable") ||
      line.includes("Property") ||
      line.includes("Argument");

    // If it's a package-prefixed line without error indicators, skip it
    if (line.match(/^[@\w-]+:[\w-]+:/) && !hasErrorIndicator) {
      continue;
    }

    filtered.push(line);
  }

  // Collapse multiple blank lines to single newline
  let result = filtered.join("\n");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Enhanced validation runner that captures stdout and stderr separately,
 * strips turbo boilerplate, and returns combined output capped at VALIDATION_OUTPUT_LIMIT.
 */
export function captureValidation(
  resolvedWorkdir: string,
  command?: string
): { success: boolean; output: string; stderr: string } {
  if (!command) {
    command = "npm run typecheck 2>/dev/null || tsc --noEmit; npm test 2>/dev/null || true";
  }

  try {
    const stdout = execSync(command, {
      cwd: resolvedWorkdir,
      encoding: "utf-8",
      timeout: 300000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const strippedStdout = stripTurboBoilerplate(stdout);
    const output = strippedStdout.slice(0, VALIDATION_OUTPUT_LIMIT);

    return { success: true, output, stderr: "" };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const rawStdout = err.stdout || "";
    const rawStderr = err.stderr || "";

    const strippedStdout = stripTurboBoilerplate(rawStdout);
    const strippedStderr = stripTurboBoilerplate(rawStderr);

    // Combine: stderr first if present, then stdout
    let combined = "";
    if (strippedStderr) {
      combined += strippedStderr;
    }
    if (strippedStdout) {
      if (combined) combined += "\n\n";
      combined += strippedStdout;
    }
    if (!combined) {
      combined = err.message || "Validation failed";
    }

    const output = combined.slice(0, VALIDATION_OUTPUT_LIMIT);

    return { success: false, output, stderr: strippedStderr };
  }
}
