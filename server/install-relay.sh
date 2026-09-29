#!/bin/sh
# Installs the Syncher relay (needed ONLY for phones) as a systemd service.
#
# Obsidian on Android/iOS gives plugins no TCP sockets, so the phone cannot talk SSH
# to sshd directly. The relay accepts a WebSocket on port 8022 and pipes the raw bytes
# to the local sshd. It never sees plaintext: SSH is end-to-end encrypted and the plugin
# still checks the server key. Desktops connect to sshd directly and do not need it.
#
# Usage (on the SSH server, from the repository checkout):
#   sudo sh server/install-relay.sh                 # listen 0.0.0.0:8022 -> 127.0.0.1:22
#   sudo sh server/install-relay.sh --port 8022 --target 127.0.0.1:22
#   sudo sh server/install-relay.sh --uninstall
# Requirements: python3 (standard library only), systemd.
set -eu

PORT=8022
TARGET=127.0.0.1:22
UNINSTALL=0
while [ $# -gt 0 ]; do
	case "$1" in
	--port) PORT="$2"; shift 2 ;;
	--target) TARGET="$2"; shift 2 ;;
	--uninstall) UNINSTALL=1; shift ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

if [ "$(id -u)" -ne 0 ]; then
	echo "run as root: sudo sh $0 $*" >&2
	exit 1
fi

UNIT=/etc/systemd/system/syncher-relay.service
BIN=/usr/local/bin/syncher-relay

# The plugin used to be called Obsyncher: remove a relay installed under that name, if any.
if [ -f /etc/systemd/system/obsyncher-relay.service ] || [ -f /usr/local/bin/obsyncher-relay ]; then
	systemctl disable --now obsyncher-relay 2>/dev/null || true
	rm -f /etc/systemd/system/obsyncher-relay.service /usr/local/bin/obsyncher-relay
	systemctl daemon-reload
	echo "Removed the relay installed under the plugin's former name (obsyncher-relay)."
fi

if [ "$UNINSTALL" = 1 ]; then
	systemctl disable --now syncher-relay 2>/dev/null || true
	rm -f "$UNIT" "$BIN"
	systemctl daemon-reload
	echo "Syncher relay removed."
	exit 0
fi

PY=$(command -v python3 || true)
if [ -z "$PY" ]; then
	echo "python3 is required (e.g. apt install python3 / dnf install python3)" >&2
	exit 1
fi

HERE=$(cd "$(dirname "$0")" && pwd)
install -m 755 "$HERE/syncher-relay.py" "$BIN"
sed -e "s#--listen 0.0.0.0:8022 --target 127.0.0.1:22#--listen 0.0.0.0:$PORT --target $TARGET#" \
	"$HERE/syncher-relay.service" > "$UNIT"
systemctl daemon-reload
systemctl enable syncher-relay >/dev/null
systemctl restart syncher-relay
sleep 1
if systemctl is-active --quiet syncher-relay; then
	echo "Syncher relay is running: ws://<this server>:$PORT -> $TARGET"
else
	echo "relay failed to start, see: journalctl -u syncher-relay" >&2
	exit 1
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
	echo "ufw is active: allow the port with  sudo ufw allow $PORT/tcp"
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
	echo "firewalld is active: sudo firewall-cmd --permanent --add-port=$PORT/tcp && sudo firewall-cmd --reload"
fi
echo "In the plugin on the phone the relay address can stay empty if it is ws://<server address>:$PORT."
