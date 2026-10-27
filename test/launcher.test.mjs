// The host launcher's guards, against a stub `docker`: no container, no browser, so it runs on any host (macOS CI too).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const RUN = path.resolve("host/run.sh");
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "vk-launcher-")));

const STUB = readFileSync(path.resolve("test/stub-docker.sh"), "utf8");

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

const dockerCalls = (r) => log(r).split("\n").filter((l) => l.startsWith("run ") && l.includes(" capture ")).join("\n");

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

describe("launcher cache key errors", { timeout: 60_000 }, () => {
  test("a listed file that cannot be read stops the run instead of counting as absent", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    const r = repo("cache-key-unreadable");
    writeFileSync(path.join(r.dir, "lock.txt"), "one\n", { mode: 0o000 });
    const res = run(r, ["check", "--base", "main"], { env: { XDG_CACHE_HOME: path.join(r.dir, "cache"), STUB_KEY_FILES: "lock.txt" } });
    assert.notEqual(res.status, 0);
    assert.match(res.out, /cannot hash lock\.txt/);
  });
});

describe("launcher host hooks", { timeout: 60_000 }, () => {
  const withHooks = (name, script) => {
    const r = repo(name);
    writeFileSync(path.join(r.dir, "visual/host-hooks.sh"), script);
    return r;
  };
  const answer = (r) => readFileSync(`${r.log}.res`, "utf8");
  const SCRIPT = `case "$1" in
  echo) shift 2; printf '%s|' "$@" ;;
  where) echo "$PWD $2" ;;
  fail) echo "boom"; exit 3 ;;
  big) head -c 70000 /dev/zero | tr '\\0' x; : >"$2/finished" ;;
  hang) echo $$ >"$2/hook.pid"; exec sleep 30 ;;
  huge) head -c 41943040 /dev/zero | tr '\\0' x; du -sk "$TMPDIR" >"$2/du"; : >"$2/finished" ;;
  linger) printf 'partial'; ( exec sleep 5 ) & ;;
  stubborn) trap '' TERM; echo $$ >"$2/hook.pid"; while :; do sleep 1; done ;;
esac
`;

  test("a request is answered by visual/host-hooks.sh: name, demo dir, arguments, stdout, exit code", () => {
    const r = withHooks("hook-ok", SCRIPT);
    run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "echo\na b\n3\n" } });
    assert.equal(answer(r), "0\na b|3|");
    assert.match(dockerCalls(r), /-v \S+:\/hostcall .*-e VISUAL_KIT_HOSTCALL=\/hostcall/);
    run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "where\n" } });
    assert.equal(answer(r), `0\n${r.dir} ${r.dir}\n`, "run from, and told, the demo's directory (the checkout for a landing run)");
    run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "fail\n" } });
    assert.equal(answer(r), "3\nboom\n");
  });

  test("stdout is cut at 64 KiB without interrupting the script", () => {
    const r = withHooks("hook-big", SCRIPT);
    run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "big\n" } });
    const [code, body] = [answer(r).slice(0, 2), answer(r).slice(2)];
    assert.equal(code, "0\n");
    assert.equal(body, "x".repeat(65536));
    assert.ok(existsSync(path.join(r.dir, "finished")), "the script ran to the end");
  });

  test("a hook still running when the launcher ends is stopped", () => {
    const r = withHooks("hook-hang", SCRIPT);
    run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "hang\n", STUB_HOSTCALL_WAIT: "15", STUB_KEEP_REQUEST: "1" } });
    const pid = Number(readFileSync(path.join(r.dir, "hook.pid"), "utf8"));
    assert.ok(pid > 1);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the hook and its sleep are gone");
  });

  test("output past 64 KiB is never stored, and the hook still runs to the end", () => {
    const r = withHooks("hook-huge", SCRIPT);
    const tmpdirForRun = path.join(r.dir, "tmp");
    mkdirSync(tmpdirForRun);
    run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "huge\n", TMPDIR: tmpdirForRun } });
    assert.equal(answer(r), `0\n${"x".repeat(65536)}`);
    assert.ok(existsSync(path.join(r.dir, "finished")), "the hook wrote all 40 MB and ran to the end");
    const usedKiB = Number(readFileSync(path.join(r.dir, "du"), "utf8").split(/\s/)[0]);
    assert.ok(usedKiB < 1024, `the temp dir held ${usedKiB} KiB right after the hook wrote 40 MB`);
  });

  // The runner withdraws req-<n> when hostTimeoutSec passes; the stub does the same, then keeps the capture alive.
  test("a request the runner gave up on is stopped while the capture is still running", () => {
    const r = withHooks("hook-abandoned", SCRIPT);
    const res = run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "hang\n", STUB_HOSTCALL_WAIT: "10", STUB_LINGER: "4", STUB_PIDFILE: path.join(r.dir, "hook.pid") } });
    assert.equal(readFileSync(`${r.log}.alive`, "utf8").trim(), "gone", "stopped within the linger, not at the end of the capture");
    assert.match(res.out, /host hook 'hang' stopped: the capture gave up on it/);
    assert.equal(existsSync(`${r.log}.res`), false, "nobody reads an answer to an abandoned request");
  });

  test("output is kept when the hook leaves a process holding its stdout, and the next request is still served", () => {
    const r = withHooks("hook-linger", SCRIPT);
    run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "linger\n", STUB_HOSTCALL2: "echo\nx\n" } });
    assert.equal(answer(r), "0\npartial");
    assert.equal(readFileSync(`${r.log}.res2`, "utf8"), "0\nx|");
  });

  test("an abandoned hook that ignores TERM is killed after the grace period", () => {
    const r = withHooks("hook-stubborn", SCRIPT);
    run(r, ["landing", "--out", "out"], { env: { STUB_HOSTCALL: "stubborn\n", STUB_HOSTCALL_WAIT: "10", STUB_LINGER: "6", STUB_PIDFILE: path.join(r.dir, "hook.pid") } });
    assert.equal(readFileSync(`${r.log}.alive`, "utf8").trim(), "gone");
  });

  test("a repo without the script gets no mount and no channel", () => {
    const r = repo("hook-none");
    run(r, ["landing", "--out", "out"]);
    assert.doesNotMatch(dockerCalls(r), /hostcall/);
  });

  test("the script's content is part of the base's cache key", () => {
    const r = withHooks("hook-key", SCRIPT);
    const env = { XDG_CACHE_HOME: path.join(r.dir, "cache") };
    const cacheFor = () => {
      writeFileSync(r.log, "");
      run(r, ["check", "--base", "main"], { env });
      return log(r).match(/-v (\S+\/cache\/visual-kit\/\S+):\/out/)?.[1];
    };
    const first = cacheFor();
    assert.ok(first, log(r));
    writeFileSync(path.join(r.dir, "visual/host-hooks.sh"), `${SCRIPT}# changed\n`);
    assert.notEqual(cacheFor(), first);
  });
});

describe("launcher baselines", { timeout: 60_000 }, () => {
  test("baseline regenerates the flagged scenes into visual/baselines, and refuses --routes", () => {
    const r = repo("baseline-mode");
    const narrowed = run(r, ["baseline", "--routes", "triage"]);
    assert.notEqual(narrowed.status, 0);
    assert.match(narrowed.out, /would drop the others/);
    run(r, ["baseline"]);
    const calls = dockerCalls(r);
    assert.match(calls, /-v \S+\/visual:\/out/, "the baselines folder is the output");
    assert.match(calls, /capture check .*--out \/out\/baselines .*--baseline-only/);
    assert.ok(existsSync(path.join(r.dir, "visual/baselines/.visual-kit")), "claimed like any output folder");
  });

  test("baseline will not write into a baselines folder it did not create", () => {
    const r = repo("baseline-claim");
    mkdirSync(path.join(r.dir, "visual/baselines"));
    writeFileSync(path.join(r.dir, "visual/baselines/precious.png"), "x");
    assert.match(run(r, ["baseline"]).out, /not written by visual-kit/);
  });

  test("a check compares against visual/baselines only when it exists", () => {
    const r = repo("baseline-check");
    const compareCall = () => log(r).split("\n").find((l) => l.includes(" compare ")) ?? "";
    run(r, ["check", "--base", "main"], { env: { XDG_CACHE_HOME: path.join(r.dir, "cache") } });
    assert.doesNotMatch(compareCall(), /--baselines/);
    mkdirSync(path.join(r.dir, "visual/baselines"));
    writeFileSync(r.log, "");
    run(r, ["check", "--base", "main"], { env: { XDG_CACHE_HOME: path.join(r.dir, "cache") } });
    assert.match(compareCall(), /--baselines \/work\/visual\/baselines --config visual\/scenes\.json/);
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
