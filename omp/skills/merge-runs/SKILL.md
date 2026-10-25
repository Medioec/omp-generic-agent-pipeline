---
name: merge-runs
description: Use when a human explicitly asks to merge completed pipeline runs into the shared memory. Human-triggered, skill-driven merge: list pending runs, plan, edit the shared memory on a branch, copy cited evidence, verify, commit, and let the human merge. Never runs automatically and never applies without the human's review.
---

# Merge completed runs into the shared memory

This is **not** part of the pipeline. A human triggers it; the session follows this skill; the memory repo is a separate git repo at `memory/`, created on first run by `scripts/bootstrap.mjs`. Runs live at `runs/` and are untracked.

## 1. Select

```
node scripts/merge-runs.mjs list
```

Pick the runs the human names. For each, read `runs/<run>/manifest.json`; require `status: pending-merge`. Validate:

```
node scripts/merge-runs.mjs validate runs/<run>
```

Do not merge `closed` or `merged` runs, and never backfill a manifest for a run that has none.

## 2. Plan

For each run, read `delta/facts.json`, `delta/decisions.json`, `delta/index.json`, `delta/corrections.json` and `summary.md`. Open the full report only when a conflict or ambiguity requires it.

Produce, for the human:

- each claim's disposition: **accept / reject / defer**, with one reason;
- duplicates across runs;
- contradictions and whether a later run explicitly supersedes an earlier claim;
- corrections to existing shared memory entries;
- the proposed facts sections, decisions, and index changes.

Conflict policy:

- Identical claim + same evidence → dedupe.
- Contradictory claims → accept neither automatically; mark both `contested` or ask the human to choose. Never silently overwrite an earlier snapshot.
- A supersession requires `supersedes` plus equal-or-higher evidence grade; otherwise defer.
- Facts are additive dated sections; decisions are append-only.

## 3. Branch

In the shared memory repo:

```
git -C memory switch -c merge/<YYYY-MM-DD>-<slug>
git -C memory status --porcelain    # must be empty first
```

All edits happen on this branch. Do not touch `main` until the human approves.

## 4. Edit

- `memory/facts/<topic>.md`: append a dated section (or add dated qualifiers). Do not rewrite the previous snapshot's numbers.
- `memory/decisions.md`: append accepted decision entries with `last-verified`/`status`.
- `memory/index.md`: update the topic line and, for merged runs, the runs table. Link only inside the shared memory.
- `memory/evidence/<run>/...`: copy every cited evidence file with:

```
node scripts/merge-runs.mjs evidence runs/<run> memory
```

- Rewrite each accepted claim's evidence link from `scratch/...` (run-relative) to `evidence/<run>/...` (memory-relative). The memory repo must not link outside itself.
- Record the run id in a `<!-- sources: ... -->` comment or in the text so provenance survives without the external run tree.
- Proposed decisions from `improvement.md` and `.omp/pipeline-backlog.md` may be accepted here; they are not applied by the improver.

## 5. Verify

```
node scripts/merge-runs.mjs verify memory
git -C memory diff --check
git -C memory status --short
```

Also run the deliverable-appropriate checks: link resolution inside `memory/`, count/label reconciliation against the deltas, duplicate decision headings, and that every pending run in the batch is accounted for. Report what was checked.

## 6. Review and commit

Show the human `git -C memory diff main...merge/<date>`. Only after their approval:

```
git -C memory add -A
git -C memory commit -m "merge: <runs>"
git -C memory switch main
git -C memory merge --ff-only merge/<date>
```

Then mark the runs:

```
node scripts/merge-runs.mjs mark-merged runs/<run> [...]
```

Do not commit anything to the project repo. Do not edit `.omp/**` or the run deltas.

## 7. Rollback

Before merging to `main`: `git -C memory switch main && git -C memory branch -D merge/<date>`.
After merging: `git -C memory revert <merge-commit>`.

No snapshot directory and no approval hash are used; git is the record.

## 8. Discipline

- Human-triggered only. Never start a merge on your own.
- Never merge a run whose `manifest.json` is absent or whose status is not `pending-merge`.
- Prefer compact deltas; open full reports only for conflicts.
- Every accepted claim must end with a memory-internal evidence link and a source run id.
