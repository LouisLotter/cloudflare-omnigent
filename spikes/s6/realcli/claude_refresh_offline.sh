#!/bin/bash
# Real Claude Code refresh against a fake token endpoint, in an isolated network (spike S6).
#
# Host-side orchestration: a throwaway CA and certificate, an internal Docker network (no route
# out), a fake server answering as platform.claude.com and api.anthropic.com, and the S6 image
# running the unmodified Claude Code with an expired synthetic login. Records how Claude Code
# writes ~/.claude/.credentials.json when it refreshes. Nothing reaches Anthropic.
#
#   bash spikes/s6/realcli/claude_refresh_offline.sh [image] [results-dir]
set -euo pipefail
IMAGE=${1:-cfo-s6-computer:dev}
S6=$(cd "$(dirname "$0")/.." && pwd)
OUT=${2:-$S6/results/realcli}
TMP=$(mktemp -d)
NET=s6-isolated-$RANDOM
SRV=s6-fake-anthropic-$RANDOM
trap 'docker rm -f "$SRV" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; rm -rf "$TMP"' EXIT

HOSTS="platform.claude.com api.anthropic.com claude.ai claude.com console.anthropic.com statsig.anthropic.com mcp-proxy.anthropic.com"
SAN=$(for h in $HOSTS; do printf 'DNS:%s,' "$h"; done | sed 's/,$//')
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=S6 throwaway test CA" \
  -keyout "$TMP/ca.key" -out "$TMP/ca.pem" -addext "basicConstraints=critical,CA:TRUE" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=platform.claude.com" -keyout "$TMP/key.pem" -out "$TMP/req.csr" 2>/dev/null
printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' "$SAN" > "$TMP/ext.cnf"
openssl x509 -req -in "$TMP/req.csr" -CA "$TMP/ca.pem" -CAkey "$TMP/ca.key" -CAcreateserial -days 1 \
  -extfile "$TMP/ext.cnf" -out "$TMP/cert.pem" 2>/dev/null
chmod 644 "$TMP"/*.pem "$TMP/key.pem"

docker network create --internal "$NET" >/dev/null
ALIASES=()
for h in $HOSTS; do ALIASES+=(--network-alias "$h"); done
docker run -d --rm --name "$SRV" --network "$NET" "${ALIASES[@]}" -v "$S6:/opt/s6:ro" -v "$TMP:/certs" \
  --entrypoint python3 "$IMAGE" -I /opt/s6/realcli/fake_anthropic.py --cert /certs/cert.pem --key /certs/key.pem --log /certs/requests.jsonl >/dev/null
sleep 2

docker run --rm --network "$NET" -e NODE_EXTRA_CA_CERTS=/certs/ca.pem -e OUT_UID="$(id -u)" -e OUT_GID="$(id -g)" \
  -v "$S6:/opt/s6:ro" -v "$TMP:/certs:ro" -v "$OUT:/out" --entrypoint /bin/bash "$IMAGE" /opt/s6/realcli/claude_refresh_inner.sh
docker logs "$SRV" >/dev/null 2>&1 || true
python3 -I - "$TMP/requests.jsonl" "$OUT/claude-refresh-offline.json" <<'EOF'
import json, sys
reqs = [json.loads(l) for l in open(sys.argv[1])] if __import__("os").path.exists(sys.argv[1]) else []
d = json.load(open(sys.argv[2]))
d["fake_server_requests"] = [{k: r.get(k) for k in ("method", "host", "path", "grant_type")} for r in reqs]
open(sys.argv[2], "w").write(json.dumps(d, indent=1) + "\n")
print("requests seen by the fake server:", len(reqs))
EOF
