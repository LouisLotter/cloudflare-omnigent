# Architecture decisions

These records describe accepted engineering choices. Acceptance does not mean implementation is complete or a release is qualified. Each record states the implementation and qualification limits at the 24 October 2026 source snapshot; [architecture](../architecture.md) gives the shared maturity and artifact-pin map.

| Record | Decision status | Implementation scope |
| --- | --- | --- |
| [0001 — Omnigent owns host execution](0001-omnigent-owns-host-execution.md) | Accepted | Fork features available; Cloudflare lifecycle integration remains draft. |
| [0002 — Two Workers and native transport](0002-two-workers-native-transport.md) | Accepted | Server-base split implemented in main; complete private computer route remains draft. |
| [0003 — Durability before acknowledgement or effect](0003-durability-before-acknowledgement-effect.md) | Accepted | Response/transcript barriers and the launcher's effect fence implemented in main; the fence awaits a real launcher API receiver. |
| [0004 — Identity and credential authority](0004-identity-credential-authority.md) | Accepted | Fork controls available; key service, GitHub wiring and computer-route qualification pending. |
| [0005 — Checkpoint publication and continuation](0005-checkpoint-publication-continuation.md) | Accepted | Contracts present in main, capture/credential experiments reported; production assembly draft. |
| [0006 — Honest uncertain outcomes](0006-honest-uncertain-outcomes.md) | Accepted | Fork implementation available; image inclusion differs by pin. |
| [0007 — Compatible releases and recovery](0007-compatible-releases-recovery.md) | Accepted | Pins, initial contracts and server recovery safeguards exist; full mixed-version and recovery procedures remain to qualify. |

Change a decision by adding a focused record that explains the new constraint and marks the earlier record superseded. Keep current product behavior and compatibility obligations here; private review conversations, approvals, account runs and work tracking remain outside this repository. Do not turn these records into a second task tracker.
