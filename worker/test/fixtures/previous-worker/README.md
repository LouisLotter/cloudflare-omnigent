# The previous platform Worker's record reader

`record.ts`, `sign-in.ts` and `status.ts` are WorkspaceDO's storage schemas as the platform Worker
before WP8.4 has them, copied unchanged from `worker/src/computer/` at `31c1513` (identical at
`fe9368d`). `test/unit/computer-rollback.test.ts` reads storage the current controller wrote with
them, as that Worker does after `bootstrap.ts update --rollback` redeploys it without reverting
WorkspaceDO's storage.

They import the current `@cfo/contracts`; none of the contract schemas they use changed in WP8.4.
When a later release becomes the one a rollback returns to, replace them with that release's
files, for example `git show <revision>:worker/src/computer/record.ts > record.ts`.
