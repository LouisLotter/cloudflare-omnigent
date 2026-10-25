# Security

Report sensitive vulnerabilities through [GitHub private vulnerability reporting](https://github.com/LouisLotter/cloudflare-omnigent/security/advisories/new). Use the private advisory form rather than public issues or pull-request comments.

If the form is unavailable, keep vulnerability details private. You may open a public issue asking the maintainer for a private contact method, without including sensitive details.

## Scope and current status

This project is under development for a single person's installation in that person's Cloudflare account. No production-ready release or maintained security-support window is declared. The [compatibility snapshot](docs/compatibility.md) identifies source/artifact gaps; the [architecture](docs/architecture.md) separates accepted boundaries from unfinished integration.

The integrated source includes ingress and server safeguards, but still registers a placeholder computer launcher, disables native GitHub linking and refuses the private platform bridge. Production computer routing, the Worker key service and complete computer lifecycle remain integration/qualification requirements. A capability implemented in the Omnigent fork is not automatically enabled or included in a platform image.

## Trust and credential boundaries

The intended public entry is owner-only Cloudflare Access plus Omnigent authentication. Private virtual hosts are container interception paths, not public routes. Exact identity, origin, generation and version checks remain necessary at each boundary; a private hostname alone is not authorization.

This is not hostile multi-tenant runner isolation. Code on a computer and delegated runners have broad owner-equivalent application reach, including other conversations and computers' work. Explicit restrictions protect approvals, account administration and identity, but do not turn a runner into an independently confined tenant. See [identity and credential authority](docs/decisions/0004-identity-credential-authority.md).

The server image requires a cookie secret and, for an S3 replica, replica credentials. The bootstrap password is first-installation material. The entrypoint removes replica credentials from the application child's environment; Litestream receives the storage credentials it needs. Private launcher/key-service signing credentials belong to planned bridge wiring, not the current integrated configuration.

Worker-held encryption keys do not imply plaintext is absent from authorized server use. Computers are intended to hold their own Claude/Codex login material; runtime tokens and provider-key files have separate custody/exclusion rules. The intended native GitHub broker deliberately makes an access token available in memory/environment to git/gh; that integration is currently disabled. Checkpoint access must be treated as access to sensitive login material. Version-one checkpoint design relies on private bindings and R2 encryption at rest, without application-level checkpoint encryption.

Use [the secret inventory](docs/secrets.md) for material-specific custody and [security operations](docs/operations/security.md) for compromise/revocation actions. Source schemas and canary scans support particular checks; they do not certify every receiver, image, log or historical artifact free of credentials.

## Prepare a report without disclosing secrets

In your private report, include:

- Affected component, exact platform/fork revision and image/deployment identity if known; state unknown identities explicitly.
- Preconditions, the trust boundary crossed, expected behavior and observed impact.
- Minimal reproduction using synthetic values and a system you are authorized to test.
- Redacted logs or request shapes sufficient to explain the result, with relevant timestamps and outcomes.

Do not attach login files, access/refresh tokens, cookie headers, private keys, full databases, checkpoint archives or unredacted account/hostname details. Do not post sensitive reproduction details in public issues or pull-request comments. Ordinary publication of a token-like string is not, by itself, proof that it is a live credential; keep actual values out of the report packet and state what was verified.

If a real credential was exposed, use its provider's established revocation/rotation controls and preserve redacted incident provenance. Repository cleanup alone does not revoke credentials, and restoring files cannot undo external actions. Coordinate any history response through the maintainer; it is separate from routine documentation or retention changes.
