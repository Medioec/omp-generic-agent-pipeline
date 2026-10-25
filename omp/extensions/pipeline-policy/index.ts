import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { evaluatePolicy } from "./policy.mjs";

export default function pipelinePolicy(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const decision = evaluatePolicy({
      agentName: ctx.agent?.name,
      toolName: event.toolName,
      input: event.input,
      cwd: ctx.cwd,
    });
    if (decision) return { block: true, reason: decision.reason };
  });
}
