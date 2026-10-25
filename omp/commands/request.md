---
description: Submit an ad-hoc request to a running pipeline
argument-hint: <request> [--run <run>] [--agent <agent-id>] [--kind auto|additive|change|new-run]
---

Add work to a live run without starting a second pipeline. The run's current state decides
whether the request is applied, queued, or rejected; see the orchestrator's request cutoff.

1. Resolve the target:
   - use `--agent <id>` if given;
   - else use `--run <run>` and find its registry entry;
   - else run `node scripts/requests.mjs agents --role orchestrator` and select the single
     entry whose status is `starting`, `running`, `sink-approved`, `verdict-written`, or
     `closed`. If there are several, stop and ask for `--run` or `--agent`. An entry whose
     role is not `orchestrator` is never a valid target.
   If no target exists, report that there is no live run; use `/pipeline` for a new run,
   or the Agent Hub to message an unregistered orchestrator.
   Before treating a target as live, read `agent://<agent-id>`. If it does not resolve,
   or `runs/<run>/verdict.md` or `manifest.json` already exists, treat the run as closed:
   add with `--queue --origin-run <run>` and do not wake it.

2. Add the request with one command. It generates the id, writes the verbatim text to
   `runs/.requests/<request-id>.request.md`, submits it (run inbox, global inbox, or the
   new-run queue), and prints the wake line and durable path:

   ```bash
   node scripts/requests.mjs add --run <run> --text "<request text>" --kind <kind>
   ```

   Use `--agent <agent-id>` when the run directory is not known yet, and `--queue` when the
   amendment window is closed. `--file <path>` reads the text from a file instead of
   `--text`. The output JSON carries `id`, `path`, `request_file`, and `wake`; the wake
   already names the record path, so do not reconstruct it.

3. For a live target, wake the orchestrator with the printed line:

   ```text
   [request] id=<request-id> path=<record-path>
   ```

   `write` it to `agent://<agent-id>`. The id is authoritative; the path saves the
   orchestrator a directory scan.

4. Report the request id, target run, and whether it is live or queued. Do not implement
   the request yourself.

The request text is the user's verbatim words. Do not rewrite it into acceptance criteria;
the pipeline's `request-check` role classifies and scopes it.
