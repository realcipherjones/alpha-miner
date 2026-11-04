#!/bin/bash
# Run on the game box with sudo, from the unpacked alpha-miner folder. Safe to run again to upgrade.
# Starts both services in dry-run mode: no seed is needed, and no KII can move.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run this with sudo."; exit 1; }
cd "$(dirname "$0")/../.."

apt-get install -y caddy

getent group alpha-shared >/dev/null || groupadd --system alpha-shared
id alpha-web >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --gid alpha-shared alpha-web
id alpha-payer >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --gid alpha-shared alpha-payer
id alpha-receipts >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --gid alpha-shared alpha-receipts

install -d -o root -g root -m 755 /opt/alpha-miner
for part in server tools dist node; do
	rm -rf "/opt/alpha-miner/$part"
	cp -r "$part" "/opt/alpha-miner/$part"
done
chown -R root:root /opt/alpha-miner
chmod -R go-w /opt/alpha-miner
chmod 755 /opt/alpha-miner/node/bin/node

install -d -o root -g root -m 755 /var/lib/alpha-miner
install -d -o alpha-web -g alpha-shared -m 2770 /var/lib/alpha-miner/shared
install -d -o alpha-payer -g alpha-shared -m 700 /var/lib/alpha-miner/payer
install -d -o alpha-receipts -g alpha-shared -m 700 /var/lib/alpha-miner/receipts

install -m 644 server/deploy/alpha-web.service server/deploy/alpha-payer.service server/deploy/alpha-receipts.service /etc/systemd/system/
install -m 644 server/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable alpha-web alpha-payer alpha-receipts caddy
systemctl restart alpha-web
sleep 2
systemctl restart alpha-payer alpha-receipts
systemctl reload-or-restart caddy

ufw allow 80/tcp
ufw allow 443/tcp

sleep 3
echo "--- services"
systemctl --no-pager --lines=0 status alpha-web alpha-payer alpha-receipts caddy | grep -E '^[^ ]|Active:' || true
echo "--- leaderboard from this box"
curl -sS http://127.0.0.1:8787/api/leaderboard
echo
echo "Done. Payer mode:"
python3 -c "import json;print(json.load(open('/var/lib/alpha-miner/shared/status.json')).get('mode'))"
