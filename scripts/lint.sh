#!/usr/bin/env bash
# Concatenate the app scripts into one scope (browser load order) and run the
# no-undef gate on the bundle. See eslint.config.mjs for why.
set -euo pipefail
trap 'rm -f .eslint-bundle.js' EXIT
cat app.js routing.js storage.js tiles.js welcome-init.js sw.js > .eslint-bundle.js
npx --yes eslint@9 .eslint-bundle.js
echo "lint: no undefined references ✓"
