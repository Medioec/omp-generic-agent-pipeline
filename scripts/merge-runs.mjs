#!/usr/bin/env node
// Deterministic helpers for the manual, human-triggered merge skill.
//
//   node scripts/merge-runs.mjs list [--project <root>]
//   node scripts/merge-runs.mjs validate <run-dir>
//   node scripts/merge-runs.mjs evidence <run-dir> <memory-root>
//   node scripts/merge-runs.mjs verify <memory-root>
//   node scripts/merge-runs.mjs mark-merged <run-dir> [<run-dir>...]
//
// The skill drafts and edits the shared memory; this script only lists, validates,
// copies cited evidence, verifies links, and records merge status.

import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) fail(`missing ${label}: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} does not parse: ${error.message}`);
  }
}

function walkEvidence(node, out = []) {
  if (Array.isArray(node)) {
    for (const entry of node) walkEvidence(entry, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node.evidence)) out.push(...node.evidence);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "evidence") walkEvidence(value, out);
  }
  return out;
}

function validateRun(runDir) {
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = readJson(manifestPath, "manifest.json");
  if (!manifest.run) fail(`${manifestPath}: missing run`);
  if (!["pending-merge", "merged", "closed"].includes(manifest.status)) fail(`${manifestPath}: invalid status ${manifest.status}`);
  const deltaDir = path.join(runDir, "delta");
  if (!fs.existsSync(deltaDir)) fail(`${runDir}: missing delta/`);
  const files = ["facts", "decisions", "index", "corrections"];
  const ids = new Set();
  for (const name of files) {
    const file = path.join(deltaDir, `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const parsed = readJson(file, `delta/${name}.json`);
    if (name === "facts") {
      if (!Array.isArray(parsed)) fail(`${file}: must be an array`);
      for (const [index, entry] of parsed.entries()) {
        if (!entry.id) fail(`${file}: facts[${index}] missing id`);
        if (ids.has(entry.id)) fail(`${file}: duplicate id ${entry.id}`);
        ids.add(entry.id);
        if (!entry.claim) fail(`${file}: facts[${index}] missing claim`);
      }
    }
    for (const raw of walkEvidence(parsed)) {
      if (typeof raw !== "string" || !raw.trim()) fail(`${file}: empty evidence pointer`);
      if (/^[a-z]+:\/\//i.test(raw)) fail(`${file}: URL evidence not allowed: ${raw}`);
      const clean = raw.split("#")[0];
      const target = path.resolve(runDir, clean);
      if (!target.startsWith(runDir + path.sep)) fail(`${file}: evidence escapes run dir: ${raw}`);
      if (!fs.existsSync(target)) fail(`${file}: evidence not found: ${raw}`);
    }
  }
  return manifest;
}

function cmdList(project) {
  const runsDir = path.join(project, "runs");
  if (!fs.existsSync(runsDir)) {
    console.log("no runs directory");
    return;
  }
  const rows = [];
  for (const name of fs.readdirSync(runsDir).sort()) {
    const manifestPath = path.join(runsDir, name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.status !== "pending-merge") continue;
      rows.push({ run: manifest.run || name, topics: (manifest.topics || []).join(","), completed: manifest.completed || "" });
    } catch {
      rows.push({ run: name, topics: "INVALID MANIFEST", completed: "" });
    }
  }
  if (!rows.length) {
    console.log("no pending runs");
    return;
  }
  for (const row of rows) console.log(`${row.run}\t${row.completed}\t${row.topics}`);
}

function cmdEvidence(runDir, memoryRoot) {
  const manifest = validateRun(runDir);
  const run = manifest.run || path.basename(runDir);
  const deltaDir = path.join(runDir, "delta");
  const copied = new Map();
  for (const name of ["facts", "decisions", "index", "corrections"]) {
    const file = path.join(deltaDir, `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const parsed = readJson(file, `delta/${name}.json`);
    for (const raw of walkEvidence(parsed)) {
      const clean = raw.split("#")[0];
      const source = path.resolve(runDir, clean);
      const relative = path.relative(runDir, source);
      const target = path.join(memoryRoot, "evidence", run, relative);
      if (!copied.has(source)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        copied.set(source, target);
      }
      console.log(`${raw} -> evidence/${run}/${relative}`);
    }
  }
  console.log(`copied ${copied.size} evidence file(s) for ${run}`);
}

function cmdVerify(memoryRoot) {
  const actions = [];
  const missing = [];
  for (const file of walkMarkdown(memoryRoot)) {
    const text = fs.readFileSync(file, "utf8");
    const base = path.dirname(file);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:\/\//i.test(target) || target.startsWith("#")) continue;
      const clean = target.split("#")[0];
      if (!clean) continue;
      const resolved = path.resolve(base, clean);
      if (!resolved.startsWith(memoryRoot + path.sep)) {
        actions.push(`${path.relative(memoryRoot, file)}: link escapes memory: ${target}`);
      } else if (!fs.existsSync(resolved)) {
        missing.push(`${path.relative(memoryRoot, file)}: missing ${target}`);
      }
    }
  }
  if (actions.length || missing.length) {
    for (const line of [...actions, ...missing]) console.error(line);
    fail(`${actions.length} escaping link(s), ${missing.length} missing target(s)`);
  }
  console.log(`verify: ${walkMarkdown(memoryRoot).length} markdown files, all relative links stay inside memory and resolve`);
}

function walkMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "evidence") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function cmdMarkMerged(runDirs) {
  const today = new Date().toISOString().slice(0, 10);
  for (const runDir of runDirs) {
    const file = path.join(runDir, "manifest.json");
    const manifest = readJson(file, "manifest.json");
    manifest.status = "merged";
    manifest.merged_at = today;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`merged: ${manifest.run || runDir}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const projectIndex = rest.indexOf("--project");
const project = projectIndex >= 0 ? path.resolve(rest[projectIndex + 1]) : process.cwd();

if (command === "list") cmdList(project);
else if (command === "validate") {
  if (!rest[0]) fail("usage: merge-runs.mjs validate <run-dir>");
  const manifest = validateRun(path.resolve(rest[0]));
  console.log(`valid: ${manifest.run} (${manifest.status})`);
} else if (command === "evidence") {
  if (!rest[0] || !rest[1]) fail("usage: merge-runs.mjs evidence <run-dir> <memory-root>");
  cmdEvidence(path.resolve(rest[0]), path.resolve(rest[1]));
} else if (command === "verify") {
  if (!rest[0]) fail("usage: merge-runs.mjs verify <memory-root>");
  cmdVerify(path.resolve(rest[0]));
} else if (command === "mark-merged") {
  if (!rest.length) fail("usage: merge-runs.mjs mark-merged <run-dir>...");
  cmdMarkMerged(rest.map(entry => path.resolve(entry)));
} else {
  fail("usage: merge-runs.mjs <list|validate|evidence|verify|mark-merged> ...");
}
