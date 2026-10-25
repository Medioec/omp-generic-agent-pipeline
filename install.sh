#!/usr/bin/env bash
# Install and preflight this pipeline project on a new machine.
#
#   bash install.sh [--check] [--prefix <dir>]
#
#   --check        report only; write nothing
#   --prefix <dir> where the omp binary is installed (default: $HOME/.local/bin,
#                  or $OMP_PREFIX when set)
#
# Without --check it installs bin/omp to the prefix, then runs
# `node scripts/bootstrap.mjs` and verifies the result.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_ONLY=0
PREFIX="${OMP_PREFIX:-$HOME/.local/bin}"

usage() {
  cat <<'USAGE'
Usage: bash install.sh [--check] [--prefix <dir>]

  --check        report only; write nothing
  --prefix <dir> where the omp binary is installed (default: $HOME/.local/bin,
                 or $OMP_PREFIX when set)

Without --check it installs bin/omp to the prefix, then runs
`node scripts/bootstrap.mjs` and verifies the result.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --prefix)
      [ -n "${2:-}" ] || { echo "ERROR: --prefix needs a directory" >&2; exit 2; }
      PREFIX="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

fails=0
warns=0
ok()   { printf 'ok    %s\n' "$*"; }
warn() { printf 'warn  %s\n' "$*"; warns=$((warns + 1)); }
fail() { printf 'FAIL  %s\n' "$*" >&2; fails=$((fails + 1)); }

# --- preflight: tools and version floors ----------------------------------
if command -v node >/dev/null 2>&1; then
  if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
    ok "node $(node --version)"
  else
    fail "node $(node --version) is older than 18"
  fi
else
  fail "node not found (need >= 18)"
fi

if git_version="$(git --version 2>/dev/null)"; then
  version="${git_version##* }"
  version="${version%%[!0-9.]*}"
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  if [ "${major:-0}" -gt 2 ] || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -ge 5 ]; }; then
    ok "$git_version"
  else
    fail "$git_version is older than 2.5 (git worktree support)"
  fi
else
  fail "git not found (need >= 2.5)"
fi

if [ "${BASH_VERSINFO[0]:-0}" -ge 3 ]; then
  ok "bash ${BASH_VERSION}"
else
  fail "bash ${BASH_VERSION:-unknown} is older than 3.2"
fi

missing_tools=""
for tool in realpath grep cat mv tr printf basename mkdir cmp du chmod cut; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools="$missing_tools $tool"
done
if [ -z "$missing_tools" ]; then
  ok "coreutils (realpath, grep, cat, mv, tr, printf, basename, mkdir, cmp, du, chmod)"
else
  fail "missing coreutils command(s):$missing_tools"
fi

command -v python3 >/dev/null 2>&1 \
  && ok "python3 $(python3 --version 2>&1 | cut -d' ' -f2)" \
  || warn "python3 not found — optional, needed only for skill://llm-wiki"
command -v curl >/dev/null 2>&1 \
  && ok "curl" \
  || warn "curl not found — optional, needed only for wiki ingest"

os="$(uname -s 2>/dev/null || echo unknown)"
arch="$(uname -m 2>/dev/null || echo unknown)"
if [ "$os" = "Linux" ] && [ "$arch" = "x86_64" ]; then
  ok "platform $os/$arch"
else
  warn "bundled binary targets Linux/x86_64; this machine is $os/$arch — supply your own build at bin/omp"
fi

# --- omp binary ------------------------------------------------------------
SOURCE=""
BUNDLED="$ROOT/bin/omp"
if [ -f "$BUNDLED" ]; then
  if [ ! -x "$BUNDLED" ]; then
    if [ "$CHECK_ONLY" -eq 1 ]; then
      fail "bin/omp is not executable (run: chmod +x bin/omp)"
    else
      chmod +x "$BUNDLED"
      ok "made bin/omp executable"
    fi
  fi
  if bundled_version="$("$BUNDLED" --version 2>/dev/null | head -n 1)" && [ -n "$bundled_version" ]; then
    ok "bundled binary: $bundled_version ($(du -h "$BUNDLED" | cut -f1))"
    SOURCE="$BUNDLED"
  else
    fail "bin/omp does not run on this machine — replace it with a build for $os/$arch"
  fi
elif system_omp="$(command -v omp 2>/dev/null)"; then
  ok "no bin/omp; using omp already on PATH: $system_omp"
  SOURCE="$system_omp"
else
  fail "no omp binary: expected $BUNDLED, or omp on PATH"
fi

if [ -n "$SOURCE" ]; then
  target="$PREFIX/omp"
  if [ "$(cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")" = "$(readlink -f "$target" 2>/dev/null || printf '%s' "$target")" ]; then
    ok "omp already installed at $target"
  elif [ -f "$target" ] && cmp -s "$SOURCE" "$target"; then
    ok "omp already installed at $target (identical)"
  elif [ "$CHECK_ONLY" -eq 1 ]; then
    if [ -f "$target" ]; then
      warn "would replace $target"
    else
      warn "would install $SOURCE -> $target"
    fi
  elif ! mkdir -p "$PREFIX" 2>/dev/null || [ ! -w "$PREFIX" ]; then
    fail "cannot write $PREFIX (use --prefix <dir> or run with sufficient permissions)"
  else
    cp -f "$SOURCE" "$target"
    chmod 755 "$target"
    ok "installed omp -> $target"
  fi
  case ":$PATH:" in
    *":$PREFIX:"*) ok "$PREFIX is on PATH" ;;
    *) warn "$PREFIX is not on PATH — add: export PATH=\"$PREFIX:\$PATH\"" ;;
  esac
fi

# --- project setup ---------------------------------------------------------
if [ "$fails" -gt 0 ]; then
  echo
  echo "install: $fails problem(s), $warns warning(s) — fix the FAIL lines and re-run" >&2
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  echo "install check: ready ($warns warning(s))"
  echo "next: bash install.sh   # installs omp and runs scripts/bootstrap.mjs"
  exit 0
fi

echo
node "$ROOT/scripts/bootstrap.mjs"
node "$ROOT/scripts/bootstrap.mjs" --check

cat <<'NEXT'

install: ready

Start omp from this directory so it loads .omp/:

  ./bin/omp            (or: omp, if the install prefix is on PATH)
  /pipeline <task>

See README.md for offline use, the shared-memory merge and troubleshooting.
NEXT
