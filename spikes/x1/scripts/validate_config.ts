// Checks X1's Wrangler configurations and staging manifest with the staging tool's own rules,
// without any cloud call:
//
//   node spikes/x1/scripts/validate_config.ts [--staging <dir holding guard.ts and cloud.ts>]
//
// --staging points at another copy of scripts/staging, for example the WP0.4 extension that
// adds manifests, rendered configurations and cross-script bindings, exported from its branch.
// Without it, this checkout's tool is used, and the checks it cannot do are reported as skipped.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const x1 = join(root, "spikes", "x1");
const { values } = parseArgs({ options: { staging: { type: "string" } } });
const staging = resolve(values.staging ?? join(root, "scripts", "staging"));
// biome-ignore lint/suspicious/noExplicitAny: the tool's API differs between its versions
const guard: any = await import(pathToFileURL(join(staging, "guard.ts")).href);
// biome-ignore lint/suspicious/noExplicitAny: as above
const cloud: any = await import(pathToFileURL(join(staging, "cloud.ts")).href);
const worker = join(root, "worker");
// A syntactically valid placeholder account: the check compares it only with the config's own.
const ACCOUNT = "0".repeat(32);
const ZONE = "example.test";
const TRANSPORT = "cfo-stg-x1-transport";
const UI = "cfo-stg-x1-ui";
let failures = 0;

function check(what: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok    ${what}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function skip(what: string, why: string): void {
  console.log(`skip  ${what}: ${why}`);
}

const transportConfig = join(x1, "transport", "wrangler.jsonc");
const uiConfig = join(x1, "ui", "wrangler.jsonc");
const manifestPath = join(x1, "transport", "staging.jsonc");

check(`${TRANSPORT}: the checked configuration`, () => {
  guard.validateDeployConfig(cloud.readWranglerConfig(transportConfig, worker), ACCOUNT, TRANSPORT);
});

let manifest: { serviceToken?: unknown; tunnel?: { publicHostname: boolean } } | undefined;
if (typeof guard.parseManifest === "function") {
  check(`${TRANSPORT}: staging.jsonc`, () => {
    manifest = guard.parseManifest(
      guard.parseJsonc(readFileSync(manifestPath, "utf8")),
      manifestPath,
    );
  });
} else {
  skip(`${TRANSPORT}: staging.jsonc`, "this staging tool has no manifests");
}

check("the F7 build flag agrees with the manifest", () => {
  const flags = readFileSync(join(x1, "transport", "src", "flags.js"), "utf8");
  const flag = /export const PUBLIC_ROUTES = (true|false);/.exec(flags)?.[1];
  const text = readFileSync(manifestPath, "utf8");
  const token = /"serviceToken"\s*:/.test(text);
  const publicHost = /"publicHostname"\s*:\s*true/.test(text);
  if (flag === undefined) throw new Error("src/flags.js has no PUBLIC_ROUTES");
  if ((flag === "true") !== token || (flag === "true") !== publicHost) {
    throw new Error(
      `PUBLIC_ROUTES is ${flag}, but the manifest's service token is ${token ? "present" : "absent"} and its public hostname ${publicHost ? "on" : "off"}`,
    );
  }
});

if (typeof guard.renderedConfigPath === "function" && typeof guard.tunnelRoute === "function") {
  check(
    `${TRANSPORT}: the configuration as the tool renders it (Tunnel route, VPC service)`,
    () => {
      const raw = guard.parseJsonc(readFileSync(transportConfig, "utf8"));
      const route = guard.tunnelRoute(guard.tunnelHostnameFor(TRANSPORT, ZONE), ZONE);
      const serviceId = "00000000-0000-4000-8000-000000000000";
      const rendered = {
        ...raw,
        routes: manifest?.tunnel?.publicHostname ? [route] : [],
        vpc_services: [{ binding: "X1_VPC", service_id: serviceId }],
      };
      const path = guard.renderedConfigPath(transportConfig, TRANSPORT);
      writeFileSync(path, JSON.stringify(rendered, null, 2));
      try {
        guard.validateDeployConfig(cloud.readWranglerConfig(path, worker), ACCOUNT, TRANSPORT, {
          rendered: { routes: rendered.routes, vpcServiceIds: [serviceId] },
        });
      } finally {
        rmSync(path, { force: true });
      }
    },
  );
} else {
  skip(`${TRANSPORT}: the rendered configuration`, "this staging tool renders none");
}

check(`${UI}: no staging manifest in its directory`, () => {
  if (existsSync(join(x1, "ui", "staging.jsonc"))) throw new Error("ui/staging.jsonc exists");
});

check(
  `${UI}: the cross-script binding to RunDO, with ${TRANSPORT} deployed by the same owner`,
  () => {
    const deployed = {
      name: TRANSPORT,
      hostname: `${TRANSPORT}.${ZONE}`,
      owner: "X1",
      createdAt: "2027-01-15T08:00:00.000Z",
      expiresAt: "2027-01-17T08:00:00.000Z",
      state: "deployed",
    };
    guard.validateDeployConfig(cloud.readWranglerConfig(uiConfig, worker), ACCOUNT, UI, {
      registry: { owner: "X1", deployments: [deployed] },
    });
  },
);

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
