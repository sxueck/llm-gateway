#!/usr/bin/env bash
# End-to-end test for pre-commit-secret-scan.sh.
# Builds a throwaway git repo, stages fixtures, and asserts the scanner exits
# 1 on secrets and 0 on clean input. Run manually: bash scripts/test-secret-scan.sh
#
# Purpose: guarantee the scanner's regex patterns actually fire (e.g. a rule
# using PCRE-only syntax under POSIX `grep -E` would be a silent dead rule).
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
SCANNER="$ROOT/pre-commit-secret-scan.sh"

pass=0
fail=0
tmpdir=""

cleanup() {
  [ -n "$tmpdir" ] && rm -rf "$tmpdir"
}
trap cleanup EXIT

# assert_case <expected_exit> <description>
# Runs the scanner with CWD = $tmpdir; counts pass/fail in THIS shell so a
# failure actually surfaces a non-zero exit at the end.
assert_case() {
  local expected="$1" desc="$2"
  ( cd "$tmpdir" && bash "$SCANNER" ) >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$expected" ]; then
    echo "PASS: $desc (exit=$got)"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc — expected exit $expected, got $got"
    fail=$((fail + 1))
  fi
}

setup_repo() {
  tmpdir="$(mktemp -d)"
  git -C "$tmpdir" init -q
  git -C "$tmpdir" config user.email t@t.tt
  git -C "$tmpdir" config user.name test
}

# --- Test 1: OpenAI key pattern fires -----------------------------
setup_repo
printf 'const key = "sk-Abcdefghijklmnopqrstuvwxyz123456";\n' > "$tmpdir/config.js"
git -C "$tmpdir" add config.js
assert_case 1 "OpenAI sk- key detected"
rm -rf "$tmpdir"; tmpdir=""

# --- Test 2: case-insensitive generic assign fires ---------------
# Proves `grep -iE` covers what `(?i)` previously did; a regression to plain
# `grep -E` (or a dead PCRE inline modifier) would let this through.
setup_repo
printf 'const API_KEY = "Abcdefghijklmnopqrstuvwxyz1234567890";\n' > "$tmpdir/env.js"
git -C "$tmpdir" add env.js
assert_case 1 "case-insensitive API_KEY assignment detected"
rm -rf "$tmpdir"; tmpdir=""

# --- Test 3: clean input passes ----------------------------------
setup_repo
printf 'const greeting = "hello world, not a secret";\n' > "$tmpdir/app.js"
git -C "$tmpdir" add app.js
assert_case 0 "clean input passes"
rm -rf "$tmpdir"; tmpdir=""

echo "----------------------------------------"
echo "secret-scan pattern test: $pass passed, $fail failed"
[ "$fail" = 0 ]
