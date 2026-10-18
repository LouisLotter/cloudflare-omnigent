# S4: Litestream and the durability barrier

Throwaway spike code. Results and conclusions are in [`docs/verification/spike-s4.md`](../../docs/verification/spike-s4.md).

## What is here

| Path | Purpose |
|---|---|
| `compose.yaml` | MinIO (S3 stand-in for R2), Toxiproxy (to slow or block the "R2" link) and the server. The server has no volume, so replacing its container restores from the replica. |
| `compose.tmpfs.yaml` | Optional overlay that puts the database on tmpfs, to separate disk fsync cost from Litestream's own latency. |
| `server/Dockerfile` | Omnigent built from the fork at `90a9bed9a`, plus Litestream 0.5.17 (checksum-verified) as PID 1. |
| `server/s4_entrypoint.py` | Runs Omnigent's unmodified Docker entrypoint, wrapping its `build_app` to add the barrier. No Omnigent file is edited. |
| `server/s4_barrier.py` | The barrier: SQLAlchemy engine events classify commits that changed security tables; an ASGI middleware holds the response until Litestream's `replicated_txid` covers the commit, or answers 424 `durability_unconfirmed`. Also the `commit_hook` variant the design first described, kept for comparison. |
| `server/tools/` | In-container helpers: seed a database, check one, time a restore, probe Litestream's control socket, and the issue #1540 harness. |
| `scripts/s4.py` | The driver. Each command writes raw results to `results/`. |

## Running it

Needs Docker and uv. Build the Omnigent base image once from the fork (read-only), into a scratch directory:

```bash
mkdir -p /tmp/s4-build/omnigent-90a9bed9a
git -C /home/decay/Lervent/omnigent archive --format=tar 90a9bed9a | tar -x -C /tmp/s4-build/omnigent-90a9bed9a
docker build -f /tmp/s4-build/omnigent-90a9bed9a/deploy/docker/Dockerfile --target runtime \
  -t cfo-s4/omnigent-server:90a9bed9a /tmp/s4-build/omnigent-90a9bed9a
```

Then, from the repository root:

```bash
S4="uv run --no-project --with httpx==0.28.1 --with boto3==1.40.0 spikes/s4/scripts/s4.py"
$S4 build          # the spike image; records digests in results/images.json
$S4 all            # the whole recorded matrix, about 100 minutes
$S4 down           # remove the containers and MinIO's data
```

Single scenarios: `$S4 routes --mode response`, `$S4 blocked --block blackhole --after kill`, `$S4 sigterm`, `$S4 restore --sizes 100`, `$S4 issue1540`, `$S4 latency --tmpfs`, `$S4 startup`. See `$S4 --help`.

Credentials (MinIO keys, the owner password, the cookie secret) are generated on first use into `.run/s4.env`, which is git-ignored. Results are checked for those values before they are written.
