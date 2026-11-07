#!/usr/bin/env bash
# macOS .app without the DMG. Same as: npm run build:app -- --no-dmg
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/build.mjs --no-dmg
