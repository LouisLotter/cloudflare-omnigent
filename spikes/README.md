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
- **Containers and R2 buckets** may be declared in your config, under these rules:
  - Every container's `name` and every bucket's `bucket_name` must be your deployment's name, `cfo-stg-<suffix>`, or start with `cfo-stg-<suffix>-`.
  - Each container needs `max_instances` between 1 and 3. Its `instance_type` must be `lite`, `basic`, `standard-1` or `standard-2`.
  - Only these container keys are allowed: `name`, `class_name`, `image`, `max_instances`, `instance_type`, `image_build_context` and `image_vars`. A bucket entry has only `binding` and `bucket_name`.
  - **A `durable_object`-policy container** (`"scheduling_policy": "durable_object"`) uses only `name`, `class_name`, `scheduling_policy`, `images` and `observability` (logs on or off). Wrangler itself rejects `max_instances` for this policy, and the staging tool refuses `ssh`, `authorized_keys` and `unsafe`.
    - Each entry of `images` is either `{dockerfile, build_context?, build_vars?}`, or `{image}` pinned by digest to a repository of your deployment in the staging account's registry.
    - Wrangler pushes each image to the repository `<worker>-<class>-<image>`. The tool records that repository and deletes every tag in it on teardown.
    - Instance size is chosen in code at each `start()`. Keep it small, and use one fixed Durable Object name so only one instance runs.
    - Container snapshots cannot be listed or deleted through any API we found; they expire 30 days after creation or last restore. Record every snapshot ID you create, and list them in your evidence.
  - The tool records them before the deploy, creates the buckets itself, and on teardown removes the Worker, the container applications, their registry images and the buckets (emptied first), then Access.
  - A probe deployment is in `scripts/staging/probe/`.
  - **R2 is not yet enabled on the staging account.** The owner must enable it in the dashboard. Until then, use MinIO locally as an S3 stand-in for anything that needs R2, and ask the lead when you are ready for real R2.
- Never create, change or delete any Cloudflare resource by hand. In particular, never touch the two existing Access applications ("Inyanda Omnigent", "Lervent Omnigent") or anything without the `cfo-stg-` prefix.
- Keep cost small: one container instance unless the question needs more, and the smallest instance type that answers it.
- Tear down when done with `pnpm stg teardown --suffix …`, and show in your evidence that the resources are gone.

**Campaign controls (IR-017).** The owner's logged-in browser is the only thing that reaches a staging spike. Being logged in through Access is therefore not, by itself, permission to start, stop, reset or inject anything. Every spike route that changes state follows these rules:
- A `GET` or `HEAD` never changes state: no container start or stop, no scenario, no fault, no write. A `GET` to a control URL shows a confirmation page with a button.
- A change is a `POST` that carries both of the following, checked before any effect:
  1. an `Origin` header exactly equal to the deployment's own origin. Missing, `null` and foreign origins get 403, and when `Sec-Fetch-Site` is present it must be `same-origin`;
  2. a request-intent token: a random value the Worker stores and embeds in the confirmation page, sent back in a form field or header and compared in constant time. A page on another site can't read it.
- Fault-injection and scenario routes are off unless a campaign has been armed by such a `POST`. They disarm themselves after a bounded time.
- Tests cover a foreign origin, `null`, a missing origin, a simple cross-site form, a cross-site top-level `GET`, and a valid same-origin control. Each refusal must have zero effect.

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
