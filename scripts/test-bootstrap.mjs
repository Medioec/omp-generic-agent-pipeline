import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, "..");
const bootstrap = path.join(scripts, "bootstrap.mjs");
const validate = path.join(scripts, "validate-omp-pipeline.mjs");

// Isolate the fixtures from the developer's git identity and system config.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: ENV });
}

function run(args) {
  return spawnSync(process.execPath, [bootstrap, ...args], { encoding: "utf8", env: ENV });
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "project\n");
  return dir;
}

function state(dir) {
  const files = {};
  for (const name of ["index.md", "README.md", "decisions.md"]) {
    files[name] = fs.readFileSync(path.join(dir, "memory", name), "utf8");
  }
  files.gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  files.projectHead = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
  files.memoryHead = git(path.join(dir, "memory"), ["rev-parse", "HEAD"]).stdout.trim();
  return files;
}

test("a fresh project gains the repository, memory skeleton and runs dir", () => {
  const dir = project();
  const result = run(["--project", dir]);
  assert.equal(result.status, 0, result.stderr);

  assert.ok(fs.existsSync(path.join(dir, ".git")));
  assert.equal(git(dir, ["rev-parse", "--verify", "HEAD"]).status, 0);
  assert.ok(fs.existsSync(path.join(dir, "memory", ".git")));
  assert.equal(git(path.join(dir, "memory"), ["rev-parse", "--verify", "HEAD"]).status, 0);
  for (const name of ["index.md", "README.md", "decisions.md"]) {
    assert.ok(fs.existsSync(path.join(dir, "memory", name)), `memory/${name} missing`);
  }
  assert.ok(fs.statSync(path.join(dir, "memory", "facts")).isDirectory());
  assert.ok(fs.statSync(path.join(dir, "memory", "evidence")).isDirectory());
  assert.ok(fs.statSync(path.join(dir, "runs")).isDirectory());
  for (const name of [".agents", ".requests", ".queue"]) {
    assert.ok(fs.statSync(path.join(dir, "runs", name)).isDirectory(), `runs/${name}/ missing`);
  }

  const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(ignore, /^memory\/$/m);
  assert.match(ignore, /^runs\/$/m);

  const tracked = git(dir, ["ls-files"]).stdout;
  assert.match(tracked, /README\.md/);
  assert.doesNotMatch(tracked, /memory\//);
  assert.doesNotMatch(tracked, /runs\//);

  // Later worktree and merge commits need an identity; bootstrap configures one.
  assert.equal(git(dir, ["config", "user.email"]).stdout.trim(), "pipeline@localhost");
  assert.equal(git(path.join(dir, "memory"), ["config", "user.email"]).stdout.trim(), "pipeline@localhost");
});

test("a second run changes nothing", () => {
  const dir = project();
  assert.equal(run(["--project", dir]).status, 0);
  const first = state(dir);
  const second = run(["--project", dir]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(state(dir), first);
  assert.match(second.stdout, /nothing to do/);
});

test("--check reports gaps without writing, then passes", () => {
  const dir = project();
  const before = run(["--project", dir, "--check"]);
  assert.equal(before.status, 1);
  assert.match(before.stderr, /missing: project is not a git repository/);
  assert.ok(!fs.existsSync(path.join(dir, ".git")));
  assert.ok(!fs.existsSync(path.join(dir, "memory")));

  assert.equal(run(["--project", dir]).status, 0);
  const after = run(["--project", dir, "--check"]);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /^bootstrap check: ok/m);
});

test("an existing .gitignore keeps its lines and gains the managed ones", () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
  const result = run(["--project", dir]);
  assert.equal(result.status, 0, result.stderr);
  const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(ignore, /^dist\/$/m);
  assert.match(ignore, /^memory\/$/m);
  assert.equal(ignore.match(/^memory\/$/gm).length, 1);
});

test("existing memory files are never overwritten", () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, "memory", "index.md"), "# Custom index\n");
  const result = run(["--project", dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "memory", "index.md"), "utf8"), "# Custom index\n");
  assert.notEqual(fs.readFileSync(path.join(dir, "memory", "README.md"), "utf8"), undefined);
  assert.match(git(path.join(dir, "memory"), ["status", "--porcelain"]).stdout, /^$/);
});

test("a project nested inside another repository is refused", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-parent-"));
  assert.equal(git(parent, ["init", "-q", "-b", "main"]).status, 0);
  const child = path.join(parent, "project");
  fs.mkdirSync(child);
  const result = run(["--project", child]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inside the repository/);
  assert.ok(!fs.existsSync(path.join(child, ".git")));
});

test("a retired shared-memory directory is ignored", () => {
  const dir = project();
  const retired = path.join(dir, "k" + "b");
  fs.mkdirSync(retired, { recursive: true });
  fs.writeFileSync(path.join(retired, "index.md"), "legacy\n");
  const result = run(["--project", dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(retired, "index.md"), "utf8"), "legacy\n");
  assert.ok(fs.existsSync(path.join(dir, "memory", "index.md")));
});

test("install.sh checks, installs the binary and bootstraps", () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "install-"));
  const skipTop = new Set([".git", "memory", "runs", "node_modules", "bin"]);
  fs.cpSync(root, copy, {
    recursive: true,
    filter: source => {
      const relative = path.relative(root, source);
      if (!relative) return true;
      return !skipTop.has(relative.split(path.sep)[0]);
    },
  });
  const fake = path.join(copy, "bin", "omp");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo omp/fake\n");
  fs.chmodSync(fake, 0o755);
  const prefix = path.join(copy, "prefix");
  const script = path.join(copy, "install.sh");

  const check = spawnSync("bash", [script, "--check", "--prefix", prefix], { encoding: "utf8", env: ENV });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /would install/);
  assert.match(check.stdout, /install check: ready/);
  assert.ok(!fs.existsSync(path.join(prefix, "omp")), "--check must not write");

  const install = spawnSync("bash", [script, "--prefix", prefix], { encoding: "utf8", env: ENV });
  assert.equal(install.status, 0, install.stderr);
  assert.ok(fs.existsSync(path.join(prefix, "omp")));
  assert.match(install.stdout, /install: ready/);
});

test("a bootstrapped project passes the static validator", () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-copy-"));
  const skipTop = new Set([".git", "memory", "runs", "node_modules", "bin"]);
  fs.cpSync(root, copy, {
    recursive: true,
    filter: source => {
      const relative = path.relative(root, source);
      if (!relative) return true;
      return !skipTop.has(relative.split(path.sep)[0]);
    },
  });
  const boot = spawnSync(process.execPath, [path.join(copy, "scripts", "bootstrap.mjs")], { encoding: "utf8", env: ENV });
  assert.equal(boot.status, 0, boot.stderr);
  const check = spawnSync(process.execPath, [validate], { encoding: "utf8", env: ENV, cwd: copy });
  assert.equal(check.status, 0, check.stderr);
});
