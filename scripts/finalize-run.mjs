#!/usr/bin/env node
// Validate a completed run's summary + delta and write runs/<run>/manifest.json.
// Usage: node scripts/finalize-run.mjs <run-dir> [--project <root>]
// Exit 0 = manifest written; exit 1 = invalid.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const args = process.argv.slice(2);
const runArg = args[0];
if (!runArg) fail("usage: node scripts/finalize-run.mjs <run-dir> [--project <root>]");
const projectArgIndex = args.indexOf("--project");
const runDir = path.resolve(runArg);
if (!fs.existsSync(runDir)) fail(`run directory not found: ${runDir}`);
const project = projectArgIndex >= 0 ? path.resolve(args[projectArgIndex + 1]) : git(runDir, "rev-parse", "--show-toplevel");

const verdictPath = path.join(runDir, "verdict.md");
const summaryPath = path.join(runDir, "summary.md");
if (!fs.existsSync(verdictPath)) fail("missing verdict.md");
if (!fs.existsSync(summaryPath)) fail("missing summary.md");

const verdict = fs.readFileSync(verdictPath, "utf8");
const outcomeLine = verdict.match(/^OUTCOME:\s*(\S+)/m);
if (!outcomeLine) fail("verdict.md has no OUTCOME line");
if (outcomeLine[1] !== "APPROVED") fail(`verdict outcome is ${outcomeLine[1]}, not APPROVED`);

let summary = fs.readFileSync(summaryPath, "utf8");
if (/^OUTCOME:/m.test(summary)) {
  summary = summary.replace(/^OUTCOME:.*$/m, "OUTCOME: APPROVED");
} else {
  summary = `OUTCOME: APPROVED\n\n${summary}`;
}
fs.writeFileSync(summaryPath, summary);

const deltaNames = ["facts", "decisions", "index", "corrections"];
const delta = {};
const counts = {};
for (const name of deltaNames) {
  const file = path.join(runDir, "delta", `${name}.json`);
  if (!fs.existsSync(file)) {
    delta[name] = null;
    counts[name] = 0;
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`delta/${name}.json does not parse: ${error.message}`);
  }
  delta[name] = `delta/${name}.json`;
  counts[name] = name === "index"
    ? (Array.isArray(parsed.topics) ? parsed.topics.length : 0)
    : (Array.isArray(parsed) ? parsed.length : (parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0));
}
const hasContent = Object.values(counts).some(count => count > 0);

if (!fs.existsSync(path.join(runDir, "delta"))) fail("missing delta/ directory");

// Evidence pointers must resolve relative to the run directory.
function checkEvidence(value, where) {
  if (value === undefined) return;
  if (!Array.isArray(value)) fail(`${where}: evidence must be an array`);
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) fail(`${where}: empty evidence pointer`);
    if (/^[a-z]+:\/\//i.test(raw)) fail(`${where}: absolute/URL evidence is not allowed: ${raw}`);
    const clean = raw.split("#")[0];
    const target = path.resolve(runDir, clean);
    if (!target.startsWith(runDir + path.sep)) fail(`${where}: evidence escapes the run directory: ${raw}`);
    if (!fs.existsSync(target)) fail(`${where}: evidence not found: ${raw}`);
  }
}

function walk(node, where) {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => walk(entry, `${where}[${index}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node.evidence !== undefined) checkEvidence(node.evidence, `${where}.evidence`);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "evidence") walk(value, `${where}.${key}`);
  }
}

const ids = new Set();
for (const name of deltaNames) {
  if (!delta[name]) continue;
  const file = path.join(runDir, delta[name]);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if (name === "facts") {
    if (!Array.isArray(parsed)) fail("delta/facts.json must be an array");
    parsed.forEach((entry, index) => {
      if (!entry || typeof entry.id !== "string" || !entry.id) fail(`facts[${index}]: missing id`);
      if (ids.has(entry.id)) fail(`duplicate claim id: ${entry.id}`);
      ids.add(entry.id);
      if (typeof entry.topic !== "string" || !entry.topic) fail(`facts[${index}]: missing topic`);
      if (typeof entry.claim !== "string" || !entry.claim) fail(`facts[${index}]: missing claim`);
      if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) fail(`facts[${index}]: evidence required`);
    });
  }
  walk(parsed, name);
}

const memoryDir = path.join(project, "memory");
let memoryCommit = null;
if (fs.existsSync(path.join(memoryDir, ".git"))) memoryCommit = git(memoryDir, "rev-parse", "HEAD");

const deliverableFile = path.join(runDir, "workspace", "deliverable.sha");
const deliverableCommit = fs.existsSync(deliverableFile)
  ? fs.readFileSync(deliverableFile, "utf8").trim()
  : git(project, "rev-parse", "HEAD");

const manifest = {
  run: path.basename(runDir),
  status: hasContent ? "pending-merge" : "closed",
  memory_impact: hasContent ? "pending-merge" : "none",
  work_type: (() => {
    const match = fs.readFileSync(path.join(runDir, "spec.md"), "utf8").match(/^\s*[-*]?\s*(?:\*\*)?work[_ ]type(?:\*\*)?\s*[:=]\s*`?([A-Za-z-]+)/mi);
    return match ? match[1] : "unknown";
  })(),
  completed: new Date().toISOString().slice(0, 10),
  verdict: "APPROVED",
  project_commit: git(project, "rev-parse", "HEAD"),
  deliverable_commit: deliverableCommit,
  memory_commit: memoryCommit,
  topics: (() => {
    const file = path.join(runDir, "delta", "index.json");
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed.topics) ? parsed.topics : [];
    } catch {
      return [];
    }
  })(),
  delta
};

fs.writeFileSync(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`finalized ${manifest.run}: ${manifest.status}, project ${manifest.project_commit.slice(0, 8)}, memory ${String(manifest.memory_commit).slice(0, 8)}`);
