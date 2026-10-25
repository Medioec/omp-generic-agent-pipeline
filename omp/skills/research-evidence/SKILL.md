---
name: research-evidence
description: Use when the deliverable is online research rather than a code change — gathering facts from external sources (GitHub, web, official docs, literature) and writing an evidence-backed report, survey, comparison, or "most popular / top projects" list, including a revision round that fixes counts or metrics in one. Trigger on requests to research, survey repos, find the most popular or top tools, compare projects, look up stars/forks/activity/versions, or any task whose output is findings rather than an edit. Covers evidence capture, per-claim citation, the pre-completion completeness sweep, snapshot provenance, honest empty-category reporting, pre-completion link validation, and the final prose-count and metric-label reconciliation against the saved artifacts. Do NOT use for ordinary code changes.
---

# Research with evidence

A research run's "correctness" = every claim is backed by a retrieved source that
is saved on disk, and the report is **complete against its own evidence**. The
failure modes that cost pipeline rounds are almost never arithmetic; they are
(a) a superlative or "there is none" claim contradicted by a candidate the
researcher already captured, and (b) unsourced numbers from memory.

## 1. Capture evidence before you conclude

- Retrieve sources directly (e.g. `curl` the API/page/raw file) and **save the raw
  artifact** under the run's scratch tree (`runs/<run>/scratch/…`). Do not
  summarise from memory or from a search-results snippet alone.
- Save **per-entity** evidence (one file per repo/page/document you profile) and
  keep the raw search/list dumps too — the dumps are what the completeness sweep
  (§3) scans.
- **One id per citable thing, minted at capture time.** A search-results dump is
  *provenance for the query*, not a citation target: give it one id whose URL cell
  records the query and whose type says `query-dump`. Every snippet or thread you
  may quote gets its own id, its own canonical result URL, its row locator in the
  dump, and its own published date (or `undated`). Never mint one id for a dump
  that carries ten threads: a later citation cannot point at the row it means and
  the appendix cannot carry more than one URL. Six packs that gave one id per
  multi-result Reddit/web dump left the writer reconstructing 13 thread URLs from 9
  dumps after the fact, and the same defect cost two writer revisions.
- Cite per claim: attach the saved path (or URL + retrieval date) to each number
  or quotation. Cite the precise line range that actually supports the claim — a
  range that merely overlaps without containing the supporting text is a citation
  defect. A claim with no artifact is `status: provisional` at best.
- Prefer primary sources (official API/page/repo README) over aggregator pages;
  if you must use a secondary source, say so and mark the claim.
- A **negative or provenance claim** ("the only mention …", "nothing else says …",
  "this is a legacy page") is a claim too, and needs the artifact that establishes
  it — the search result, the redirect trace, or the entity's own metadata — not a
  citation to a file that merely fails to contain the content. Never point at a
  search-dump comment line, a `<title>`, or a range that only overlaps the claim:
  cite the line/field that actually contains the supporting text.

## 2. Make the method and its limits explicit

Include, in the deliverable itself:

- The **queries/endpoints run** and where each response was saved (a small table
  works well).
- The **retrieval date** and the fact that live values (stars, forks, `pushed_at`,
  download counts, versions) **drift** — the saved snapshot is authoritative;
  re-check before quoting.
- **A date basis for every dated source, including versioned preprints.** Record the
  publication date *and* the artifact it came from (a JSON field, a visible byline, the
  submission history). For a versioned preprint, `published` is the first public version
  (v1) from the submission history; later revisions are notes, not a re-date, and an HTML
  render date is not a publication date. State the convention in the deliverable so a reader
  can dispute the convention rather than the counts (one render said "August 24, 2026"
  while the abstract page showed v1 at 2026-06-08 on a single version, so the paper was
  excluded as pre-window).
- Any **quota/rate-limit or access limit** hit and the fallback used, recorded as
  provenance.
- **Budget a rate-limited host before you harvest from it.** Concurrently
  dispatched units share one per-IP budget, so eight units each planning "a few
  hundred calls" against `api.github.com` exhaust the same bucket. In one run the
  unauthenticated core bucket was drained mid-run (a unit recorded `0/60` remaining in
  its saved header dump) and the search bucket went 9 → 0 during another unit's
  harvest. Read `/rate_limit` or the `x-ratelimit-remaining`
  header first, size the call plan to what is left, and prefer a surface with its
  own budget — the search endpoint, `releases.atom`, `raw.githubusercontent.com`,
  the HTML issue page — over retrying a 403. Save the snapshot next to the
  fallback.
- **Back the method's own numbers.** A provenance statement is a claim too — assert
  only what a saved artifact shows. If a source was blocked or errored, describe what
  the saved body actually is (e.g. "a bot-protection checkpoint page; no status or
  headers captured") instead of asserting an HTTP status you did not save; never state
  a rate-limit/quota *remaining* count without the saved response-header dump (omit it
  or mark it unmeasured). A provenance section that asserted an unsaved status and an
  unsourced quota reading drew advisor minors for exactly this.
- What was **searched but found empty**, with the evidence that establishes the
  emptiness (e.g. the total_count of a search). An unsupported "there is none"
  is itself a defect.

## 3. The completeness sweep (do this BEFORE claiming done)

Every pipeline round lost to a research miss has been a coverage miss. Before you
write "the most/highest/first …" or "there is no …", run this sweep mechanically:

1. Compute the universe mechanically from **every saved dump that carries the
   ranking field** — search/list dumps, org inventories, curated lists, **and
   per-entity/per-repo JSON records** — not just the dumps you happen to re-open by
   hand. The reliable form is a replayable script (saved under the run's `scratch/`)
   that reads every dump, dedupes by entity, and emits the ranked set; a hand-built
   list silently drops the evidence set you did not re-read. Then keep every
   candidate above the inclusion threshold you stated for the deliverable. The
   sweep's **saved output file is the authoritative record of its counts**:
   re-run the sweep as the last step before finalizing (after every evidence file
   is saved) and transcribe the file/URL/host counts *from that output* — never
   from memory or an earlier run. If evidence files are added later, re-run again
   (or state the sweep's epoch) so the report's counts and the saved `*.out.txt`
   cannot diverge. Keep the sweep script **non-destructive**: write to a stable
   path and snapshot the prior output under `scratch/originals/` before a re-run
   rather than clobbering the only copy.
2. For each, decide: **profiled**, or **explicitly excluded with a reason**. There
   is no third state — silent omission is the defect.
3. Sort/rank the final set so the ordering actually reflects the metric you name
   (if you claim "ranked by stars", it must be sorted by stars).
4. Re-check every **superlative** ("highest-starred", "largest", "most popular")
   and every **empty/sparse-category** claim against step 1. If a captured
   candidate outranks or contradicts the claim, the claim is wrong.
5. State each superlative with the sweep's exact scope — "highest in every dump in
   which it appears", never the broader "in every dump" when a candidate is absent
   from some — and keep the body's wording consistent with the sweep's.
6. Check the deliverable's links before you report the round complete. Every
   markdown link target must resolve **from the file that contains it**; relative
   depth is the common defect (a report at `runs/<run>/worker/round-N.md` reaches
   the shared memory as `../../../memory/facts/` and its own `scratch/` as `../scratch/`, not
   `../../…`). Run a resolver over the file and report the checked/resolved counts.

   A resolver that checks only *existence and span-in-file* does not verify a
   citation: it passes a blank line, a range that ends one line past the last
   content line, and a range that does not contain the claim at all. Enforce four
   things and report each count separately: (a) the path resolves from the run
   root; (b) the span ends at or before the file's **last content-carrying line** —
   a `wc -l` bound is one line too generous on a trailing-newline file and once
   passed 8 bad ranges; (c) the span contains at least one non-blank line — a
   blank-line anchor passed both the writer's and the verifier's resolvers;
   (d) the span contains a distinctive
   token of the claim it supports: the number, field name, or phrase. Treat (d) as
   a warning to read, not a hard failure. Run the resolver over the deliverable
   **and** the round file, `summary.md` and `delta/`, which quote the same evidence.
   One run rebuilt this resolver four times (three units and the verifier) and every
   version was weaker than this contract; reuse a shared checker
   when the project ships one rather than writing a fourth. A round file that logs
   superseded citations — a `was → now` defect table — must mark them so they do not
   parse as live: that same writer normalised its defect table to live-looking paths,
   six historical citations then failed its own resolver, and the repair cost four
   calls (the round file records the convention: "Paths in this table are shown relative
   to `scratch/` on purpose, so the superseded strings are not mistaken for live
   citations").
7. **Reconcile the prose against the count table — including counts with no unit.**
   Step 1 fixes the section that quotes the sweep; it does not stop a count written
   elsewhere from drifting. As the last pass, after every edit: build the count table
   once from the current sweep output and the per-source metadata (profiled /
   duplicate / excluded / unclassified / undated / papers / publishers / date
   distribution / per-type tallies), then extract **every** count in the deliverable
   — unit-bearing measurements, bare numerals, and spelled-out counts ("four",
   "thirteen") — and compare each to that table. Locators, section numbers, index row
   ids, and dates are legitimate exceptions: list them explicitly in the round file
   instead of skipping silently. An exception class is for tokens that are not counts at
   all; it is never a home for a count you have not traced, and a phraseological class that
   absorbs a real count ("ten areas", "six of the six papers") is a hole in the check, not
   an exception. A count that describes the source base but is absent
   from the table is stale until it is traced to an artifact. A checker that only
   inspects unit-bearing tokens (`%`, `pp`, `$`, …) passes while `59 excluded`,
   `13 papers`, and `four undated` are all wrong.
8. **Check each number's label, not just its presence.** A numeral that does appear in
   the cited range can still be attached to the wrong metric. Compare the noun phrase
   beside the number with the source's own label for that figure and use the source's
   wording (a paper's `+15.12%` on *partial goal completion* is not a "grader score",
   even when both occur in the cited lines).
9. **Check a stated count against its own enumeration, and derive typed tallies from the
   records.** A sentence that enumerates its members is its own authority: "Four headline
   claims … in three of the eight reporting areas" must match the claims and the area numbers
   that follow it, and a count of a typed set ("six arXiv items — five `paper` records and one
   `survey`") must be computed from the per-item records (`type`, `date_basis`), not hardcoded
   in the checker and not carried over from an earlier draft. **Prove each assertion with a
   negative control**: mutate a copy of the deliverable so the defect is present, confirm the
   checker fails (non-zero exit) and record the mutation and the `[FAIL]` line in the round
   file. An assertion nobody has seen fail is a claim, not a check.
10. **Describe every guard as narrowly as its code.** A round file, report, or decision entry
    that says a checker "catches X" must be true of what the code inspects. A new
    `area N` guard rejected out-of-range tags only and could not have caught the
    in-range `area 8→cost` heading that review found; an advisor forced the scope note,
    and a second over-claimed guard provenance in a decision entry drew another. State
    the known gap next to the guard, and never present a review catch as a check.
11. **Put every shipped file that quotes a saved output inside the reconciliation.** The
    deliverable is not the only file that states counts: the round file, `summary.md`,
    and decision entries quote the same outputs, and they go stale the moment
    those outputs are regenerated. Re-read the saved output as it stands after the last re-run
    before restating any number, and widen the resolver's scope to the file you are writing. A
    checker scoped to the report alone cannot see any of it.
12. **A negative claim is only as strong as the corpus you swept.** Build the sweep's input from
    the **union of every corpus the deliverable cites** — help dumps, doc pages, and the
    package / type-definition / module corpora — and name the corpus next to the claim. An
    absence sweep ran over 33 doc pages and 3 help dumps but not over the installed package
    corpus, so "opencode has no … listing, killing or supervision" survived while the same
    report cited that package's `Pty` class. For a comparison or gap claim, also
    check the **other side's inventory**: an "only X can …" item whose counterpart is named in
    the other inventory is a defect, not a finding.
13. **An inherited figure is a claim, not data.** When the deliverable synthesises an upstream
    inventory, re-derive each numeral and each enumerated set from the artifact that *defines*
    the concept — the doc page that lists the roles, the schema that lists the keys — never from
    the artifact that merely mentions a flag. An upstream citation tells you where the number
    came from, not that it is right: an inventory row once read "five model roles"
    off `omp --help` flags while the doc page defined fifteen, and the writer re-cited the help
    dump, so the error survived a link check and approval until the sink re-read the doc.
    A set claim is re-derivable: grep
    the corpus for the concept and compare the enumeration member by member.
14. **Turn every per-row criterion into a checker before you claim the criterion.** If a
    criterion says "a short note for each row", the note is a countable field, not a prose
    obligation. Write the row checker first — row count, cells per row, every required cell
    non-empty, presence values restricted to the declared vocabulary — save its output, and
    quote the counts per criterion in the round file. Split cells on unescaped `|` only: a naive
    split reports escaped pipes inside cells as malformed rows. One writer's completion round
    claimed AC1 satisfied while 136 of 186 rows had an empty Note; approval rested on the same
    claim and the sink found it, costing a reopen of the writer and a second sink pass. The
    checker written after the fact reported it in one line.

Worked failure: the report claimed a
9,195★ project was the highest-starred opencode-native project, while an 11,001★
one sat in the researcher's own saved search dump and was never mentioned — a
verification caught it and forced a full revision. The sweep above would have caught
it before the round ended.

Worked failures: the report stated a
22-entity ≥10,000★ union while the saved per-repo JSON held nine more above-threshold
entities — a mechanical union over `scratch/repos/**` + `scratch/search/**` found 31
(the hand-built list had been drawn from the search dumps alone, so step 1's universe
must include per-repo JSON); and five baseline links written `../../facts/…` resolved
into a non-existent tree at the wrong depth (historical layout) — step 6's relative-depth check catches exactly
that class. Both were verification-caught `[major]` findings that cost a revision round.

Worked failure: the report's sweep
section stated "53 files / 7,190 URLs / 124 hosts" while the saved
`scratch/sweep_sources.out.txt` read 63 / 7,882 / 154 — the counts had been
transcribed from an earlier sweep run, not the current artifact; and a
`langchain-community` caveat cited a search-dump comment-header line that contained
none of the claimed content while asserting an unsupported "the only in-run mention
… legacy page" provenance. Both cost a revision round; the fixes were to transcribe
the counts from the current artifact and to classify the package from its own PyPI
`info.summary`.

Worked failure: both checkers passed —
`check_citations.py` 335/335 links, `audit_numbers.py` 85/85 "measurement tokens" —
while the report said "the 59 excluded candidates" and "every one of the 59
exclusions" against a sweep total of **78**, "13 papers" against the **15** its own
header and §2.3 stated, and "four profiled artifacts" undated against **five** (three
vendor doc pages plus two OWASP project pages). None of those numerals carries a
unit, so the numeric audit could not see them; approval rested on the same report; the run's
independent whole-spec check found them, not the worker's own checks. The same report called the MCP
tool-description paper's **15.12% partial goal completion** a "grader score" — the
numeral really was inside the cited range, which is why step 8 (compare the label)
is separate from step 7 (compare the count). Fixing all of it cost an extra revision
round; steps 7–8 over the finished prose find them in one pass.

Worked failure: four checkers passed —
`check_links.py` 291/291, `check_citations.py` 0 failures, `count_reconciliation.py` 39/39,
`audit_numbers.py` 19/19 — while the shipped report said "Five of the ten areas' …" over an
enumeration of four, called a set of 5 `paper` + 1 `survey` "the six papers", and turned a
per-area empty result into "eighteen queries … produced no new primary source" against 19
in-window sources. The round file still quoted a pre-edit run ("288 links … round file 22",
"30 sweep assertions" after the set grew to 39), and the run's `summary.md` said §1 carries
"five stated method limits" where the report names four. The orchestrator found the first four by
reading the prose after reproducing every checker; the advisor found the rest, because a checker
scoped to the report cannot see the round file or the summary. Steps 9–11 make the same checks
mechanical: enumeration and records instead of the count table alone, negative controls so each
assertion is known to fail, and the quoting files inside the scope.

## 4. Shape the deliverable around the acceptance criteria

When the spec does not already impose a shape, a usable research deliverable has:

- A short **TL;DR** of the load-bearing conclusions.
- **Per-entity profiles** (what it is, in 2–4 sentences, its actual relationship to
  the subject, and the evidence path) grouped/ranked coherently.
- A clear **subject-boundary** distinction where the topic has a canonical "official"
  vs "community/adjacent" split — establish "official" from a primary source (e.g.
  the domain's own link or a redirect you observed), and say how you established it.
- An **honest exclusions** section for lookalikes/name-collisions, so a reader is
  not misled by a same-named unrelated entity.
- A compact **indexed table** (entity, URL, key metric, date, category).
- Explicit statement of **categories searched and found empty/sparse**, each with
  the evidence.

## 5. For the advisor of a research deliverable

"Reality" is the live source **plus** the saved artifacts — not the worker's prose.

- Re-fetch a sample of load-bearing values live; expect benign drift and treat the
  saved snapshot as authoritative for the report's own consistency.
- **Independently perform §3**: scan the saved evidence dumps for unmentioned
  candidates that outrank or contradict the report's claims, and check that empty
  categories are evidenced. This sweep is a required verification step, not an
  optional nicety — it is what caught the major defect in the run above.
- Reproduce the worker's cited artifacts (paths exist, contents match), confirm
  no number is unsourced, and confirm every markdown link target resolves from the
  file that contains it (§3 step 6 — a wrong relative path is the usual cause).
- **Reconcile reported numbers against the output you actually captured.** When you
  re-run the worker's sweep/script, diff your captured output against both the saved
  artifact and the report's quoted counts, and quote the numbers you saw. Writing
  that a re-run "confirms", is "identical to", or "matches" a reported number is
  valid only if the output you saved literally shows it — otherwise it is a phantom
  verification. (Worked failure: a round-1 review claimed its re-run was "output identical to saved
  `scratch/sweep_sources.out.txt`" and "Confirms … 53 files / 7,190 URLs / 124
  hosts", but its own preserved capture `scratch/tmp/reviewer_sweep.out.txt` already
  read 63 / 7,882 / 154.)
- **Run the prose-count and label reconciliation yourself (§3 steps 7–11).** For a
  research deliverable, build the count table from the saved sweep and metadata and
  check every numeral and spelled-out count in the deliverable against it, plus each
  number's label. Also check each stated count against the enumeration in its own
  sentence, each set claim against the set it actually covers, whether a claimed guard
  scope matches the code, and include the round file, `summary.md` and the merge delta —
  they quote the same outputs. Do not treat the worker's passing numeric checker as
  coverage: a checker scoped to unit-bearing tokens reports 85/85 while four prose counts
  have drifted (worked failure), and a checker scoped to the report passes while the
  round file quotes a superseded run.
- The advisor still never edits the deliverable; report findings with a fix
  direction.
