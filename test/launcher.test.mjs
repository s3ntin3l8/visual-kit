// The host launcher's guards, against a stub `docker`: no container, no browser, so it runs on any host (macOS CI too).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const RUN = path.resolve("host/run.sh");
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "vk-launcher-")));

// The stub answers `env` with a demo that is only an echo and a sleep, and logs every call, one line each.
const STUB = `#!/bin/bash
echo "$*" >>"$STUB_LOG"
case " $* " in
  *" env --config "*) printf "DEMO_START='echo DEMO_READY; exec sleep 60'\\nDEMO_URL='http://127.0.0.1:1'\\nDEMO_READY='DEMO_READY'\\nDEMO_TIMEOUT='5'\\nBASE_DEPS=''\\nCACHE_KEY_FILES='%s'\\n" "$STUB_KEY_FILES" ;;
  "image inspect"*) echo sha256:stubimage ;;
esac
`;

function repo(name) {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, "visual"), { recursive: true });
  writeFileSync(path.join(dir, "visual/scenes.json"), "{}\n");
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "docker"), STUB);
  chmodSync(path.join(bin, "docker"), 0o755);
  return { dir, bin, log: path.join(dir, "docker.log") };
}

/** Runs the launcher in `r`; `shims` are extra executables (name -> script) placed ahead of the real tools. */
function run(r, args, { env = {}, shims = {} } = {}) {
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(path.join(r.bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(r.bin, name), 0o755);
  }
  const res = spawnSync("bash", [RUN, ...args], {
    cwd: r.dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${r.bin}:${process.env.PATH}`, VISUAL_KIT_IMAGE: "stub", STUB_LOG: r.log, ...env },
  });
  return { ...res, out: `${res.stdout}${res.stderr}` };
}

const log = (r) => {
  try {
    return readFileSync(r.log, "utf8");
  } catch {
    return "";
  }
};

// A demo that outlives its run must fail the test, not stall the job.
describe("launcher guards", { timeout: 60_000 }, () => {
  test("an unknown mode prints the usage", () => {
    const res = run(repo("usage"), ["bogus"]);
    assert.notEqual(res.status, 0);
    assert.match(res.out, /usage: run\.sh/);
  });

  test("--out is refused when it is / , the repository, a parent of it or inside .git", () => {
    const r = repo("out-guards");
    for (const out of ["/", ".", "..", "a/../..", ".git/x"]) {
      const res = run(r, ["landing", "--out", out]);
      assert.notEqual(res.status, 0, out);
      assert.match(res.out, /refusing --out/, out);
    }
  });

  test("an audit slug must look like YYYY-MM-scope-topic", () => {
    const r = repo("slug");
    for (const slug of ["", "2026-10", "2026-1-x", "2026-10-Bad", "../x"]) {
      const res = run(r, ["audit", ...(slug ? ["--slug", slug] : [])]);
      assert.notEqual(res.status, 0, slug);
      assert.match(res.out, /audit needs --slug|slug must look like/, slug);
    }
  });

  test("a check never writes into a folder it did not create, unless --force", () => {
    const r = repo("claim");
    mkdirSync(path.join(r.dir, "mine"));
    writeFileSync(path.join(r.dir, "mine/precious.txt"), "x");
    const refused = run(r, ["check", "--out", "mine", "--base", "nope"]);
    assert.match(refused.out, /not written by visual-kit/);
    const forced = run(r, ["check", "--out", "mine", "--base", "nope", "--force"]);
    assert.doesNotMatch(forced.out, /not written by visual-kit/);
    assert.match(forced.out, /no merge base with nope/);
  });
});

describe("launcher portability", { timeout: 60_000 }, () => {
  // BSD realpath has no -m and macOS has no sha256sum: the shims make the Linux tools behave that way.
  // Each shim leaves a marker, so a test can tell the fallback ran rather than the GNU tool.
  const bsd = (r) => ({ realpath: `echo realpath >>"${r.dir}/shim.log"; exit 1`, sha256sum: `echo sha256sum >>"${r.dir}/shim.log"; exit 127` });
  const shimLog = (r) => readFileSync(path.join(r.dir, "shim.log"), "utf8");

  test("the guards still hold without GNU realpath -m, and the fallback is what ran", () => {
    const r = repo("bsd-guards");
    for (const out of ["/", "a/../..", ".git/x"]) {
      assert.match(run(r, ["landing", "--out", out], { shims: bsd(r) }).out, /refusing --out/, out);
    }
    assert.match(shimLog(r), /realpath/);
  });

  test("an --out that is a symlink to the repository (or into .git) is refused without GNU realpath", () => {
    const r = repo("bsd-symlink");
    symlinkSync(r.dir, path.join(tmp, "link-to-repo"));
    symlinkSync(path.join(r.dir, ".git"), path.join(r.dir, "link-to-git"));
    mkdirSync(path.join(r.dir, "real-out"));
    symlinkSync(path.join(r.dir, "real-out"), path.join(r.dir, "link-to-out"));
    for (const out of [path.join(tmp, "link-to-repo"), path.join(tmp, "link-to-repo/visual/.."), "link-to-git/x"]) {
      assert.match(run(r, ["landing", "--out", out], { shims: bsd(r) }).out, /refusing --out/, out);
    }
    // A symlink to an ordinary folder is fine, and not-yet-existing leaves under it too.
    assert.doesNotMatch(run(r, ["landing", "--out", "link-to-out/new/leaf"], { shims: bsd(r) }).out, /refusing --out/);
  });

  test("the cache key is the same with shasum as with sha256sum", () => {
    const r = repo("key");
    const env = { XDG_CACHE_HOME: path.join(r.dir, "cache") };
    // The base capture mounts its cache folder (<root>/<key>) at /out; the stub demo needs no app, so the run reaches it.
    const cacheMount = () => log(r).match(/-v (\S+\/cache\/visual-kit\/\S+):\/out/)?.[1];
    run(r, ["check", "--base", "main"], { env });
    const gnu = cacheMount();
    assert.ok(gnu, log(r));
    writeFileSync(r.log, "");
    run(r, ["check", "--base", "main"], { env, shims: bsd(r) });
    assert.match(shimLog(r), /sha256sum/);
    assert.equal(cacheMount(), gnu);
  });
});

describe("launcher cache key", { timeout: 60_000 }, () => {
  test("a listed file invalidates the cached base, an unlisted one does not", () => {
    const r = repo("cache-key-files");
    writeFileSync(path.join(r.dir, "lock.txt"), "one\n");
    writeFileSync(path.join(r.dir, "other.txt"), "one\n");
    const env = { XDG_CACHE_HOME: path.join(r.dir, "cache"), STUB_KEY_FILES: "lock.txt missing.txt" };
    const cacheFor = () => {
      writeFileSync(r.log, "");
      run(r, ["check", "--base", "main"], { env });
      return log(r).match(/-v (\S+\/cache\/visual-kit\/\S+):\/out/)?.[1];
    };
    const first = cacheFor();
    assert.ok(first, log(r));
    assert.equal(cacheFor(), first, "nothing changed: same key");
    writeFileSync(path.join(r.dir, "other.txt"), "two\n");
    assert.equal(cacheFor(), first, "an unlisted file does not matter");
    writeFileSync(path.join(r.dir, "lock.txt"), "two\n");
    const changed = cacheFor();
    assert.notEqual(changed, first, "a listed file changed: a new base");
    writeFileSync(path.join(r.dir, "missing.txt"), "now here\n");
    assert.notEqual(cacheFor(), changed, "a listed file that appears counts too");
  });
});

describe("launcher networking", { timeout: 60_000 }, () => {
  const dockerRun = (r) => log(r).split("\n").filter((l) => l.startsWith("run ")).join("\n");

  test("Linux uses host networking; bridge adds the host alias instead", () => {
    const host = repo("net-host");
    run(host, ["landing", "--out", "out"], { env: { VISUAL_KIT_HOST_NETWORK: "host" } });
    assert.match(dockerRun(host), /--network host/);
    const bridge = repo("net-bridge");
    run(bridge, ["landing", "--out", "out"], { env: { VISUAL_KIT_HOST_NETWORK: "bridge" } });
    assert.doesNotMatch(dockerRun(bridge), /--network host/);
    assert.match(dockerRun(bridge), /--add-host host\.docker\.internal:host-gateway/);
    assert.match(dockerRun(bridge), /VISUAL_KIT_HOST_ALIAS=host\.docker\.internal/);
  });

  test("bridge networking on Linux warns that the demo must listen beyond loopback", { skip: process.platform !== "linux" }, () => {
    const res = run(repo("net-warn"), ["landing", "--out", "out"], { env: { VISUAL_KIT_HOST_NETWORK: "bridge" } });
    assert.match(res.out, /bridge networking on Linux/);
  });

  test("an unknown network mode is refused", () => {
    const res = run(repo("net-bad"), ["landing", "--out", "out"], { env: { VISUAL_KIT_HOST_NETWORK: "overlay" } });
    assert.notEqual(res.status, 0);
    assert.match(res.out, /must be host or bridge/);
  });
});
