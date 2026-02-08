import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Default maximum retry attempts before skipping a story
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Per-story retry tracking and early termination
 */
export class StoryRetryTracker {
  private attempts: Map<string, { attempts: number; failures: number }>;
  private maxRetries: number;

  constructor(maxRetries: number = DEFAULT_MAX_RETRIES) {
    this.attempts = new Map();
    this.maxRetries = maxRetries;
  }

  /**
   * Record a story attempt outcome
   */
  recordAttempt(storyId: string, success: boolean): void {
    const current = this.attempts.get(storyId) || { attempts: 0, failures: 0 };
    current.attempts += 1;
    if (!success) {
      current.failures += 1;
    }
    this.attempts.set(storyId, current);
  }

  /**
   * Check if story should be skipped due to excessive failures
   */
  shouldSkip(storyId: string): boolean {
    const stats = this.attempts.get(storyId);
    if (!stats) return false;
    return stats.failures >= this.maxRetries;
  }

  /**
   * Get current failure count for a story
   */
  getFailCount(storyId: string): number {
    const stats = this.attempts.get(storyId);
    return stats?.failures || 0;
  }

  /**
   * Get all stories that would be skipped
   */
  getSkippedStories(): Array<{ storyId: string; failCount: number }> {
    const skipped: Array<{ storyId: string; failCount: number }> = [];
    for (const [storyId, stats] of this.attempts.entries()) {
      if (stats.failures >= this.maxRetries) {
        skipped.push({ storyId, failCount: stats.failures });
      }
    }
    return skipped;
  }

  /**
   * Reset retry tracking for one or all stories
   */
  reset(storyId?: string): void {
    if (storyId) {
      this.attempts.delete(storyId);
    } else {
      this.attempts.clear();
    }
  }
}

/**
 * Stateless check: should this story be skipped based on iteration log?
 * Reads .ralph-iterations.jsonl and counts consecutive failures.
 */
export function shouldSkipStory(
  storyId: string,
  workdir: string,
  maxRetries: number
): boolean {
  const logPath = join(workdir, ".ralph-iterations.jsonl");

  if (!existsSync(logPath)) {
    return false;
  }

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");

    let failCount = 0;
    for (const line of lines) {
      if (!line.trim()) continue;

      const entry = JSON.parse(line);
      if (entry.storyId === storyId && entry.success === false) {
        failCount += 1;
      }
    }

    return failCount >= maxRetries;
  } catch (err) {
    // On read/parse error, don't skip
    return false;
  }
}

/**
 * Format a human-readable summary of skipped stories
 */
export function formatSkippedSummary(
  skipped: Array<{ storyId: string; failCount: number }>
): string {
  if (skipped.length === 0) {
    return "";
  }

  const items = skipped
    .map((s) => `${s.storyId} (${s.failCount} failures)`)
    .join(", ");

  return `Skipped ${skipped.length} ${
    skipped.length === 1 ? "story" : "stories"
  } after max retries: ${items}. These need human review.`;
}
