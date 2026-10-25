import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dispatch-plan.mjs");

function plan(units, extra = {}) {
  return JSON.stringify({ version: 1, maxConcurrency: 8, units, ...extra }, null, 2);
}

function spec({ acs = ["AC1"], units, prose = "", version = 1, acceptance = null }) {
  const acceptanceText = acceptance ?? (acs.length ? `## Acceptance criteria\n${acs.map(ac => `- ${ac}: testable`).join("\n")}\n` : "");
  return `# Spec\n\n${prose}\n${acceptanceText}\n## Dispatch plan\n\n\`\`\`json\n${plan(units, { version })}\n\`\`\`\n`;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function metricsBlock(log) {
  const numbers = [...log.matchAll(/^\|\s*\d+\s*\|\s*[^|]+\|\s*dispatched\s*\|\s*(\d+)\s*\|/gm)].map(match => Number(match[1]));
  if (!numbers.length) return "";
  return `\n## Dispatch metrics\n\n${numbers.map(number => `- ${number} unit dur=— tokens=— req=— rev=0`).join("\n")}\n`;
}

function fixture({ acs, units, log, rounds = {}, metrics = true, prose = "" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-plan-"));
  fs.writeFileSync(path.join(dir, "spec.md"), spec({ acs, units, prose }));
  fs.writeFileSync(path.join(dir, "dispatch.md"), metrics ? `${log}${metricsBlock(log)}` : log);
  fs.mkdirSync(path.join(dir, "worker"), { recursive: true });
  for (const [number, body] of Object.entries(rounds)) {
    fs.writeFileSync(path.join(dir, "worker", `round-${number}.md`), body);
  }
  return dir;
}

const unit = (id, deps = [], acs = [], resources = []) => ({
  id, objective: id, deps, acs, reads: [], writes: [], resources,
});

const logRow = (seq, id, event, dispatch, deps = "—") =>
  `| ${seq} | ${id} | ${event} | ${dispatch} | abc | ${deps} | ag_${seq} | |`;

const complete = "# round\n\n## Completion\nok\n";
const increment = "# round\n\n## Proposed Next Steps\n- more\n\n## Completion\nok\n";

test("valid plan and valid replay pass", () => {
  const validUnits = [unit("R1"), unit("W1", ["R1"], ["AC1"])];
  const dir = fixture({
    acs: ["AC1"],
    units: validUnits,
    log: [
      logRow(1, "R1", "dispatched", 1),
      logRow(2, "R1", "approved", 1),
      logRow(3, "W1", "dispatched", 2, "R1=approved"),
      logRow(4, "W1", "approved", 2),
      "",
    ].join("\n"),
    rounds: { 1: complete, 2: complete },
  });
  assert.equal(run(["validate", path.join(dir, "spec.md")]).status, 0);
  const replay = run(["replay", dir]);
  assert.equal(replay.status, 0, replay.stderr);
});

test("an addendum AC and a new unit replay after an approved unit", () => {
  const dir = fixture({
    acs: ["AC1"],
    prose: "## Addendum 1 — req-1\n- AC2: append a methods note\n",
    units: [unit("A", [], ["AC1"]), unit("B", [], ["AC2"])],
    log: [
      logRow(1, "A", "dispatched", 1),
      logRow(2, "A", "approved", 1),
      logRow(3, "B", "dispatched", 2),
      logRow(4, "B", "approved", 2),
      "",
    ].join("\n"),
    rounds: { 1: complete, 2: complete },
  });
  const replay = run(["replay", dir]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /"approved":2/);
});

test("control dispatches are ignored by replay", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("R1", [], ["AC1"])],
    log: [
      logRow(1, "R1", "dispatched", 1),
      logRow(2, "R1", "approved", 1),
      "",
      "## Control dispatches",
      "",
      "| c | role | mode | target | agent | status | report |",
      "|---|------|------|--------|-------|--------|--------|",
      "| c1 | intake | setup | run | ag_x | settled | control/c1-intake.md |",
      "| c2 | integrate | merge | units | ag_y | settled | control/c2-integrate.md |",
      "",
    ].join("\n"),
    rounds: { 1: complete },
  });
  const replay = run(["replay", dir]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /"approved":1/);
});

test("a cycle is rejected", () => {
  const dir = fixture({
    acs: [],
    units: [unit("A", ["B"]), unit("B", ["A"])],
    log: "",
  });
  assert.equal(run(["validate", path.join(dir, "spec.md")]).status, 1);
});

test("duplicate AC ownership is rejected", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("A", [], ["AC1"]), unit("B", [], ["AC1"])],
    log: "",
  });
  assert.equal(run(["validate", path.join(dir, "spec.md")]).status, 1);
});

test("an unowned AC is rejected", () => {
  const dir = fixture({
    acs: ["AC1", "AC2"],
    units: [unit("A", [], ["AC1"])],
    log: "",
  });
  assert.equal(run(["validate", path.join(dir, "spec.md")]).status, 1);
});

test("a wildcard on a non-sink is rejected", () => {
  const dir = fixture({
    acs: [],
    units: [unit("A", [], ["*"]), unit("B", ["A"], ["AC1"])],
    log: "",
  });
  assert.equal(run(["validate", path.join(dir, "spec.md")]).status, 1);
});

test("dispatching before a dependency is approved is rejected", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("R1"), unit("W1", ["R1"], ["AC1"])],
    log: [
      logRow(1, "R1", "dispatched", 1),
      logRow(2, "W1", "dispatched", 2),
      "",
    ].join("\n"),
    rounds: { 1: complete, 2: complete },
  });
  assert.equal(run(["replay", dir]).status, 1);
});

test("concurrent units sharing a resource is rejected", () => {
  const dir = fixture({
    acs: ["AC1", "AC2"],
    units: [unit("A", [], ["AC1"], ["port:8101"]), unit("B", [], ["AC2"], ["port:8101"])],
    log: [logRow(1, "A", "dispatched", 1), logRow(2, "B", "dispatched", 2), ""].join("\n"),
    rounds: { 1: complete, 2: complete },
  });
  assert.equal(run(["replay", dir]).status, 1);
});

test("approval on an increment round is rejected", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("A", [], ["AC1"])],
    log: [logRow(1, "A", "dispatched", 1), logRow(2, "A", "approved", 1), ""].join("\n"),
    rounds: { 1: increment },
  });
  assert.equal(run(["replay", dir]).status, 1);
});

test("approval without a round file is rejected", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("A", [], ["AC1"])],
    log: [logRow(1, "A", "dispatched", 1), logRow(2, "A", "approved", 1), ""].join("\n"),
    rounds: {},
  });
  assert.equal(run(["replay", dir]).status, 1);
});

test("a terminal event without a dispatch is rejected", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("A", [], ["AC1"])],
    log: [logRow(1, "A", "approved", 1), ""].join("\n"),
    rounds: { 1: complete },
  });
  assert.equal(run(["replay", dir]).status, 1);
});

test("revision followed by re-dispatch is accepted", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("A", [], ["AC1"])],
    log: [
      logRow(1, "A", "dispatched", 1),
      logRow(2, "A", "revise", 1),
      logRow(3, "A", "dispatched", 2),
      logRow(4, "A", "approved", 2),
      "",
    ].join("\n"),
    rounds: { 1: complete, 2: complete },
  });
  assert.equal(run(["replay", dir]).status, 0);
});

test("an approved unit may be reopened for merge-conflict rework", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("A", [], ["AC1"])],
    log: [
      logRow(1, "A", "dispatched", 1),
      logRow(2, "A", "approved", 1),
      logRow(3, "A", "reopened", 1),
      logRow(4, "A", "dispatched", 2),
      logRow(5, "A", "approved", 2),
      "",
    ].join("\n"),
    rounds: { 1: complete, 2: complete },
  });
  assert.equal(run(["replay", dir]).status, 0);
});

test("a per-unit dispatch counter is rejected as an ordinal violation", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("R1"), unit("W1", ["R1"], ["AC1"])],
    log: [
      logRow(1, "R1", "dispatched", 1),
      logRow(2, "R1", "approved", 1),
      logRow(3, "W1", "dispatched", 1, "R1=approved"),
      logRow(4, "W1", "approved", 1),
      "",
    ].join("\n"),
    rounds: { 1: complete },
  });
  const replay = run(["replay", dir]);
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /run-global ordinal/, "the error must name the run-global ordinal rule");
});

test("a settled dispatch without a metrics bullet is rejected", () => {
  const dir = fixture({
    acs: ["AC1"],
    units: [unit("A", [], ["AC1"])],
    log: [logRow(1, "A", "dispatched", 1), logRow(2, "A", "approved", 1), ""].join("\n"),
    rounds: { 1: complete },
    metrics: false,
  });
  const replay = run(["replay", dir]);
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /## Dispatch metrics/, "the error must name the missing metrics section");
});

test("improver passes are recorded outside the worker dispatch metrics", () => {
  const units = [unit("A", [], ["AC1"])];
  const log = [logRow(1, "A", "dispatched", 1), logRow(2, "A", "approved", 1), ""].join("\n");
  const dir = fixture({ acs: ["AC1"], units, log, rounds: { 1: complete } });
  fs.appendFileSync(
    path.join(dir, "dispatch.md"),
    "\n## Improver passes\n\n- s1 woke trigger=intake commit=none\n",
  );
  const replay = run(["replay", dir]);
  assert.equal(replay.status, 0, replay.stderr);
});

test("an improver bullet does not satisfy a missing worker metrics bullet", () => {
  const units = [unit("A", [], ["AC1"])];
  const log = [logRow(1, "A", "dispatched", 1), logRow(2, "A", "approved", 1), ""].join("\n");
  const dir = fixture({ acs: ["AC1"], units, log, rounds: { 1: complete }, metrics: false });
  fs.appendFileSync(
    path.join(dir, "dispatch.md"),
    "\n## Improver passes\n\n- s1 woke trigger=intake commit=none\n",
  );
  const replay = run(["replay", dir]);
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /## Dispatch metrics/, "the error must still name the missing worker metrics");
});

test("metrics stay readable when a bullet follows the improver section", () => {
  const units = [unit("A", [], ["AC1"]), unit("B", [], ["AC2"])];
  const log = [
    logRow(1, "A", "dispatched", 1),
    logRow(2, "A", "approved", 1),
    logRow(3, "B", "dispatched", 2),
    logRow(4, "B", "approved", 2),
    "",
  ].join("\n");
  const dir = fixture({ acs: ["AC1", "AC2"], units, log, rounds: { 1: complete, 2: complete }, metrics: false });
  fs.writeFileSync(
    path.join(dir, "dispatch.md"),
    [
      log,
      "## Dispatch metrics",
      "",
      "- 1 A ag_1 dur=— tokens=— req=— rev=0",
      "",
      "## Improver passes",
      "",
      "- s1 woke trigger=intake commit=none",
      "",
      "- 2 B ag_3 dur=— tokens=— req=— rev=0",
      "",
    ].join("\n"),
  );
  const replay = run(["replay", dir]);
  assert.equal(replay.status, 0, replay.stderr);
});

test("a wildcard sink covers the spec and is reachable from every unit", () => {
  const dir = fixture({
    acs: ["AC1", "AC2"],
    units: [unit("A", [], ["AC1"]), unit("B", [], ["AC2"]), unit("F", ["A", "B"], ["*"])],
    log: "",
  });
  assert.equal(run(["validate", path.join(dir, "spec.md")]).status, 0);
});

test("a unit that cannot reach the wildcard sink is rejected", () => {
  const dir = fixture({
    acs: ["AC1", "AC2"],
    units: [unit("A", [], ["AC1"]), unit("B", [], ["AC2"]), unit("F", ["A"], ["*"])],
    log: "",
  });
  assert.equal(run(["validate", path.join(dir, "spec.md")]).status, 1);
});

test("incremental validate reports only amended ACs, units and checks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-incr-"));
  const acceptanceV1 = "## Acceptance criteria\nAC1 - first rule\n\nAC2 - second rule\n";
  const acceptanceV2 = "## Acceptance criteria\nAC1 - first rule\n\nAC2 - second rule, amended\n\nAC3 - third rule\n";
  const v1Units = [unit("A", [], ["AC1"]), unit("B", [], ["AC2"])];
  const v2Units = [unit("A", [], ["AC1"]), unit("B", ["A"], ["AC2"]), unit("C", ["B"], ["AC3"])];
  fs.writeFileSync(path.join(dir, "v1.md"), spec({ version: 1, acceptance: acceptanceV1, units: v1Units }));
  fs.writeFileSync(path.join(dir, "v2.md"), spec({ version: 2, acceptance: acceptanceV2, units: v2Units }));

  const result = run(["validate", path.join(dir, "v2.md"), "--changed-from", path.join(dir, "v1.md"), "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.incremental.fromVersion, 1);
  assert.equal(out.incremental.toVersion, 2);
  assert.deepEqual(out.incremental.acs.added, ["AC3"]);
  assert.deepEqual(out.incremental.acs.modified, ["AC2"]);
  assert.deepEqual(out.incremental.acs.removed, []);
  assert.deepEqual(out.incremental.units.added, ["C"]);
  assert.deepEqual(out.incremental.units.changed.map(entry => entry.id), ["B"]);
  assert.ok(out.incremental.affectedUnits.includes("B"));
  assert.ok(out.incremental.affectedUnits.includes("C"));
  assert.ok(out.incremental.rerun.some(check => check.includes("AC2")));
  assert.ok(out.incremental.rerun.some(check => check.includes("B")));

  const same = run(["validate", path.join(dir, "v2.md"), "--changed-from", path.join(dir, "v2.md")]);
  assert.equal(same.status, 1);
  assert.match(same.stderr, /must increase the plan version/);
});
