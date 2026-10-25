---
name: run-forensics
description: How to mine agent transcripts and round artifacts when analyzing a pipeline run — live settlement or completed run — resolving `history://` ids, bounded reads of long transcripts, and separating what a worker actually ran from what its round file claims. Use during improver diagnosis, when a round file and a transcript may disagree, or when reconstructing advisor feedback for a round.
---

# Run forensics

Round files are **self-reports**. Transcripts are **what ran**. Diagnose from transcripts whenever a signal depends on what a worker actually executed: whether a check was run, against which corpus, how many times a command was retried, which approach was abandoned, and what the advisors said at that turn.

## Sources and what each is good for

| Source | Contains | Use for |
|---|---|---|
| `history://<id>` | full turn transcript of a subagent | claims vs actions, tool calls, retries, abandoned paths, injected advisor notes |
| `agent://<id>` | final published output only | confirming what the dispatch finally returned |
| `runs/<run>/worker/round-N.md` | worker's own account | intent, declared checks, what it believed it measured |
| `runs/<run>/dispatch.md` | ids, seq, settlement notes | which ids exist and which round they belong to |
| `runs/<run>/requests/*.json` | ad-hoc request, triage, status | why a unit exists and when the request was submitted |
| `runs/.agents/*.json` | live agent/run registry | which agent and run served a request |
| `scratch/verification/*` | sink/verifier reports | independent measurements to test the transcript against |

## Advisor notes live inside the primary transcript

Accepted advisor notes are rendered into the primary session as `<advisory advisor="…">` elements. Advisor rows are excluded from the `history://` index, so a separate advisor transcript does not exist for you to read; do not hunt for one and do not report "no advisor transcript" as a gap. Grep the worker transcript for `<advisory` instead. `/advisor dump` is a TUI affordance, not a subagent path.

**They render truncated.** Every `[advisor]` line is clipped at a fixed width (observed at 130 characters) and ends in `…`: all 64 notes observed in one run were clipped, so the opening clause is all a transcript shows. Quote the attributes and that clause; take the substance from the worker's `## Advisor feedback` row or the round file. Never infer a recommendation from the first eight words, and never write the note's content as though you had read it whole.

**Tool calls are elided too.** A rendered call keeps about 100 characters of its arguments — `→ bash(cd … && python3 - <<'PY' p='report.md'; s=o…)` — so an inline script's body, its target file and the corpus it swept are not visible. When a finding turns on what such a call did, read the saved script under `scratch/` (a run's checkers are saved files) or the output section that follows the call. Do not conclude from the call line that a command covered something.

## Bounded read recipe

1. **Resolve ids.** `read history://` lists what still resolves — id, status, kind, parent, last activity. Ids are session-scoped, not resume keys, so a fresh session may see nothing. Parked subagents from the run resolve normally for the session that spawned them.
2. **Locate markers before reading prose.** A transcript renders as `# <id> (<status>)` plus `## user`, `## assistant`, and tool sections. `grep` returns line numbers, which are the citation anchor. Anchor on what you need:
   - `pattern: "<advisory|WORKER STATUS|STALLED|## Completion"` — advice, terminal markers, completion claims
   - `pattern: "node |python3? |grep |wc -l|git "` — the commands actually issued
   - `pattern: "<the specific claim under test>"` — e.g. a count the round file asserts
3. **Read the tail first.** The completion turn carries the claims that reached approval: `read history://<id>:-80`. Work backwards only where a marker demands it.
4. **Read the cited turn, not the run.** Open a narrow span (`read history://<id>:197-215`) around a marker hit; stop when the claim is decided.

**Oversized transcripts:** grep searches only the leading window of an oversized file. A no-match on a multi-megabyte transcript is not evidence of absence — page the tail with `read` before concluding anything is missing.

## Markers beyond the turn structure

A transcript also carries lines that are neither prose nor tool calls, and each is evidence:

| marker | meaning | what it establishes |
|---|---|---|
| `[advisor] <advisory …>` | live advice, clipped | the advisor loop; see above |
| `[advisor] The following is an aggregated review from other models.` | a cross-model review pass injected after the first yield | post-completion rework that no round file describes |
| `[irc] <peer> → me: …` | a message from the orchestrator into a parked or finished session | work delivered without a `task` dispatch; check it against `dispatch.md` |
| `[async-result] …` | a background job's output arriving later | which command the next turn is reacting to |
| `[budget notice] …` | the request soft budget was reached | a budget finding, not a discipline finding |
| `WORKER STATUS: DONE\|STALLED round=N` | the turn-set's terminal marker | count turn-sets, not messages: one reply can carry the marker twice |

Count dispatches by transport, not by the marker: one run's `dispatch.md` logged 11 dispatches while the transcripts show additional `[irc]`-delivered and post-DONE repair turn-sets that wrote no row.

## Unavailable transcripts

If an id does not resolve, say so once, then fall back to round files plus the verifier reports, and record `transcripts unavailable: <id> — <reason>` in the analysis. Do not silently substitute round files for a transcript and present the result as transcript-checked.

## Extracting findings

Advisor notes are rendered inline as `[advisor] <advisory advisor="<name>" severity="<level>" guidance="…"> … </advisory>`. Quote the attributes you rely on; they carry the roster name and the severity that the note was filed at, which is what a phantom-issue judgment turns on.

For each finding, capture:

- the **anchor** — `history://<id>:NNN` (the grep line number, widened just enough to read), so the finding is locatable;
- a quote of at most three lines;
- the contrast stated plainly: *round file says X at `round-N.md:L`; transcript shows Y at `history://<id>:NNN`*.

If a merged delivery carries a `turns_ago` attribute, quote it; it places the advice relative to the turn it criticizes.

Look specifically for these, none of which a round file can reveal:

- **Narrated verification** — the round file claims a check; the transcript shows no such command, or the same narrower command as before.
- **Corpus drift** — a claimed sweep run over fewer sources than the deliverable cites.
- **Retry chains** — a tool or script failing repeatedly then being replaced; the failure mode is the signal, not the retry count.
- **Advice lifecycle** — a `<advisory>` whose fix never appears in a later diff: the advisor fired, the worker did not absorb it.
- **Context pressure** — compaction markers before the turn where quality dropped; that is a budget finding, not a discipline finding.

Quote only what the finding needs. A transcript read is evidence for a divergence, not a second copy of the run.

## Cost accounting

The transcript renders tool calls compactly — `→ tool(args) ⇒ ok · N lines` — with no usage numbers. Durations and tokens do **not** survive into `history://`; the only measured record is the `## Dispatch metrics` section the orchestrator writes in `dispatch.md`. Read that first; a dispatch missing there is unmeasurable, which is itself a finding about the orchestrator, not an invitation to estimate.

Reading the three axes:

- **Duration** — `dur` per dispatch. A unit whose total exceeds its siblings by a large factor is either bigger or worse decomposed; check its increment count before blaming the prompt.
- **Revision count** — `rev` per unit. Each revision is a full dispatch: read the first round of that unit and the orchestrator's revise note that rejected it. If that note named the defect precisely and the fix was one edit, the loss is in the first dispatch's spec, not the revision.
- **Tokens and requests** — `tokens`/`req` per dispatch. Normalize before comparing: tokens per deliverable line, or per citation, is comparable across sizes; raw totals are not. A unit with high `req` and low output is looping — find the repeated command in its transcript.

Redundancy is countable from the rendered tool calls, with no token accounting needed: extract the `→` lines and count duplicate targets. Use the `grep` tool on the transcript (`^→ bash\(`), which returns line numbers, so each hit is also the citation anchor; page with `read` when the match list is long. The improver's bash allowlist (`IMPROVER_BASH_PREFIXES` and `IMPROVER_BASH_EXACT` in `.omp/extensions/pipeline-policy/policy.mjs`) excludes `grep`, `wc`, `sort` and every pipe, so a shell pipeline is for a human shell, not for the improver:

```bash
grep -o '^→ [a-z_]*(.*' history://<id> | sed 's/ ⇒.*//' | sort | uniq -c | sort -rn | head -20
```

For exact counts over a long transcript, load the resource whole and count, rather than eyeballing a page of matches: `read history://<id>` returns the full rendered text (about 46k characters for a 900-line, 200-call transcript), and the eval kernel can classify those lines. Normalise before comparing units — calls per deliverable line is comparable across sizes; raw call totals are not.

A path read three times, or a `sed -n '1,60p'` over the same file two turns apart, is a prompt defect: the first read should have fed the answer. Same for a checker rewritten rather than extended, and for an ad-hoc `python3 - <<PY` used where one `edit` would have appended a table row. Count them, and say what the count is in the dispatch's own units — `<n> calls of <checker> across <m> dispatches` — not as a percentage of an unmeasured total.

**What not to count as waste:** a re-read that caught a defect, a second verification pass whose result differed, a round file that quotes evidence a later round cites. Removing those trades correctness for a number. An efficiency finding must leave every verification capable of failing.
