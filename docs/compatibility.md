# Compatibility and verification status

Source snapshot dated 24 October 2026, based on platform source `91261d7e8fe4b87c8010d50739cd921dd4bf09fe`. This snapshot does not select a release assembly. Builds, tests and production qualification are different claims: a fix in fork source is not automatically present in an image built from an earlier commit.

| Source assembly | Server's default Omnigent source | Status |
|---|---|---|
| Platform baseline `91261d7e8fe4b87c8010d50739cd921dd4bf09fe` | `af3e49de2b169a8593e2d91e7ab98e2581f9f90a` | Integrated platform source; image digest and deployed identity not established by this document |
| Separate candidate `eb26816c150bb62c2ecc3222991769738b220afb` | `35ac1ebd2405264de7c0456084f45c4af1e657ca` | Startup/recovery and artifact-record candidate; real R2 startup qualification on the target `basic` instance remains pending |
| Fork integration `184b5cf8b32815b48c7859973a00a139e8aa50f0` | Not selected by either default above | Includes later UI and history-resume corrections; no containing product image is identified here |
| Paused computer supervisor `e566f7f816c61cb840e872d0fde1256fdb6f4017` | No product computer Dockerfile at this revision | Partial source, not an assembled computer image; CLI/SDK pins and image digest remain unselected |

The [server Dockerfile](../images/server/Dockerfile) pins source/base inputs and checks the fork Dockerfile mirror. Build arguments may override defaults, so record the values actually used. A matching mirror digest only describes build coupling; it does not mean that different fork commits contain the same fixes. Rebuilds also resolve Debian packages, so source pins alone do not promise identical image bytes.

| Behavior | Baseline server pin | Candidate server pin | Current fork integration |
|---|---|---|---|
| Single-attempt Stop with explicit delivery outcome | Absent | Included | Included |
| Referenced native provider-key file and transcript replay | Absent | Included | Included |
| Later main-chat Stop failure and launch-outcome notices | Absent | Absent | Included |
| Later history-unavailable resume refusal and resume-ID preservation | Absent | Absent | Included |

These are source-inclusion statements. They do not establish runtime behavior on an uninspected image. The main server still registers a [placeholder Cloudflare launcher](../images/server/cfo_server/launcher.py), [disables GitHub linking](../images/server/cfo_server/app.py), and has an [unavailable internal platform bridge](../worker/src/server/platform-internal.ts). Fork capabilities do not make those product integrations complete.

The [wire contracts](../contracts/README.md) define launcher/supervisor protocol version 1, workspace/control interface version 1, workspace/credential format version 1 and checkpoint-policy version 1. Receivers must check the versions they support before effects. Exported JSON Schema covers shape constraints; cross-field refinements and policy/signing/tree calculations also need tests against each actual receiver. The [generic Python fixture tests](../python/tests/test_contracts.py) cover valid/invalid schema fixtures, and the [vector tests](../python/tests/test_contract_vectors.py) use independent reference calculations. They do not prove that an unfinished supervisor applies all refinements. The WorkspaceDO controller refuses unsupported launcher, supervisor, intercept-props and interface versions before any effect. Every command shape it sends is recorded in a [corpus](../worker/test/fixtures/workspace-commands.json) that the supervisor's [actual parser](../images/computer/cfo_computer/contract.py) accepts in the [Python tests](../python/tests/computer/test_workspace_commands.py). That shows the two parsers agree; it is not a test of an assembled supervisor.

Current [CI](../.github/workflows/ci.yml) runs the workspace's Node checks, the root `python/` project, limited canary checks, explicit platform and [web](../worker/wrangler.web.jsonc) bundles, and builds/tests the existing server image targets. Its image suite excludes S3/fault integration and runs without external networking. The [scripts test configuration](../scripts/vitest.config.ts) already includes restore-drill staging tests in Node with fakes. Restore-drill Python, candidate-only fork/artifact tests and real-platform qualification remain separate; the added CI checks do not change the source pins or assembly status above.

The [canary scanner](../scripts/canary-scan.ts) detects synthetic markers and exact configured values in its supported paths/formats. A clean result is bounded evidence about those values; it is not general proof of no credentials, a whole-repository/history/image scan, or publication approval. Incomplete scans fail.

For every qualification run record platform and fork revisions, actual Worker build/deployment IDs, final server/computer manifest digests and architecture, CLI/SDK/Litestream versions, packaged contract/policy assets, test commands/results, known exclusions and remaining runtime obligations. Image IDs from local tests must be labelled separately from registry manifest digests. Do not use mutable “latest” tags as the record.
