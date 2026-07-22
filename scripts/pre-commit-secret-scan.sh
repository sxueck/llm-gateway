#!/usr/bin/env bash
# Pre-commit secret scanner — blocks staged secrets before they enter history.
# Lightweight regex-based; complements (not replaces) CI-side Semgrep p/secrets.
set -euo pipefail

# Patterns: name|regex
# Each pattern uses POSIX ERE; matched against staged added/modified lines only.
PATTERNS=(
  'SonarQube token|squ_[A-Za-z0-9]{40}'
  'OpenAI API key|sk-[A-Za-z0-9]{20,}'
  'Anthropic API key|sk-ant-[A-Za-z0-9]{20,}'
  'GitHub PAT|gh[pousr]_[A-Za-z0-9]{36,}'
  'Generic API key assign|(api[_-]?key|secret|password|token)["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9_+/=-]{20,}'
)

# Files / paths to skip
SKIP_GLOBS=(
  '*.lock' '*.md' 'yarn.lock' 'package-lock.json' 'bun.lockb' 'pnpm-lock.yaml'
  '*.map' 'CHANGELOG*' 'LICENSE*'
  # The secret-scan self-test intentionally stages fake-key fixtures; skip the
  # test file itself so committing it doesn't trip the scanner.
  'scripts/test-secret-scan.sh'
)

if ! staged=$(git diff --cached --name-only --diff-filter=ACM -- 2>/dev/null); then
  exit 0
fi

if [ -z "$staged" ]; then
  exit 0
fi

found_secret=0
report=""

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # Skip by glob
  skip=false
  for glob in "${SKIP_GLOBS[@]}"; do
    case "$file" in
      $glob) skip=true; break ;;
    esac
  done
  $skip && continue

  # Only scan text files (skip binaries)
  if file --mime-encoding "$file" 2>/dev/null | grep -qi 'binary'; then
    continue
  fi

  # Get only added/modified lines from the staged diff
  diff_lines=$(git diff --cached -- "$file" | grep '^+' | grep -v '^+++' || true)
  [ -z "$diff_lines" ] && continue

  for entry in "${PATTERNS[@]}"; do
    name="${entry%%|*}"
    regex="${entry#*|}"
    matches=$(printf '%s\n' "$diff_lines" | grep -iE "$regex" || true)
    if [ -n "$matches" ]; then
      found_secret=1
      while IFS= read -r line; do
        report+="  $file: [$name] ${line:0:120}\n"
      done <<< "$matches"
    fi
  done
done <<< "$staged"

if [ "$found_secret" -ne 0 ]; then
  echo "========================================" >&2
  echo "SECRET SCAN: Potential secrets detected!" >&2
  echo "========================================" >&2
  printf '%b\n' "$report" >&2
  echo "If these are false positives, bypass with:" >&2
  echo "  git commit --no-verify" >&2
  echo "========================================" >&2
  exit 1
fi

exit 0
