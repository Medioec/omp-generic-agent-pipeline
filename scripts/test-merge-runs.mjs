import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "merge-runs.mjs");

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function fixture({ status = "pending-merge", evidence = "scratch/e.txt", createEvidence = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-runs-"));
  const runDir = path.join(root, "runs", "2026-01-01-demo");
  fs.mkdirSync(path.join(runDir, "delta"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "scratch"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
    run: "2026-01-01-demo", status, completed: "2026-01-01", topics: ["demo"], delta: {},
  }, null, 2));
  fs.writeFileSync(path.join(runDir, "delta", "facts.json"), JSON.stringify([
    { id: "c1", topic: "demo", claim: "x", evidence: [evidence] },
  ], null, 2));
  if (createEvidence) fs.writeFileSync(path.join(runDir, "scratch", "e.txt"), "evidence\n");
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  return { root, runDir };
}

test("list prints pending runs only", () => {
  const { root } = fixture();
  const result = run(["list", "--project", root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2026-01-01-demo/);
});

test("list ignores merged runs", () => {
  const { root } = fixture({ status: "merged" });
  const result = run(["list", "--project", root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no pending runs/);
});

test("validate accepts a complete run", () => {
  const { runDir } = fixture();
  const result = run(["validate", runDir]);
  assert.equal(result.status, 0, result.stderr);
});

test("validate rejects a missing evidence file", () => {
  const { runDir } = fixture({ createEvidence: false });
  const result = run(["validate", runDir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /evidence not found/);
});

test("evidence copies cited files under memory/evidence/<run>", () => {
  const { root, runDir } = fixture();
  const memory = path.join(root, "memory");
  const result = run(["evidence", runDir, memory]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(memory, "evidence", "2026-01-01-demo", "scratch", "e.txt")));
});

test("mark-merged flips status", () => {
  const { runDir } = fixture();
  const result = run(["mark-merged", runDir]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "merged");
});

test("verify resolves links in the memory tree", () => {
  const { root } = fixture();
  const memory = path.join(root, "memory");
  fs.mkdirSync(path.join(memory, "facts"), { recursive: true });
  fs.writeFileSync(path.join(memory, "index.md"), "# Index\n");
  fs.writeFileSync(path.join(memory, "facts", "a.md"), "[up](../index.md)\n");
  const result = run(["verify", memory]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all relative links stay inside memory and resolve/);
});

test("verify rejects a broken link in a merged page", () => {
  const { root } = fixture();
  const memory = path.join(root, "memory");
  fs.mkdirSync(path.join(memory, "facts"), { recursive: true });
  fs.writeFileSync(path.join(memory, "facts", "a.md"), "[missing](./nope.md)\n");
  const result = run(["verify", memory]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing \.\/nope\.md/);
});

test("verify treats copied evidence as opaque content", () => {
  const { root } = fixture();
  const memory = path.join(root, "memory");
  fs.mkdirSync(path.join(memory, "facts"), { recursive: true });
  fs.writeFileSync(path.join(memory, "index.md"), "# Index\n");
  fs.mkdirSync(path.join(memory, "evidence", "2026-01-01-demo"), { recursive: true });
  fs.writeFileSync(path.join(memory, "evidence", "2026-01-01-demo", "report.md"), "[broken](../../nowhere.md)\n");
  const result = run(["verify", memory]);
  assert.equal(result.status, 0, result.stderr);
});
