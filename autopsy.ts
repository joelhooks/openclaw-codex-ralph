/**
 * Repo Autopsy Tools
 *
 * Clone repos locally and analyze with local tools: rg, ast-grep, fd, tokei, gitleaks
 * Ported from: https://github.com/joelhooks/opencode-config/blob/main/tool/repo-autopsy.ts
 */
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const AUTOPSY_DIR = join(homedir(), ".openclaw-autopsy");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const lastFetchTime: Map<string, number> = new Map();

function parseRepoUrl(input: string): { owner: string; repo: string; url: string } | null {
  let owner: string, repo: string;

  if (input.includes("git@")) {
    const match = input.match(/git@github\.com:([^\/]+)\/(.+?)(?:\.git)?$/);
    if (!match || !match[1] || !match[2]) return null;
    owner = match[1];
    repo = match[2];
  } else {
    const match = input.match(/(?:(?:https?:\/\/)?github\.com\/)?([^\/]+)\/([^\/\s]+)/i);
    if (!match || !match[1] || !match[2]) return null;
    owner = match[1];
    repo = match[2].replace(/\.git$/, "");
  }

  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

function shellExec(cmd: string, timeout = 60000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return err.stdout?.trim() || err.message || "Command failed";
  }
}

export function ensureRepo(
  repoInput: string,
  forceRefresh = false
): { path: string; owner: string; repo: string; cached: boolean } | { error: string } {
  const parsed = parseRepoUrl(repoInput);
  if (!parsed) return { error: "Invalid repo format. Use: owner/repo or GitHub URL" };

  const { owner, repo, url } = parsed;
  const repoPath = join(AUTOPSY_DIR, owner, repo);
  const cacheKey = `${owner}/${repo}`;

  // Ensure directory exists
  shellExec(`mkdir -p ${AUTOPSY_DIR}/${owner}`);

  if (existsSync(repoPath)) {
    const lastFetch = lastFetchTime.get(cacheKey) || 0;
    if (!forceRefresh && Date.now() - lastFetch < CACHE_TTL_MS) {
      return { path: repoPath, owner, repo, cached: true };
    }

    // Update existing
    try {
      shellExec(`git -C "${repoPath}" fetch --all --prune`, 30000);
      shellExec(`git -C "${repoPath}" reset --hard origin/HEAD`, 10000);
      lastFetchTime.set(cacheKey, Date.now());
    } catch {
      shellExec(`rm -rf "${repoPath}"`);
      shellExec(`git clone --depth 100 "${url}" "${repoPath}"`, 120000);
      lastFetchTime.set(cacheKey, Date.now());
    }
  } else {
    shellExec(`git clone --depth 100 "${url}" "${repoPath}"`, 120000);
    lastFetchTime.set(cacheKey, Date.now());
  }

  return { path: repoPath, owner, repo, cached: false };
}

export function truncateOutput(output: string, maxLen = 8000): string {
  if (output.length <= maxLen) return output;
  return output.slice(0, maxLen) + "\n\n... (truncated)";
}

// Tool implementations
export const autopsyTools = {
  clone: (repo: string, refresh = false) => {
    const result = ensureRepo(repo, refresh);
    if ("error" in result) return result.error;

    const cacheStatus = result.cached ? "📦 (cached)" : "🔄 (fetched)";
    const fileCount = shellExec(`find "${result.path}" -type f -not -path '*/.git/*' | wc -l`);
    const languages = shellExec(`find "${result.path}" -type f -not -path '*/.git/*' | sed 's/.*\\.//' | sort | uniq -c | sort -rn | head -10`);

    return `✓ Repo ready at: ${result.path} ${cacheStatus}

Files: ${fileCount}

Top extensions:
${languages}

Available tools: autopsy_structure, autopsy_search, autopsy_ast, autopsy_deps, autopsy_hotspots, autopsy_stats, autopsy_file, autopsy_find`;
  },

  structure: (repo: string, path = "", depth = 4) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const targetPath = path ? join(result.path, path) : result.path;
    return shellExec(`tree -L ${depth} --dirsfirst -I '.git|node_modules|__pycache__|.venv|dist|build|.next' "${targetPath}" 2>/dev/null || find "${targetPath}" -maxdepth ${depth} -not -path '*/.git/*' -not -path '*/node_modules/*' | head -200`);
  },

  search: (repo: string, pattern: string, fileGlob?: string, context = 2, maxResults = 50) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const globArg = fileGlob ? `--glob '${fileGlob}'` : "";
    const output = shellExec(`rg '${pattern.replace(/'/g, "\\'")}' "${result.path}" -C ${context} ${globArg} --max-count ${maxResults} -n --color never 2>/dev/null | head -500`);
    return truncateOutput(output || "No matches found");
  },

  ast: (repo: string, pattern: string, lang?: string) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const langArg = lang ? `--lang ${lang}` : "";
    return shellExec(`ast-grep --pattern '${pattern.replace(/'/g, "\\'")}' ${langArg} "${result.path}" 2>/dev/null | head -200`) || "No matches (or ast-grep not installed)";
  },

  deps: (repo: string) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const outputs: string[] = [];

    // Node.js
    const pkgPath = join(result.path, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const deps = Object.keys(pkg.dependencies || {}).slice(0, 20);
        const devDeps = Object.keys(pkg.devDependencies || {}).slice(0, 15);
        outputs.push(`## Node.js\nDeps: ${deps.join(", ")}\nDevDeps: ${devDeps.join(", ")}`);
      } catch { /* ignore */ }
    }

    // Python
    const reqPath = join(result.path, "requirements.txt");
    if (existsSync(reqPath)) {
      const reqs = readFileSync(reqPath, "utf-8").split("\n").filter(l => l.trim() && !l.startsWith("#")).slice(0, 20);
      outputs.push(`## Python\n${reqs.join("\n")}`);
    }

    // Go
    const goPath = join(result.path, "go.mod");
    if (existsSync(goPath)) {
      outputs.push(`## Go\n${readFileSync(goPath, "utf-8").slice(0, 1500)}`);
    }

    // Rust
    const cargoPath = join(result.path, "Cargo.toml");
    if (existsSync(cargoPath)) {
      outputs.push(`## Rust\n${readFileSync(cargoPath, "utf-8").slice(0, 1500)}`);
    }

    return outputs.length ? outputs.join("\n\n") : "No dependency files found";
  },

  hotspots: (repo: string) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const outputs: string[] = [];

    const churn = shellExec(`git -C "${result.path}" log --oneline --name-only --pretty=format: | sort | uniq -c | sort -rn | grep -v '^$' | head -15`);
    if (churn) outputs.push(`## Most Changed Files\n${churn}`);

    const largest = shellExec(`fd -t f -E .git -E node_modules . "${result.path}" --exec wc -l {} 2>/dev/null | sort -rn | head -15`);
    if (largest) outputs.push(`## Largest Files\n${largest}`);

    const todos = shellExec(`rg -c 'TODO|FIXME|HACK|XXX' "${result.path}" --glob '!.git' 2>/dev/null | sort -t: -k2 -rn | head -10`);
    if (todos) outputs.push(`## Most TODOs\n${todos}`);

    const recent = shellExec(`git -C "${result.path}" log --oneline -20`);
    if (recent) outputs.push(`## Recent Commits\n${recent}`);

    return truncateOutput(outputs.join("\n\n"));
  },

  stats: (repo: string) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    return shellExec(`tokei "${result.path}" --exclude .git --exclude node_modules 2>/dev/null`) || "tokei not installed";
  },

  secrets: (repo: string) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const output = shellExec(`gitleaks detect --source "${result.path}" --no-banner -v 2>&1`);
    if (output.includes("no leaks found")) return "✓ No secrets detected";
    return truncateOutput(output);
  },

  find: (repo: string, pattern: string, type?: string, ext?: string) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const typeArg = type ? `-t ${type}` : "";
    const extArg = ext ? `-e ${ext}` : "";
    return shellExec(`fd '${pattern}' "${result.path}" ${typeArg} ${extArg} -E .git -E node_modules 2>/dev/null | head -50`) || "No matches";
  },

  file: (repo: string, path: string, startLine?: number, endLine?: number) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const filePath = join(result.path, path);
    if (!existsSync(filePath)) return `File not found: ${path}`;

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      if (startLine || endLine) {
        const start = (startLine || 1) - 1;
        const end = endLine || lines.length;
        return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
      }

      if (lines.length > 500) {
        return lines.slice(0, 500).map((l, i) => `${i + 1}: ${l}`).join("\n") + `\n\n... (${lines.length - 500} more lines)`;
      }

      return lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
    } catch (e) {
      return `Failed to read: ${e}`;
    }
  },

  blame: (repo: string, path: string, startLine?: number, endLine?: number) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const lineRange = startLine && endLine ? `-L ${startLine},${endLine}` : "";
    return shellExec(`git -C "${result.path}" blame ${lineRange} --date=short "${path}" 2>/dev/null | head -100`) || "No blame info";
  },

  cleanup: (repo: string) => {
    if (repo === "all") {
      shellExec(`rm -rf "${AUTOPSY_DIR}"`);
      return `Cleared all repos from ${AUTOPSY_DIR}`;
    }

    const parsed = parseRepoUrl(repo);
    if (!parsed) return "Invalid repo format";

    const repoPath = join(AUTOPSY_DIR, parsed.owner, parsed.repo);
    if (existsSync(repoPath)) {
      shellExec(`rm -rf "${repoPath}"`);
      return `Removed: ${repoPath}`;
    }
    return "Repo not in cache";
  },

  exports: (repo: string) => {
    const result = ensureRepo(repo);
    if ("error" in result) return result.error;

    const outputs: string[] = [];

    const named = shellExec(`rg "^export (const|function|class|type|interface|enum) " "${result.path}" --glob '*.ts' --glob '*.tsx' -o -N 2>/dev/null | sort | uniq -c | sort -rn | head -30`);
    if (named) outputs.push(`## Named Exports\n${named}`);

    const defaults = shellExec(`rg "^export default" "${result.path}" --glob '*.ts' --glob '*.tsx' -l 2>/dev/null | head -20`);
    if (defaults) outputs.push(`## Default Exports\n${defaults}`);

    const reexports = shellExec(`rg "^export \\* from|^export \\{[^}]+\\} from" "${result.path}" --glob '*.ts' --glob '*.tsx' 2>/dev/null | head -30`);
    if (reexports) outputs.push(`## Re-exports\n${reexports}`);

    return truncateOutput(outputs.join("\n\n") || "No exports found");
  },
};

export type AutopsyToolName = keyof typeof autopsyTools;
