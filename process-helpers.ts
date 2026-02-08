import { ChildProcess, execSync } from "child_process";

/**
 * Registry for tracking child processes and ensuring cleanup on exit.
 * Prevents orphaned processes when parent receives SIGTERM/SIGINT.
 */
export class ChildProcessRegistry {
  private children = new Map<ChildProcess, string>();

  constructor() {
    process.on("SIGTERM", () => this.killAll());
    process.on("SIGINT", () => this.killAll());
  }

  register(child: ChildProcess, label: string): void {
    this.children.set(child, label);
    // Auto-unregister when child exits
    child.once("exit", () => this.unregister(child));
  }

  unregister(child: ChildProcess): void {
    this.children.delete(child);
  }

  killAll(): void {
    if (this.children.size === 0) return;

    // Send SIGTERM to all children
    for (const [child, label] of this.children.entries()) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }

    // After 5s, send SIGKILL to any survivors
    setTimeout(() => {
      for (const [child, label] of this.children.entries()) {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }
    }, 5000);
  }

  count(): number {
    return this.children.size;
  }
}

export const processRegistry = new ChildProcessRegistry();

/**
 * Monitor stdout for item.completed events and detect stalls.
 * Calls onStall if no item.completed appears within stallTimeoutMs.
 */
export function monitorProgress(
  stdout: NodeJS.ReadableStream,
  options: { stallTimeoutMs?: number; onStall: () => void }
): { cancel: () => void } {
  const stallTimeoutMs = options.stallTimeoutMs ?? 120000;
  let stallTimer: NodeJS.Timeout | undefined;
  let buffer = "";

  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => options.onStall(), stallTimeoutMs);
  };

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "item.completed") {
          resetStallTimer();
        }
      } catch {
        // Not JSON or malformed - ignore
      }
    }
  };

  stdout.on("data", onData);
  resetStallTimer(); // Start initial timer

  return {
    cancel: () => {
      if (stallTimer) clearTimeout(stallTimer);
      stdout.removeListener("data", onData);
    },
  };
}

/**
 * Get all files modified in the working directory using git diff.
 * Returns committed, staged, and unstaged changes.
 */
export function getActualFilesModified(workdir: string): string[] {
  const files = new Set<string>();

  const runDiff = (args: string[]) => {
    try {
      const output = execSync(`git diff --name-only ${args.join(" ")}`, {
        cwd: workdir,
        encoding: "utf-8",
        timeout: 10000,
      });
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((file) => files.add(file));
    } catch {
      // No git repo, no commits, or error - ignore
    }
  };

  // Committed changes (HEAD~1 -> HEAD)
  runDiff(["HEAD~1", "HEAD"]);
  // Unstaged changes
  runDiff([]);
  // Staged changes
  runDiff(["--cached"]);

  return Array.from(files);
}
