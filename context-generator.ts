/**
 * Codebase context generator for Ralph iterations.
 *
 * Pre-builds a CODEBASE_MAP.md that gets injected into the Codex prompt,
 * eliminating the 2-3 minutes Codex wastes doing rg/sed/cat to explore
 * the repo before writing code.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

const MAX_MAP_SIZE = 5000; // 5KB budget
const TREE_DEPTH = 3;

// ─── File Tree ───────────────────────────────────────────────────────────────

type TreeEntry = { name: string; isDir: boolean; children?: TreeEntry[] };

function buildTree(dir: string, depth: number, root: string): TreeEntry[] {
  if (depth <= 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const skip = new Set([
    "node_modules", ".git", "dist", "build", "coverage", ".next",
    ".turbo", ".cache", "__pycache__", ".ralph-iterations.jsonl",
  ]);

  return entries
    .filter((e) => !skip.has(e) && !e.startsWith(".ralph-last-message"))
    .sort((a, b) => {
      const aDir = isDir(join(dir, a));
      const bDir = isDir(join(dir, b));
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    })
    .map((name) => {
      const full = join(dir, name);
      const d = isDir(full);
      return {
        name,
        isDir: d,
        children: d ? buildTree(full, depth - 1, root) : undefined,
      };
    });
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function renderTree(entries: TreeEntry[], prefix = ""): string {
  const lines: string[] = [];
  entries.forEach((e, i) => {
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const suffix = e.isDir ? "/" : "";
    lines.push(`${prefix}${connector}${e.name}${suffix}`);
    if (e.children?.length) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      lines.push(renderTree(e.children, childPrefix));
    }
  });
  return lines.join("\n");
}

// ─── Type Extraction ─────────────────────────────────────────────────────────

interface ExtractedType {
  name: string;
  kind: "type" | "interface" | "enum" | "class";
  file: string;
  line: number;
}

function extractTypes(workdir: string): ExtractedType[] {
  const types: ExtractedType[] = [];
  const tsFiles = findTsFiles(workdir);

  const exportPattern = /^export\s+(type|interface|enum|class)\s+(\w+)/;

  for (const file of tsFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i]!.match(exportPattern);
      if (match && match[1] && match[2]) {
        types.push({
          kind: match[1] as ExtractedType["kind"],
          name: match[2],
          file: relative(workdir, file),
          line: i + 1,
        });
      }
    }
  }

  return types;
}

function findTsFiles(dir: string, depth = 3): string[] {
  if (depth <= 0) return [];
  const files: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...findTsFiles(full, depth - 1));
      } else if (
        (name.endsWith(".ts") || name.endsWith(".tsx")) &&
        !name.endsWith(".d.ts") &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".test.tsx")
      ) {
        files.push(full);
      }
    } catch {
      continue;
    }
  }
  return files;
}

// ─── Route Extraction ────────────────────────────────────────────────────────

interface RouteEntry {
  method: string;
  path: string;
  file: string;
  line: number;
}

function extractRoutes(workdir: string): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const routePattern = /\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)/i;
  const routerFiles = findTsFiles(workdir).filter((f) => {
    const name = basename(f).toLowerCase();
    return name.includes("route") || name.includes("router") || name.includes("server") || name.includes("app");
  });

  for (const file of routerFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i]!.match(routePattern);
      if (match && match[1] && match[2]) {
        routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: relative(workdir, file),
          line: i + 1,
        });
      }
    }
  }
  return routes;
}

// ─── Test Inventory ──────────────────────────────────────────────────────────

interface TestFileInfo {
  file: string;
  describes: string[];
  testCount: number;
}

function extractTestInventory(workdir: string): TestFileInfo[] {
  const inventory: TestFileInfo[] = [];
  const testFiles = findAllTestFiles(workdir);

  for (const file of testFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const describes: string[] = [];
    let testCount = 0;
    for (const line of content.split("\n")) {
      const descMatch = line.match(/describe\s*\(\s*["'`]([^"'`]+)/);
      if (descMatch && descMatch[1]) describes.push(descMatch[1]);
      if (/\b(it|test)\s*\(/.test(line)) testCount++;
    }
    inventory.push({ file: relative(workdir, file), describes, testCount });
  }
  return inventory;
}

function findAllTestFiles(dir: string, depth = 4): string[] {
  if (depth <= 0) return [];
  const files: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...findAllTestFiles(full, depth - 1));
      } else if (name.endsWith(".test.ts") || name.endsWith(".test.tsx") || name.endsWith(".spec.ts")) {
        files.push(full);
      }
    } catch {
      continue;
    }
  }
  return files;
}

// ─── Import Graph ────────────────────────────────────────────────────────────

interface ImportEdge {
  from: string;
  to: string;
}

function extractImportGraph(workdir: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const tsFiles = findTsFiles(workdir, 2); // shallow — only entry-level files
  const importPattern = /(?:import|from)\s+["'](\.[^"']+)["']/g;

  for (const file of tsFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const relFile = relative(workdir, file);
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(content)) !== null) {
      if (match[1]) edges.push({ from: relFile, to: match[1] });
    }
  }
  return edges;
}

// ─── Incremental Enrichment ──────────────────────────────────────────────────

/**
 * Parse Codex session JSONL for exec_command calls that explored the codebase.
 * Returns file paths that were read/examined.
 */
export function parseCodexExplorations(jsonlPath: string): string[] {
  if (!existsSync(jsonlPath)) return [];
  const explored: string[] = [];

  try {
    const content = readFileSync(jsonlPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === "item.completed" && event?.item?.type === "command_execution") {
          const cmd: string = event.item.command || "";
          // Extract file paths from common exploration commands
          const pathPattern = /(\S+\.(?:ts|tsx|js|jsx|json|md|yaml|yml))\b/g;
          let pathMatch: RegExpExecArray | null;
          while ((pathMatch = pathPattern.exec(cmd)) !== null) {
            const p = pathMatch[1];
            if (p && !explored.includes(p) && !p.startsWith("-")) {
              explored.push(p);
            }
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // JSONL doesn't exist or is unreadable
  }
  return explored;
}

// ─── Main Generator ──────────────────────────────────────────────────────────

export function generateCodebaseMap(workdir: string): string {
  const sections: string[] = [];

  // File tree
  const tree = buildTree(workdir, TREE_DEPTH, workdir);
  if (tree.length > 0) {
    sections.push("## File Structure\n```\n" + renderTree(tree) + "\n```");
  }

  // Exported types
  const types = extractTypes(workdir);
  if (types.length > 0) {
    const typeLines = types
      .slice(0, 40) // cap at 40 types
      .map((t) => `- \`${t.kind} ${t.name}\` → ${t.file}:${t.line}`);
    sections.push("## Key Types\n" + typeLines.join("\n"));
  }

  // Routes
  const routes = extractRoutes(workdir);
  if (routes.length > 0) {
    const routeLines = routes.map((r) => `- ${r.method} \`${r.path}\` → ${r.file}:${r.line}`);
    sections.push("## Routes\n" + routeLines.join("\n"));
  }

  // Test inventory
  const tests = extractTestInventory(workdir);
  if (tests.length > 0) {
    const testLines = tests.map(
      (t) => `- ${t.file} (${t.testCount} tests${t.describes.length ? ": " + t.describes.join(", ") : ""})`
    );
    sections.push("## Tests\n" + testLines.join("\n"));
  }

  // Import graph (top-level files only)
  const imports = extractImportGraph(workdir);
  if (imports.length > 0) {
    // Group by source file
    const grouped = new Map<string, string[]>();
    for (const edge of imports) {
      const existing = grouped.get(edge.from) || [];
      existing.push(edge.to);
      grouped.set(edge.from, existing);
    }
    const importLines: string[] = [];
    for (const [from, tos] of grouped) {
      importLines.push(`- ${from} → ${tos.join(", ")}`);
    }
    sections.push("## Import Graph\n" + importLines.slice(0, 20).join("\n"));
  }

  let result = "# Codebase Reference\n\n" + sections.join("\n\n");

  // Enforce size budget
  if (result.length > MAX_MAP_SIZE) {
    result = result.slice(0, MAX_MAP_SIZE - 4) + "\n...";
  }

  return result;
}

/**
 * Generate and write CODEBASE_MAP.md to the workdir.
 * Returns the markdown content.
 */
export function writeCodebaseMap(workdir: string): string {
  const map = generateCodebaseMap(workdir);
  writeFileSync(join(workdir, "CODEBASE_MAP.md"), map);
  return map;
}

/**
 * Enrich an existing map with discoveries from a Codex session.
 * Appends an "Explored Files" section with paths Codex accessed.
 */
export function enrichMapFromSession(workdir: string, sessionJsonlPath: string): string {
  const mapPath = join(workdir, "CODEBASE_MAP.md");
  let existing = "";
  try {
    existing = readFileSync(mapPath, "utf-8");
  } catch {
    existing = generateCodebaseMap(workdir);
  }

  const explored = parseCodexExplorations(sessionJsonlPath);
  if (explored.length === 0) return existing;

  // Don't duplicate if already present
  const alreadyHasExplored = existing.includes("## Explored Files");
  const exploredSection = "\n\n## Explored Files (from previous session)\n" +
    explored.map((f) => `- ${f}`).join("\n");

  let enriched: string;
  if (alreadyHasExplored) {
    // Replace existing explored section
    enriched = existing.replace(/\n\n## Explored Files[^#]*/s, exploredSection);
  } else {
    enriched = existing + exploredSection;
  }

  // Re-enforce size budget
  if (enriched.length > MAX_MAP_SIZE) {
    enriched = enriched.slice(0, MAX_MAP_SIZE - 4) + "\n...";
  }

  writeFileSync(mapPath, enriched);
  return enriched;
}
