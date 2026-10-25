import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_TABLE } from "../.omp/extensions/pipeline-policy/policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const omp = path.join(root, ".omp");
const agentsDir = path.join(omp, "agents");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function exists(relative) {
  return fs.existsSync(path.join(root, relative));
}

function parseFrontmatter(relative) {
  const text = read(relative);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, `${relative}: missing frontmatter`);
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map(entry => entry.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    fields.set(field[1], value);
  }
  return { text, fields };
}

const requiredFiles = [
  ".omp/config.yml",
  ".omp/APPEND_SYSTEM.md",
  ".omp/RULES.md",
  ".omp/agents/orchestrator.md",
  ".omp/agents/worker.md",
  ".omp/agents/improver.md",
  ".omp/WATCHDOG.md",
  ".omp/WATCHDOG.yml",
  ".omp/extensions/pipeline-policy/index.ts",
  ".omp/extensions/pipeline-policy/policy.mjs",
  ".omp/commands/pipeline.md",
  ".omp/commands/improver.md",
  ".omp/commands/request.md",
  ".omp/commands/status.md",
  ".omp/commands/wait.md",
  ".omp/skills/research-evidence/SKILL.md",
  ".omp/skills/general-work-verification/SKILL.md",
  ".omp/skills/dispatch-planning/SKILL.md",
  ".omp/skills/pipeline-control/SKILL.md",
  ".omp/skills/merge-runs/SKILL.md",
  ".omp/skills/run-forensics/SKILL.md",
  ".omp/skills/pipeline-audit/SKILL.md",
  ".omp/pipeline-backlog.md",
  ".omp/skills/llm-wiki/SKILL.md",
  ".omp/skills/llm-wiki/scripts/wiki.py",
  ".omp/commands/merge.md",
  "scripts/dispatch-plan.mjs",
  "scripts/test-dispatch-plan.mjs",
  "scripts/bootstrap.mjs",
  "scripts/test-bootstrap.mjs",
  "scripts/requests.mjs",
  "scripts/test-requests.mjs",
  "scripts/templates/memory/index.md",
  "scripts/templates/memory/README.md",
  "scripts/templates/memory/decisions.md",
  "scripts/finalize-run.mjs",
  "scripts/merge-runs.mjs",
  "scripts/test-merge-runs.mjs",
  "scripts/test-workspace.mjs",
  "scripts/workspace.sh",
  "install.sh",
];

for (const file of requiredFiles) {
  assert.ok(exists(file), `missing required file: ${file}`);
}

const orchestrator = parseFrontmatter(".omp/agents/orchestrator.md");
const worker = parseFrontmatter(".omp/agents/worker.md");
const improver = parseFrontmatter(".omp/agents/improver.md");

for (const [name, parsed] of Object.entries({ orchestrator, worker, improver })) {
  assert.equal(parsed.fields.get("name"), name, `${name}: frontmatter name mismatch`);
  assert.ok(parsed.fields.get("description"), `${name}: missing description`);
}

assert.deepEqual(orchestrator.fields.get("spawns"), ["worker"], "orchestrator may spawn only the worker; the improver is a sibling");
assert.ok(orchestrator.fields.get("blocking") !== "true", "orchestrator must be non-blocking for async request handling");
assert.deepEqual(orchestrator.fields.get("autoloadSkills"), ["dispatch-planning"], "orchestrator must autoload dispatch-planning");
assert.equal(worker.fields.get("advisor"), "true", "worker must opt into the advisor");
assert.ok(!worker.fields.has("spawns"), "worker must not spawn");
assert.deepEqual(improver.fields.get("autoloadSkills"), ["pipeline-audit", "run-forensics"], "improver must autoload its audit skill");
assert.ok(!improver.fields.has("spawns"), "improver must not spawn");
assert.ok(!improver.fields.has("advisor"), "improver must not be advised");

for (const [name, parsed] of Object.entries({ orchestrator, worker, improver })) {
  assert.match(parsed.text, /general-purpose/i, `${name}: missing general-purpose framing`);
  assert.match(parsed.text, /general-work-verification/, `${name}: missing general-work-verification pointer`);
}

assert.match(read(".omp/APPEND_SYSTEM.md"), /general-purpose/i, "APPEND_SYSTEM.md must state general-purpose scope");
assert.match(read(".omp/APPEND_SYSTEM.md"), /do not assume a git repository/i, "APPEND_SYSTEM.md must warn against code assumptions");
assert.match(read(".omp/RULES.md"), /work_type/i, "RULES.md must require work_type");
assert.match(read(".omp/RULES.md"), /NEVER assume the deliverable is code/i, "RULES.md must forbid code assumptions");
assert.match(read(".omp/commands/pipeline.md"), /research, analysis, automation/i, "pipeline command must describe general-purpose work");

const orchestratorText = read(".omp/agents/orchestrator.md");
assert.doesNotMatch(orchestratorText, /if and only if the user's request asks for parallel/i, "orchestrator must not gate parallelism on an explicit user request");
assert.doesNotMatch(orchestratorText, /Without an explicit parallel request/i, "orchestrator must not fall back to a sequential-only mode");
assert.match(orchestratorText, /^## Delegation boundary$/m, "orchestrator must state its delegation boundary");
assert.match(orchestratorText, /^## Control dispatches$/m, "orchestrator must document control dispatches");
assert.match(orchestratorText, /^## Request channel$/m, "orchestrator must define the request channel");
assert.match(orchestratorText, /^## Request processing$/m, "orchestrator must define request processing");
assert.match(orchestratorText, /request-check/, "orchestrator must delegate request triage");
assert.match(orchestratorText, /STOP request=/, "orchestrator must stop stale in-flight work");
assert.match(orchestratorText, /REQUESTS:/, "orchestrator verdict must record requests");
assert.match(read(".omp/commands/request.md"), /agent:\/\//, "request command must wake the orchestrator");
assert.match(read(".omp/commands/request.md"), /agents --role orchestrator/, "request command must resolve only orchestrator agents");
assert.match(read(".omp/commands/request.md"), /requests\.mjs add/, "request command must use the one-command add helper");
assert.match(orchestratorText, /--changed-from/, "orchestrator must re-check amendments incrementally");
assert.match(read(".omp/commands/pipeline.md"), /asynchronous/i, "pipeline command must state the async launch");
assert.match(read(".omp/commands/pipeline.md"), /agent: "orchestrator"/, "pipeline command must select the orchestrator agent explicitly");
assert.match(read(".omp/commands/pipeline.md"), /agent: "improver"/, "pipeline command must launch the improver alongside");
assert.match(read(".omp/commands/pipeline.md"), /--role improver/, "pipeline command must register the improver role");
assert.match(read(".omp/commands/pipeline.md"), /starts alongside the orchestrator/i, "pipeline command must state the sibling launch");
assert.match(read(".omp/commands/wait.md"), /role: orchestrator/, "wait must resolve the orchestrator, never the improver");
assert.match(read("scripts/requests.mjs"), /received/, "request helper must define request statuses");
assert.match(orchestratorText, /## Dispatch model$/m, "orchestrator must state the dispatch model");
assert.match(orchestratorText, /dispatch-plan\.mjs/, "orchestrator must reference the plan validator/replay");
assert.match(orchestratorText, /workspace\.sh/, "orchestrator must reference the workspace helper");
assert.match(orchestratorText, /scripts\/workspace\.sh commit/, "orchestrator must commit the deliverable");
assert.match(orchestratorText, /runs\/<run>/, "orchestrator must use the external runs root");
assert.doesNotMatch(orchestratorText, /memory\/runs\/<run>/, "orchestrator must not use memory/runs as a live path");
assert.match(orchestratorText, /finalize-run\.mjs/, "orchestrator must finalize the run");
assert.match(orchestratorText, /## Dispatch metrics/, "orchestrator must record per-dispatch cost metrics");
assert.match(orchestratorText, /## Improver supervision \(sibling\)$/m, "orchestrator must define sibling improver supervision");
assert.match(orchestratorText, /write agent:\/\/<improver-id>/, "orchestrator must wake the improver by message, not dispatch");
assert.match(orchestratorText, /## Improver passes/, "orchestrator must record supervision passes separately");
assert.match(orchestratorText, /tick=intake/, "orchestrator must define the improver wake triggers");
assert.match(orchestratorText, /settled s<N> commit=/, "orchestrator must consume the improver's settled report");
assert.doesNotMatch(orchestratorText, /after every settled worker\+advisor dispatch/i, "orchestrator must not dispatch the improver per settlement");
assert.doesNotMatch(orchestratorText, /queued dispatch=/, "improver work is no longer queued per dispatch");
assert.doesNotMatch(orchestratorText, /IMPROVER STATUS: DONE/, "the orchestrator must expect the IDLE marker");
assert.match(orchestratorText, /--ignore \.omp --ignore scripts/, "orchestrator must scope check-live during a pass");
assert.match(orchestratorText, /sync-main/, "orchestrator must resolve a mid-run pipeline commit conflict");
assert.doesNotMatch(orchestratorText, /dispatch the improver once/i, "orchestrator must not keep a single end-of-run improver dispatch");
assert.doesNotMatch(orchestratorText, /send no new dispatch before the pass settles/i, "orchestrator must not block on the improver");

for (const [file, text] of [
  [".omp/agents/orchestrator.md", orchestratorText],
  [".omp/agents/worker.md", read(".omp/agents/worker.md")],
  [".omp/agents/improver.md", read(".omp/agents/improver.md")],
  [".omp/WATCHDOG.md", read(".omp/WATCHDOG.md")],
]) {
  assert.match(text, /OBJECTIVE\.md/, `${file}: missing OBJECTIVE.md ownership rule`);
  assert.match(text, /human-owned/i, `${file}: OBJECTIVE.md must be marked human-owned`);
  assert.match(text, /Never (write|modify)/, `${file}: missing OBJECTIVE.md no-write rule`);
}

const workerText = read(".omp/agents/worker.md");
assert.match(workerText, /runs\/<run>/, "worker must use the external runs root");
assert.doesNotMatch(workerText, /memory\/runs\/<run>/, "worker must not write memory/runs");
assert.match(workerText, /Run where you edit/i, "worker must state the workspace execution rule");
assert.match(workerText, /round-<N>\.md/, "worker must write the flat round file");
assert.match(workerText, /live project tree is read-only/i, "worker must treat the live tree as read-only");
assert.match(workerText, /limited to the project directory/i, "worker must be confined to the project directory");
assert.match(read(".omp/extensions/pipeline-policy/policy.mjs"), /workerBashDecision/, "policy must guard worker bash paths");
assert.match(read(".omp/extensions/pipeline-policy/policy.mjs"), /readDecision/, "policy must guard worker reads");
assert.match(workerText, /delta\/facts\.json/, "worker must write the merge delta");
assert.match(workerText, /OUTCOME: PENDING/, "worker summary must carry the pending outcome");

const improverText = read(".omp/agents/improver.md");
assert.doesNotMatch(improverText, /memory\/runs\/<run>/, "improver must not use memory/runs as a live path");
assert.match(improverText, /pipeline: <slug>/, "improver must commit pipeline changes");
assert.match(improverText, /Never write shared knowledge/i, "improver must be forbidden from shared memory writes");
assert.match(read(".omp/skills/merge-runs/SKILL.md"), /Human-triggered/i, "merge skill must be human-triggered");

const watchdogMd = read(".omp/WATCHDOG.md");
assert.match(watchdogMd, /unit's workspace and its patch/i, "WATCHDOG must retarget review to the unit workspace");
assert.match(read(".omp/WATCHDOG.yml"), /unit workspace and its patch/i, "WATCHDOG.yml must retarget review to the unit workspace");

const memoryIndex = read("scripts/templates/memory/index.md");
assert.match(memoryIndex, /^## Topics$/m, "memory template must carry a Topics section");
assert.match(memoryIndex, /^## Runs$/m, "memory template must carry a Runs section");
assert.match(memoryIndex, /^\|\s*run\s*\|/im, "memory template must carry a runs table header");
const memoryReadme = read("scripts/templates/memory/README.md");
assert.match(memoryReadme, /human-triggered/i, "memory README must state the merge rule");
assert.match(memoryReadme, /never writes/i, "memory README must state that runs never write it");
assert.match(read("scripts/templates/memory/decisions.md"), /append-only/i, "memory decisions must state append-only");

assert.match(orchestratorText, /bootstrap\.mjs --check/, "orchestrator must verify run prerequisites through bootstrap");
assert.match(read(".omp/commands/pipeline.md"), /bootstrap\.mjs/, "pipeline command must bootstrap on first run");
assert.match(read("install.sh"), /bootstrap\.mjs/, "install script must run the bootstrap");
assert.match(read("install.sh"), /bin\/omp/, "install script must install the bundled binary");
assert.match(read("install.sh"), /node.*18|18.*node/is, "install script must enforce the node floor");
assert.match(read("scripts/workspace.sh"), /show-toplevel/, "workspace helper must reject a project nested in another repository");

const config = read(".omp/config.yml");
assert.doesNotMatch(config, /^modelRoles:\s*$/m, "modelRoles should be absent so the advisor uses fallback resolution");
assert.match(config, /maxRecursionDepth:\s*2/, "maxRecursionDepth must be 2");
assert.match(config, /structured:\s*false/, "task.structured must be false");
assert.match(config, /agentSoftRequestBudget:[\s\S]*improver:\s*400/, "the improver must carry an explicit request budget");
assert.match(config, /maxNotesPerUpdate:\s*16/, "advisor maxNotesPerUpdate must be 16");

const watchdog = read(".omp/WATCHDOG.yml");
assert.doesNotMatch(watchdog, /^\s+model:/m, "advisors must not pin a model");
assert.doesNotMatch(watchdog, /pipeline-reviewer/, "the final-yield gate advisor is retired");
assert.equal((watchdog.match(/^\s+- name:/gm) ?? []).length, 1, "WATCHDOG.yml must define exactly one advisor");
assert.match(watchdog, /name:\s*early-blocker/, "WATCHDOG.yml must define early-blocker");
assert.match(watchdog, /tools:\s*\[read, grep, glob, bash\]/, "advisor tools must be read/grep/glob/bash");
assert.doesNotMatch(watchdog, /tools:\s*\[[^\]]*\b(write|edit)\b[^\]]*\]/, "advisors must not have write/edit");
assert.match(watchdog, /Do not write reports/i, "WATCHDOG must forbid review files");
assert.match(watchdog, /skill:\/\/general-work-verification/, "WATCHDOG must point at general-work-verification");
assert.match(watchdog, /skill:\/\/research-evidence/, "WATCHDOG must point at research-evidence");

const earlyStart = watchdog.indexOf("name: early-blocker");
assert.ok(earlyStart > 0, "WATCHDOG.yml must define early-blocker");
const early = watchdog.slice(earlyStart);
assert.match(early, /enabled:\s*true/, "early-blocker must be enabled");
assert.match(early, /reviewMode:\s*turn/, "early-blocker must review every turn");
assert.match(early, /syncBacklog:\s*["']?off["']?/, "early-blocker must never block the worker");
assert.match(early, /tools:\s*\[read, grep, glob, bash\]/, "early-blocker tools must be read/grep/glob/bash");
assert.match(early, /Emit only `blocker` notes/, "early-blocker must be blockers-only");
assert.match(early, /A mistake is a concrete, provable error/, "early-blocker must define a provable mistake");
assert.match(early, /clearly better way/i, "early-blocker must accept a provable better approach");
assert.match(early, /not a preference/i, "early-blocker better-path blockers must not be preferences");
assert.match(early, /earliest moment/i, "early-blocker must act at the first provable issue");
assert.match(early, /Never emit `nit` or `concern`/, "early-blocker must not emit graded findings");
assert.match(early, /approval summary/i, "early-blocker must not approve");
assert.doesNotMatch(early, /reviewMode:\s*agent-end/, "early-blocker must not be a second gate");

assert.match(watchdogMd, /only output is live advice/i, "WATCHDOG.md must be live-only");
assert.match(watchdogMd, /Do not write reports, review files, verdict files/i, "WATCHDOG.md must forbid files");
assert.match(watchdogMd, /general-purpose/i, "WATCHDOG.md must state general-purpose scope");
assert.match(watchdogMd, /Do not demand code tests for a research report/i, "WATCHDOG.md must avoid code-only verification");
assert.match(watchdogMd, /Early detector/i, "WATCHDOG.md must document the early detector");
assert.match(watchdogMd, /What counts as a clearly better way/i, "WATCHDOG.md must define the better-path trigger");
assert.match(watchdogMd, /no final-yield gate advisor/i, "WATCHDOG.md must state the single-advisor model");
assert.doesNotMatch(watchdogMd, /pipeline-reviewer/, "WATCHDOG.md must not reference the retired gate advisor");
assert.match(watchdogMd, /either a mistake becomes\s+provable or a clearly better way/i, "WATCHDOG.md must define the early trigger");
assert.match(watchdogMd, /Severity restrictions in a roster entry are binding/i, "WATCHDOG.md must bind per-entry severity restrictions");
assert.match(watchdogMd, /does not approve/i, "WATCHDOG.md must state the advisor does not approve");

for (const [name, parsed] of Object.entries({
  research: parseFrontmatter(".omp/skills/research-evidence/SKILL.md"),
  general: parseFrontmatter(".omp/skills/general-work-verification/SKILL.md"),
})) {
  assert.equal(parsed.fields.get("name"), name === "research" ? "research-evidence" : "general-work-verification");
  assert.ok(parsed.fields.get("description"), `${name}: skill description missing`);
}

const dispatchSkill = parseFrontmatter(".omp/skills/dispatch-planning/SKILL.md");
assert.equal(dispatchSkill.fields.get("name"), "dispatch-planning", "dispatch skill name mismatch");
assert.ok(dispatchSkill.fields.get("description"), "dispatch skill description missing");
assert.match(dispatchSkill.text, /sibling supervisor launched by `\/pipeline`/, "dispatch skill must state the sibling launch");
assert.match(dispatchSkill.text, /never wait on it while a unit is ready/, "dispatch skill must not block on the improver");
assert.match(dispatchSkill.text, /settled s<N> commit=/, "dispatch skill must carry the settled report");
assert.match(dispatchSkill.text, /## Improver passes/, "dispatch skill must separate improver records");
assert.doesNotMatch(dispatchSkill.text, /queued dispatch=/, "dispatch skill must not queue per-dispatch curation");

const controlSkill = parseFrontmatter(".omp/skills/pipeline-control/SKILL.md");
assert.equal(controlSkill.fields.get("name"), "pipeline-control", "control skill name mismatch");
assert.ok(controlSkill.fields.get("description"), "control skill description missing");
for (const role of ["intake", "plan-check", "request-check", "integrate", "ops", "close"]) {
  assert.match(controlSkill.text, new RegExp("`" + role + "`"), `control skill must define ${role}`);
}
assert.match(controlSkill.text, /CONTROL STATUS: DONE/, "control skill must define the report marker");
assert.match(controlSkill.text, /Never write, replace, rename, or delete it/, "control skill must forbid OBJECTIVE.md writes");

const wikiSkill = parseFrontmatter(".omp/skills/llm-wiki/SKILL.md");
assert.equal(wikiSkill.fields.get("name"), "llm-wiki", "llm-wiki skill name mismatch");
assert.ok(wikiSkill.fields.get("description"), "llm-wiki skill description missing");
assert.match(wikiSkill.text, /WIKI_PATH/, "llm-wiki skill must define the wiki path");
assert.match(wikiSkill.text, /skill:\/\/merge-runs/, "llm-wiki skill must state the memory/ boundary");
assert.match(wikiSkill.text, /scripts\/wiki\.py/, "llm-wiki skill must point at its lint tool");

assert.deepEqual(POLICY_TABLE.orchestrator.taskAgents, ["worker"], "the orchestrator must not spawn the improver");
assert.deepEqual(POLICY_TABLE.orchestrator.editRoots, ["runs"], "orchestrator writes only runs");
assert.equal(POLICY_TABLE.orchestrator.bash, "deny", "orchestrator must not run commands");
for (const name of ["spec.md", "summary.md", "improvement.md", "manifest.json", "objective.snapshot.md"]) {
  assert.ok(POLICY_TABLE.orchestrator.denyBasenames.includes(name), `orchestrator must not write ${name}`);
}
for (const dir of ["delta", "worker", "control"]) {
  assert.ok(POLICY_TABLE.orchestrator.denyDirs.includes(dir), `orchestrator must not write runs/*/${dir}`);
}
assert.deepEqual(POLICY_TABLE.improver.editRoots, [".omp", "scripts", "runs"], "improver writes config and tooling");
assert.ok(!POLICY_TABLE.improver.editRoots.includes("memory"), "improver must not write memory");
for (const frozen of [
  "scripts/workspace.sh",
  "scripts/dispatch-plan.mjs",
  "scripts/finalize-run.mjs",
  "scripts/validate-omp-pipeline.mjs",
  "scripts/requests.mjs",
  "scripts/test-workspace.mjs",
  ".omp/extensions/pipeline-policy/policy.mjs",
]) {
  assert.ok(POLICY_TABLE.improver.editDeny.includes(frozen), `improver must not edit ${frozen} mid-run`);
}
const policyText = read(".omp/extensions/pipeline-policy/policy.mjs");
assert.doesNotMatch(policyText, /\["git", "checkout"\]/, "improver must not move HEAD");
assert.doesNotMatch(policyText, /\["git", "switch"\]/, "improver must not switch branches");
assert.match(policyText, /node --test scripts\/test-workspace\.mjs/, "improver must run the workspace test");
assert.match(read("scripts/workspace.sh"), /sync-main/, "workspace helper must resolve a main/integration conflict");
assert.match(read("scripts/workspace.sh"), /--ignore/, "workspace helper must scope the live check during a pass");
assert.equal(POLICY_TABLE.worker.editRoots, "unrestricted-except-review");
assert.deepEqual(POLICY_TABLE.worker.taskAgents, []);
assert.deepEqual(POLICY_TABLE.improver.taskAgents, []);
assert.deepEqual(POLICY_TABLE.advisor.taskAgents, []);
assert.equal(POLICY_TABLE.advisor.editRoots.length, 0, "advisor must have no write/edit roots");
assert.equal(POLICY_TABLE.advisor.bash, "allow", "advisor must keep bash");
assert.match(read(".omp/agents/improver.md"), /WATCHDOG\.md/, "improver must be allowed to modify WATCHDOG");
assert.match(read(".omp/agents/improver.md"), /Never grant the advisor `write` or `edit`/, "improver must preserve advisor live-only");
assert.match(read(".omp/agents/improver.md"), /reload-required/, "improver must record reload requirements");
assert.match(read(".omp/agents/improver.md"), /history:\/\/<id>/, "improver must read subagent transcripts");
assert.match(read(".omp/agents/improver.md"), /skill:\/\/run-forensics/, "improver must point at the run-forensics skill");
assert.match(improver.fields.get("description"), /launched by \/pipeline as a sibling/i, "improver description must state the sibling launch");
assert.match(improver.fields.get("description"), /pipeline as a whole/i, "improver description must state the whole-pipeline scope");
assert.ok(!improver.fields.has("blocking"), "improver must stay non-blocking");
assert.match(improverText, /## Supervision loop/, "improver must define its wake/pass/yield loop");
assert.match(improverText, /## Scope: the whole pipeline/, "improver must scope itself to the whole pipeline");
assert.match(improverText, /skill:\/\/pipeline-audit/, "improver must point at the audit skill");
assert.match(improverText, /pipeline-backlog\.md/, "improver must maintain the durable backlog");
assert.match(improverText, /<!-- improver-pass: s<N> trigger=/, "improver must write a machine-readable pass trailer");
assert.match(improverText, /## Supervision s<N> — <trigger>/, "improver must append one section per pass");
assert.match(improverText, /pipeline: <slug> s<N>/, "improver must commit each pass separately");
assert.match(improverText, /IMPROVER STATUS: IDLE/, "improver must keep its idle marker");
assert.match(improverText, /Stop cleanly before the budget/, "improver must wrap up at the soft budget");
assert.match(improverText, /One section per pass/, "improver must make sections the completion record");
assert.match(improverText, /never trade verification depth for cost/i, "improver must not trade verification depth for savings");
const auditSkill = parseFrontmatter(".omp/skills/pipeline-audit/SKILL.md");
assert.equal(auditSkill.fields.get("name"), "pipeline-audit", "pipeline-audit skill name mismatch");
assert.ok(auditSkill.fields.get("description"), "pipeline-audit skill description missing");
assert.match(auditSkill.text, /## Cost/, "pipeline-audit must define cost accounting");
assert.match(auditSkill.text, /### Recurrence/, "pipeline-audit must define cross-run recurrence");
assert.match(auditSkill.text, /## Recording/, "pipeline-audit must define the record format");
assert.match(read(".omp/skills/run-forensics/SKILL.md"), /## Cost accounting/, "run-forensics must document cost accounting");
assert.match(read(".omp/skills/run-forensics/SKILL.md"), /<advisory/, "run-forensics must cover advisor notes in the primary transcript");

// The shared-memory directory is `memory/`, and the retired lane partition must not
// reappear anywhere in pipeline configuration or tooling.
const retiredToken = new RegExp(["\\b" + "kb" + "\\b", "\\b" + "KB" + "\\b", "kb/", "kb_", "kb[A-Z]"].join("|"));
const retiredLane = new RegExp("\\b" + "lane" + "s?\\b", "i");
const offenders = [];
function guardFile(full) {
  const relative = path.relative(root, full);
  if (relative === path.join("scripts", "validate-omp-pipeline.mjs")) return;
  const text = fs.readFileSync(full, "utf8");
  text.split("\n").forEach((line, index) => {
    if (retiredToken.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
    else if (retiredLane.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
  });
}
function guardDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) guardDir(full);
    else if (/\.(md|mjs|ts|sh|ya?ml|py)$/.test(entry.name)) guardFile(full);
  }
}
guardDir(omp);
guardDir(path.join(root, "scripts"));
guardFile(path.join(root, ".gitignore"));
assert.deepEqual(offenders, [], `retired terminology found (the memory repo is memory/, and there is no lane concept):\n${offenders.join("\n")}`);

console.log("OMP pipeline validation passed");
console.log(`agents: ${orchestrator.fields.get("name")}, ${worker.fields.get("name")}, ${improver.fields.get("name")}`);
console.log("advisors: early-blocker (turn/off, blockers only; no final-yield gate)");
console.log("recursion depth: 2");
