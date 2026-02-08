import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateCodebaseMap, parseCodexExplorations, enrichMapFromSession, writeCodebaseMap } from "./context-generator.js";

const TMP = join(process.cwd(), ".test-context-gen");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("generateCodebaseMap", () => {
  it("produces a file tree", () => {
    writeFileSync(join(TMP, "index.ts"), "console.log('hello');");
    writeFileSync(join(TMP, "utils.ts"), "export function add(a: number, b: number) { return a + b; }");
    mkdirSync(join(TMP, "src"));
    writeFileSync(join(TMP, "src", "app.ts"), "export class App {}");

    const map = generateCodebaseMap(TMP);

    expect(map).toContain("# Codebase Reference");
    expect(map).toContain("## File Structure");
    expect(map).toContain("index.ts");
    expect(map).toContain("utils.ts");
    expect(map).toContain("src/");
  });

  it("extracts exported types", () => {
    writeFileSync(
      join(TMP, "types.ts"),
      `export type User = { name: string };\nexport interface Config { debug: boolean };\nexport enum Status { Active, Inactive }\n`
    );

    const map = generateCodebaseMap(TMP);

    expect(map).toContain("## Key Types");
    expect(map).toContain("type User");
    expect(map).toContain("interface Config");
    expect(map).toContain("enum Status");
  });

  it("extracts routes from router files", () => {
    writeFileSync(
      join(TMP, "router.ts"),
      `app.get("/api/users", handler);\napp.post("/api/login", loginHandler);\n`
    );

    const map = generateCodebaseMap(TMP);

    expect(map).toContain("## Routes");
    expect(map).toContain("GET `/api/users`");
    expect(map).toContain("POST `/api/login`");
  });

  it("builds test inventory", () => {
    writeFileSync(
      join(TMP, "app.test.ts"),
      `describe("App", () => {\n  it("should work", () => {});\n  it("should fail gracefully", () => {});\n});\n`
    );

    const map = generateCodebaseMap(TMP);

    expect(map).toContain("## Tests");
    expect(map).toContain("app.test.ts");
    expect(map).toContain("2 tests");
    expect(map).toContain("App");
  });

  it("builds import graph", () => {
    writeFileSync(join(TMP, "main.ts"), `import { add } from "./utils.js";\nimport { App } from "./app.js";\n`);
    writeFileSync(join(TMP, "utils.ts"), "export function add() {}");
    writeFileSync(join(TMP, "app.ts"), "export class App {}");

    const map = generateCodebaseMap(TMP);

    expect(map).toContain("## Import Graph");
    expect(map).toContain("./utils.js");
    expect(map).toContain("./app.js");
  });

  it("stays under 5KB", () => {
    // Create a bunch of files to stress the size limit
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(TMP, `module${i}.ts`), `export type Type${i} = { value: number };\nexport interface Interface${i} { data: string };\n`);
    }

    const map = generateCodebaseMap(TMP);

    expect(map.length).toBeLessThanOrEqual(5000);
  });

  it("skips node_modules and .git", () => {
    mkdirSync(join(TMP, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(TMP, "node_modules", "foo", "index.ts"), "export type Bad = {}");
    mkdirSync(join(TMP, ".git", "objects"), { recursive: true });
    writeFileSync(join(TMP, "real.ts"), "export type Good = {}");

    const map = generateCodebaseMap(TMP);

    expect(map).toContain("Good");
    expect(map).not.toContain("Bad");
    expect(map).not.toContain("node_modules");
  });
});

describe("parseCodexExplorations", () => {
  it("extracts file paths from exec_command events", () => {
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat src/index.ts" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg pattern src/utils.ts" } }),
      JSON.stringify({ type: "item.completed", item: { type: "file_change", file: "ignored.ts" } }),
    ].join("\n");

    const jsonlPath = join(TMP, "session.jsonl");
    writeFileSync(jsonlPath, jsonl);

    const explored = parseCodexExplorations(jsonlPath);

    expect(explored).toContain("src/index.ts");
  });

  it("returns empty for missing file", () => {
    expect(parseCodexExplorations(join(TMP, "nonexistent.jsonl"))).toEqual([]);
  });
});

describe("writeCodebaseMap", () => {
  it("writes CODEBASE_MAP.md to workdir", () => {
    writeFileSync(join(TMP, "index.ts"), "export type Foo = {}");

    const content = writeCodebaseMap(TMP);
    const mapPath = join(TMP, "CODEBASE_MAP.md");

    expect(existsSync(mapPath)).toBe(true);
    expect(content).toContain("Foo");
  });
});

describe("enrichMapFromSession", () => {
  it("appends explored files section", () => {
    writeFileSync(join(TMP, "index.ts"), "export type Foo = {}");
    writeCodebaseMap(TMP);

    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "cat deep/nested/file.ts" },
    });
    const sessionPath = join(TMP, "session.jsonl");
    writeFileSync(sessionPath, jsonl);

    const enriched = enrichMapFromSession(TMP, sessionPath);

    expect(enriched).toContain("## Explored Files");
    expect(enriched).toContain("deep/nested/file.ts");
  });
});
