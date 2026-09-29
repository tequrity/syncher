#!/bin/sh
# Starts a throw-away, user-mode OpenSSH server for integration tests.
# Usage (from WSL or any Linux): sh test/sshd/start-wsl-sshd.sh <dir-with-client-pubkeys> [port]
# The server serves SFTP for the current user, accepts only the given public keys,
# and keeps its state under $HOME/.syncher-test.
set -eu
KEYS_DIR="$1"
PORT="${2:-2299}"
BASE="$HOME/.syncher-test"
mkdir -p "$BASE"
chmod 700 "$BASE"
for t in ed25519 ecdsa rsa; do
	[ -f "$BASE/host_$t" ] || ssh-keygen -q -t "$t" -N '' -f "$BASE/host_$t"
done
cat "$KEYS_DIR"/*.pub > "$BASE/authorized_keys"
chmod 600 "$BASE/authorized_keys"
SFTP_SERVER=$(for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server; do [ -x "$p" ] && echo "$p" && break; done)
cat > "$BASE/sshd_config" <<EOF
Port $PORT
ListenAddress 0.0.0.0
HostKey $BASE/host_ed25519
HostKey $BASE/host_ecdsa
HostKey $BASE/host_rsa
PidFile $BASE/sshd.pid
AuthorizedKeysFile $BASE/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
Subsystem sftp $SFTP_SERVER
LogLevel VERBOSE
EOF
if [ -f "$BASE/sshd.pid" ] && kill -0 "$(cat "$BASE/sshd.pid")" 2>/dev/null; then
	kill "$(cat "$BASE/sshd.pid")"
	sleep 0.5
fi
/usr/sbin/sshd -f "$BASE/sshd_config" -E "$BASE/sshd.log"
echo "sshd listening on $PORT as $(id -un), home $HOME"
