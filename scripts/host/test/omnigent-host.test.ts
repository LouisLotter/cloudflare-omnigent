// The per-machine host setup (WP3.43), run as the real script against fake `warp-cli`, `curl`,
// `git`, `uv`, `systemctl` and a fake Omnigent build, in a throwaway HOME. Only the commands it
// is allowed to use are on its PATH, so a call to anything else fails the test.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const REAL_SCRIPT = join(ROOT, "scripts", "host", "omnigent-host.sh");
const DOCKERFILE = readFileSync(join(ROOT, "images", "computer", "Dockerfile"), "utf8");
const BUILD_PINS = readFileSync(join(ROOT, "scripts", "host", "build-requirements.txt"), "utf8");
const COMMIT = /^ARG OMNIGENT_COMMIT=([0-9a-f]{40})$/m.exec(DOCKERFILE)?.[1] as string;
const SERVER = "https://omnigent.example.test";
const UNIT = "omnigent-cfo-host.service";
const PID = "4242";

/** The system utilities the script may use besides the faked commands. */
const UTILITIES = [
  "bash",
  "sh",
  "env",
  "sed",
  "grep",
  "mktemp",
  "readlink",
  "tr",
  "head",
  "cat",
  "mv",
  "chmod",
  "ln",
  "rm",
  "mkdir",
  "sleep",
  "basename",
  "dirname",
  "uname",
  "cp",
  "touch",
  "sha256sum",
  "cut",
];

const FAKES: Record<string, string> = {
  "warp-cli": `#!/bin/bash
w=$FAKE_WORLD
# As a fresh install answers without a terminal (2026.8.2115.0): the terms of service first.
if [[ $1 == --accept-tos ]]; then shift
elif [[ $* != --version ]]; then
  echo "Please accept the WARP Terms of Service by running this command in a TTY or by passing the --accept-tos flag." >&2
  exit 1
fi
echo "warp-cli $*" >>"$w/calls"
[[ -f $w/warp-down ]] && { echo "Error: Unable to connect to the CloudflareWARP daemon" >&2; exit 1; }
case "$*" in
--version) echo "warp-cli 2026.9.1234.0" ;;
status)
  if [[ -f $w/connected ]]; then printf 'Status update: Connected\\nNetwork: healthy\\n'
  else printf 'Status update: Disconnected\\nReason: Manual Disconnection\\n'; fi ;;
"registration show")
  if [[ -f $w/registered ]]; then echo "Account type: $(cat "$w/registered")"; echo "Organization: team"
  else echo 'Error: Missing registration. Try running: "warp-cli registration new"' >&2; exit 1; fi ;;
"registration new "*)
  echo "$3" >"$w/registered-team"
  [[ -f $w/registration-pending ]] || echo Team >"$w/registered"
  echo Success ;;
connect) [[ -f $w/registered && ! -f $w/never-connects ]] && touch "$w/connected"; echo Success ;;
*) echo "unexpected warp-cli $*" >&2; exit 2 ;;
esac
`,
  curl: `#!/bin/bash
w=$FAKE_WORLD
out=/dev/null fmt="" url=""
while (($#)); do
  case $1 in
  -o) out=$2; shift 2 ;;
  -w) fmt=$2; shift 2 ;;
  -H|--max-time) shift 2 ;;
  -*) shift ;;
  *) url=$1; shift ;;
  esac
done
echo "curl $url" >>"$w/calls"
code=200 location="" body=""
case $url in
"${SERVER}/")
  if [[ -f $w/connected && $(cat "$w/access" 2>/dev/null || echo ok) == ok ]]; then code=200
  else code=302 location="https://team.cloudflareaccess.com/cdn-cgi/access/login/omnigent.example.test?kid=x"; fi ;;
"${SERVER}/v1/me")
  access=$(cat "$w/access" 2>/dev/null || echo ok)
  [[ -f $w/connected ]] || access=login
  case $access in
  ok) code=401 body='{"detail":"Not authenticated","login_url":"/login"}' ;;
  login) code=302 location="https://team.cloudflareaccess.com/cdn-cgi/access/login/omnigent.example.test" ;;
  lapsed) code=401 body='Unauthorized' ;;
  refused) code=403 body='{"error":{"code":"forbidden"}}' ;;
  down) exit 7 ;;
  esac ;;
*) echo "unexpected curl $url" >&2; exit 2 ;;
esac
printf '%s' "$body" >"$out"
fmt=\${fmt//'%{http_code}'/$code}
fmt=\${fmt//'%{redirect_url}'/$location}
printf '%s' "$fmt"
`,
  git: `#!/bin/bash
w=$FAKE_WORLD
echo "git $*" >>"$w/calls"
case $1 in
init) mkdir -p "$3" ;;
-C)
  case $3 in
  fetch) echo "\${@: -1}" >"$2/.fetched" ;;
  rev-parse) cat "$w/git-head" 2>/dev/null || cat "$2/.fetched" ;;
  esac ;;
esac
`,
  uv: `#!/bin/bash
w=$FAKE_WORLD
echo "uv $* (in $PWD) skip_web=$OMNIGENT_SKIP_WEB_UI" >>"$w/calls"
case $1 in
export) while (($#)); do [[ $1 == -o ]] && echo 'a-dependency==1.0 --hash=sha256:00' >"$2"; shift; done ;;
venv)
  dir=\${@: -1}
  mkdir -p "$dir/bin"
  cp "$FAKE_BIN/python" "$dir/bin/python"
  cp "$FAKE_BIN/omnigent" "$dir/bin/omnigent" ;;
pip)
  [[ $2 == freeze ]] && { echo 'omnigent==0.20.0'; exit 0; }
  [[ -f $w/pip-fails ]] && exit 1 ;;
esac
exit 0
`,
  // Starts the unit's ExecStart as systemd would: /proc then shows that command line.
  systemctl: `#!/bin/bash
w=$FAKE_WORLD
unit="$HOME/.config/systemd/user/${UNIT}"
echo "systemctl $*" >>"$w/calls"
start() {
  [[ -f $w/stale-process ]] && return 0
  local line
  line=$(sed -n 's/^ExecStart=//p' "$unit")
  eval "set -- $line"
  mkdir -p "$w/proc/${PID}"
  printf '%s\\0' "$@" >"$w/proc/${PID}/cmdline"
  # The environment the unit gives the process: its Environment= lines, unquoted as systemd does.
  : >"$w/proc/${PID}/environ"
  while IFS= read -r line; do
    eval "set -- $line"
    printf '%s\\0' "$@" >>"$w/proc/${PID}/environ"
  done < <(sed -n 's/^Environment=//p' "$unit")
  echo ${PID} >"$w/pid"
}
case "$*" in
"--user show -p MainPID --value ${UNIT}") cat "$w/pid" 2>/dev/null || echo 0 ;;
"--user is-active ${UNIT}") echo active ;;
"--user enable --now ${UNIT}")
  [[ -f $w/enable-fails ]] && exit 1
  [[ -f $w/pid ]] || start ;;
"--user restart ${UNIT}") start ;;
esac
exit 0
`,
  // Copied into each environment the fake uv makes.
  python: `#!/bin/bash
w=$FAKE_WORLD
echo "python $* data=$OMNIGENT_DATA_DIR config=$OMNIGENT_CONFIG_HOME" >>"$w/calls"
case "$2:$3" in
*signin-check.py:*) cat "$w/token" 2>/dev/null || echo absent ;;
*python_version*) echo 3.12.13 ;;
esac
`,
  omnigent: `#!/bin/bash
w=$FAKE_WORLD
echo "omnigent $* data=$OMNIGENT_DATA_DIR config=$OMNIGENT_CONFIG_HOME wrapper=$OMNIGENT_WRAPPER_COMMAND analytics=$OMNIGENT_ANALYTICS passthrough=$OMNIGENT_RUNNER_ENV_PASSTHROUGH" >>"$w/calls"
case $1 in
login) [[ -f $w/login-fails ]] && exit 1; echo ok >"$w/token" ;;
host) if [[ -f $w/offline ]]; then echo '[{"host_status": "offline"}]'; else echo '[{"host_status": "online"}]'; fi ;;
esac
`,
};

interface Env {
  readonly dir: string;
  readonly home: string;
  readonly world: string;
  readonly bin: string;
  readonly cfoHome: string;
  readonly cfoConfig: string;
  readonly unitFile: string;
  readonly wrapper: string;
  run(...args: string[]): { status: number | null; out: string };
  calls(): string[];
  flag(name: string, content?: string): void;
  unflag(name: string): void;
  /** The running service's command line, as /proc shows it. */
  proc(argv: readonly string[]): void;
  /** The copy of the repository's files the script runs from. */
  readonly dockerfile: string;
  /** The build directory the current pins make. */
  build(): string;
}

let env: Env | undefined;

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "cfo-host-"));
  const home = join(dir, "home");
  const world = join(dir, "world");
  const bin = join(dir, "bin");
  const sys = join(dir, "sys");
  for (const d of [home, world, bin, sys, join(dir, "tmp")]) mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), text, { mode: 0o755 });
  }
  for (const util of UTILITIES) {
    const found = spawnSync("bash", ["-c", `command -v ${util}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (found === "") throw new Error(`no ${util} on this machine`);
    symlinkSync(found, join(sys, util));
  }
  // The script runs from a copy of the files it reads, which a test may change.
  const root = join(dir, "root");
  const script = join(root, "scripts", "host", "omnigent-host.sh");
  const dockerfile = join(root, "images", "computer", "Dockerfile");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(dirname(dockerfile), { recursive: true });
  writeFileSync(script, readFileSync(REAL_SCRIPT), { mode: 0o755 });
  writeFileSync(join(root, "scripts", "host", "build-requirements.txt"), BUILD_PINS);
  writeFileSync(
    join(root, "scripts", "host", "signin-check.py"),
    readFileSync(join(ROOT, "scripts", "host", "signin-check.py")),
  );
  writeFileSync(dockerfile, DOCKERFILE);
  const cfoHome = join(home, ".local", "share", "omnigent-cfo");
  const cfoConfig = join(home, ".config", "omnigent-cfo");
  const e: Env = {
    dockerfile,
    build: () => {
      const recipe = /^RECIPE=([0-9]+)$/m.exec(readFileSync(script, "utf8"))?.[1] as string;
      const certifi = /^ARG CERTIFI_PIN="(.*)"$/m.exec(readFileSync(dockerfile, "utf8"))?.[1];
      const digest = createHash("sha256")
        .update(`${recipe}\n${certifi}\n${BUILD_PINS}`)
        .digest("hex")
        .slice(0, 12);
      return join(cfoHome, "venvs", `${COMMIT}-${digest}`);
    },
    dir,
    home,
    world,
    bin,
    cfoHome,
    cfoConfig,
    unitFile: join(home, ".config", "systemd", "user", UNIT),
    wrapper: join(home, ".local", "bin", "omnigent-cfo"),
    run: (...args) => {
      const result = spawnSync(join(sys, "bash"), [script, ...args], {
        encoding: "utf8",
        input: "",
        env: {
          HOME: home,
          PATH: `${bin}:${sys}`,
          TMPDIR: join(dir, "tmp"),
          FAKE_WORLD: world,
          FAKE_BIN: bin,
          CFO_HOST_PROC: join(world, "proc"),
          CFO_HOST_ONLINE_WAIT: "0",
          CFO_HOST_CONNECT_WAIT: "0",
          CFO_HOST_REGISTER_WAIT: "0",
          CFO_HOST_SERVICE_WAIT: "0",
          LANG: "C.UTF-8",
        },
      });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    },
    calls: () =>
      existsSync(join(world, "calls"))
        ? readFileSync(join(world, "calls"), "utf8").trim().split("\n")
        : [],
    flag: (name, content = "") => writeFileSync(join(world, name), content),
    unflag: (name) => rmSync(join(world, name), { force: true }),
    proc: (argv) => {
      mkdirSync(join(world, "proc", PID), { recursive: true });
      writeFileSync(join(world, "proc", PID, "cmdline"), [...argv, ""].join("\0"));
      writeFileSync(join(world, "pid"), `${PID}\n`);
    },
  };
  // The machine's retired Omnigent: never touched.
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "omnigent"), "#!/bin/sh\necho old\n", { mode: 0o755 });
  mkdirSync(dirname(e.unitFile), { recursive: true });
  writeFileSync(join(dirname(e.unitFile), "omnigent-host.service"), "[Unit]\nDescription=old\n");
  mkdirSync(join(home, ".omnigent"));
  return e;
}

beforeEach(() => {
  env = makeEnv();
});

afterEach(() => {
  if (env !== undefined) rmSync(env.dir, { recursive: true, force: true });
  env = undefined;
});

const current = (): Env => env as Env;
const reset = () => rmSync(join(current().world, "calls"), { force: true });

describe("omnigent-host.sh setup", () => {
  it("registers and connects the client, installs the pinned build, signs in and starts the host", () => {
    const e = current();
    const { status, out } = e.run("setup", "--server", `${SERVER}/`);
    expect(out).toContain(
      "ready: this machine is an Omnigent host of https://omnigent.example.test",
    );
    expect(status).toBe(0);
    const calls = e.calls();
    // 1. The client: registered with the team Access names, then connected.
    expect(calls).toContain("warp-cli registration new team");
    expect(calls).toContain("warp-cli connect");
    // 2. The pinned commit; its lock exported with hashes, without Omnigent's own (local)
    // packages, and installed from wheels with the hashes checked; the build backends pinned the
    // same way; Omnigent's packages built without isolation or the web UI (Codex r1-1, -3, -4).
    expect(calls).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^git -C .* fetch -q --depth 1 https://github.com/LouisLotter/omnigent.git ${COMMIT}$`,
        ),
      ),
    );
    expect(calls).toContainEqual(
      expect.stringMatching(
        /^uv export --frozen --no-dev --no-emit-project --no-emit-workspace --no-emit-local --no-editable .* \(in .*\/src\/[0-9a-f]{40}\)/,
      ),
    );
    expect(calls).toContainEqual(expect.stringMatching(/^uv venv -q --python 3\.12 /));
    const installs = calls.filter((c) => c.startsWith("uv pip install"));
    expect(installs).toHaveLength(4);
    expect(installs[0]).toMatch(
      /^uv pip install -q --python \S+ --require-hashes --only-binary :all: -r \S+\/requirements\.txt/,
    );
    expect(installs[1]).toMatch(
      /^uv pip install -q --python \S+ --require-hashes --only-binary :all: -r \S+\/scripts\/host\/build-requirements\.txt/,
    );
    expect(installs[2]).toMatch(
      /^uv pip install -q --python \S+ --no-deps --no-build-isolation \S+\/src\/[0-9a-f]{40} \S+\/sdks\/python-client \S+\/sdks\/ui .* skip_web=true$/,
    );
    expect(installs[3]).toMatch(
      /^uv pip install -q --python \S+ --no-deps --require-hashes --only-binary :all: -r \S+trust-pins\.txt/,
    );
    const build = e.build();
    expect(readlinkSync(join(e.cfoHome, "venv"))).toBe(`venvs/${build.split("/").at(-1)}`);
    expect(readFileSync(join(build, "cfo-build"), "utf8")).toBe(
      `build=${build.split("/").at(-1)}\ncommit=${COMMIT}\nrepository=https://github.com/LouisLotter/omnigent.git\ncertifi=certifi==2026.10.23\n`,
    );
    expect(readFileSync(join(build, "cfo-requirements.txt"), "utf8")).toContain("--hash=sha256:");
    expect(readFileSync(join(build, "cfo-freeze.txt"), "utf8")).toContain("omnigent==");
    // 3. The sign-in, by Omnigent itself, with this build's own data and configuration.
    const data = join(e.cfoHome, "data");
    expect(calls).toContain(
      `omnigent login ${SERVER} data=${data} config=${e.cfoConfig} wrapper=omnigent-cfo analytics=0 passthrough=OMNIGENT_ANALYTICS`,
    );
    // 4. The service: Omnigent's own service entry, from this build, restarted whenever it stops.
    const unit = readFileSync(e.unitFile, "utf8");
    // The build's own directory, never changed once complete (Codex r1-2).
    expect(unit).toContain(
      `ExecStart="${build}/bin/python" -P -m omnigent.host.service_entry --server "${SERVER}"`,
    );
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain(`Environment="OMNIGENT_DATA_DIR=${data}"`);
    expect(unit).toContain(`Environment="OMNIGENT_CONFIG_HOME=${e.cfoConfig}"`);
    expect(unit).toMatch(/Environment="PATH=\/.*"/);
    // D49: Omnigent's analytics off in the service's process, and named in Omnigent's own
    // passthrough so the runners it starts get it too; off in the command's sign-in (above) and
    // its host status check (below) as well.
    const environ = readFileSync(join(e.world, "proc", PID, "environ"), "utf8").split("\0");
    expect(environ).toContain("OMNIGENT_ANALYTICS=0");
    expect(environ).toContain("OMNIGENT_RUNNER_ENV_PASSTHROUGH=OMNIGENT_ANALYTICS");
    expect(environ).toContain(`OMNIGENT_DATA_DIR=${data}`);
    expect(calls).toContainEqual(
      expect.stringMatching(
        /^omnigent host status --server \S+ --json .* analytics=0 passthrough=OMNIGENT_ANALYTICS$/,
      ),
    );
    expect(calls).toContain(`systemctl --user enable --now ${UNIT}`);
    expect(calls).toContain(`systemctl --user restart ${UNIT}`);
    expect(out).toContain(`the service runs Omnigent ${COMMIT}`);
    // The command, side by side.
    const wrapper = readFileSync(e.wrapper, "utf8");
    expect(wrapper).toContain(`exec '${build}/bin/omnigent' "$@"`);
    expect(wrapper).toContain(`export OMNIGENT_DATA_DIR='${data}'`);
    expect(wrapper).toContain("export OMNIGENT_ANALYTICS=0");
    // A host started from the command passes it on to its runners too, keeping the person's own
    // pass-through names (Codex r1-1).
    reset();
    const own = spawnSync(e.wrapper, ["host", "--server", SERVER], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        FAKE_WORLD: e.world,
        OMNIGENT_RUNNER_ENV_PASSTHROUGH: "MY_VAR",
      },
    });
    expect(own.status).toBe(0);
    expect(e.calls()).toEqual([
      `omnigent host --server ${SERVER} data=${data} config=${e.cfoConfig} wrapper=omnigent-cfo analytics=0 passthrough=MY_VAR,OMNIGENT_ANALYTICS`,
    ]);
    expect(readFileSync(join(e.cfoConfig, "server"), "utf8")).toBe(`${SERVER}\n`);
    // The retired Omnigent and its service are left alone; nothing reads ~/.omnigent.
    expect(readFileSync(join(e.home, ".local", "bin", "omnigent"), "utf8")).toBe(
      "#!/bin/sh\necho old\n",
    );
    expect(readFileSync(join(dirname(e.unitFile), "omnigent-host.service"), "utf8")).toBe(
      "[Unit]\nDescription=old\n",
    );
    expect(calls.join("\n")).not.toContain(join(e.home, ".omnigent"));
  });

  it("changes nothing when run again", () => {
    const e = current();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    reset();
    const { status } = e.run("setup", "--server", SERVER);
    expect(status).toBe(0);
    const calls = e.calls();
    for (const word of [
      "registration new",
      "connect",
      "git ",
      "uv ",
      "omnigent login",
      "restart",
    ]) {
      expect(
        calls.filter((c) => c.includes(word)),
        word,
      ).toEqual([]);
    }
  });

  it("builds again for a new trust pin, switches the service to it and removes the old build (Codex r1-7)", () => {
    const e = current();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    const first = e.build();
    const pin = /^ARG CERTIFI_PIN="(.*)"$/m.exec(readFileSync(e.dockerfile, "utf8"))?.[1] as string;
    writeFileSync(
      e.dockerfile,
      readFileSync(e.dockerfile, "utf8").replace(pin, pin.replace(/[0-9a-f]{64}/, "f".repeat(64))),
    );
    const second = e.build();
    expect(second).not.toBe(first);
    reset();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    expect(e.calls().filter((c) => c.startsWith("uv pip install"))).toHaveLength(4);
    expect(readlinkSync(join(e.cfoHome, "venv"))).toBe(`venvs/${second.split("/").at(-1)}`);
    expect(e.calls()).toContain(`systemctl --user restart ${UNIT}`);
    expect(readFileSync(e.unitFile, "utf8")).toContain(`ExecStart="${second}/bin/python"`);
    expect(existsSync(first)).toBe(false);
    // The fetched source of the same commit is kept.
    expect(existsSync(join(e.cfoHome, "src", COMMIT))).toBe(true);
  });

  it("restarts a service still running an earlier build, and keeps that build until it has (Codex r1-2)", () => {
    const e = current();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    // An earlier run stopped after the new build and unit were in place, before the restart:
    // the process still runs the old build, whose directory is still there.
    const old = join(e.cfoHome, "venvs", `${"1".repeat(40)}-000000000000`);
    mkdirSync(join(old, "bin"), { recursive: true });
    e.proc([
      join(old, "bin", "python"),
      "-P",
      "-m",
      "omnigent.host.service_entry",
      "--server",
      SERVER,
    ]);
    e.flag("stale-process");
    reset();
    let r = e.run("setup", "--server", SERVER);
    expect(e.calls()).toContain(`systemctl --user restart ${UNIT}`);
    expect(r.status).toBe(1);
    expect(r.out).toContain("does not run the Omnigent build installed here");
    expect(existsSync(old)).toBe(true);
    e.unflag("stale-process");
    r = e.run("setup", "--server", SERVER);
    expect(r.status).toBe(0);
    expect(existsSync(old)).toBe(false);
  });

  it("restarts the service when its unit changes", () => {
    const e = current();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    writeFileSync(e.unitFile, "[Unit]\nDescription=edited\n");
    reset();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    expect(e.calls()).toContain(`systemctl --user restart ${UNIT}`);
    expect(readFileSync(e.unitFile, "utf8")).toContain("omnigent.host.service_entry");
  });

  it("exits 3 when the host does not come online", () => {
    const e = current();
    e.flag("offline");
    const { status, out } = e.run("setup", "--server", SERVER);
    expect(status).toBe(3);
    expect(out).toContain("does not list this machine's host as online yet");
  });

  it("refuses a service that runs anything but the build installed here", () => {
    const e = current();
    e.proc(["/usr/bin/python3", "-P", "-m", "omnigent.host.service_entry", "--server", SERVER]);
    e.flag("stale-process");
    const { status, out } = e.run("setup", "--server", SERVER);
    expect(status).toBe(1);
    expect(out).toContain("does not run the Omnigent build installed here");
    // The right interpreter with other arguments is not the unit's process either.
    e.unflag("stale-process");
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    e.proc([
      join(e.build(), "bin", "python"),
      "-P",
      "-m",
      "omnigent.host.service_entry",
      "--server",
      "https://other.example.test",
    ]);
    e.flag("stale-process");
    expect(e.run("setup", "--server", SERVER).status).toBe(1);
  });

  it("signs in again when the installation rejects the stored sign-in, and stops when it cannot ask (Codex r1-8)", () => {
    const e = current();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    // The password changed: the token is still unexpired locally, but the installation says no.
    e.flag("token", "rejected");
    reset();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    expect(e.calls().filter((c) => c.startsWith("omnigent login"))).toHaveLength(1);
    e.flag("token", "unknown 502");
    reset();
    const r = e.run("setup", "--server", SERVER);
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      "could not ask https://omnigent.example.test whether this machine's sign-in is good",
    );
    expect(e.calls().filter((c) => c.startsWith("omnigent login"))).toHaveLength(0);
  });

  it("names what to fix for the Cloudflare One Client", () => {
    const e = current();
    rmSync(join(e.bin, "warp-cli"));
    let r = e.run("setup", "--server", SERVER);
    expect(r.status).toBe(1);
    expect(r.out).toContain("cloudflare-warp-bin");

    const f = makeEnv();
    try {
      f.flag("warp-down");
      r = f.run("setup", "--server", SERVER);
      expect(r.out).toContain("sudo systemctl enable --now warp-svc");

      f.unflag("warp-down");
      f.flag("registered", "Free");
      r = f.run("setup", "--server", SERVER);
      expect(r.out).toContain("consumer WARP service");

      f.unflag("registered");
      f.flag("registration-pending");
      r = f.run("setup", "--server", SERVER);
      expect(r.status).toBe(1);
      expect(r.out).toContain("not registered with team yet");

      f.unflag("registration-pending");
      f.flag("registered", "Team");
      f.flag("never-connects");
      r = f.run("setup", "--server", SERVER);
      expect(r.out).toContain("does not connect");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("uses a team given with --team, and refuses when none can be found", () => {
    const e = current();
    expect(e.run("setup", "--server", SERVER, "--team", "my-team").status).toBe(0);
    expect(e.calls()).toContain("warp-cli registration new my-team");
    const r = e.run("setup", "--server", SERVER, "--team", "Not A Team");
    expect(r.status).toBe(0); // registered already: the team is not needed
    const f = makeEnv();
    try {
      const refused = f.run("setup", "--server", SERVER, "--team", "Not A Team");
      expect(refused.out).toContain("could not tell the installation's Zero Trust team");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("names what Access said when it does not let the machine through", () => {
    const e = current();
    const cases: [string, string][] = [
      ["login", "run bootstrap.ts devices"],
      ["lapsed", "has lapsed or was revoked"],
      ["refused", "signed in as someone other than the installation's owner"],
      ["down", "could not reach Omnigent"],
    ];
    for (const [access, message] of cases) {
      e.flag("access", access);
      const r = e.run("setup", "--server", SERVER);
      expect(r.status, access).toBe(1);
      expect(r.out, access).toContain(message);
      expect(existsSync(join(e.cfoHome, "venv")), access).toBe(false);
    }
  });

  it("stops on a fetched commit that is not the pin, a failed install and a failed sign-in", () => {
    const e = current();
    e.flag("git-head", "2".repeat(40));
    let r = e.run("setup", "--server", SERVER);
    expect(r.out).toContain(`is not commit ${COMMIT}`);
    expect(existsSync(join(e.cfoHome, "venv"))).toBe(false);
    e.unflag("git-head");
    rmSync(join(e.cfoHome, "src"), { recursive: true, force: true });
    e.flag("pip-fails");
    r = e.run("setup", "--server", SERVER);
    expect(r.out).toContain("installing Omnigent's locked dependencies failed");
    expect(existsSync(join(e.cfoHome, "venv"))).toBe(false);
    e.unflag("pip-fails");
    e.flag("login-fails");
    r = e.run("setup", "--server", SERVER);
    expect(r.status).toBe(1);
    expect(r.out).toContain("the sign-in did not finish");
    expect(e.calls()).not.toContain(`systemctl --user enable --now ${UNIT}`);
    e.unflag("login-fails");
    e.flag("enable-fails");
    r = e.run("setup", "--server", SERVER);
    expect(r.out).toContain(`systemctl --user enable --now ${UNIT} failed`);
  });

  it("never overwrites an omnigent-cfo it did not write", () => {
    const e = current();
    writeFileSync(e.wrapper, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    const r = e.run("setup", "--server", SERVER);
    expect(r.status).toBe(1);
    expect(r.out).toContain("was not written by this setup");
    expect(readFileSync(e.wrapper, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("refuses arguments out of form and missing tools", () => {
    const e = current();
    for (const args of [
      ["setup"],
      ["setup", "--server", "http://omnigent.example.test"],
      ["setup", "--server", `${SERVER}/omnigent`],
      ["setup", "--bogus"],
      ["frobnicate"],
      [],
    ]) {
      expect(e.run(...args).status, args.join(" ")).toBe(1);
    }
    rmSync(join(e.bin, "uv"));
    const r = e.run("setup", "--server", SERVER);
    expect(r.out).toContain("this machine lacks uv");
  });
});

describe("omnigent-host.sh status and remove", () => {
  it("shows each check without changing anything", () => {
    const e = current();
    expect(e.run("status").out).toContain("not set up yet");
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    reset();
    const { status, out } = e.run("status");
    expect(status).toBe(0);
    expect(out).toContain("Cloudflare One Client: installed: warp-cli 2026.9.1234.0");
    expect(out).toContain("registered; connected");
    expect(out).toContain(`Access to ${SERVER}: ok`);
    expect(out).toContain(`Omnigent build: ${e.build().split("/").at(-1)}, as pinned`);
    expect(out).toContain("command line sign-in: ok");
    expect(out).toContain("service: active, running the installed build");
    expect(out).toContain("host: online");
    const changing = ["registration new", "connect", "uv ", "git ", "login", "enable", "restart"];
    expect(e.calls().filter((c) => changing.some((w) => c.includes(w)))).toEqual([]);
    writeFileSync(join(e.cfoHome, "venv", "cfo-build"), `build=${"3".repeat(40)}-000000000000\n`);
    expect(e.run("status").out).toContain("run setup to update");
  });

  it("removes only what setup made, and asks first", () => {
    const e = current();
    expect(e.run("setup", "--server", SERVER).status).toBe(0);
    expect(e.run("remove").out).toContain("run it with --yes");
    expect(existsSync(e.unitFile)).toBe(true);
    reset();
    const { status, out } = e.run("remove", "--yes");
    expect(status).toBe(0);
    expect(out).toContain("warp-cli registration delete");
    expect(e.calls()).toContain(`systemctl --user disable --now ${UNIT}`);
    for (const path of [e.unitFile, e.wrapper, e.cfoHome, e.cfoConfig]) {
      expect(existsSync(path), path).toBe(false);
    }
    expect(existsSync(join(e.home, ".local", "bin", "omnigent"))).toBe(true);
    expect(existsSync(join(dirname(e.unitFile), "omnigent-host.service"))).toBe(true);
    expect(existsSync(join(e.home, ".omnigent"))).toBe(true);
    expect(e.run("remove", "--bogus").status).toBe(1);
  });

  it("is executable", () => {
    expect(spawnSync("test", ["-x", REAL_SCRIPT]).status).toBe(0);
  });
});
