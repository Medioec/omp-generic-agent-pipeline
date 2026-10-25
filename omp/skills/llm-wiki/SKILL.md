---
name: llm-wiki
description: Use when building, ingesting into, querying, or linting a persistent interlinked markdown wiki (Karpathy's LLM-wiki pattern) in this project — create the wiki skeleton, capture raw sources, write and cross-reference entity/concept/comparison/query pages, answer from compiled knowledge, and audit links, index, frontmatter, taxonomy, page size and source drift. Not for this project's merge-gated memory/, which is written only by skill://merge-runs.
---

# LLM wiki

Build and maintain a persistent, compounding knowledge base as interlinked markdown files.
Based on [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f);
adapted for this project from the [Hermes Agent skill](https://github.com/NousResearch/hermes-agent/blob/main/skills/research/llm-wiki/SKILL.md) (MIT).

RAG rediscovers knowledge per query. The wiki compiles it once and keeps it current: cross-references
already exist, contradictions are already flagged, synthesis reflects everything ingested.

**Division of labor:** the human curates sources and directs analysis. The agent summarizes,
cross-references, files, and maintains consistency.

## When this activates

- The user asks to create, build, or start a wiki or knowledge base.
- The user asks to ingest, add, or process a source into the wiki.
- The user asks a question and a wiki exists at the configured path.
- The user asks to lint, audit, or health-check the wiki.
- The user references "the wiki", "knowledge base", or "notes" in a research context.

## Where the wiki lives (project constraint)

The pipeline confines workers to the project directory: `read` rejects paths outside it, and `bash`
rejects `~`, `$HOME`, and absolute paths that escape it. A wiki at `~/wiki` is therefore unusable
from a pipeline run.

- `WIKI="${WIKI_PATH:-wiki}"` — **project-relative by default**, resolved from the project root.
- The wiki is ordinary project content: commit it unless the human says otherwise.
- A pipeline run may write the wiki only when the unit that does so declares `wiki/` in its `writes`
  scope in the dispatch plan. Otherwise propose the change and leave it to the human.
- A human session outside the policy may set `WIKI_PATH=$HOME/wiki`; the layout is unchanged and
  every path below is relative to `$WIKI`.

**Do not point `WIKI_PATH` at `memory/`.** `memory/` is this project's merge-gated shared memory: pipeline
agents never write it, and a human-triggered merge (`skill://merge-runs`) is its only writer. The
wiki is a separate, human-directed corpus with its own schema. If the human wants a single corpus,
follow the shared memory rules in `memory/index.md` — not both conventions at once.

The wiki needs no database, service, or plugin. It is a directory of markdown files.

## Architecture: three layers

```
wiki/
├── SCHEMA.md           # conventions, structure rules, domain, tag taxonomy
├── index.md            # sectioned content catalog with one-line summaries
├── log.md              # append-only chronological action log
├── raw/                # Layer 1: immutable source material
│   ├── articles/       # web articles, clippings
│   ├── papers/         # PDFs, papers
│   ├── transcripts/    # meeting notes, interviews
│   └── assets/         # images, diagrams referenced by sources
├── entities/           # Layer 2: entity pages (people, orgs, products, models)
├── concepts/           # Layer 2: concept/topic pages
├── comparisons/        # Layer 2: side-by-side analyses
└── queries/            # Layer 2: filed query results worth keeping
```

Layer 1 is immutable: read it, never modify it. Layer 2 is agent-owned. Layer 3 (`SCHEMA.md`)
constrains everything else.

## Orient before every operation

For an existing wiki, do this first — every session:

1. `read wiki/SCHEMA.md` — domain, conventions, tag taxonomy.
2. `read wiki/index.md` — what pages exist and what each covers.
3. `read wiki/log.md:-30` — recent activity.

Then `grep` for the topic at hand before creating anything. Skipping orientation causes duplicate
pages, missed cross-references, schema violations, and repeated work.

## Initialize

1. Resolve `WIKI` (see above). Ask the human for the domain — be specific. In a non-interactive run,
   take the domain from the spec and record the assumption in `runs/<run>/issues.md`.
2. Create the tree:

   ```bash
   WIKI="${WIKI_PATH:-wiki}"
   mkdir -p "$WIKI"/{raw/{articles,papers,transcripts,assets},entities,concepts,comparisons,queries}
   ```

3. Write `SCHEMA.md`, `index.md`, and `log.md` from the templates below, customized to the domain.
4. Report the path and suggest the first sources to ingest.

### SCHEMA.md template

````markdown
# Wiki Schema

## Domain
[What this wiki covers — e.g. "AI/ML research", "personal health", "startup intelligence"]

## Conventions
- File names: lowercase, hyphens, no spaces (e.g. `transformer-architecture.md`)
- Every page starts with YAML frontmatter (below)
- Link with `[[wikilinks]]`; at least 2 outbound links per page
- When updating a page, bump `updated`
- Every new page is added to `index.md` under the correct section
- Every action is appended to `log.md`
- **Provenance:** on pages synthesizing 3+ sources, append `^[raw/articles/source-file.md]` at the
  end of each paragraph whose claims come from one specific source. Optional on single-source pages,
  where `sources:` is enough.

## Frontmatter
```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [from the taxonomy below]
sources: [raw/articles/source-name.md]
# optional quality signals:
confidence: high | medium | low        # how well-supported the claims are
contested: true                        # unresolved contradictions
contradictions: [other-page-slug]      # pages this one conflicts with
---
```

`confidence` and `contested` are optional but recommended for opinion-heavy or fast-moving topics.
Lint surfaces `contested: true` and `confidence: low` pages for review so weak claims do not harden
into accepted fact.

### raw/ frontmatter

Raw sources also carry a small frontmatter block so re-ingests detect drift:

```yaml
---
source_url: https://example.com/article   # original URL, if any
ingested: YYYY-MM-DD
sha256: <hex digest of the body below the frontmatter>
---
```

Compute the digest over the body only (everything after the closing `---`), never over the
frontmatter. On re-ingest of the same URL, recompute and compare: identical means skip, a mismatch
means the source changed or the raw file was edited. Stamp it with the skill's tool:

```bash
python3 .omp/skills/llm-wiki/scripts/wiki.py hash "$WIKI/raw/articles/source-name.md" --write
```

## Tag Taxonomy
[Define 10–20 top-level tags for the domain. Add a new tag here BEFORE using it.]

Example for AI/ML:
- Models: model, architecture, benchmark, training
- People/Orgs: person, company, lab, open-source
- Techniques: optimization, fine-tuning, inference, alignment, data
- Meta: comparison, timeline, controversy, prediction

Rule: every tag on a page must appear in this taxonomy. Adding a tag here first prevents tag sprawl.

## Page Thresholds
- **Create a page** when an entity/concept appears in 2+ sources, or is central to one source
- **Add to an existing page** when a source mentions something already covered
- **Do not create a page** for passing mentions, minor details, or out-of-domain items
- **Split a page** above ~200 lines into sub-topics with cross-links
- **Archive a page** when fully superseded: move it to `_archive/`, remove it from `index.md`

## Entity Pages
Overview; key facts and dates; relationships ([[wikilinks]]); source references.

## Concept Pages
Definition; current state of knowledge; open questions or debates; related concepts ([[wikilinks]]).

## Comparison Pages
What is compared and why; dimensions (table preferred); verdict or synthesis; sources.

## Update Policy
When new information conflicts with existing content:
1. Check dates — newer sources generally supersede older ones.
2. If genuinely contradictory, keep both positions with dates and sources.
3. Mark `contradictions: [page-name]` in frontmatter.
4. Flag it for human review in the lint report.
````

### index.md template

```markdown
# Wiki Index

> Content catalog. Every wiki page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: YYYY-MM-DD | Total pages: N

## Entities
<!-- alphabetical within the section -->

## Concepts

## Comparisons

## Queries
```

**Scaling:** when a section exceeds 50 entries, split it into sub-sections by first letter or
sub-domain. Above 200 entries total, add `_meta/topic-map.md` grouping pages by theme.

### log.md template

```markdown
# Wiki Log

> Chronological record of all wiki actions. Append-only.
> Format: `## [YYYY-MM-DD] action | subject`
> Actions: ingest, update, query, lint, create, archive, delete
> Above 500 entries, rotate: rename to log-YYYY.md and start fresh.

## [YYYY-MM-DD] create | Wiki initialized
- Domain: [domain]
- Structure created with SCHEMA.md, index.md, log.md
```

## Ingest

When the human provides a source (URL, file, paste), integrate it:

1. **Capture the raw source** into the matching `raw/` subdirectory with a descriptive name
   (`raw/articles/karpathy-llm-wiki-2026.md`):

   ```bash
   curl -fsSL "<url>" -o "$WIKI/raw/articles/<name>.md"
   ```

   `read <url>` is fine when you only need the text in context; use `curl` when the bytes must be
   saved. For a PDF, save the bytes under `raw/papers/` and read the saved file for its text. If the
   page needs JavaScript, use the browser tool or the human-provided text, and record the method in
   the log entry. Add the raw frontmatter (`source_url`, `ingested`, `sha256`) and stamp the hash.
2. **Re-ingest drift:** recompute the hash and compare. Identical → skip processing. Different →
   report the drift, replace the raw file, then update the affected pages.
3. **Discuss takeaways** with the human — skip this step in an automated run and proceed.
4. **Check what exists** — search `index.md` and `grep` the wiki for every entity and concept the
   source mentions. This is the difference between a growing wiki and a pile of duplicates.
5. **Write or update pages:**
   - New entities/concepts only when they meet the Page Thresholds.
   - Existing pages: add the information, correct facts, bump `updated`; follow the Update Policy on
     conflict.
   - Cross-reference: at least 2 outbound `[[wikilinks]]`, and make sure existing pages link back.
   - Tags only from the taxonomy.
   - Provenance markers on 3+-source pages; `confidence` for opinion-heavy or single-source claims.
6. **Update navigation:** add new pages to `index.md` alphabetically, update the total/date header,
   append `## [YYYY-MM-DD] ingest | Source Title` to `log.md` listing every file created or updated.
7. **Report** every file created or updated.

One source touching 5–15 pages is normal and desired — that is the compounding effect.

## Query

When the human asks a question about the wiki's domain:

1. Read `index.md` to find relevant pages.
2. For 100+ pages, also `grep` the page directories for key terms — the index may miss content.
3. Read the relevant pages.
4. Synthesize, citing the pages you drew from: "Based on [[page-a]] and [[page-b]]…".
5. File valuable answers back: a substantial comparison, deep dive, or novel synthesis becomes a
   page in `queries/` or `comparisons/`. Do not file trivial lookups.
6. Append the query to `log.md` and say whether it was filed.

## Lint

```bash
python3 .omp/skills/llm-wiki/scripts/wiki.py lint "$WIKI"
# skill installed outside this project: python3 skill://llm-wiki/scripts/wiki.py lint "$WIKI"
```

`lint` is read-only. It prints a severity-grouped report and exits 1 when an error exists.

| Check | Flag | Severity |
|---|---|---|
| `[[link]]` targets an existing page stem | `broken-link` | error |
| page stem is unique across page dirs | `duplicate-stem` | error |
| required frontmatter fields present and well-typed | `frontmatter`, `invalid-type`, `invalid-date` | error |
| every tag is in `SCHEMA.md` | `invalid-tag` | error |
| every page appears in `index.md` | `index-missing` | error |
| `raw/` `sha256` matches its body | `raw-drift` | error |
| page has inbound links from other pages | `orphan` | warning |
| `contested: true` / `contradictions:` | `contested` | warning |
| `confidence: low`, or `high` on a single source | `confidence` | warning |
| `updated` older than 90 days | `stale` | warning |
| page above 200 lines | `page-size` | warning |
| `log.md` above 500 entries | `log-rotation` | warning |
| `raw/` file without `sha256` | `raw-unhashed` | warning |

Warnings not listed above: `tags` (empty tag list), `no-sources` (empty sources list),
`raw-frontmatter` (raw file without frontmatter), `schema` (missing schema or taxonomy),
`log-missing` (no `log.md`), and `confidence` for an unrecognized value.

Act on the report: fix errors, review contested and low-confidence pages, split oversized pages,
rotate the log. Then append `## [YYYY-MM-DD] lint | N issues found` to `log.md` with the counts and
the files you changed. Report what remains unresolved rather than silently accepting it.

## Search recipes

| Need | Call |
|---|---|
| pages by content | `grep "<pattern>" path=wiki/*/*.md` |
| pages by name | `glob "wiki/*/*.md"` |
| pages by tag | `grep "tags:.*alignment" path=wiki/*/*.md` |
| recent activity | `read wiki/log.md:-20` |
| one page | `read wiki/concepts/<slug>.md` |

## Bulk ingest

1. Read all sources first.
2. Identify every entity and concept across all of them.
3. Check existing pages for all of them in one search pass.
4. Create/update pages in one pass.
5. Update `index.md` once at the end.
6. Write a single log entry covering the batch.

## Archiving

When content is fully superseded or the domain scope changes:

1. Create `_archive/` if absent.
2. Move the page there preserving its path (`_archive/entities/old-page.md`).
3. Remove it from `index.md`.
4. Replace inbound wikilinks with plain text + "(archived)".
5. Log the archive action.

The lint script skips `_archive/`.

## Obsidian

The wiki directory is an Obsidian vault as-is: `[[wikilinks]]` are clickable, Graph View shows the
network, frontmatter powers Dataview, and `raw/assets/` holds attachments (`![[image.png]]`).

- **Open `wiki/` itself as the vault**, not the project root. A project-root vault also indexes
  `.omp/`, `memory/` and `runs/`, and `[[slug]]` then competes with notes outside the wiki.
- Settings → Files & Links: set the attachment folder to `raw/assets/` and keep **Wikilinks**
  enabled. Lint resolves `[[wikilinks]]` in page bodies and both wikilinks and Markdown links in
  `index.md`; Markdown-style body links would not count as cross-references.
- Optional: add `raw/` to "Excluded files" so source snapshots stay out of search and the graph.
- `.obsidian/` is already ignored by the project `.gitignore`, so vault settings stay local and
  uncommitted.
- Server-side sync (`obsidian-headless`, systemd) needs the home directory and a long-lived
  service, so it is a human action outside a pipeline run — do not attempt it from a worker.

## Pitfalls

- **Never modify `raw/`** — corrections go in wiki pages.
- **Orient first** — SCHEMA + index + log tail before any operation.
- **Always update `index.md` and `log.md`** — they are the navigational backbone.
- **No page for a passing mention** — apply the Page Thresholds.
- **No page without cross-references** — isolated pages are invisible.
- **Frontmatter is required** — it enables search, filtering, and staleness detection.
- **Tags come from the taxonomy** — add the tag to `SCHEMA.md` first.
- **Keep pages scannable** — readable in 30 seconds; split above ~200 lines.
- **Ask before mass-updating** — an ingest that would touch 10+ existing pages should be confirmed
  with the human first. In a non-interactive run, record the scope in the round file instead.
- **Rotate the log** — `log-YYYY.md` above 500 entries; lint reports the size.
- **Handle contradictions explicitly** — keep both claims with dates, mark frontmatter, flag for
  review; never silently overwrite.

## Hermes → omp tool mapping

| Hermes tool | omp |
|---|---|
| `read_file` | `read` (ranges `:50-80`, tail `:-30`, URLs) |
| `write_file` | `write` |
| surgical edit | `edit` |
| `search_files` (content) | `grep` |
| `search_files` (names) | `glob` |
| `web_extract` | `read <url>`; `curl` when the bytes must be saved |
| `execute_code` | `eval` (Python/JS), or a saved script run with `bash` |

## Source

Adapted from the Hermes Agent `research/llm-wiki` skill (MIT, v2.1.0). Changes for this project:
project-relative wiki path and worker-confinement rules, a `memory/` boundary, omp tool names, and a
runnable lint/hash tool at `scripts/wiki.py` replacing the original pseudocode.
