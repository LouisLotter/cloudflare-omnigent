import { z } from "zod";

// Omnigent's GitHub linking as the platform sees it (WP3.36): OmnigentServer's `githubSetup`
// RPC, for the web Worker's GitHub setup page (`/platform/github`), the GitHub App's setup URL.
// GitHub sends the owner there after the App is installed; the page waits until the server
// reports GitHub linking on, then opens Omnigent's Integrations page, where "Connect GitHub" is.
//
// Every field is a fact OmnigentServer can see, never a value of a setting:
//   - `configured`: the platform Worker version the object runs holds the GitHub App's client
//     ID (`SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_ID`). An object still on the version from before
//     the App's settings were stored says false until it switches (about 5 minutes at most);
//   - `applied`: the running server was started with that version's configuration (its
//     environment, image and size, the watchdog's start fingerprint);
//   - `server`: the watchdog's view of the server container;
//   - `linking`: whether Omnigent's `GET /v1/info` lists `github` in `enabled_connections`,
//     the condition under which Omnigent's interface shows its Integrations settings and
//     "Connect GitHub". Read once per call while the server answers; `unknown` otherwise.

/** What the GitHub setup page asks OmnigentServer. */
export const GitHubSetupCall = z.looseObject({ interfaceVersion: z.number().int().min(1) });
export type GitHubSetupCall = z.infer<typeof GitHubSetupCall>;

/** OmnigentServer's answer. */
export const GitHubSetupResult = z.looseObject({
  configured: z.boolean(),
  applied: z.boolean(),
  /**
   * `answering`: it answered the read just made. `starting`: a start, a stop, a retry or a
   * server that does not answer right now. `held`: it exited with a missing or malformed setting
   * (78) and is not started again until the configuration changes. `recovery`: the server image's
   * recovery mode. `unavailable`: no server container is configured.
   */
  server: z.enum(["answering", "starting", "held", "recovery", "unavailable"]),
  linking: z.enum(["on", "off", "unknown"]),
});
export type GitHubSetupResult = z.infer<typeof GitHubSetupResult>;
