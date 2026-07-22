#!/usr/bin/env bash
# Installs git hooks for local development.
# Run automatically via `npm install` (prepare script) or manually: npm run prepare
set -euo pipefail

# Skip when not inside a git repo (e.g. Docker builds, `npm install` from a
# tarball) so the `prepare` lifecycle script never breaks dependency install.
git rev-parse --git-dir >/dev/null 2>&1 || { echo 'install-hooks: not a git repo, skipping'; exit 0; }

HOOK_DIR="$(git rev-parse --git-dir)/hooks"
mkdir -p "$HOOK_DIR"

HOOK_NAME="pre-commit"
SOURCE="$(cd "$(dirname "$0")" && pwd)/pre-commit-secret-scan.sh"
TARGET="$HOOK_DIR/$HOOK_NAME"

cat > "$TARGET" <<EOF
#!/usr/bin/env bash
# Auto-installed by scripts/install-hooks.sh — do not edit directly.
exec "$(cd "$(dirname "$0")" && pwd)/../scripts/pre-commit-secret-scan.sh" "\$@"
EOF

chmod +x "$TARGET"
chmod +x "$SOURCE"

echo "✓ Installed pre-commit hook: $TARGET -> pre-commit-secret-scan.sh"
