#!/usr/bin/env node
// Idempotent first-run bootstrap for the pipeline workspace.
//
//   node scripts/bootstrap.mjs [--project <root>] [--check]
//
// Creates only what is missing and never overwrites an existing file:
//   - the project git repository and an initial commit
//   - the managed .gitignore lines (memory/, runs/, .worktrees/, ...)
//   - the memory repo at memory/ (index.md, README.md, decisions.md, facts/, evidence/)
//   - the runs/ directory
//
// --check writes nothing and exits 1 listing every gap.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const projectFlag = args.indexOf("--project");
if (projectFlag >= 0 && !args[projectFlag + 1]) {
  console.error("ERROR: --project needs a path");
  process.exit(1);
}
const project = fs.realpathSync(projectFlag >= 0 ? path.resolve(args[projectFlag + 1]) : scriptRoot);

const GITIGNORE_LINES = [
  "memory/",
  "runs/",
  ".worktrees/",
  "node_modules/",
  ".obsidian/",
  "bin/omp",
  "*.tmp",
];
const GITIGNORE_HEADER = "# Ignored pipeline state: the separate memory repo and per-run data.";
const MEMORY_FILES = ["index.md", "README.md", "decisions.md"];
const MEMORY_DIRS = ["facts", "evidence"];
const MANAGED_DIRS = ["memory", "runs", ".worktrees", "node_modules"];

const gaps = [];
const actions = [];

function run(cwd, gitArgs) {
  return spawnSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8" });
}

function git(cwd, gitArgs) {
  const result = run(cwd, gitArgs);
  if (result.status !== 0) {
    console.error(`ERROR: git ${gitArgs.join(" ")} failed in ${cwd}\n${result.stderr.trim()}`);
    process.exit(1);
  }
  return result.stdout.trim();
}

function hasCommits(cwd) {
  return run(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).status === 0;
}

function head(cwd) {
  if (!fs.existsSync(path.join(cwd, ".git")) || !hasCommits(cwd)) return "none";
  return run(cwd, ["rev-parse", "--short", "HEAD"]).stdout.trim();
}

function ensureIdentity(cwd) {
  const email = run(cwd, ["config", "user.email"]);
  if (email.status === 0 && email.stdout.trim()) return;
  git(cwd, ["config", "user.name", "omp-pipeline"]);
  git(cwd, ["config", "user.email", "pipeline@localhost"]);
  actions.push("set local git identity: omp-pipeline <pipeline@localhost>");
}

function commitPaths(cwd, message, paths) {
  if (paths) {
    git(cwd, ["add", "--", ...paths]);
  } else {
    git(cwd, ["add", "-A"]);
  }
  const staged = run(cwd, ["diff", "--cached", "--name-only"]).stdout.trim();
  git(cwd, ["commit", "-q", "-m", message, ...(staged ? [] : ["--allow-empty"])]);
  actions.push(`committed ${message} (${head(cwd)})`);
}

function report(gap) {
  gaps.push(gap);
}

function initRepo(dir) {
  const result = spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  if (result.status !== 0) git(dir, ["init", "-q"]);
}

function managedPath(line) {
  const value = line.slice(3).trim().replace(/^"|"$/g, "");
  return MANAGED_DIRS.some(dir => value === dir || value.startsWith(`${dir}/`));
}

function dirtyPaths(cwd) {
  const status = run(cwd, ["status", "--porcelain"]);
  if (status.status !== 0) return [];
  return status.stdout
    .split("\n")
    .filter(Boolean)
    .filter(line => !managedPath(line));
}

// --- refusal: a project nested inside another repository -------------------
const toplevel = run(project, ["rev-parse", "--show-toplevel"]);
if (toplevel.status === 0) {
  const top = fs.realpathSync(toplevel.stdout.trim());
  if (top !== project) {
    console.error(`ERROR: refusing to bootstrap ${project}: it is inside the repository ${top}.`);
    console.error("The project must be its own git repository so worktrees branch from its commits.");
    process.exit(1);
  }
}

// --- .gitignore ------------------------------------------------------------
function ensureGitignore() {
  const file = path.join(project, ".gitignore");
  if (!fs.existsSync(file)) {
    if (checkOnly) return report(".gitignore missing");
    fs.writeFileSync(file, `${GITIGNORE_HEADER}\n${GITIGNORE_LINES.join("\n")}\n`);
    actions.push("created .gitignore");
    return;
  }
  const current = fs.readFileSync(file, "utf8");
  const lines = current.split(/\r?\n/).map(line => line.trim());
  const missing = GITIGNORE_LINES.filter(line => !lines.includes(line));
  if (!missing.length) return;
  if (checkOnly) return report(`.gitignore missing line(s): ${missing.join(", ")}`);
  const body = current.endsWith("\n") ? current : `${current}\n`;
  fs.writeFileSync(file, `${body}${missing.join("\n")}\n`);
  actions.push(`appended .gitignore line(s): ${missing.join(", ")}`);
  return true;
}

// --- project repository ----------------------------------------------------
function ensureProjectRepo(gitignoreChanged) {
  const gitDir = path.join(project, ".git");
  if (!fs.existsSync(gitDir)) {
    if (checkOnly) return report("project is not a git repository");
    initRepo(project);
    actions.push("initialised project repository (main)");
  }
  if (checkOnly) {
    if (!run(project, ["config", "user.email"]).stdout.trim()) report("no git identity configured (user.name/user.email)");
  } else {
    ensureIdentity(project);
  }
  if (!hasCommits(project)) {
    if (checkOnly) return report("project repository has no commit");
    commitPaths(project, "pipeline: bootstrap");
    return;
  }
  if (gitignoreChanged && !checkOnly) {
    commitPaths(project, "pipeline: bootstrap .gitignore", [".gitignore"]);
  }
  if (checkOnly) {
    const dirty = dirtyPaths(project);
    if (dirty.length) report(`project tree has ${dirty.length} uncommitted path(s)`);
  }
}

// --- memory repository -----------------------------------------------------
function ensureMemory() {
  const dir = path.join(project, "memory");
  const repo = path.join(dir, ".git");
  const created = [];
  if (!fs.existsSync(repo)) {
    if (checkOnly) {
      report("memory/ is not a git repository");
    } else {
      fs.mkdirSync(dir, { recursive: true });
      initRepo(dir);
      actions.push("initialised memory repository (main)");
    }
  }
  for (const name of MEMORY_DIRS) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) continue;
    if (checkOnly) {
      report(`memory/${name}/ missing`);
      continue;
    }
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, ".gitkeep"), "");
    actions.push(`created memory/${name}/`);
    created.push(path.join(name, ".gitkeep"));
  }
  for (const name of MEMORY_FILES) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) continue;
    if (checkOnly) {
      report(`memory/${name} missing`);
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    const template = path.join(scriptRoot, "scripts", "templates", "memory", name);
    if (!fs.existsSync(template)) {
      console.error(`ERROR: missing memory template: ${template}`);
      process.exit(1);
    }
    fs.copyFileSync(template, full);
    actions.push(`created memory/${name}`);
    created.push(name);
  }
  if (checkOnly) {
    if (fs.existsSync(repo)) {
      if (!run(dir, ["config", "user.email"]).stdout.trim()) report("memory repository has no git identity");
      if (!hasCommits(dir)) report("memory repository has no commit");
      else {
        const dirty = dirtyPaths(dir);
        if (dirty.length) report(`memory repository has ${dirty.length} uncommitted path(s)`);
      }
    }
    return;
  }
  if (!fs.existsSync(repo)) return;
  ensureIdentity(dir);
  if (!hasCommits(dir)) {
    commitPaths(dir, "memory: bootstrap");
    return;
  }
  if (created.length) commitPaths(dir, "memory: bootstrap artifacts", created);
}

// --- runs directory --------------------------------------------------------
function ensureRuns() {
  const dir = path.join(project, "runs");
  const managed = [
    [dir, "runs/"],
    [path.join(dir, ".agents"), "runs/.agents/"],
    [path.join(dir, ".requests"), "runs/.requests/"],
    [path.join(dir, ".queue"), "runs/.queue/"],
  ];
  for (const [full, label] of managed) {
    if (fs.existsSync(full)) continue;
    if (checkOnly) {
      report(`${label} missing`);
      continue;
    }
    fs.mkdirSync(full, { recursive: true });
    actions.push(`created ${label}`);
  }
}

// --- run -------------------------------------------------------------------
const gitignoreChanged = ensureGitignore();
ensureProjectRepo(gitignoreChanged);
ensureMemory();
ensureRuns();

if (checkOnly) {
  if (gaps.length) {
    console.error(`bootstrap check: ${gaps.length} gap(s)`);
    for (const gap of gaps) console.error(`missing: ${gap}`);
    process.exit(1);
  }
  console.log(`bootstrap check: ok (project ${head(project)}, memory ${head(path.join(project, "memory"))}, runs/)`);
  process.exit(0);
}

if (!actions.length) actions.push("nothing to do");
for (const action of actions) console.log(action);
console.log(`bootstrap: ok (project ${head(project)}, memory ${head(path.join(project, "memory"))}, runs/)`);

const projectDirty = dirtyPaths(project);
if (projectDirty.length) {
  console.log(`note: project tree has ${projectDirty.length} uncommitted path(s); commit or stash them before starting a run`);
}
const memoryDirty = dirtyPaths(path.join(project, "memory"));
if (memoryDirty.length) {
  console.log(`note: memory repository has ${memoryDirty.length} uncommitted path(s); commit them before a merge`);
}
