import path from "node:path";

export const PIPELINE_AGENTS = new Set([
  "orchestrator",
  "worker",
  "improver",
  "advisor",
  "early-blocker",
]);

const ADVISOR_POLICY = {
  editRoots: [],
  bash: "allow",
  taskAgents: [],
  ask: "deny",
};

export const POLICY_TABLE = {
  orchestrator: {
    editRoots: ["runs"],
    bash: "deny",
    taskAgents: ["worker"],
    ask: "deny",
    denyBasenames: ["spec.md", "summary.md", "improvement.md", "manifest.json", "objective.snapshot.md"],
    denyDirs: ["delta", "worker", "control"],
  },
  worker: {
    editRoots: "unrestricted-except-review",
    bash: "allow",
    taskAgents: [],
    ask: "deny",
  },
  improver: {
    editRoots: [".omp", "scripts", "runs"],
    editDeny: [
      ".omp/agents/improver.md",
      ".omp/extensions/pipeline-policy/index.ts",
      ".omp/extensions/pipeline-policy/policy.mjs",
      "scripts/workspace.sh",
      "scripts/dispatch-plan.mjs",
      "scripts/finalize-run.mjs",
      "scripts/validate-omp-pipeline.mjs",
      "scripts/requests.mjs",
      "scripts/test-bootstrap.mjs",
      "scripts/test-dispatch-plan.mjs",
      "scripts/test-merge-runs.mjs",
      "scripts/test-pipeline-policy.mjs",
      "scripts/test-workspace.mjs",
    ],
    bash: "allowlist",
    taskAgents: [],
    ask: "deny",
  },
  advisor: ADVISOR_POLICY,
  "early-blocker": ADVISOR_POLICY,
};

const IMPROVER_BASH_PREFIXES = [
  ["git", "diff"],
  ["git", "log"],
  ["git", "status"],
  ["git", "add"],
  ["git", "commit"],
  ["git", "rev-parse"],
  ["git", "restore"],
  ["omp", "config", "list"],
  ["omp", "config", "get"],
  ["node", "scripts/dispatch-plan.mjs"],
];

const IMPROVER_BASH_EXACT = [
  "node scripts/bootstrap.mjs --check",
  "node scripts/validate-omp-pipeline.mjs",
  "node --test scripts/test-pipeline-policy.mjs",
  "node --test scripts/test-dispatch-plan.mjs",
  "node --test scripts/test-merge-runs.mjs",
  "node --test scripts/test-bootstrap.mjs",
  "node --test scripts/test-workspace.mjs",
];

const ORCHESTRATOR_BASH_PREFIXES = [
  ["node", "scripts/requests.mjs", "claim"],
  ["node", "scripts/requests.mjs", "ack"],
  ["node", "scripts/requests.mjs", "list"],
  ["node", "scripts/dispatch-plan.mjs", "validate"],
];

function normalizeAgent(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function normalizeCommand(command) {
  return typeof command === "string" ? command.trim().replace(/\s+/g, " ") : "";
}

function isUnsafeShell(command) {
  return /[;&|`$<>\n\r]/.test(command);
}

const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

function outsideProject(abs, cwd) {
  return !isUnder(cwd, abs);
}

function readDecision(agentName, input, cwd) {
  if (agentName !== "worker") return { allow: true };
  for (const target of collectPaths(input)) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) continue;
    const abs = resolveProjectPath(cwd, target);
    if (!abs) continue;
    if (outsideProject(abs, cwd)) {
      return { allow: false, reason: `The worker may only read inside the project directory; blocked: ${target}` };
    }
  }
  return { allow: true };
}

function workerBashDecision(command, cwd) {
  const normalized = normalizeCommand(command);
  if (!normalized) return { allow: true };
  if (/(^|[\s"'`=:(])(?:~(?:\/|\b)|\$\{?HOME\}?)/.test(normalized)) {
    return { allow: false, reason: "The worker may not reference home-directory paths; keep work inside the project directory." };
  }
  for (const match of normalized.matchAll(/(^|[\s"'`=:(])(\/[^\s"'`;|&()<>]+)/g)) {
    const raw = match[2];
    if (raw.startsWith("//")) continue;
    if (SAFE_DEVICES.has(raw)) continue;
    const abs = path.resolve(cwd, raw);
    if (outsideProject(abs, cwd)) {
      return {
        allow: false,
        reason:
          `The worker may only access paths inside the project directory; blocked: ${raw}. ` +
          "Sed/awk/grep addresses, URL fragments and markdown inside an inline script match this scan too: " +
          "a token that is not really a path means the command should be restructured around project-relative files, " +
          "not retried in a variant. A token that is a real path outside the project is not negotiable — record it in " +
          "issues.md. Never disguise a path to get past this check (`[/]` classes, chr(47)).",
      };
    }
  }
  return { allow: true };
}

function isImproverBashAllowed(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  if (isUnsafeShell(normalized)) return false;
  if (IMPROVER_BASH_EXACT.includes(normalized)) return true;
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < 2) return false;
  if (IMPROVER_BASH_PREFIXES.some(prefix => prefix.every((word, index) => words[index] === word))) return true;
  if (words[0] === "node" && words[1] === "--test" && words[2] === "scripts/test-pipeline-policy.mjs") return true;
  return false;
}

function isOrchestratorBashAllowed(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  if (isUnsafeShell(normalized)) return false;
  const words = normalized.split(" ").filter(Boolean);
  return ORCHESTRATOR_BASH_PREFIXES.some(prefix => prefix.every((word, index) => words[index] === word));
}

function stripSelector(target) {
  const idx = target.search(/:(?:\d|raw|img|conflicts|L\d)/);
  return idx === -1 ? target : target.slice(0, idx);
}

function resolveProjectPath(cwd, target) {
  if (typeof target !== "string" || target.length === 0) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) return null;
  const cleaned = stripSelector(target);
  return path.resolve(cwd, cleaned);
}

function isUnder(root, target) {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return true;
}

function isReviewOrVerdictPath(cwd, target) {
  const abs = resolveProjectPath(cwd, target);
  if (!abs) return false;
  const root = path.join(cwd, "runs");
  if (!isUnder(root, abs)) return false;
  const relative = path.relative(root, abs);
  const parts = relative.split(path.sep);
  return parts.includes("review") || path.basename(abs) === "verdict.md";
}

function isRequestPath(cwd, target) {
  const abs = resolveProjectPath(cwd, target);
  if (!abs) return false;
  const root = path.join(cwd, "runs");
  if (!isUnder(root, abs)) return false;
  const parts = path.relative(root, abs).split(path.sep);
  return parts[0] === ".agents" || parts[0] === ".requests" || parts[0] === ".queue" || (parts.length >= 2 && parts[1] === "requests");
}

function isRequestWriteCommand(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  if (/\bnode\s+scripts\/requests\.mjs\s+(?:submit|register|update|ack|claim)\b/.test(normalized)) return true;
  const target = /runs\/(?:[^\s"']*\/)?(?:requests|\.requests|\.agents|\.queue)(?:[/\s"']|$)/.test(normalized);
  if (!target) return false;
  const mutates =
    /(^|[\s"'`=:(])(?:>>?|tee\b|rm\b|mv\b|cp\b|truncate\b|sed\s+-i\b|writeFile\b|appendFile\b)/.test(normalized) ||
    /^git\s+(?:add|commit)\b/.test(normalized);
  return mutates;
}

function collectPaths(input) {
  const targets = [];
  if (!input || typeof input !== "object") return targets;
  if (typeof input.path === "string") targets.push(input.path);
  if (typeof input.file_path === "string") targets.push(input.file_path);
  if (Array.isArray(input.paths)) {
    for (const value of input.paths) {
      if (typeof value === "string") targets.push(value);
    }
  }
  if (typeof input.input === "string") {
    for (const line of input.input.split(/\r?\n/)) {
      const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line.trim());
      if (match) targets.push(match[1].trim());
    }
  }
  return targets;
}

function internalTargetDecision(agentName, toolName, target) {
  if (target.startsWith("agent://") || target.startsWith("proc://") || target.startsWith("local://")) {
    return { allow: true };
  }
  if (target.startsWith("xd://")) {
    const device = target.slice("xd://".length).split(/[/?#]/)[0].toLowerCase();
    if (device === "ask") return { allow: false, reason: "The ask tool is disabled for pipeline agents." };
    if (device === "task") {
      return taskDecision(agentName, { agent: undefined });
    }
    return { allow: true };
  }
  if (target.startsWith("conflict://")) {
    return { allow: agentName === "worker" };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) {
    return { allow: true };
  }
  return { allow: undefined };
}

function taskDecision(agentName, input) {
  const policy = POLICY_TABLE[agentName];
  if (!policy) return { allow: true };
  const requested = [];
  if (input && typeof input === "object") {
    if (typeof input.agent === "string") requested.push(input.agent);
    if (Array.isArray(input.tasks)) {
      for (const item of input.tasks) {
        if (item && typeof item.agent === "string") requested.push(item.agent);
      }
    }
  }
  if (requested.length === 0) {
    return {
      allow: false,
      reason: `The task tool is disabled for ${agentName}; specify an allowed agent (${policy.taskAgents.join(", ") || "none"}).`,
    };
  }
  const allowed = new Set(policy.taskAgents.map(value => value.toLowerCase()));
  for (const name of requested) {
    if (!allowed.has(name.toLowerCase())) {
      return {
        allow: false,
        reason: `Agent ${agentName} may not spawn ${name}. Allowed: ${policy.taskAgents.join(", ") || "none"}.`,
      };
    }
  }
  return { allow: true };
}

function writeEditDecision(agentName, input, cwd) {
  const policy = POLICY_TABLE[agentName];
  if (!policy) return { allow: true };
  const memoryRoot = path.join(cwd, "memory");
  for (const target of collectPaths(input)) {
    const abs = resolveProjectPath(cwd, target);
    if (abs && isUnder(memoryRoot, abs)) {
      return { allow: false, reason: "The shared memory (memory/) is read-only to pipeline agents; record the claim in the run delta." };
    }
    if (agentName === "worker" && abs && outsideProject(abs, cwd)) {
      return { allow: false, reason: `The worker may only write inside the project directory; blocked: ${target}` };
    }
    if ((agentName === "worker" || agentName === "improver") && isRequestPath(cwd, target)) {
      return { allow: false, reason: `Ad-hoc request files are user-owned; ${agentName} may not write ${target}.` };
    }
  }
  if (policy.editRoots === "unrestricted-except-review") {
    for (const target of collectPaths(input)) {
      if (isReviewOrVerdictPath(cwd, target)) {
        return { allow: false, reason: "Workers may not write review files or verdict.md." };
      }
    }
    return { allow: true };
  }
  if (Array.isArray(policy.editRoots) && policy.editRoots.length === 0) {
    return { allow: false, reason: `The ${agentName} advisor is read-only and must not write files.` };
  }
  const roots = policy.editRoots.map(root => path.resolve(cwd, root));
  const denied = (policy.editDeny ?? []).map(target => path.resolve(cwd, target));
  const runsRoot = path.resolve(cwd, "runs");
  const denyBasenames = policy.denyBasenames ?? [];
  const denyDirs = policy.denyDirs ?? [];
  for (const target of collectPaths(input)) {
    const internal = internalTargetDecision(agentName, "write", target);
    if (internal.allow !== undefined) {
      if (!internal.allow) return internal;
      continue;
    }
    const abs = resolveProjectPath(cwd, target);
    if (!abs) {
      return { allow: false, reason: `Cannot resolve write target: ${target}` };
    }
    if (denied.some(entry => entry === abs)) {
      return { allow: false, reason: `${agentName} may not edit ${target}.` };
    }
    if (isUnder(runsRoot, abs) && denyBasenames.includes(path.basename(abs))) {
      return { allow: false, reason: `${agentName} may not write ${target}; it is produced by a worker dispatch.` };
    }
    if (isUnder(runsRoot, abs)) {
      const parts = path.relative(runsRoot, abs).split(path.sep);
      if (parts.length >= 2 && denyDirs.includes(parts[1])) {
        return { allow: false, reason: `${agentName} may not write ${target}; control and worker artifacts belong to worker dispatches.` };
      }
    }
    if (!roots.some(root => isUnder(root, abs))) {
      return {
        allow: false,
        reason: `${agentName} may only write under ${policy.editRoots.join("/ or ")}; ${target} is outside that scope.`,
      };
    }
  }
  return { allow: true };
}

export function evaluatePolicy({ agentName, toolName, input, cwd }) {
  const agent = normalizeAgent(agentName);
  if (!PIPELINE_AGENTS.has(agent)) return null;
  const policy = POLICY_TABLE[agent];
  const projectCwd = cwd || process.cwd();

  if (toolName === "ask") {
    return { block: true, reason: `The ask tool is disabled for pipeline agent ${agent}.` };
  }

  if (toolName === "advise") {
    return null;
  }

  if (toolName === "task") {
    const decision = taskDecision(agent, input);
    return decision.allow ? null : { block: true, reason: decision.reason };
  }

  if (toolName === "read" || toolName === "grep" || toolName === "glob") {
    const decision = readDecision(agent, input, projectCwd);
    return decision.allow ? null : { block: true, reason: decision.reason };
  }

  if (toolName === "bash") {
    const command = input && typeof input === "object" ? input.command : "";
    if (agent === "worker") {
      const decision = workerBashDecision(command, projectCwd);
      if (!decision.allow) return { block: true, reason: decision.reason };
    }
    if ((agent === "worker" || agent === "improver") && isRequestWriteCommand(command)) {
      return {
        block: true,
        reason: "Ad-hoc request and registry files are user-owned; workers and the improver may read them but not write them.",
      };
    }
    if (agent === "orchestrator") {
      if (isOrchestratorBashAllowed(command)) return null;
      return {
        block: true,
        reason:
          "The orchestrator may run only the deterministic request/plan helpers: " +
          "`node scripts/requests.mjs claim|ack|list ...` and `node scripts/dispatch-plan.mjs validate ...`. " +
          "Any other command is a worker dispatch; chaining, redirection and substitution are rejected.",
      };
    }
    if (policy.bash === "deny") {
      return {
        block: true,
        reason:
          `The ${agent} may not run bash or scripts. Dispatch a worker control role ` +
          "(intake, plan-check, integrate, ops, close) and read its report.",
      };
    }
    if (policy.bash === "allow") return null;
    if (!isImproverBashAllowed(command)) {
      return {
        block: true,
        reason:
          "The improver may run one allowlisted command per call: git diff|log|status|add|commit|rev-parse|restore, " +
          "omp config list|get, node scripts/dispatch-plan.mjs, and the validation commands. Chaining (; && |), " +
          "redirection, backticks and $( ) are rejected even inside quotes, so a commit subject must avoid them. " +
          `blocked: ${String(command).slice(0, 200)}`,
      };
    }
    return null;
  }

  if (toolName === "write" || toolName === "edit" || toolName === "ast_edit") {
    const decision = writeEditDecision(agent, input, projectCwd);
    return decision.allow ? null : { block: true, reason: decision.reason };
  }

  return null;
}
