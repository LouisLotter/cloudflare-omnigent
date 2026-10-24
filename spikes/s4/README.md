# S4: Litestream and the durability barrier

A historical Docker fault/reproduction harness. It compares response/commit-hook barrier variants, measures replica/restore behavior and reproduces Litestream failure cases. Its pinned app/entrypoint and results describe this experiment, not the current product server or a universal timing guarantee. Current behavior is described by [durability before acknowledgement/effect](../../docs/decisions/0003-durability-before-acknowledgement-effect.md) and the [maintained server image](../../images/README.md).

| Path | Purpose |
|---|---|
| [compose.yaml](compose.yaml) | MinIO as an S3 stand-in, Toxiproxy and the historical server; replacing the server restores from its replica |
| [compose.tmpfs.yaml](compose.tmpfs.yaml) | Optional tmpfs comparison |
| [server/Dockerfile](server/Dockerfile) | Historical fork-base image plus checksum-verified Litestream 0.5.17 |
| [server/s4_entrypoint.py](server/s4_entrypoint.py), [server/s4_barrier.py](server/s4_barrier.py) | Historical entrypoint and barrier variants, separate from the maintained image implementation |
| [server/tools/](server/tools/) | Database, restore, control-socket and issue-reproduction helpers |
| [scripts/s4.py](scripts/s4.py), [scripts/s4lib.py](scripts/s4lib.py) | Driver, generated test credentials, Docker operations and result writer |

## Historical reproduction setup

Use Docker/Compose and uv in a separate scratch checkout of this repository. The driver writes `results/`, including fixed names such as `images.json`, and can replace/fault its server. Do not use a checkout whose historical results or running campaign you need to retain. Reserve the Compose project/ports for one run.

The base requires fork commit `90a9bed9a5e25b1cab8d06a7e361c86cd5460918` available in a caller-selected fork checkout. Set `S4_FORK_DIR` to that checkout before running this recipe. Build setup downloads base/system/Python/web dependencies; it is not an offline check.

```bash
set -euo pipefail
: "${S4_FORK_DIR:?Set S4_FORK_DIR to your Omnigent fork checkout}"
S4_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cfo-s4-build.XXXXXX")"
mkdir -p "$S4_BUILD_DIR/omnigent"
git -C "$S4_FORK_DIR" archive --format=tar 90a9bed9a5e25b1cab8d06a7e361c86cd5460918 | tar -x -C "$S4_BUILD_DIR/omnigent"
docker build -f "$S4_BUILD_DIR/omnigent/deploy/docker/Dockerfile" --target runtime -t cfo-s4/omnigent-server:90a9bed9a "$S4_BUILD_DIR/omnigent"
```

From the scratch platform checkout root, define the historical driver:

```bash
s4() {
  uv run --no-project --with httpx==0.28.1 --with boto3==1.40.0 spikes/s4/scripts/s4.py "$@"
}
s4 --help
s4 build
```

The uv invocation can download its separate tools; root `python/` dependencies do not provide them. The `build` command builds the spike image and writes its local image identities to `results/images.json`. Those local IDs are not registry manifest digests.

Choose scenarios from the driver's help: `routes`, `window`, `blocked`, `latency`, `sigterm`, `restore`, `postrestore`, `startup` or `issue1540`. These deliberately start/replace/kill containers or fault the replica link; the `all` command runs the entire historical matrix and is not a quick contributor test. A MinIO result is not real R2/Cloudflare qualification. Keep the exact revision, environment and failed observations with a new run.

## Credentials, output and teardown

The harness generates test credentials into gitignored `.run/s4.env` (mode 0600). Its result writer refuses known generated/observed secret values; this bounded check is not general proof every output is safe. Do not supply real provider accounts or publish raw credential material. Retain historical results and applicable licences/notices; follow the [spike evidence rules](../README.md).

When this isolated test run is finished, `s4 down` invokes Compose `down -v --remove-orphans`: it removes this Compose stack and its volumes, including MinIO replica data. That cleanup is destructive to the test data and must not target someone else's active campaign. See [testing](../../docs/testing.md) for the separate maintained image/restore-drill suites.
