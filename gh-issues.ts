/**
 * gh-issues.ts — GitHub Issues integration for Ralph loops
 *
 * All GitHub operations isolated here. Every function is best-effort —
 * failures log warnings but never break the loop.
 */

import { execSync } from "child_process";

// Re-use the Story/PRD shapes without importing (to avoid circular deps)
interface Story {
  id: string;
  title: string;
  description: string;
  priority: number;
  passes: boolean;
  validationCommand?: string;
  acceptanceCriteria?: string[];
  issueNumber?: number;
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
    trackingIssue?: number;
  };
}

function ghExec(cmd: string, workdir: string): string | null {
  try {
    return execSync(cmd, {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    console.error(`[gh-issues] Command failed: ${cmd}\n  ${(err as Error).message?.slice(0, 200)}`);
    return null;
  }
}

/** Detect repo from workdir (gh CLI infers from git remote) */
export function detectGhRepo(workdir: string): string | null {
  return ghExec("gh repo view --json nameWithOwner -q .nameWithOwner", workdir);
}

/** Create a GH issue for a story, return issue number */
export function createStoryIssue(workdir: string, story: Story, prd: PRD): number | null {
  const criteriaLines = (story.acceptanceCriteria || [])
    .map((c) => `- [ ] ${c}`)
    .join("\n");

  const validation = story.validationCommand
    ? `### Validation\n\`${story.validationCommand}\``
    : "";

  const body = [
    `## Story: ${story.title}`,
    `Priority: ${story.priority}`,
    "",
    story.description,
    "",
    criteriaLines ? `### Acceptance Criteria\n${criteriaLines}` : "",
    "",
    validation,
    "",
    "---",
    "_Managed by Ralph loop. Do not close manually._",
  ]
    .filter(Boolean)
    .join("\n");

  // Escape for shell — use a temp approach via stdin
  const result = ghExec(
    `gh issue create --title ${shellEscape(`[Ralph] ${story.title}`)} --body ${shellEscape(body)} --label ralph --label automated 2>&1`,
    workdir
  );

  if (!result) return null;

  // gh issue create prints the URL, extract issue number from it
  const match = result.match(/\/issues\/(\d+)/);
  return match ? parseInt(match[1]!, 10) : null;
}

/** Comment on an issue */
export function commentOnIssue(workdir: string, issueNumber: number, body: string): boolean {
  const result = ghExec(
    `gh issue comment ${issueNumber} --body ${shellEscape(body)}`,
    workdir
  );
  return result !== null;
}

/** Close an issue with a comment */
export function closeIssue(workdir: string, issueNumber: number, comment: string): boolean {
  // Comment first, then close
  commentOnIssue(workdir, issueNumber, comment);
  const result = ghExec(`gh issue close ${issueNumber}`, workdir);
  return result !== null;
}

/** Add labels to an issue */
export function labelIssue(workdir: string, issueNumber: number, labels: string[]): boolean {
  if (labels.length === 0) return true;
  const labelArgs = labels.map((l) => `--add-label ${shellEscape(l)}`).join(" ");
  const result = ghExec(`gh issue edit ${issueNumber} ${labelArgs}`, workdir);
  return result !== null;
}

/** Read issue body + comments for worker context */
export function readIssueContext(workdir: string, issueNumber: number): string | null {
  const body = ghExec(
    `gh issue view ${issueNumber} --json body,comments -q '[.body, (.comments[]?.body // empty)] | join("\\n---\\n")'`,
    workdir
  );
  return body;
}

/** Create parent/tracking issue for entire PRD */
export function createTrackingIssue(workdir: string, prd: PRD): number | null {
  const storyLines = prd.stories
    .map((s) => {
      const check = s.passes ? "x" : " ";
      const ref = s.issueNumber ? ` #${s.issueNumber}` : "";
      const done = s.passes ? " ✅" : "";
      return `- [${check}] ${s.title}${ref}${done}`;
    })
    .join("\n");

  const completed = prd.stories.filter((s) => s.passes).length;
  const total = prd.stories.length;

  const body = [
    "## Stories",
    storyLines || "_No stories yet_",
    "",
    "### Progress",
    `${completed}/${total} stories complete`,
    "",
    "---",
    "_Managed by Ralph loop. Updated automatically as stories complete._",
  ].join("\n");

  const result = ghExec(
    `gh issue create --title ${shellEscape(`[Ralph] ${prd.projectName}`)} --body ${shellEscape(body)} --label ralph --label tracking 2>&1`,
    workdir
  );

  if (!result) return null;

  const match = result.match(/\/issues\/(\d+)/);
  return match ? parseInt(match[1]!, 10) : null;
}

/** Update tracking issue checklist as stories complete */
export function updateTrackingChecklist(workdir: string, issueNumber: number, prd: PRD): boolean {
  const storyLines = prd.stories
    .map((s) => {
      const check = s.passes ? "x" : " ";
      const ref = s.issueNumber ? ` #${s.issueNumber}` : "";
      const done = s.passes ? " ✅" : "";
      return `- [${check}] ${s.title}${ref}${done}`;
    })
    .join("\n");

  const completed = prd.stories.filter((s) => s.passes).length;
  const total = prd.stories.length;

  const body = [
    "## Stories",
    storyLines || "_No stories yet_",
    "",
    "### Progress",
    `${completed}/${total} stories complete`,
    "",
    "---",
    "_Managed by Ralph loop. Updated automatically as stories complete._",
  ].join("\n");

  const result = ghExec(
    `gh issue edit ${issueNumber} --body ${shellEscape(body)}`,
    workdir
  );
  return result !== null;
}

/** Shell-escape a string for use in execSync commands */
function shellEscape(s: string): string {
  // Use single quotes, escaping any existing single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
