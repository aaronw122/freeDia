#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
spike="$root/e2e/spike/extension"
ln -sfn "$root/packages/extension/node_modules" "$spike/node_modules"
trap 'rm -f "$spike/node_modules"' EXIT
cd "$root"
bun --bun packages/extension/node_modules/.bin/wxt build e2e/spike/extension
echo "unpacked: $spike/.output/chrome-mv3"
