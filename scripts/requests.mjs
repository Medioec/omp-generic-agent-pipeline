#!/usr/bin/env node
// Deterministic helpers for ad-hoc pipeline requests.
//
//   node scripts/requests.mjs id [--prefix req]
//   node scripts/requests.mjs register --agent <id> --request-id <id> [--run <dir>] [--status starting] [--role orchestrator]
//   node scripts/requests.mjs update --agent <id> --status <status> [--run <dir>] [--role <role>]
//   node scripts/requests.mjs agents [--status running] [--role orchestrator]
//   node scripts/requests.mjs submit --run <dir>|--agent <id>|--queue --request <text> [--request-file <path>]
//                                  [--id <id>] [--kind auto] [--source user] [--reply-to <id>]
//   node scripts/requests.mjs add --run <dir>|--agent <id>|--queue --text <text> [--file <path>]
//                                [--id <id>] [--kind auto] [--register <role>]
//                                  writes runs/.requests/<id>.request.md, submits, and prints the wake line
//   node scripts/requests.mjs list --run <dir> [--status received]
//   node scripts/requests.mjs list --global [--status received]
//   node scripts/requests.mjs list --queue [--status queued]
//   node scripts/requests.mjs claim <id> [--run <dir>]
//   node scripts/requests.mjs ack <id> --status <status> [--reason <text>] [--run <dir>]
//   node scripts/requests.mjs validate <id> [--run <dir>]
//
// The request file is the durable record; the agent message is only a doorbell.
// This script never runs git and never writes outside runs/.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const projectFlag = argv.indexOf("--project");
const project = fs.realpathSync(projectFlag >= 0 ? path.resolve(argv[projectFlag + 1]) : scriptRoot);
const runs = path.join(project, "runs");
const agentsDir = path.join(runs, ".agents");
const globalDir = path.join(runs, ".requests");
const queueDir = path.join(runs, ".queue");

const STATUSES = new Set(["received", "triaged", "accepted", "rejected", "done", "failed", "queued"]);
const KINDS = new Set(["auto", "additive", "change", "new-run"]);
const SOURCES = new Set(["user", "command"]);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function option(name, required = false) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) fail(`missing ${name}`);
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (required) fail(`${name} needs a value`);
    return undefined;
  }
  return value;
}

function flag(name) {
  return argv.includes(name);
}

function now() {
  return new Date().toISOString();
}

function ensureDirs() {
  for (const dir of [runs, agentsDir, globalDir, queueDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isUnder(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveRun(value) {
  if (!value) return null;
  const abs = path.resolve(project, value);
  if (!isUnder(runs, abs) || abs === runs) fail(`run directory must be under runs/: ${value}`);
  return abs;
}

function resolveUnderRuns(value, label) {
  if (!value) return null;
  const abs = path.resolve(project, value);
  if (!isUnder(runs, abs) || abs === runs) fail(`${label} must be under runs/: ${value}`);
  return abs;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${path.relative(project, file)}: ${error.message}`);
  }
}

function requestPath(runDir, id) {
  return runDir ? path.join(runDir, "requests", `${id}.json`) : path.join(globalDir, `${id}.json`);
}

function findRequest(id, runValue) {
  if (!id) fail("missing request id");
  const candidates = [];
  const run = resolveRun(runValue);
  if (run) candidates.push(path.join(run, "requests", `${id}.json`));
  candidates.push(path.join(globalDir, `${id}.json`), path.join(queueDir, `${id}.json`));
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  // Fall back to a scan: a request may have been moved into a run inbox.
  for (const entry of fs.existsSync(runs) ? fs.readdirSync(runs, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = path.join(runs, entry.name, "requests", `${id}.json`);
    if (fs.existsSync(file)) return file;
  }
  fail(`request not found: ${id}`);
}

function validateRequest(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where}: must be an object`);
  if (typeof value.id !== "string" || !value.id) fail(`${where}: missing id`);
  if (typeof value.request !== "string" || !value.request.trim()) fail(`${where}: missing request text`);
  if (!SOURCES.has(value.source)) fail(`${where}: source must be user or command`);
  if (!KINDS.has(value.kind)) fail(`${where}: unknown kind ${value.kind}`);
  if (!STATUSES.has(value.status)) fail(`${where}: unknown status ${value.status}`);
  if (typeof value.submitted !== "string" || !value.submitted) fail(`${where}: missing submitted`);
  return value;
}

function requestId(prefix = "req") {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function cmdId() {
  console.log(requestId(option("--prefix") || "req"));
}

function upsertAgent({ agent, requestIdValue, run, statusArg, roleArg }) {
  ensureDirs();
  const file = path.join(agentsDir, `${agent}.json`);
  const existed = fs.existsSync(file);
  const entry = existed
    ? readJson(file)
    : { agent_id: agent, request_id: requestIdValue, run_dir: run ? path.relative(project, run) : null, role: roleArg || null, started: now(), status: statusArg || "starting", updated: now() };
  entry.request_id = requestIdValue;
  if (run) entry.run_dir = path.relative(project, run);
  if (roleArg) entry.role = roleArg;
  if (statusArg || !existed) entry.status = statusArg || entry.status;
  entry.updated = now();
  writeJson(file, entry);
  return entry;
}

function cmdRegister() {
  const entry = upsertAgent({
    agent: option("--agent", true),
    requestIdValue: option("--request-id", true),
    run: resolveRun(option("--run")),
    statusArg: option("--status"),
    roleArg: option("--role"),
  });
  console.log(JSON.stringify(entry));
}

function cmdUpdate() {
  ensureDirs();
  const agent = option("--agent", true);
  const status = option("--status", true);
  if (!STATUSES.has(status) && !["starting", "running", "sink-approved", "verdict-written", "closed", "failed"].includes(status)) {
    fail(`unknown status: ${status}`);
  }
  const file = path.join(agentsDir, `${agent}.json`);
  if (!fs.existsSync(file)) fail(`agent not registered: ${agent}`);
  const entry = readJson(file);
  entry.status = status;
  const role = option("--role");
  if (role) entry.role = role;
  const run = resolveRun(option("--run"));
  if (run) entry.run_dir = path.relative(project, run);
  entry.updated = now();
  writeJson(file, entry);
  console.log(JSON.stringify(entry));
}

function cmdAgents() {
  const status = option("--status");
  const role = option("--role");
  const out = [];
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir)) {
      if (!entry.endsWith(".json")) continue;
      const value = readJson(path.join(agentsDir, entry));
      if (status && value.status !== status) continue;
      if (role && value.role !== role) continue;
      out.push(value);
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

function verifyAgentRole(agent) {
  const file = path.join(agentsDir, `${agent}.json`);
  if (!fs.existsSync(file)) {
    console.error(`warning: agent ${agent} is not registered; cannot verify it is an orchestrator`);
    return;
  }
  const entry = readJson(file);
  if (!entry.role) {
    fail(`agent ${agent} has no recorded role; register it with --role orchestrator before submitting requests`);
  }
  if (entry.role !== "orchestrator") {
    fail(`agent ${agent} is registered as ${entry.role}; requests are delivered only to orchestrator agents`);
  }
}

function deliverRequest({ queue, runValue, agent, id, text, filePath, source, kind, replyTo, originRun }) {
  const run = resolveRun(runValue);
  const origin = resolveRun(originRun);
  const target = queue ? "new-run" : run ? "current-run" : `agent:${agent}`;
  const value = {
    id,
    source,
    submitted: now(),
    request: text,
    request_file: filePath ? path.relative(project, filePath) : null,
    kind,
    target,
    status: queue ? "queued" : "received",
    reply_to: replyTo || null,
    origin_run: origin ? path.relative(project, origin) : null,
    updated: now(),
    triage: null,
    amendment: null,
    reason: queue ? "new-run queue" : null,
  };
  validateRequest(value, id);
  const file = queue
    ? path.join(queueDir, `${id}.json`)
    : run
      ? path.join(run, "requests", `${id}.json`)
      : path.join(globalDir, `${id}.json`);
  if (fs.existsSync(file)) fail(`request already exists: ${id}`);
  writeJson(file, value);
  return { file, value };
}

function cmdSubmit() {
  ensureDirs();
  const queue = flag("--queue");
  const runValue = option("--run");
  const agent = option("--agent");
  if (queue && (runValue || agent)) fail("--queue cannot be combined with --run or --agent");
  if (!queue && !!runValue === !!agent) fail("submit needs exactly one of --run, --agent, or --queue");
  if (agent) verifyAgentRole(agent);
  const id = option("--id") || requestId();
  const requestFile = option("--request-file");
  const filePath = requestFile ? resolveUnderRuns(requestFile, "--request-file") : null;
  const text = filePath ? fs.readFileSync(filePath, "utf8") : option("--request", true);
  if (!text || !text.trim()) fail("request text is empty");
  const source = option("--source") || "user";
  const kind = option("--kind") || "auto";
  if (!SOURCES.has(source)) fail(`unknown source: ${source}`);
  if (!KINDS.has(kind)) fail(`unknown kind: ${kind}`);
  const { file, value } = deliverRequest({
    queue,
    runValue,
    agent,
    id,
    text,
    filePath,
    source,
    kind,
    replyTo: option("--reply-to"),
    originRun: option("--origin-run"),
  });
  console.log(JSON.stringify({ path: path.relative(project, file), request: value }));
}

function cmdAdd() {
  ensureDirs();
  const queue = flag("--queue");
  const runValue = option("--run");
  const agent = option("--agent");
  if (queue && (runValue || agent)) fail("--queue cannot be combined with --run or --agent");
  if (!queue && !!runValue === !!agent) fail("add needs exactly one of --run, --agent, or --queue");
  if (agent) verifyAgentRole(agent);
  const id = option("--id") || requestId();
  const source = option("--source") || "user";
  const kind = option("--kind") || "auto";
  if (!SOURCES.has(source)) fail(`unknown source: ${source}`);
  if (!KINDS.has(kind)) fail(`unknown kind: ${kind}`);
  const suppliedFile = option("--file") || option("--request-file");
  let filePath = suppliedFile ? resolveUnderRuns(suppliedFile, "--file") : null;
  let text = option("--text") || option("--request");
  if (filePath) text = fs.readFileSync(filePath, "utf8");
  if (!text || !text.trim()) fail("add needs --text, --request, --file or --request-file");
  if (!filePath) {
    filePath = path.join(globalDir, `${id}.request.md`);
    if (fs.existsSync(filePath)) fail(`request file already exists: ${path.relative(project, filePath)}`);
    fs.writeFileSync(filePath, text);
  }
  const { file, value } = deliverRequest({
    queue,
    runValue,
    agent,
    id,
    text,
    filePath,
    source,
    kind,
    replyTo: option("--reply-to"),
    originRun: option("--origin-run"),
  });
  const role = option("--register");
  if (role) {
    if (!agent) fail("--register needs --agent");
    upsertAgent({ agent, requestIdValue: id, run: resolveRun(runValue), statusArg: undefined, roleArg: role });
  }
  const relative = path.relative(project, file);
  console.log(JSON.stringify({
    id,
    path: relative,
    request_file: path.relative(project, filePath),
    wake: `[request] id=${id} path=${relative}`,
    request: value,
  }));
}

function cmdList() {
  const run = resolveRun(option("--run"));
  const global = flag("--global");
  const queue = flag("--queue");
  if ([run, global, queue].filter(Boolean).length !== 1) fail("list needs exactly one of --run, --global, or --queue");
  const dir = queue ? queueDir : run ? path.join(run, "requests") : globalDir;
  const status = option("--status");
  const out = [];
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const value = readJson(path.join(dir, entry));
      if (status && value.status !== status) continue;
      out.push(value);
    }
  }
  out.sort((a, b) => String(a.submitted).localeCompare(String(b.submitted)) || String(a.id).localeCompare(String(b.id)));
  console.log(JSON.stringify(out, null, 2));
}

function cmdClaim() {
  const id = argv[1] && !argv[1].startsWith("--") ? argv[1] : option("--id", true);
  const file = findRequest(id, option("--run"));
  const value = readJson(file);
  validateRequest(value, id);
  if (value.status === "received") {
    value.status = "triaged";
    value.updated = now();
    writeJson(file, value);
  }
  console.log(JSON.stringify({ path: path.relative(project, file), request: value }));
}

function cmdAck() {
  const id = argv[1] && !argv[1].startsWith("--") ? argv[1] : option("--id", true);
  const status = option("--status", true);
  if (!STATUSES.has(status)) fail(`unknown status: ${status}`);
  const file = findRequest(id, option("--run"));
  const value = readJson(file);
  value.status = status;
  value.reason = option("--reason") || value.reason || null;
  value.updated = now();
  writeJson(file, value);
  console.log(JSON.stringify({ path: path.relative(project, file), request: value }));
}

function cmdValidate() {
  const id = argv[1] && !argv[1].startsWith("--") ? argv[1] : option("--id", true);
  const file = findRequest(id, option("--run"));
  const value = readJson(file);
  validateRequest(value, id);
  console.log(`request valid: ${id} (${value.status}, ${value.kind})`);
}

const command = argv[0];
if (command === "id") cmdId();
else if (command === "register") cmdRegister();
else if (command === "update") cmdUpdate();
else if (command === "agents") cmdAgents();
else if (command === "submit") cmdSubmit();
else if (command === "add") cmdAdd();
else if (command === "list") cmdList();
else if (command === "claim") cmdClaim();
else if (command === "ack") cmdAck();
else if (command === "validate") cmdValidate();
else fail("usage: requests.mjs <id|register|update|agents|submit|add|list|claim|ack|validate> ...");
