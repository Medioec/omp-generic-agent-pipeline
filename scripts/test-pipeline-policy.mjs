import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePolicy } from "../.omp/extensions/pipeline-policy/policy.mjs";

const cwd = "/tmp/omp-pipeline-policy-test";

function blocked(result) {
  return result !== null && result.block === true;
}

test("unknown agents are not constrained", () => {
  assert.equal(evaluatePolicy({ agentName: "reviewer", toolName: "ask", input: {}, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "task", toolName: "bash", input: { command: "rm -rf x" }, cwd }), null);
});

test("orchestrator writes only its own decision records", () => {
  for (const record of ["dispatch.md", "issues.md", "verdict.md"]) {
    assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: `runs/x/${record}` }, cwd }), null);
  }
  for (const delegated of ["spec.md", "summary.md", "improvement.md", "manifest.json", "objective.snapshot.md"]) {
    assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: `runs/x/${delegated}` }, cwd })), true);
  }
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "runs/x/delta/facts.json" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "runs/x/worker/round-1.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "runs/x/control/c1-intake.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "memory/runs/x/spec.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "src/app.ts" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "edit", input: { path: ".omp/config.yml" }, cwd })), true);
});

test("orchestrator runs only the request and dispatch-plan helpers", () => {
  for (const command of [
    "node scripts/requests.mjs claim req-1 --run runs/x",
    "node scripts/requests.mjs ack req-1 --status accepted --run runs/x --reason additive",
    "node scripts/requests.mjs list --run runs/x",
    "node scripts/dispatch-plan.mjs validate runs/x/spec.md --changed-from runs/x/spec.v1.md",
  ]) {
    assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "bash", input: { command }, cwd }), null);
  }
  for (const command of [
    "node scripts/bootstrap.mjs --check",
    "bash scripts/workspace.sh check-live runs/x",
    "git rev-parse HEAD",
    "node scripts/requests.mjs submit --run runs/x --request x",
    "node scripts/dispatch-plan.mjs replay runs/x",
    "node scripts/requests.mjs claim req-1; rm -rf runs/x",
    "node scripts/requests.mjs claim req-1 | tee out",
  ]) {
    assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "bash", input: { command }, cwd })), true);
  }
});

test("orchestrator may coordinate through agent and proc URLs", () => {
  assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "agent://worker-1" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "proc://job-1/kill" }, cwd }), null);
});

test("orchestrator may spawn only the worker; the improver is a sibling", () => {
  assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "task", input: { agent: "worker" }, cwd }), null);
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "task", input: { tasks: [{ agent: "improver" }] }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "task", input: { agent: "scout" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "orchestrator", toolName: "task", input: {}, cwd })), true);
  assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "agent://improver" }, cwd }), null);
});

test("improver may read and message peers but never spawn or write the registry", () => {
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: "agent://orchestrator" }, cwd }), null);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "task", input: { agent: "worker" }, cwd })), true);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: ".omp/pipeline-backlog.md" }, cwd }), null);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: "runs/.agents/ag_1.json" }, cwd })), true);
});

test("worker may not write shared memory, review files or verdict.md", () => {
  assert.equal(evaluatePolicy({ agentName: "worker", toolName: "write", input: { path: "src/app.ts" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "worker", toolName: "write", input: { path: "runs/r/worker/round-1.md" }, cwd }), null);
  assert.equal(blocked(evaluatePolicy({ agentName: "worker", toolName: "write", input: { path: "runs/r/review/round-1.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "worker", toolName: "write", input: { path: "runs/r/verdict.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "worker", toolName: "write", input: { path: "memory/runs/r/worker/round-1.md" }, cwd })), true);
});

test("workers and the improver may not write request or registry files", () => {
  for (const agentName of ["worker", "improver"]) {
    for (const target of [
      "runs/r/requests/req-1.json",
      "runs/.requests/req-1.json",
      "runs/.agents/ag_1.json",
      "runs/.queue/req-1.json",
    ]) {
      assert.equal(blocked(evaluatePolicy({ agentName, toolName: "write", input: { path: target }, cwd })), true, `${agentName} ${target}`);
    }
  }
  assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "runs/r/requests/req-1.json" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "runs/.agents/ag_1.json" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "orchestrator", toolName: "write", input: { path: "runs/.queue/req-1.json" }, cwd }), null);
});

test("workers and the improver may not write request files through bash", () => {
  for (const command of [
    "printf x > runs/r/requests/req-1.json",
    "rm runs/.agents/ag_1.json",
    "sed -i s/a/b/ runs/r/requests/req-1.json",
    "git add runs/.queue/req-1.json",
  ]) {
    assert.equal(blocked(evaluatePolicy({ agentName: "worker", toolName: "bash", input: { command }, cwd })), true, command);
  }
  assert.equal(evaluatePolicy({ agentName: "worker", toolName: "bash", input: { command: "cat runs/r/requests/req-1.json" }, cwd }), null);
  assert.equal(blocked(evaluatePolicy({ agentName: "worker", toolName: "bash", input: { command: "node scripts/requests.mjs submit --run runs/r --request x" }, cwd })), true);
  assert.equal(evaluatePolicy({ agentName: "worker", toolName: "bash", input: { command: "node scripts/requests.mjs list --run runs/r" }, cwd }), null);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "git add runs/r/requests/req-1.json" }, cwd })), true);
});

test("worker control roles can write their reports and run artifacts", () => {
  for (const target of [
    "runs/r/control/c1-intake.md",
    "runs/r/spec.md",
    "runs/r/issues.md",
    "runs/r/dispatch.md",
    "runs/r/summary.md",
    "runs/r/manifest.json",
  ]) {
    assert.equal(evaluatePolicy({ agentName: "worker", toolName: "write", input: { path: target }, cwd }), null, target);
  }
});

test("worker and advisor may not use ask", () => {
  assert.equal(blocked(evaluatePolicy({ agentName: "worker", toolName: "ask", input: {}, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "advisor", toolName: "ask", input: {}, cwd })), true);
});

test("advisor is read-only for files but may run bash", () => {
  assert.equal(blocked(evaluatePolicy({ agentName: "advisor", toolName: "write", input: { path: "runs/r/review/round-1.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "advisor", toolName: "edit", input: { path: "src/app.ts" }, cwd })), true);
  assert.equal(evaluatePolicy({ agentName: "advisor", toolName: "bash", input: { command: "node --test tests" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "advisor", toolName: "advise", input: { note: "x" }, cwd }), null);
});

test("advisor roster names carry the same read-only policy", () => {
  for (const name of ["early-blocker"]) {
    assert.equal(blocked(evaluatePolicy({ agentName: name, toolName: "write", input: { path: "runs/r/review/round-1.md" }, cwd })), true);
    assert.equal(blocked(evaluatePolicy({ agentName: name, toolName: "edit", input: { path: "memory/facts/x.md" }, cwd })), true);
    assert.equal(evaluatePolicy({ agentName: name, toolName: "bash", input: { command: "node --test tests" }, cwd }), null);
  }
});

test("improver may edit prompts and non-critical scripts but not its gate or memory", () => {
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: ".omp/WATCHDOG.yml" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: "scripts/merge-runs.mjs" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: "runs/r/improvement.md" }, cwd }), null);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: "memory/runs/r/improvement.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: "memory/facts/x.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: ".omp/agents/improver.md" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: "src/app.ts" }, cwd })), true);
  for (const frozen of [
    "scripts/workspace.sh",
    "scripts/dispatch-plan.mjs",
    "scripts/finalize-run.mjs",
    "scripts/validate-omp-pipeline.mjs",
    "scripts/requests.mjs",
    "scripts/test-workspace.mjs",
    ".omp/extensions/pipeline-policy/policy.mjs",
  ]) {
    assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "write", input: { path: frozen }, cwd })), true);
  }
});

test("improver bash is restricted to validation commands", () => {
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "git status --short" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "node scripts/validate-omp-pipeline.mjs" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "node --test scripts/test-dispatch-plan.mjs" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "node scripts/dispatch-plan.mjs validate runs/x/spec.md" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "node scripts/dispatch-plan.mjs replay runs/x" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "git commit -m pipeline:x" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "omp config list" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "omp config get advisor.reviewMode" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "node scripts/bootstrap.mjs --check" }, cwd }), null);
  assert.equal(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "node --test scripts/test-workspace.mjs" }, cwd }), null);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "git checkout main" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "git switch main" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "node scripts/bootstrap.mjs" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "rm -rf build" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "git status; rm -rf build" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "git status && rm -rf build" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "omp config set theme.dark light" }, cwd })), true);
  assert.equal(blocked(evaluatePolicy({ agentName: "improver", toolName: "bash", input: { command: "omp agents unpack --force" }, cwd })), true);
});

test("worker may only read, write and run bash inside the project directory", () => {
  const worker = (toolName, input) => evaluatePolicy({ agentName: "worker", toolName, input, cwd });

  assert.equal(worker("read", { path: "runs/r/worker/round-1.md" }), null);
  assert.equal(blocked(worker("read", { path: "/etc/passwd" })), true);
  assert.equal(blocked(worker("read", { path: "../outside.txt" })), true);
  assert.equal(worker("grep", { pattern: "x", path: "runs/r" }), null);
  assert.equal(blocked(worker("grep", { pattern: "x", path: "/etc" })), true);

  assert.equal(worker("write", { path: "runs/r/scratch/tmp/out.txt" }), null);
  assert.equal(blocked(worker("write", { path: "/tmp/out.txt" })), true);
  assert.equal(blocked(worker("edit", { path: "../outside.txt" })), true);

  assert.equal(worker("bash", { command: "node --test tests" }), null);
  assert.equal(blocked(worker("bash", { command: "cat /etc/passwd" })), true);
  assert.equal(blocked(worker("bash", { command: "cat $HOME/notes.txt" })), true);
  assert.equal(blocked(worker("bash", { command: "cat ~/notes.txt" })), true);
  assert.equal(worker("bash", { command: "cat runs/r/scratch/tmp/out.txt" }), null);
});
