# Historical spike results

Selected S1–S7 raw outputs have been preserved before removal from the current checkout. This is repository housekeeping, not new runtime qualification. Failed runs, before-fix results, teardown observations and distinct screenshot labels retain their original meaning.

## Recover the original evidence

The complete public source and all 332 result files are available at [the historical source revision](https://github.com/LouisLotter/cloudflare-omnigent/tree/22b2236a2e0840c30f008a10bfcbe92188b1a6c6/spikes), commit `22b2236a2e0840c30f008a10bfcbe92188b1a6c6`. Follow the family and original path there. Maintainers also retain a private, checksummed preservation copy and full source snapshot. Public readers do not need access to those private notes to retrieve the historical version.

For historical analysis, use a separate checkout at that exact revision. Keep its source, companion files, lockfiles and licences together. A checkout does not recreate an old Docker image, external dependency, provider service or live account: those remain the harness's documented prerequisites. Do not run a historical campaign merely to view its recorded results.

## Material retained in the current checkout

- The 22 S3 inputs consumed by `s3/bench/facts.py` and `s3/bench/report.py`, including capture files, remain unchanged.
- The executable S2 saturation analysis remains at its existing path. Its account/network effects require separate authorization; it is not an offline report.
- Nine S7 Markdown summaries and two representative PNGs remain pending a separately reviewed curation. Their JSON and other companions remain recoverable at the historical revision; these are historical illustrations, not current product screenshots.
- Every spike source file, harness, configuration, licence, test fixture and maintained product file remains. Result-directory placeholders preserve the existing output paths for harnesses that do not create them.

Raw historical outputs are evidence, not mandatory runtime dependencies or proof that resources still exist. New runs can overwrite fixed filenames: use a scratch checkout, preserve run associations and review output before retaining or sharing it. No Git history was rewritten; old public commits still contain their original files. This cleanup reduces current-checkout size, not historical exposure or Git clone history size.
