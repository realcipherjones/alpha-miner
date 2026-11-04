#!/bin/bash
# Run on the dev box: bundles the service, the game build it verifies against, and Node.
# Usage: server/deploy/package.sh /path/to/node /path/to/output.tar.gz
set -euo pipefail
cd "$(dirname "$0")/../.."
node_bin=$(readlink -f "$1")
out=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/alpha-miner/server/static" "$work/alpha-miner/server/deploy" "$work/alpha-miner/tools" "$work/alpha-miner/dist" "$work/alpha-miner/node/bin"
cp server/app.py server/payer.py server/receipts.py server/store.py server/kii_chain.py server/README.md "$work/alpha-miner/server/"
cp server/static/index.html "$work/alpha-miner/server/static/"
cp server/deploy/alpha-web.service server/deploy/alpha-payer.service server/deploy/alpha-receipts.service server/deploy/Caddyfile server/deploy/install.sh server/deploy/go_live.sh "$work/alpha-miner/server/deploy/"
cp tools/replay_lib.mjs tools/replay_run.mjs "$work/alpha-miner/tools/"
cp dist/bundle.js "$work/alpha-miner/dist/"
cp "$node_bin" "$work/alpha-miner/node/bin/node"
tar -C "$work" -czf "$out" alpha-miner
sha256sum "$out"
