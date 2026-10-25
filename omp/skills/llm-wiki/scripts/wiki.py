#!/usr/bin/env python3
"""Lint and stamp a markdown wiki maintained by the llm-wiki skill.

Usage:
  python3 wiki.py lint <wiki-dir>
  python3 wiki.py hash <raw-file> [--write]

`lint` is read-only. It prints a severity-grouped report and exits 1 when at
least one error-severity finding exists. Warnings never fail the run.

`hash` prints the SHA-256 of the file body (everything after the closing
frontmatter fence). `--write` stamps it into the `sha256:` field.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from datetime import date, timedelta
from pathlib import Path

PAGE_DIRS = ("entities", "concepts", "comparisons", "queries")
REQUIRED_FIELDS = ("title", "created", "updated", "type", "tags", "sources")
PAGE_TYPES = {"entity", "concept", "comparison", "query", "summary"}
CONFIDENCE_VALUES = {"high", "medium", "low"}
STALE_DAYS = 90
MAX_PAGE_LINES = 200
MAX_LOG_ENTRIES = 500

WIKILINK = re.compile(r"\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]")
MDLINK = re.compile(r"\]\(([^)\s]+)\)")
LOG_ENTRY = re.compile(r"^## \[", re.M)
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

errors: list[str] = []
warnings: list[str] = []


def error(kind: str, message: str) -> None:
    errors.append(f"[{kind}] {message}")


def warn(kind: str, message: str) -> None:
    warnings.append(f"[{kind}] {message}")


def split_frontmatter(data: bytes) -> tuple[str | None, bytes]:
    """Return (frontmatter text, body bytes); frontmatter is None when absent."""
    if not data.startswith(b"---"):
        return None, data
    idx = data.find(b"\n---", 3)
    if idx == -1:
        return None, data
    after = idx + 4
    if data.startswith(b"\r\n", after):
        after += 2
    elif data.startswith(b"\n", after):
        after += 1
    elif after != len(data):
        return None, data
    frontmatter = data[3:idx].decode("utf-8", "replace").strip("\r\n")
    return frontmatter, data[after:]


def parse_fields(frontmatter: str) -> dict[str, object]:
    fields: dict[str, object] = {}
    for line in frontmatter.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            fields[key] = [part.strip().strip("'\"") for part in inner.split(",") if part.strip()] if inner else []
        else:
            fields[key] = value.strip("'\"")
    return fields


def valid_date(value: object) -> bool:
    if not isinstance(value, str) or not DATE.match(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def taxonomy(schema: Path) -> set[str] | None:
    if not schema.is_file():
        return None
    text = schema.read_text(encoding="utf-8", errors="replace")
    heading = re.search(r"^## Tag Taxonomy\s*$", text, re.M)
    if not heading:
        return None
    section = text[heading.end():]
    following = re.search(r"^## ", section, re.M)
    if following:
        section = section[: following.start()]
    tags: set[str] = set()
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped.startswith(("-", "*")):
            continue
        item = stripped[1:].strip()
        if ":" in item:
            item = item.split(":", 1)[1]
        for candidate in item.split(","):
            candidate = candidate.strip().strip("`*[]")
            if re.fullmatch(r"[a-z0-9][a-z0-9-]*", candidate):
                tags.add(candidate)
    return tags or None


def normalize_target(target: str) -> str | None:
    target = target.strip()
    if not target or "://" in target or target.startswith("#"):
        return None
    target = target.split("#", 1)[0].split("|", 1)[0].strip()
    target = target.replace("%20", " ")
    target = target.rstrip("/").split("/")[-1]
    if target.lower().endswith(".md"):
        target = target[:-3]
    return target or None


def collect(wiki: Path) -> list[Path]:
    pages: list[Path] = []
    for directory in PAGE_DIRS:
        base = wiki / directory
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.md")):
            relative = path.relative_to(wiki)
            if any(part.startswith("_") or part.startswith(".") for part in relative.parts):
                continue
            pages.append(path)
    return pages


def collect_raw(wiki: Path) -> list[Path]:
    base = wiki / "raw"
    if not base.is_dir():
        return []
    raw: list[Path] = []
    for path in sorted(base.rglob("*.md")):
        relative = path.relative_to(wiki)
        if any(part.startswith("_") or part.startswith(".") for part in relative.parts):
            continue
        raw.append(path)
    return raw


def lint(wiki: Path) -> int:
    if not wiki.is_dir():
        print(f"wiki-lint: not a directory: {wiki}", file=sys.stderr)
        return 2

    schema = wiki / "SCHEMA.md"
    index = wiki / "index.md"
    log = wiki / "log.md"
    known_tags = taxonomy(schema)
    if known_tags is None:
        warn("schema", "SCHEMA.md is missing or has no '## Tag Taxonomy' section")
    if not index.is_file():
        error("index-missing", "index.md does not exist")

    pages = collect(wiki)
    stems: dict[str, list[Path]] = {}
    for page in pages:
        stems.setdefault(page.stem, []).append(page)

    for stem, holders in stems.items():
        if len(holders) > 1:
            names = ", ".join(str(path.relative_to(wiki)) for path in holders)
            error("duplicate-stem", f'"{stem}" appears in {names}; wikilinks cannot resolve')

    index_targets: set[str] = set()
    if index.is_file():
        text = index.read_text(encoding="utf-8", errors="replace")
        for match in WIKILINK.finditer(text):
            target = normalize_target(match.group(1))
            if target:
                index_targets.add(target)
        for match in MDLINK.finditer(text):
            target = normalize_target(match.group(1))
            if target:
                index_targets.add(target)

    inbound: dict[str, set[str]] = {page.stem: set() for page in pages}
    today = date.today()

    for page in pages:
        relative = page.relative_to(wiki)
        data = page.read_bytes()
        frontmatter, body = split_frontmatter(data)
        fields = parse_fields(frontmatter) if frontmatter is not None else {}

        if frontmatter is None:
            error("frontmatter", f"{relative}: no YAML frontmatter")
        else:
            for field in REQUIRED_FIELDS:
                if field not in fields:
                    error("frontmatter", f"{relative}: missing required field '{field}'")

        page_type = fields.get("type")
        if page_type and page_type not in PAGE_TYPES:
            error("invalid-type", f"{relative}: type '{page_type}' not in {sorted(PAGE_TYPES)}")

        created, updated = fields.get("created"), fields.get("updated")
        for label, value in (("created", created), ("updated", updated)):
            if label in fields and not valid_date(value):
                error("invalid-date", f"{relative}: {label} '{value}' is not YYYY-MM-DD")
        if valid_date(created) and valid_date(updated) and str(created) > str(updated):
            error("invalid-date", f"{relative}: updated {updated} precedes created {created}")

        tags = fields.get("tags")
        if "tags" in fields:
            if not isinstance(tags, list):
                error("frontmatter", f"{relative}: tags must be an inline list")
            elif known_tags is not None:
                for tag in tags:
                    if tag not in known_tags:
                        error("invalid-tag", f"{relative}: tag '{tag}' is not in SCHEMA.md")
            if not tags:
                warn("tags", f"{relative}: no tags")

        sources = fields.get("sources")
        if "sources" in fields and isinstance(sources, list) and not sources:
            warn("no-sources", f"{relative}: sources list is empty")

        if fields.get("contested") in (True, "true") or fields.get("contradictions"):
            warn("contested", f"{relative}: marked contested; needs human review")

        confidence = fields.get("confidence")
        if confidence and confidence not in CONFIDENCE_VALUES:
            warn("confidence", f"{relative}: confidence '{confidence}' is not high|medium|low")
        if confidence == "low":
            warn("confidence", f"{relative}: confidence low")
        if isinstance(sources, list) and confidence is None and len(sources) <= 1:
            warn("confidence", f"{relative}: single-source page has no confidence field")
        if confidence == "high" and isinstance(sources, list) and len(sources) < 2:
            warn("confidence", f"{relative}: confidence high on {len(sources)} source(s)")

        if valid_date(updated):
            age = (today - date.fromisoformat(str(updated))).days
            if age > STALE_DAYS:
                warn("stale", f"{relative}: updated {updated} ({age} days old)")

        body_lines = body.decode("utf-8", "replace").count("\n") + 1
        if body_lines > MAX_PAGE_LINES:
            warn("page-size", f"{relative}: {body_lines} lines (limit {MAX_PAGE_LINES})")

        text = body.decode("utf-8", "replace")
        for match in WIKILINK.finditer(text):
            target = normalize_target(match.group(1))
            if target is None:
                continue
            if target not in stems:
                error("broken-link", f'{relative}: [[{match.group(1).strip()}]] has no page stem "{target}"')
                continue
            for holder in stems[target]:
                if holder != page:
                    inbound[target].add(str(page.relative_to(wiki)))

        if index.is_file() and page.stem not in index_targets:
            error("index-missing", f"{relative}: not linked from index.md")

    for page in pages:
        if not inbound.get(page.stem):
            warn("orphan", f"{page.relative_to(wiki)}: no inbound wikilinks")

    raw_files = collect_raw(wiki)
    for raw in raw_files:
        relative = raw.relative_to(wiki)
        data = raw.read_bytes()
        frontmatter, body = split_frontmatter(data)
        if frontmatter is None:
            warn("raw-frontmatter", f"{relative}: raw source has no frontmatter")
            continue
        fields = parse_fields(frontmatter)
        stored = fields.get("sha256")
        if not stored or not isinstance(stored, str):
            warn("raw-unhashed", f"{relative}: no sha256; stamp with 'wiki.py hash --write'")
            continue
        digest = hashlib.sha256(body).hexdigest()
        if stored.strip().lower() != digest:
            error("raw-drift", f"{relative}: sha256 {stored.strip()[:12]}… != body {digest[:12]}…")

    if log.is_file():
        entries = len(LOG_ENTRY.findall(log.read_text(encoding="utf-8", errors="replace")))
        if entries > MAX_LOG_ENTRIES:
            warn("log-rotation", f"log.md: {entries} entries (rotate above {MAX_LOG_ENTRIES})")
    else:
        warn("log-missing", "log.md does not exist")

    print(f"wiki: {wiki.resolve()}")
    print(f"pages: {len(pages)}   raw: {len(raw_files)}")
    print()
    for title, findings in (("errors", errors), ("warnings", warnings)):
        print(f"{title} ({len(findings)})")
        for finding in findings:
            print(f"  {finding}")
        print()
    print(f"summary: {len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


def stamp_hash(raw: Path, write: bool) -> int:
    if not raw.is_file():
        print(f"wiki-hash: not a file: {raw}", file=sys.stderr)
        return 2
    data = raw.read_bytes()
    frontmatter, body = split_frontmatter(data)
    if frontmatter is None:
        print(f"wiki-hash: {raw} has no frontmatter", file=sys.stderr)
        return 2
    digest = hashlib.sha256(body).hexdigest()
    if not write:
        print(digest)
        return 0

    lines = frontmatter.splitlines()
    for index, line in enumerate(lines):
        if re.match(r"^\s*sha256\s*:", line):
            indent = line[: len(line) - len(line.lstrip())]
            lines[index] = f"{indent}sha256: {digest}"
            break
    else:
        lines.append(f"sha256: {digest}")

    rewritten = b"---\n" + "\n".join(lines).encode("utf-8") + b"\n---\n" + body
    raw.write_bytes(rewritten)
    _, rewritten_body = split_frontmatter(raw.read_bytes())
    if hashlib.sha256(rewritten_body).hexdigest() != digest:
        print(f"wiki-hash: rewrite changed the body of {raw}", file=sys.stderr)
        return 2
    print(f"{raw}: sha256 {digest}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lint and stamp an llm-wiki directory.")
    sub = parser.add_subparsers(dest="command", required=True)

    lint_parser = sub.add_parser("lint", help="audit links, index, frontmatter, tags, drift")
    lint_parser.add_argument("wiki", type=Path)

    hash_parser = sub.add_parser("hash", help="print or stamp a raw file's body SHA-256")
    hash_parser.add_argument("file", type=Path)
    hash_parser.add_argument("--write", action="store_true", help="stamp the sha256 field")

    args = parser.parse_args(argv)
    if args.command == "lint":
        return lint(args.wiki)
    return stamp_hash(args.file, args.write)


if __name__ == "__main__":
    raise SystemExit(main())
