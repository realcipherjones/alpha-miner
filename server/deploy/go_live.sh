#!/bin/bash
# Run on the game box with sudo, from the unpacked alpha-miner folder, once. Switches payouts to real KII.
# Wipes all test players and records, installs the wallet seed you type, and starts the payer in live mode.
# Nothing is wiped until the seed has been checked against the alpha wallet.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run this with sudo."; exit 1; }

DATA=${ALPHA_DATA:-/var/lib/alpha-miner}
DROP_IN=${ALPHA_DROP_IN:-/etc/systemd/system/alpha-payer.service.d}
SERVER=${ALPHA_SERVER:-/opt/alpha-miner/server}
ACCOUNT=${ALPHA_ACCOUNT:-kii_35ftdboa5fww3z7h6zur441abyep6dtduzaunds3srbc3c4pcj5e19a1p1u3}
SEED_FILE=$DATA/payer/seed

if [ -e "$DROP_IN/live.conf" ]; then
	echo "Payouts are already live. Refusing to run again: this would erase the real payment records."
	exit 1
fi

echo "This erases every test player and record, then starts paying REAL KII automatically."
echo "Confirmed sends can't be reversed."
read -r -p "Type GO LIVE to continue: " answer
[ "$answer" = "GO LIVE" ] || { echo "Stopped. Nothing changed."; exit 1; }

read -r -s -p "Alpha wallet seed (hidden, 64 hex characters): " seed
echo
( umask 077; printf '%s\n' "$seed" > "$SEED_FILE" )
unset seed
chown alpha-payer:alpha-shared "$SEED_FILE"
chmod 600 "$SEED_FILE"

if ! sudo -u alpha-payer python3 -B -c "
import sys
sys.path.insert(0, '$SERVER')
import payer
payer.load_seed('$SEED_FILE', '$ACCOUNT', 0)
"; then
	rm -f "$SEED_FILE"
	echo "That seed doesn't give the alpha wallet. Seed removed. Nothing else changed."
	exit 1
fi
echo "Seed matches the alpha wallet."

systemctl stop alpha-payer alpha-receipts alpha-web
rm -f "$DATA"/shared/app.db* "$DATA"/shared/status.json "$DATA"/shared/receipts.json "$DATA"/shared/.status-* "$DATA"/shared/.receipts-*
rm -f "$DATA"/payer/payer.db* "$DATA"/receipts/receipts.db*

mkdir -p "$DROP_IN"
printf '[Service]\nEnvironment=PAYER_MODE=live\n' > "$DROP_IN/live.conf"
systemctl daemon-reload
systemctl start alpha-web
sleep 2
systemctl start alpha-receipts alpha-payer
sleep 8

echo "--- services"
systemctl is-active alpha-web alpha-receipts alpha-payer || true
echo "--- payer"
python3 -c "
import json
status = json.load(open('$DATA/shared/status.json'))
print('mode:', status.get('mode'))
print('paused:', status.get('paused'))
" || echo "No payer status yet. Tell Claude Code, and don't share the link until it's checked."
echo "Done. Tell Claude Code it's live."
