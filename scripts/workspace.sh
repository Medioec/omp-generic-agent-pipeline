#!/usr/bin/env bash
# Git-native workspace helper for dependency-scheduled runs.
#
#   bash scripts/workspace.sh init        <run-dir> [project-root]
#   bash scripts/workspace.sh new-unit    <run-dir> <unit>
#   bash scripts/workspace.sh diff-unit   <run-dir> <unit>
#   bash scripts/workspace.sh resolve-unit <run-dir> <unit>
#   bash scripts/workspace.sh merge-units <run-dir> <unit> [unit...]
#   bash scripts/workspace.sh integration <run-dir>
#   bash scripts/workspace.sh check-live  <run-dir> [--ignore <path>]...
#   bash scripts/workspace.sh sync-main   <run-dir>
#   bash scripts/workspace.sh commit      <run-dir> [project-root]
#   bash scripts/workspace.sh cleanup     <run-dir> [project-root]
#   bash scripts/workspace.sh status      <run-dir>
#
# The project repo is the deliverable history. Unit workspaces are git
# worktrees under runs/<run>/workspace. Runs themselves are untracked.

set -euo pipefail

say() { printf '%s\n' "$*" >&2; }
die() { say "ERROR: $*"; exit 1; }

run_dir=""; project=""; workspace=""; slug=""; base=""; main_branch=""

load_run() {
  run_dir="$(realpath "${1:?missing run directory}")"
  project="$(realpath "${WS_PROJECT:-$PWD}")"
  workspace="$run_dir/workspace"
  slug="$(basename "$run_dir")"
  slug="${slug//[^A-Za-z0-9._-]/-}"
  main_branch="$(cat "$workspace/main.branch" 2>/dev/null || echo main)"
  base="$(cat "$workspace/base.sha" 2>/dev/null || true)"
}

ensure_git() {
  local toplevel
  git -C "$project" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $project (run: node scripts/bootstrap.mjs)"
  toplevel="$(git -C "$project" rev-parse --show-toplevel 2>/dev/null || true)"
  [ "$(realpath "$toplevel" 2>/dev/null)" = "$project" ] || \
    die "the project must be its own git repository; $project resolves to ${toplevel:-no repository} (run: node scripts/bootstrap.mjs)"
}

ensure_init() {
  [ -f "$workspace/base.sha" ] || die "workspace not initialised: run 'init' first"
  base="$(cat "$workspace/base.sha")"
}

cmd_init() {
  load_run "$1"
  ensure_git
  mkdir -p "$workspace/units" "$workspace/patches"
  if [ -f "$workspace/base.sha" ]; then say "already initialised: $workspace"; return 0; fi
  [ -z "$(git -C "$project" status --porcelain)" ] || die "project tree is dirty; commit or stash first"
  git -C "$project" rev-parse HEAD > "$workspace/base.sha"
  git -C "$project" rev-parse --abbrev-ref HEAD > "$workspace/main.branch"
  : > "$workspace/accepted.txt"
  say "base $(cat "$workspace/base.sha") on $(cat "$workspace/main.branch")"
}

unit_branch() { printf 'run/%s/%s' "$slug" "$1"; }
integration_branch() { printf 'run/%s/integration' "$slug"; }

cmd_new_unit() {
  load_run "$1"
  local unit="${2:?missing unit id}"
  ensure_init
  local wt="$workspace/units/$unit" branch
  branch="$(unit_branch "$unit")"
  if [ -d "$wt" ]; then say "unit workspace already exists: $wt"; return 0; fi
  if git -C "$project" rev-parse --verify -q "$branch" >/dev/null; then
    git -C "$project" worktree add -q "$wt" "$branch"
  else
    git -C "$project" worktree add -q "$wt" -b "$branch" "$base"
  fi
  say "unit $unit worktree: $wt (branch $branch from $base)"
}

cmd_diff_unit() {
  load_run "$1"
  local unit="${2:?missing unit id}"
  ensure_init
  local wt="$workspace/units/$unit"
  [ -d "$wt" ] || die "no worktree for unit $unit"
  git -C "$wt" add -A
  if ! git -C "$wt" diff --cached --quiet; then
    git -C "$wt" commit -qm "unit $unit attempt"
  fi
  mkdir -p "$workspace/patches"
  git -C "$wt" diff --binary "$base...HEAD" > "$workspace/patches/$unit.patch"
  git -C "$wt" diff --stat "$base...HEAD"
}

cmd_merge_units() {
  load_run "$1"
  shift 1
  ensure_init
  [ "$#" -gt 0 ] || die "merge-units needs at least one unit"
  local ib; ib="$(integration_branch)"
  git -C "$project" rev-parse --verify -q "$ib" >/dev/null || \
    git -C "$project" branch "$ib" "$base"
  for unit in "$@"; do
    if grep -qx "$unit" "$workspace/accepted.txt"; then say "unit $unit already merged; skipping"; continue; fi
    local branch; branch="$(unit_branch "$unit")"
    git -C "$project" rev-parse --verify -q "$branch" >/dev/null || die "no branch for unit $unit"
    local wt="$workspace/integration"
    [ -d "$wt" ] || cmd_integration "$run_dir" >/dev/null
    git -C "$wt" checkout -q "$ib"
    if git -C "$wt" merge --no-ff --no-edit "$branch" >/dev/null 2>&1; then
      printf '%s\n' "$unit" >> "$workspace/accepted.txt"
      say "merged unit $unit"
    else
      git -C "$wt" merge --abort >/dev/null 2>&1 || true
      die "merge conflict on unit $unit; run 'resolve-unit' then retry"
    fi
  done
}

cmd_resolve_unit() {
  load_run "$1"
  local unit="${2:?missing unit id}"
  ensure_init
  local wt="$workspace/units/$unit" branch patch ib
  branch="$(unit_branch "$unit")"; patch="$workspace/patches/$unit.patch"; ib="$(integration_branch)"
  [ -f "$patch" ] || die "no patch for unit $unit"
  grep -vx "$unit" "$workspace/accepted.txt" > "$workspace/accepted.txt.tmp" 2>/dev/null || true
  mv "$workspace/accepted.txt.tmp" "$workspace/accepted.txt" 2>/dev/null || true
  [ -d "$wt" ] && git -C "$project" worktree remove --force "$wt" >/dev/null 2>&1 || true
  git -C "$project" branch -D "$branch" >/dev/null 2>&1 || true
  git -C "$project" worktree add -q "$wt" -b "$branch" "$ib"
  if git -C "$wt" apply --3way "$patch" >/dev/null 2>&1; then
    say "unit $unit re-based cleanly; run diff-unit then merge-units"
    return 0
  fi
  say "unit $unit re-based with conflicts; resolve in $wt, then diff-unit and merge-units"
  git -C "$wt" status --short >&2 || true
  return 4
}

cmd_integration() {
  load_run "$1"
  ensure_init
  local wt="$workspace/integration" ib; ib="$(integration_branch)"
  if [ -d "$wt" ]; then
    git -C "$wt" checkout -q "$ib" 2>/dev/null || git -C "$wt" checkout -q -B "$ib" "$base"
    say "integration workspace: $wt"
    return 0
  fi
  git -C "$project" rev-parse --verify -q "$ib" >/dev/null || git -C "$project" branch "$ib" "$base"
  git -C "$project" worktree add -q "$wt" "$ib"
  say "integration workspace: $wt"
}

cmd_check_live() {
  load_run "$1"
  shift || true
  local pathspec=(-- . ':(exclude)runs')
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --ignore)
        [ "$#" -ge 2 ] && [ -n "$2" ] || die "--ignore needs a project-relative path"
        pathspec+=(":(exclude)$2")
        shift 2
        ;;
      *)
        die "unknown check-live argument: $1"
        ;;
    esac
  done
  ensure_init
  if [ -n "$(git -C "$project" status --porcelain -- "${pathspec[@]}")" ]; then
    say "project tree is dirty:"; git -C "$project" status --short -- "${pathspec[@]}" >&2; return 3
  fi
  say "project tree clean at $(git -C "$project" rev-parse --short HEAD)"
}

cmd_sync_main() {
  load_run "$1"
  ensure_init
  local ib; ib="$(integration_branch)"
  git -C "$project" rev-parse --verify -q "$ib" >/dev/null || die "no integration branch"
  local wt="$workspace/integration"
  [ -d "$wt" ] || cmd_integration "$run_dir" >/dev/null
  git -C "$wt" checkout -q "$ib"
  if [ -n "$(git -C "$wt" status --porcelain)" ]; then
    die "integration workspace is dirty; commit or restore it before sync-main"
  fi
  if git -C "$wt" merge --no-ff --no-edit "$main_branch" >/dev/null 2>&1; then
    say "merged $main_branch into $ib; run commit"
    return 0
  fi
  say "merge conflict merging $main_branch into $ib; resolve it in $wt, then run commit"
  git -C "$wt" status --short >&2 || true
  return 4
}

cmd_commit() {
  load_run "$1"
  ensure_init
  local ib; ib="$(integration_branch)"
  git -C "$project" rev-parse --verify -q "$ib" >/dev/null || die "no integration branch"
  cmd_check_live "$run_dir" >/dev/null || die "project tree is dirty; commit or stash first"
  git -C "$project" checkout -q "$main_branch"
  if ! git -C "$project" merge --no-ff --no-edit "$ib" >/dev/null 2>&1; then
    git -C "$project" merge --abort >/dev/null 2>&1 || true
    die "deliverable merge conflict; run sync-main, resolve it in the integration workspace, then retry"
  fi
  git -C "$project" rev-parse HEAD > "$workspace/deliverable.sha"
  say "deliverable commit $(cat "$workspace/deliverable.sha") on $main_branch"
}

cmd_cleanup() {
  load_run "$1"
  ensure_init
  for d in "$workspace"/units/*; do
    [ -d "$d" ] && git -C "$project" worktree remove --force "$d" >/dev/null 2>&1 || true
  done
  [ -d "$workspace/integration" ] && git -C "$project" worktree remove --force "$workspace/integration" >/dev/null 2>&1 || true
  say "worktrees removed; branches retained for audit"
}

cmd_status() {
  load_run "$1"
  say "run: $run_dir"
  say "base: ${base:-unknown} on $main_branch"
  say "accepted: $(tr '\n' ' ' < "$workspace/accepted.txt" 2>/dev/null || true)"
  git -C "$project" worktree list
  git -C "$project" branch --list "run/$slug/*"
}

case "${1:-}" in
  init) cmd_init "${2:-}" ;;
  new-unit) cmd_new_unit "${2:-}" "${3:-}" ;;
  diff-unit) cmd_diff_unit "${2:-}" "${3:-}" ;;
  resolve-unit) cmd_resolve_unit "${2:-}" "${3:-}" ;;
  merge-units) cmd_merge_units "${2:-}" "${@:3}" ;;
  integration) cmd_integration "${2:-}" ;;
  check-live) cmd_check_live "${2:-}" "${@:3}" ;;
  sync-main) cmd_sync_main "${2:-}" ;;
  commit) cmd_commit "${2:-}" ;;
  cleanup) cmd_cleanup "${2:-}" ;;
  status) cmd_status "${2:-}" ;;
  *) die "usage: workspace.sh <init|new-unit|diff-unit|resolve-unit|merge-units|integration|check-live|sync-main|commit|cleanup|status> ..." ;;
esac
