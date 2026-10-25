import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "workspace.sh");

function workspaceCommand(args, cwd) {
  return spawnSync("bash", [workspace, ...args], { cwd, encoding: "utf8" });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-workspace-"));
  fs.mkdirSync(path.join(dir, ".omp"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "runs/\n");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  fs.writeFileSync(path.join(dir, ".omp", "WATCHDOG.md"), "v1\n");
  fs.writeFileSync(path.join(dir, "scripts", "x.json"), "{}\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

function makeRun(dir, name = "2026-10-25-test") {
  const run = path.join(dir, "runs", name);
  fs.mkdirSync(path.join(run, "worker"), { recursive: true });
  fs.writeFileSync(path.join(run, "spec.md"), "# spec\n");
  return run;
}

function prepareUnit(dir, run, unit = "U1") {
  assert.equal(workspaceCommand(["init", run], dir).status, 0);
  assert.equal(workspaceCommand(["new-unit", run, unit], dir).status, 0);
}

test("check-live can ignore the paths an improver pass is editing", () => {
  const dir = makeProject();
  const run = makeRun(dir);
  assert.equal(workspaceCommand(["init", run], dir).status, 0);
  assert.equal(workspaceCommand(["check-live", run], dir).status, 0);

  fs.writeFileSync(path.join(dir, ".omp", "WATCHDOG.md"), "v2\n");
  assert.equal(workspaceCommand(["check-live", run], dir).status, 3);
  assert.equal(workspaceCommand(["check-live", run, "--ignore", ".omp"], dir).status, 0);

  fs.writeFileSync(path.join(dir, "scripts", "x.json"), "{\"v\":2}\n");
  assert.equal(workspaceCommand(["check-live", run, "--ignore", ".omp"], dir).status, 3);
  assert.equal(
    workspaceCommand(["check-live", run, "--ignore", ".omp", "--ignore", "scripts"], dir).status,
    0,
  );

  fs.writeFileSync(path.join(dir, "src.txt"), "dirty\n");
  assert.equal(
    workspaceCommand(["check-live", run, "--ignore", ".omp", "--ignore", "scripts"], dir).status,
    3,
  );
});

test("sync-main merges a mid-run pipeline commit before the deliverable commit", () => {
  const dir = makeProject();
  const run = makeRun(dir);
  prepareUnit(dir, run);
  fs.writeFileSync(path.join(run, "workspace", "units", "U1", "unit.txt"), "unit\n");
  assert.equal(workspaceCommand(["diff-unit", run, "U1"], dir).status, 0);
  assert.equal(workspaceCommand(["merge-units", run, "U1"], dir).status, 0);

  fs.appendFileSync(path.join(dir, ".omp", "WATCHDOG.md"), "v2\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "pipeline: test d1"]);

  const sync = workspaceCommand(["sync-main", run], dir);
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(workspaceCommand(["commit", run], dir).status, 0);
  assert.ok(fs.existsSync(path.join(run, "workspace", "deliverable.sha")));
  assert.equal(fs.readFileSync(path.join(dir, "unit.txt"), "utf8"), "unit\n");
  assert.match(fs.readFileSync(path.join(dir, ".omp", "WATCHDOG.md"), "utf8"), /v2/);
});

test("sync-main leaves a conflicting merge for resolution before commit", () => {
  const dir = makeProject();
  const run = makeRun(dir);
  prepareUnit(dir, run);
  fs.writeFileSync(path.join(run, "workspace", "units", "U1", "scripts", "x.json"), "{\"unit\":1}\n");
  assert.equal(workspaceCommand(["diff-unit", run, "U1"], dir).status, 0);
  assert.equal(workspaceCommand(["merge-units", run, "U1"], dir).status, 0);

  fs.writeFileSync(path.join(dir, "scripts", "x.json"), "{\"pipeline\":1}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "pipeline: test d1"]);

  const sync = workspaceCommand(["sync-main", run], dir);
  assert.equal(sync.status, 4);

  const integration = path.join(run, "workspace", "integration");
  fs.writeFileSync(path.join(integration, "scripts", "x.json"), "{\"resolved\":1}\n");
  git(integration, ["add", "scripts/x.json"]);
  git(integration, ["commit", "-qm", "resolve pipeline and unit"]);

  assert.equal(workspaceCommand(["commit", run], dir).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "scripts", "x.json"), "utf8"), "{\"resolved\":1}\n");
});
