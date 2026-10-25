import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "requests.mjs");

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requests-"));
  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  return dir;
}

function run(dir, args) {
  return spawnSync(process.execPath, [script, ...args, "--project", dir], { encoding: "utf8" });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("request ids are unique and prefixed", () => {
  const dir = project();
  const first = run(dir, ["id"]);
  const second = run(dir, ["id"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout.trim(), /^req-/);
  assert.notEqual(first.stdout.trim(), second.stdout.trim());
});

test("register and list live agents", () => {
  const dir = project();
  json(run(dir, ["register", "--agent", "ag_1", "--request-id", "req-1", "--status", "starting", "--role", "orchestrator"]));
  json(run(dir, ["update", "--agent", "ag_1", "--status", "running", "--run", "runs/r1"]));
  const agents = json(run(dir, ["agents", "--status", "running"]));
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agent_id, "ag_1");
  assert.equal(agents[0].run_dir, "runs/r1");
  assert.equal(agents[0].role, "orchestrator");

  // A late launcher registration must not downgrade the live status or drop the role.
  json(run(dir, ["register", "--agent", "ag_1", "--request-id", "req-1"]));
  const after = json(run(dir, ["agents"]));
  assert.equal(after[0].status, "running");
  assert.equal(after[0].run_dir, "runs/r1");
  assert.equal(after[0].role, "orchestrator");
});

test("agent roles gate request delivery", () => {
  const dir = project();

  json(run(dir, ["register", "--agent", "orch", "--request-id", "req-o", "--role", "orchestrator"]));
  const accepted = json(run(dir, ["submit", "--agent", "orch", "--request", "add an appendix"]));
  assert.equal(accepted.request.target, "agent:orch");

  json(run(dir, ["register", "--agent", "plain", "--request-id", "req-p"]));
  const unverified = run(dir, ["submit", "--agent", "plain", "--request", "deliver me"]);
  assert.equal(unverified.status, 1);
  assert.match(unverified.stderr, /no recorded role/);

  json(run(dir, ["register", "--agent", "worker", "--request-id", "req-w", "--role", "worker"]));
  const blocked = run(dir, ["submit", "--agent", "worker", "--request", "deliver me"]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /registered as worker/);

  const orchestrators = json(run(dir, ["agents", "--role", "orchestrator"]));
  assert.deepEqual(orchestrators.map((entry) => entry.agent_id), ["orch"]);

  const unregistered = run(dir, ["submit", "--agent", "ghost", "--request", "deliver me"]);
  assert.equal(unregistered.status, 0, unregistered.stderr);
  assert.match(unregistered.stderr, /not registered/);
});

test("add writes the request file, submits, and prints a self-describing wake", () => {
  const dir = project();
  json(run(dir, ["register", "--agent", "orch", "--request-id", "req-o", "--role", "orchestrator"]));

  const added = json(run(dir, ["add", "--agent", "orch", "--text", "add a methods appendix", "--kind", "additive"]));
  assert.equal(added.request.status, "received");
  assert.equal(added.request.target, "agent:orch");
  assert.equal(added.request.kind, "additive");
  assert.equal(fs.readFileSync(path.join(dir, added.request_file), "utf8"), "add a methods appendix");
  assert.equal(added.wake, `[request] id=${added.id} path=${added.path}`);

  const runAdd = json(run(dir, ["add", "--run", "runs/r1", "--text", "second ask"]));
  assert.equal(runAdd.request.target, "current-run");
  assert.equal(json(run(dir, ["list", "--run", "runs/r1"]))[0].id, runAdd.id);
  assert.equal(run(dir, ["add", "--run", "runs/r1", "--id", runAdd.id, "--text", "duplicate"]).status, 1);

  const queued = json(run(dir, ["add", "--queue", "--text", "later run"]));
  assert.equal(queued.request.status, "queued");

  const launched = json(run(dir, ["add", "--agent", "orch2", "--text", "launch", "--register", "orchestrator"]));
  assert.equal(launched.request.target, "agent:orch2");
  const roles = json(run(dir, ["agents", "--role", "orchestrator"])).map(entry => entry.agent_id);
  assert.deepEqual(roles.sort(), ["orch", "orch2"]);
});

test("submit, list, claim, ack and validate a run-local request", () => {
  const dir = project();
  const submitted = json(run(dir, [
    "submit", "--run", "runs/r1", "--request", "add a methods appendix", "--source", "user",
  ]));
  const id = submitted.request.id;
  assert.equal(submitted.request.status, "received");
  assert.equal(submitted.request.target, "current-run");

  const listed = json(run(dir, ["list", "--run", "runs/r1", "--status", "received"]));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);

  const claimed = json(run(dir, ["claim", id, "--run", "runs/r1"]));
  assert.equal(claimed.request.status, "triaged");

  const accepted = json(run(dir, ["ack", id, "--status", "accepted", "--run", "runs/r1", "--reason", "additive"]));
  assert.equal(accepted.request.status, "accepted");
  assert.equal(accepted.request.reason, "additive");

  const valid = run(dir, ["validate", id, "--run", "runs/r1"]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /request valid/);
});

test("pre-intake requests target a live agent", () => {
  const dir = project();
  const submitted = json(run(dir, [
    "submit", "--agent", "ag_1", "--request", "add a glossary", "--kind", "auto",
  ]));
  assert.equal(submitted.request.target, "agent:ag_1");
  const listed = json(run(dir, ["list", "--global", "--status", "received"]));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, submitted.request.id);
});

test("request files are accepted and recorded", () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "runs", ".requests"), { recursive: true });
  const text = path.join(dir, "runs", ".requests", "req-file.request.md");
  fs.writeFileSync(text, "extend the data appendix\n");
  const submitted = json(run(dir, [
    "submit", "--run", "runs/r1", "--id", "req-file", "--request-file", "runs/.requests/req-file.request.md",
  ]));
  assert.equal(submitted.request.request, "extend the data appendix\n");
  assert.equal(submitted.request.request_file, "runs/.requests/req-file.request.md");
});

test("queued requests are written for a new run", () => {
  const dir = project();
  const submitted = json(run(dir, ["submit", "--queue", "--request", "start a separate report"]));
  assert.equal(submitted.request.target, "new-run");
  assert.equal(submitted.request.status, "queued");
  const queued = json(run(dir, ["list", "--queue", "--status", "queued"]));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, submitted.request.id);
});

test("duplicate ids and invalid sources are rejected", () => {
  const dir = project();
  assert.equal(run(dir, ["submit", "--run", "runs/r1", "--id", "req-dup", "--request", "one"]).status, 0);
  assert.equal(run(dir, ["submit", "--run", "runs/r1", "--id", "req-dup", "--request", "two"]).status, 1);
  assert.equal(run(dir, ["submit", "--run", "runs/r1", "--request", "x", "--source", "worker"]).status, 1);
  assert.equal(run(dir, ["submit", "--run", "runs/r1", "--request", "x", "--kind", "unknown"]).status, 1);
});
