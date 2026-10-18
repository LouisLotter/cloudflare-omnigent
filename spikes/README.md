# Spikes (milestone M1)

Small, throwaway experiments that settle the design's open questions before anyone builds on them. Each spike answers one question from the implementation plan's M1 table, and ends with three things:

- an evidence report;
- a go or no-go;
- teardown evidence: its containers, Workers and buckets are gone.

The lessons move into the design. The code here is not reused.

| Spike | Directory | Staging suffix | Branch |
|---|---|---|---|
| S1 Lifecycle and wake time | `spikes/s1/` | `s1-…` | `spike/s1-lifecycle` |
| S2 Private host route | `spikes/s2/` | `s2-…` | `spike/s2-host-route` |
| S3 Bounded capture and runner counting | `spikes/s3/` | `s3-…` | `spike/s3-capture` |
| S4 Litestream and the durability barrier | `spikes/s4/` | `s4-…` | `spike/s4-litestream` |
| S5 Access and platform login | `spikes/s5/` | `s5-…` | `spike/s5-access-login` |
| S6 Sign-in and credential files | `spikes/s6/` | `s6-…` | `spike/s6-credentials` |
| S7 Managed settings | `spikes/s7/` | `s7-…` | `spike/s7-managed-settings` |

## Rules

**Where you work**
- Work only in your own directory, `spikes/s<n>/`.
- Also write your evidence entry, `docs/verification/spike-s<n>.md`, and change only the Status, Branch and Evidence cells of your own row in `docs/WORKPLAN.md`.
- Everything else in the repository is shared and owned by the lead: `contracts/`, `worker/`, `scripts/`, `python/`, `.github/`, the other docs. Ask the lead for a change instead of making it.
- Commit on your spike branch. Do not push.

**Staging**
- Deploy only through the guarded tool: `pnpm stg deploy --suffix s<n>-<name> --owner S<n> --config spikes/s<n>/<config>.jsonc --days <1–7>`.
  - Your Wrangler config must set `"workers_dev": false` and `"preview_urls": false`, have no routes, and use only the keys the tool manages. The tool explains any refusal.
  - Every Worker gets an owner-only Access application before it can serve traffic.
- **Containers and R2 buckets** are refused until the tool records and tears them down. The lead is adding that support. Until it lands, work locally (Docker, `wrangler dev`, MinIO as an S3 stand-in), and ask the lead when you are ready to deploy.
- Never create, change or delete any Cloudflare resource by hand. In particular, never touch the two existing Access applications ("Inyanda Omnigent", "Lervent Omnigent") or anything without the `cfo-stg-` prefix.
- Keep cost small: one container instance unless the question needs more, and the smallest instance type that answers it.
- Tear down when done with `pnpm stg teardown --suffix …`, and show in your evidence that the resources are gone.

**Secrets and accounts**
- No secrets, tokens, account IDs or email addresses in commits, logs you keep, or evidence. Use synthetic values and runtime-generated canaries.
- Real Claude and ChatGPT accounts are for S6 only. The owner has standing approval, but signing in needs the owner at the keyboard: the lead schedules it. Record every run, and sign out afterwards.
- The Omnigent fork at `/home/decay/Lervent/omnigent` (branch `cloudflare`) is read-only for spikes. Use the published images, such as `ghcr.io/omnigent-ai/omnigent-server`, or build from the fork into your own directory.

**Evidence**
- Copy `docs/verification/TEMPLATE-wp.md` to `docs/verification/spike-s<n>.md`. Fill it in with:
  - the question and the pass criteria, from the plan;
  - what ran, and the raw measurements, kept under `spikes/s<n>/results/` with the script that reproduces them;
  - the go or no-go, and the reasoning;
  - what the design must change. Put that in the report only; the lead edits the design;
  - teardown evidence.
- A no-go is a valid, useful result. Report it plainly.

## Design context

- **Governing design:** `/home/decay/Lervent/omnigent-cloudflare-context/design/hybrid-architecture.md`.
- **Code structure:** `design/code-structure.md`.
- **Implementation plan:** `design/implementation-plan.md`, section "M1 — Spikes", with the pass criteria.
- **Research behind the open questions:** `/home/decay/Lervent/omnigent-cloudflare-context/research/open-questions-2026-10-18.md`.
- **Cloudflare documentation:** `cf docs search "<question>"`. Fetch a result with `Accept: text/markdown`.
