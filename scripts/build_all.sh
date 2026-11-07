#!/usr/bin/env bash
# Kept for old habits. The real build is scripts/build.mjs (works on macOS and Windows).
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/build.mjs "$@"
