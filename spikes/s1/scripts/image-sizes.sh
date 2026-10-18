#!/usr/bin/env bash
# Records the compressed (registry) and unpacked sizes of the S1 images, as JSON lines.
#
#   spikes/s1/scripts/image-sizes.sh > spikes/s1/results/image-sizes.jsonl
set -euo pipefail

compressed() {
  # Sum of the linux/amd64 manifest's layer sizes, in bytes.
  local digest
  digest=$(docker buildx imagetools inspect "$1" --raw |
    python3 -c 'import sys,json;d=json.load(sys.stdin);print(next(m["digest"] for m in d["manifests"] if m.get("platform",{}).get("architecture")=="amd64"))')
  docker buildx imagetools inspect "${1%@*}@$digest" --raw |
    python3 -c 'import sys,json;d=json.load(sys.stdin);print(sum(l["size"] for l in d["layers"]), len(d["layers"]), max(l["size"] for l in d["layers"]))'
}

unpacked() {
  # Sum of the layer sizes Docker reports in the image history (uncompressed).
  docker history --no-trunc --format '{{.Size}}' "$1" | python3 -c '
import sys
units = {"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9}
total = 0
for line in sys.stdin:
    s = line.strip()
    for u in sorted(units, key=len, reverse=True):
        if s.endswith(u):
            total += float(s[: -len(u)]) * units[u]
            break
print(int(total))'
}

for ref in \
  "ghcr.io/omnigent-ai/omnigent-host:v0.17.0@sha256:51880f0edb7e0357f395f88f4bc3c4e1dfc3df06e46cffb55ae6700c1dfd82b2" \
  "ghcr.io/omnigent-ai/omnigent-server:v0.17.0@sha256:101474ecb299d45aacf49cb01051cc2cc5392ee6a6d30879d72c55bf346af3c3"; do
  read -r bytes layers largest <<<"$(compressed "$ref")"
  echo "{\"image\":\"${ref%@*}\",\"compressedBytes\":$bytes,\"layers\":$layers,\"largestLayerBytes\":$largest,\"unpackedBytes\":$(unpacked "$ref")}"
done

# The slim S1 computer image is built locally (spikes/s1/computer); its compressed size is the
# sum of its layers as pushed, which `docker save` approximates with gzip.
local_ref=cfo-s1/computer:local
gz=$(docker save "$local_ref" | gzip -1 | wc -c)
echo "{\"image\":\"$local_ref\",\"gzipBytes\":$gz,\"unpackedBytes\":$(unpacked "$local_ref")}"
