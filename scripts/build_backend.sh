#!/usr/bin/env bash
# Only the Python sidecar. Same as: npm run backend
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/build.mjs --backend
