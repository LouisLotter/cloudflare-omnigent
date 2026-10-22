#!/bin/bash
# Which login values the real CLIs copy into other files, by key (S6 follow-up, DC-45), with
# synthetic logins and no route out.
#
# Host-side orchestration, as claude_refresh_offline.sh: a throwaway CA, an internal Docker
# network, the fake Anthropic server (sign-in, profile, messages) answering for Anthropic's
# hostnames, and the S6 image running the unmodified Claude Code and Codex with this checkout's
# spikes/s6 mounted read-only. Nothing reaches Anthropic or OpenAI.
#
#   bash spikes/s6/realcli/login_values_offline.sh [image] [results-dir]
set -euo pipefail
IMAGE=${1:-cfo-s6-computer:dev}
S6=$(cd "$(dirname "$0")/.." && pwd)
OUT=${2:-$S6/results/followup}
SCRATCH=${S6FU_SCRATCH:-$HOME/.pt/s6fu-lv}
mkdir -p "$SCRATCH"
TMP=$(mktemp -d "$SCRATCH/run.XXXXXX")
NET=s6fu-isolated-$RANDOM
SRV=s6fu-fake-anthropic-$RANDOM
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
  --entrypoint python3 "$IMAGE" -I /opt/s6/realcli/fake_anthropic.py --cert /certs/cert.pem --key /certs/key.pem \
  --log /certs/requests.jsonl --answer-messages >/dev/null
sleep 2

docker run --rm --name "s6fu-client-$RANDOM" --network "$NET" -e NODE_EXTRA_CA_CERTS=/certs/ca.pem \
  -e OUT_UID="$(id -u)" -e OUT_GID="$(id -g)" \
  -v "$S6:/opt/s6:ro" -v "$TMP:/certs:ro" -v "$OUT:/out" --entrypoint /bin/bash "$IMAGE" /opt/s6/realcli/login_values_inner.sh
python3 -I - "$TMP/requests.jsonl" "$OUT/login-values-offline.json" <<'EOF'
import json, os, sys
reqs = [json.loads(l) for l in open(sys.argv[1])] if os.path.exists(sys.argv[1]) else []
d = json.load(open(sys.argv[2]))
d["fake_anthropic_requests"] = sorted({f"{r.get('method')} {r.get('host')} {r.get('path')}" for r in reqs})
open(sys.argv[2], "w").write(json.dumps(d, indent=1) + "\n")
print("requests seen by the fake Anthropic server:", len(reqs))
EOF
