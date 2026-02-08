/**
 * Prompt optimization utilities for openclaw-codex-ralph.
 *
 * Compresses AGENTS.md content and deduplicates failure context
 * to prevent prompt bloat across retries.
 */

const BOX_DRAWING_CHARS = /[─│┌┐└┘├┤┬┴┼━┃┏┓┗┛═║╔╗╚╝]/;
const SIMPLE_BOX_CHARS = /^[\s+|\-]+$/;
const TREE_DIAGRAM_CHARS = /[→├└]/;

const KEEP_HEADERS = /Rules|Constraints|Requirements|Guidelines|Critical|Important|Must|Never|Always/i;
const KEEP_IMPERATIVES = /\b(MUST|DO NOT|NEVER|ALWAYS|REQUIRED|CRITICAL|IMPORTANT)\b/;

/**
 * Compresses AGENTS.md content to essential rules and constraints.
 *
 * Removes:
 * - ASCII art and box-drawing
 * - Markdown tables
 * - Workflow diagrams
 * - Decorative lines
 *
 * Keeps:
 * - Sections with important headers
 * - Lines with imperatives (MUST, NEVER, etc.)
 *
 * @param agentsMd Raw AGENTS.md content
 * @returns Compressed content (≤2500 chars)
 */
export function compressAgentsMd(agentsMd: string): string {
  if (!agentsMd || !agentsMd.trim()) {
    return "";
  }

  const lines = agentsMd.split("\n");
  const filtered: string[] = [];
  let inImportantSection = false;
  let lastLineWasBlank = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();

    // Skip empty lines but track them for collapsing
    if (!trimmed) {
      if (!lastLineWasBlank) {
        filtered.push("");
        lastLineWasBlank = true;
      }
      continue;
    }

    lastLineWasBlank = false;

    // Detect important section headers
    if (trimmed.startsWith("#") && KEEP_HEADERS.test(trimmed)) {
      inImportantSection = true;
      filtered.push(line);
      continue;
    }

    // Reset section tracking on new headers
    if (trimmed.startsWith("#")) {
      inImportantSection = false;
    }

    // Skip ASCII art (lines >50% box-drawing chars)
    const boxCharCount = (line.match(BOX_DRAWING_CHARS) || []).length;
    if (boxCharCount > line.length * 0.5) {
      continue;
    }

    // Skip simple box chars (+-|)
    if (SIMPLE_BOX_CHARS.test(trimmed)) {
      continue;
    }

    // Skip tree diagrams
    if (TREE_DIAGRAM_CHARS.test(trimmed) && /^\s+/.test(line)) {
      continue;
    }

    // Skip markdown table delimiters
    if (/^\|[\s\-|]+\|$/.test(trimmed)) {
      continue;
    }

    // Skip purely decorative lines (only special chars)
    if (/^[^a-zA-Z0-9]+$/.test(trimmed)) {
      continue;
    }

    // Keep lines with imperatives
    if (KEEP_IMPERATIVES.test(line)) {
      filtered.push(line);
      continue;
    }

    // Keep lines in important sections
    if (inImportantSection) {
      filtered.push(line);
      continue;
    }

    // Skip markdown table rows (but keep if they contain imperatives)
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      continue;
    }
  }

  let result = filtered.join("\n");

  // Truncate if still too long
  if (result.length > 2500) {
    result = result.slice(0, 2500) + "\n[AGENTS.md truncated — see file for full context]";
  }

  return result;
}

/**
 * Deduplicates error signatures between previous attempt and failure patterns.
 *
 * If the same error appears in both sections, removes it from failurePatterns
 * to avoid redundant context.
 *
 * @param previousAttempt Previous attempt context
 * @param failurePatterns Failure pattern context
 * @returns Deduplicated versions of both inputs
 */
export function deduplicateFailureContext(
  previousAttempt: string,
  failurePatterns: string
): { previousAttempt: string; failurePatterns: string } {
  if (!previousAttempt || !failurePatterns) {
    return { previousAttempt, failurePatterns };
  }

  // Extract error signatures (first 80 chars of lines containing error keywords)
  const errorPattern = /error|Error|FAIL|failed|TypeError|Cannot/i;

  const extractSignatures = (text: string): Set<string> => {
    const signatures = new Set<string>();
    const lines = text.split("\n");

    for (const line of lines) {
      if (errorPattern.test(line)) {
        const signature = line.trim().slice(0, 80);
        if (signature) {
          signatures.add(signature);
        }
      }
    }

    return signatures;
  };

  const previousSigs = extractSignatures(previousAttempt);

  // Filter out duplicate error lines from failurePatterns
  const failureLines = failurePatterns.split("\n");
  const deduplicatedLines: string[] = [];

  for (const line of failureLines) {
    if (errorPattern.test(line)) {
      const signature = line.trim().slice(0, 80);
      if (!previousSigs.has(signature)) {
        deduplicatedLines.push(line);
      }
    } else {
      deduplicatedLines.push(line);
    }
  }

  return {
    previousAttempt,
    failurePatterns: deduplicatedLines.join("\n")
  };
}

/**
 * Estimates total prompt size and provides per-section breakdown.
 *
 * @param parts Named sections of the prompt
 * @returns Total char count and per-section breakdown
 */
export function estimatePromptSize(parts: Record<string, string>): {
  total: number;
  breakdown: Record<string, number>;
} {
  const breakdown: Record<string, number> = {};
  let total = 0;

  for (const [key, value] of Object.entries(parts)) {
    const size = (value || "").length;
    breakdown[key] = size;
    total += size;
  }

  return { total, breakdown };
}
