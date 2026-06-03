#!/usr/bin/env bash
# no-undef lint gate. See eslint.config.mjs for the why.
#
# Derives the app-script list from index.html's local <script src> tags (in
# load order) so it can't drift from what the browser actually loads. sw.js is
# registered via JS (not a script tag), so it's excluded here and linted
# separately in its own service-worker scope.
set -euo pipefail
trap 'rm -f .eslint-bundle.js' EXIT

ESLINT=node_modules/.bin/eslint
[ -x "$ESLINT" ] || { echo "lint: eslint not installed — run 'npm ci'"; exit 1; }

# Local .js scripts from index.html, in order (drop CDN/https).
FILES=$(grep -oE '<script[^>]*src="[^"]+"' index.html \
  | grep -oE 'src="[^"]+"' | sed -E 's/src="([^"]+)"/\1/' | grep -vE '^https?:')
[ -n "$FILES" ] || { echo "lint: no local scripts found in index.html"; exit 1; }
echo "$FILES" | sed 's/^/  bundling: /'

# shellcheck disable=SC2086  # FILES are simple names, intentional word-split
cat $FILES > .eslint-bundle.js

"$ESLINT" .eslint-bundle.js   # app bundle — browser scope
"$ESLINT" sw.js               # service worker — SW scope
echo "lint: no undefined references ✓"
