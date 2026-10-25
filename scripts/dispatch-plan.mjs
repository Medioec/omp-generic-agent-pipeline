#!/usr/bin/env node
// Validate a run's dispatch plan (static DAG) or replay its dispatch log.
// Usage:
//   node scripts/dispatch-plan.mjs validate <spec.md> [--changed-from <old-spec.md>] [--json]
//   node scripts/dispatch-plan.mjs replay   <run-dir>
// Exit 0 = valid; exit 1 = invalid (messages on stderr).
// --changed-from reports only the amended units/ACs and the checks that must re-run.

import fs from "node:fs";
import path from "node:path";

const EVENTS = new Set(["dispatched", "approved", "revise", "reopened", "blocked", "blocked-verification", "skipped"]);

function fail(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  for (const message of list) console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readFile(file) {
  if (!fs.existsSync(file)) fail(`missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function extractPlan(specText) {
  const blocks = [...specText.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)].map(match => match[1]);
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch (error) {
      fail(`dispatch plan JSON does not parse: ${error.message}`);
    }
    if (parsed && Array.isArray(parsed.units)) return parsed;
  }
  fail("no fenced json block with a units array found in spec.md");
}

function stringArray(value, where, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    errors.push(`${where} must be an array of strings`);
    return [];
  }
  return value;
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function enumeratedAcs(specText) {
  const outside = specText.replace(/```json\s*\r?\n[\s\S]*?```/g, "");
  return [...new Set([...outside.matchAll(/\bAC[-\s]?(\d+)\b/g)].map(match => `AC${match[1]}`))];
}

function acParagraphs(specText) {
  const outside = specText.replace(/```json\s*\r?\n[\s\S]*?```/g, "");
  const map = new Map();
  let current = null;
  for (const line of outside.split(/\r?\n/)) {
    const heading = /^(AC\d+)\s*[—–-]\s*(.*)$/.exec(line) || /^-\s*(AC\d+)\s*[:—–-]\s*(.*)$/.exec(line);
    if (heading) {
      current = heading[1];
      map.set(current, heading[2]);
      continue;
    }
    if (/^##\s/.test(line)) {
      current = null;
      continue;
    }
    if (current) map.set(current, `${map.get(current)} ${line}`);
  }
  for (const [id, text] of map) map.set(id, normalizeText(text));
  return map;
}

function specSections(specText) {
  const map = new Map();
  const parts = specText.split(/^## /m);
  const preamble = parts.shift() ?? "";
  map.set("(preamble)", normalizeText(preamble));
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const title = (newline === -1 ? part : part.slice(0, newline)).trim();
    map.set(title, normalizeText(newline === -1 ? "" : part.slice(newline + 1)));
  }
  return map;
}

function dependentsMap(plan) {
  const map = new Map(plan.units.map(unit => [unit.id, []]));
  for (const unit of plan.units) {
    for (const dep of unit.deps ?? []) {
      if (map.has(dep)) map.get(dep).push(unit.id);
    }
  }
  return map;
}

function reachableFrom(dependents, ids) {
  const seen = new Set();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of dependents.get(id) ?? []) stack.push(next);
  }
  return [...seen].sort();
}

const DIFF_FIELDS = ["objective", "deps", "acs", "reads", "writes", "resources"];

function normalizedField(unit, field) {
  const value = unit[field];
  if (Array.isArray(value)) return JSON.stringify([...new Set(value)].sort());
  return JSON.stringify(value ?? "");
}

function incrementalDiff(oldSpec, newSpec, oldPlan, newPlan) {
  const unitDiff = { added: [], removed: [], changed: [] };
  const oldUnits = new Map(oldPlan.units.map(unit => [unit.id, unit]));
  const newUnits = new Map(newPlan.units.map(unit => [unit.id, unit]));
  for (const id of newUnits.keys()) {
    if (!oldUnits.has(id)) unitDiff.added.push(id);
  }
  for (const id of oldUnits.keys()) {
    if (!newUnits.has(id)) unitDiff.removed.push(id);
  }
  for (const [id, unit] of newUnits) {
    const previous = oldUnits.get(id);
    if (!previous) continue;
    const fields = DIFF_FIELDS.filter(field => normalizedField(previous, field) !== normalizedField(unit, field));
    if (fields.length) unitDiff.changed.push({ id, fields });
  }
  unitDiff.added.sort();
  unitDiff.removed.sort();
  unitDiff.changed.sort((a, b) => a.id.localeCompare(b.id));

  const oldParagraphs = acParagraphs(oldSpec);
  const newParagraphs = acParagraphs(newSpec);
  const oldAcs = new Set([...enumeratedAcs(oldSpec), ...oldParagraphs.keys()]);
  const newAcs = new Set([...enumeratedAcs(newSpec), ...newParagraphs.keys()]);
  const acDiff = { added: [], removed: [], modified: [] };
  for (const id of newAcs) {
    if (!oldAcs.has(id)) acDiff.added.push(id);
    else if (oldParagraphs.has(id) && newParagraphs.has(id) && oldParagraphs.get(id) !== newParagraphs.get(id)) {
      acDiff.modified.push(id);
    }
  }
  for (const id of oldAcs) {
    if (!newAcs.has(id)) acDiff.removed.push(id);
  }
  const sortAc = (a, b) => Number(a.slice(2)) - Number(b.slice(2));
  acDiff.added.sort(sortAc);
  acDiff.removed.sort(sortAc);
  acDiff.modified.sort(sortAc);

  const oldSections = specSections(oldSpec);
  const newSections = specSections(newSpec);
  const sectionsChanged = [];
  for (const [title, text] of newSections) {
    if (title === "Dispatch plan") continue;
    if (oldSections.get(title) !== text) sectionsChanged.push(title);
  }
  for (const title of oldSections.keys()) {
    if (title === "Dispatch plan") continue;
    if (!newSections.has(title)) sectionsChanged.push(`${title} (removed)`);
  }

  const touched = [
    ...unitDiff.added,
    ...unitDiff.removed,
    ...unitDiff.changed.map(entry => entry.id),
  ];
  const affectedUnits = touched.length
    ? reachableFrom(dependentsMap(newPlan), touched.filter(id => newUnits.has(id)))
    : [];

  const rerun = new Set();
  const changedAcs = [...acDiff.added, ...acDiff.removed, ...acDiff.modified];
  if (changedAcs.length) {
    rerun.add(`AC traceability and testability (${changedAcs.join(", ")})`);
    rerun.add(`addendum coverage (${changedAcs.join(", ")})`);
  }
  if (touched.length) {
    rerun.add(`unit ownership and read/write edges (${touched.join(", ")})`);
    rerun.add("dependency graph and reachability");
  }
  if (unitDiff.changed.some(entry => entry.fields.some(field => field === "reads" || field === "writes" || field === "resources"))) {
    rerun.add("single ownership and resource conflicts");
  }
  if (sectionsChanged.includes("Safety constraints")) {
    rerun.add("safety constraints (full re-read)");
  }
  if (sectionsChanged.some(title => title === "Scope" || title === "Work type, deliverable, verification")) {
    rerun.add("feasibility and AC realism");
  }
  if (sectionsChanged.includes("Objective alignment")) {
    rerun.add("objective alignment");
  }
  if (!rerun.size) rerun.add("none (no plan or AC change detected)");

  return {
    fromVersion: oldPlan.version,
    toVersion: newPlan.version,
    acs: acDiff,
    units: unitDiff,
    sectionsChanged,
    affectedUnits,
    rerun: [...rerun],
  };
}

function validatePlan(plan, specText) {
  const errors = [];
  if (!Number.isInteger(plan.version) || plan.version < 1) errors.push("version must be an integer >= 1");
  const maxConcurrency = plan.maxConcurrency === undefined ? 8 : plan.maxConcurrency;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) {
    errors.push("maxConcurrency must be an integer between 1 and 32");
  }
  if (!Array.isArray(plan.units) || plan.units.length === 0) fail("plan.units must be a non-empty array");

  const ids = new Set();
  const byId = new Map();
  for (const [index, unit] of plan.units.entries()) {
    const where = `units[${index}]`;
    if (!unit || typeof unit.id !== "string" || !unit.id.trim()) {
      errors.push(`${where}.id must be a non-empty string`);
      continue;
    }
    if (ids.has(unit.id)) errors.push(`duplicate unit id: ${unit.id}`);
    ids.add(unit.id);
    byId.set(unit.id, unit);
    if (typeof unit.objective !== "string" || !unit.objective.trim()) errors.push(`${unit.id}: objective is required`);
    unit._deps = stringArray(unit.deps, `${unit.id}.deps`, errors);
    unit._acs = stringArray(unit.acs, `${unit.id}.acs`, errors);
    unit._reads = stringArray(unit.reads, `${unit.id}.reads`, errors);
    unit._writes = stringArray(unit.writes, `${unit.id}.writes`, errors);
    unit._resources = stringArray(unit.resources, `${unit.id}.resources`, errors);
  }

  for (const unit of byId.values()) {
    for (const dep of unit._deps) {
      if (dep === unit.id) errors.push(`${unit.id}: self dependency`);
      else if (!byId.has(dep)) errors.push(`${unit.id}: unknown dependency ${dep}`);
    }
  }
  if (errors.length) fail(errors);

  // Acyclicity (Kahn).
  const indegree = new Map([...byId.keys()].map(id => [id, 0]));
  const dependents = new Map([...byId.keys()].map(id => [id, []]));
  for (const unit of byId.values()) {
    for (const dep of new Set(unit._deps)) {
      indegree.set(unit.id, indegree.get(unit.id) + 1);
      dependents.get(dep).push(unit.id);
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited++;
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== byId.size) errors.push("dependency graph contains a cycle");

  // AC ownership.
  const owners = new Map();
  for (const unit of byId.values()) {
    if (unit._acs.includes("*")) {
      if (dependents.get(unit.id).length > 0) errors.push(`${unit.id}: "*" is only allowed on a sink unit`);
      continue;
    }
    for (const ac of unit._acs) {
      if (owners.has(ac)) errors.push(`acceptance criterion ${ac} is owned by both ${owners.get(ac)} and ${unit.id}`);
      else owners.set(ac, unit.id);
    }
  }
  const sinks = [...byId.values()].filter(unit => dependents.get(unit.id).length === 0);
  for (const sink of sinks) {
    for (const other of byId.values()) {
      if (other.id === sink.id) continue;
      // Every unit must reach every wildcard sink.
      if (sink._acs.includes("*") && !reachesDependents(dependents, other.id, sink.id)) {
        errors.push(`${other.id} cannot reach wildcard sink ${sink.id}`);
      }
    }
  }

  // AC coverage against the spec text, when the spec enumerates ACs.
  const planBlock = /```json\s*\r?\n[\s\S]*?```/g;
  const specOutsidePlan = specText.replace(planBlock, "");
  const specAcs = [...new Set([...specOutsidePlan.matchAll(/\bAC[-\s]?(\d+)\b/g)].map(match => `AC${match[1]}`))];
  const wildcard = [...byId.values()].some(unit => unit._acs.includes("*"));
  if (!wildcard && specAcs.length) {
    for (const ac of specAcs) {
      if (!owners.has(ac)) errors.push(`acceptance criterion ${ac} has no owning unit`);
    }
    for (const ac of owners.keys()) {
      if (!specAcs.includes(ac)) errors.push(`unit owns ${ac}, which the spec does not enumerate`);
    }
  }

  if (errors.length) fail(errors);
  const edgeCount = [...byId.values()].reduce((sum, unit) => sum + new Set(unit._deps).size, 0);
  return { plan, byId, edges: edgeCount, sinks };
}

function reachesDependents(dependents, from, target) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of dependents.get(id) || []) stack.push(next);
  }
  return false;
}

function metricsEntries(logText) {
  const numbers = new Set();
  let inSection = false;
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^##\s+Dispatch metrics\b/i.test(line)) { inSection = true; continue; }
    if (inSection && /^##\s+Improver passes\b/i.test(line)) continue;
    if (inSection && /^##\s/.test(line)) { inSection = false; continue; }
    if (!inSection) continue;
    const match = /^[-*]\s+(\d+)\b/.exec(line);
    if (match) numbers.add(Number(match[1]));
  }
  return { present: /^##\s+Dispatch metrics\b/im.test(logText), numbers };
}

function parseLog(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
    if (!cells.length || !/^\d+$/.test(cells[0])) continue;
    if (cells.length < 7) fail(`dispatch.md row has ${cells.length} columns, expected at least 7: ${line}`);
    const [seq, unit, event, dispatch, base, deps] = cells;
    const note = cells.slice(7).join(" | ");
    rows.push({ seq: Number(seq), unit, event, dispatch: Number(dispatch), base, deps, note });
  }
  return rows;
}

function replay(runDir) {
  const specPath = path.join(runDir, "spec.md");
  const logPath = path.join(runDir, "dispatch.md");
  const specText = readFile(specPath);
  const plan = extractPlan(specText);
  const { byId } = validatePlan(plan, specText);
  const logText = readFile(logPath);
  const rows = parseLog(logText);
  const metrics = metricsEntries(logText);
  const errors = [];
  const state = new Map([...byId.keys()].map(id => [id, { status: "pending", dispatch: 0 }]));
  const inFlight = new Map();
  let expectedSeq = 1;
  let expectedDispatch = 1;

  for (const row of rows) {
    if (row.seq !== expectedSeq) errors.push(`seq ${row.seq} out of order (expected ${expectedSeq})`);
    expectedSeq = row.seq + 1;
    const unit = byId.get(row.unit);
    if (!unit) {
      errors.push(`seq ${row.seq}: unknown unit ${row.unit}`);
      continue;
    }
    if (!EVENTS.has(row.event)) {
      errors.push(`seq ${row.seq}: unknown event ${row.event}`);
      continue;
    }
    const current = state.get(row.unit);

    if (row.event === "dispatched") {
      if (current.status === "approved") errors.push(`seq ${row.seq}: ${row.unit} is already approved`);
      if (inFlight.has(row.unit)) errors.push(`seq ${row.seq}: ${row.unit} is already in flight`);
      for (const dep of unit._deps) {
        const depState = state.get(dep);
        if (!depState || depState.status !== "approved") {
          errors.push(`seq ${row.seq}: ${row.unit} dispatched before dependency ${dep} was approved (${depState ? depState.status : "unknown"})`);
        }
      }
      if (row.dispatch !== expectedDispatch) {
        errors.push(
          `seq ${row.seq}: dispatch ${row.dispatch}, expected ${expectedDispatch} — "dispatch" must be the run-global ordinal of ` +
            "dispatched rows (1, 2, 3, ... with no gaps); a revision, a reopen and a second unit each take the next number, " +
            "not a per-unit counter. Renumber the log rather than renaming round files.",
        );
      }
      expectedDispatch = row.dispatch + 1;
      for (const [otherId, otherUnit] of inFlight) {
        const shared = unit._resources.filter(resource => otherUnit._resources.includes(resource));
        if (shared.length) errors.push(`seq ${row.seq}: ${row.unit} and ${otherId} share resource(s) ${shared.join(", ")}`);
      }
      current.status = "in_flight";
      current.dispatch = row.dispatch;
      inFlight.set(row.unit, unit);
      continue;
    }

    if (row.event === "skipped") {
      if (current.status !== "pending") errors.push(`seq ${row.seq}: only a pending unit may be skipped`);
      current.status = "skipped";
      continue;
    }

    if (row.event === "reopened") {
      if (current.status !== "approved") errors.push(`seq ${row.seq}: only an approved unit may be reopened`);
      current.status = "revise";
      continue;
    }

    if (current.status !== "in_flight" || current.dispatch !== row.dispatch) {
      errors.push(`seq ${row.seq}: ${row.event} for ${row.unit} without a matching dispatched row`);
      continue;
    }
    inFlight.delete(row.unit);

    if (row.event === "approved") {
      const roundFile = path.join(runDir, "worker", `round-${row.dispatch}.md`);
      if (!fs.existsSync(roundFile)) {
        errors.push(`seq ${row.seq}: ${row.unit} approved without ${path.relative(runDir, roundFile)}`);
      } else {
        const content = fs.readFileSync(roundFile, "utf8");
        if (!/^## Completion\b/m.test(content)) errors.push(`seq ${row.seq}: ${row.unit} round ${row.dispatch} lacks ## Completion`);
        if (/^## Proposed Next Steps\b/m.test(content)) {
          errors.push(`seq ${row.seq}: ${row.unit} approved on an increment round (## Proposed Next Steps present)`);
        }
      }
      current.status = "approved";
    } else if (row.event === "revise") {
      current.status = "revise";
    } else if (row.event === "blocked" || row.event === "blocked-verification") {
      current.status = row.event;
    }
  }

  const dispatched = rows.filter(row => row.event === "dispatched");
  const settled = new Set(rows.filter(row => row.event !== "dispatched").map(row => row.dispatch));
  if (dispatched.length && !metrics.present) {
    errors.push(
      "dispatch.md has no ## Dispatch metrics section under the event table — add one bullet per settled dispatch " +
        "(`- <dispatch> <unit> <agent id> dur=<duration> tokens=<n> req=<n> rev=<n>`, `—` for a field the dispatch result " +
        "does not report). It is the only cost record the improver gets, and a transcript keeps none of it.",
    );
  } else {
    for (const row of dispatched) {
      if (!settled.has(row.dispatch) || metrics.numbers.has(row.dispatch)) continue;
      errors.push(
        `seq ${row.seq}: dispatch ${row.dispatch} (${row.unit}) is settled but has no ## Dispatch metrics bullet — ` +
          "record `- <dispatch> <unit> <agent id> dur=<duration> tokens=<n> req=<n> rev=<n>` with `—` for unreported fields.",
      );
    }
  }

  for (const [id, current] of state) {
    if (current.status === "in_flight") errors.push(`${id} is in flight at the end of the log`);
  }
  if (errors.length) fail(errors);

  const counts = {};
  for (const current of state.values()) counts[current.status] = (counts[current.status] || 0) + 1;
  return { units: state.size, dispatches: rows.filter(row => row.event === "dispatched").length, counts };
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const target = args[1] && !args[1].startsWith("--") ? args[1] : null;
  const flagValue = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  if (command === "validate" && target) {
    const specText = readFile(target);
    const plan = extractPlan(specText);
    const result = validatePlan(plan, specText);
    const changedFrom = flagValue("--changed-from");
    if (!changedFrom) {
      console.log(`dispatch plan valid: ${result.byId.size} units, ${result.edges} edges, version ${plan.version}`);
      return;
    }
    const oldSpecText = readFile(changedFrom);
    const oldPlan = extractPlan(oldSpecText);
    if (!(plan.version > oldPlan.version)) {
      fail(`amendment must increase the plan version: ${changedFrom} is version ${oldPlan.version}, ${target} is version ${plan.version}`);
    }
    const diff = incrementalDiff(oldSpecText, specText, oldPlan, plan);
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        valid: true,
        units: result.byId.size,
        edges: result.edges,
        version: plan.version,
        incremental: diff,
      }, null, 2));
      return;
    }
    console.log(`dispatch plan valid: ${result.byId.size} units, ${result.edges} edges, version ${plan.version}`);
    console.log(`incremental: version ${diff.fromVersion} -> ${diff.toVersion}`);
    const list = values => (values.length ? values.join(", ") : "none");
    console.log(`changed ACs: added [${list(diff.acs.added)}], removed [${list(diff.acs.removed)}], modified [${list(diff.acs.modified)}]`);
    console.log(`changed units: added [${list(diff.units.added)}], removed [${list(diff.units.removed)}], modified [${list(diff.units.changed.map(entry => `${entry.id}(${entry.fields.join("/")})`))}]`);
    console.log(`changed spec sections: ${list(diff.sectionsChanged)}`);
    console.log(`affected units (dependents closure): ${list(diff.affectedUnits)}`);
    console.log(`re-run checks: ${diff.rerun.join("; ")}`);
    return;
  }
  if (command === "replay" && target) {
    const result = replay(target);
    console.log(`dispatch replay valid: ${result.units} units, ${result.dispatches} dispatches, ${JSON.stringify(result.counts)}`);
    return;
  }
  fail("usage: node scripts/dispatch-plan.mjs <validate <spec.md> [--changed-from <old-spec.md>] [--json]|replay <run-dir>>");
}

main();
