import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { compare, diffPngs } from "../src/compare.mjs";
import { padRect } from "../src/clip.mjs";
import { hostEnv, loadConfig } from "../src/config.mjs";
import { lastChangeSeconds, loopEnd } from "../src/freeze.mjs";
import { capture, failureDetail, runStep, sceneUrl } from "../src/capture.mjs";
import { createHost } from "../src/hostcall.mjs";
import { PROFILES, selectScenes, variants } from "../src/profiles.mjs";
import * as provenance from "../src/provenance.mjs";

function config(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-"));
  const file = path.join(dir, "scenes.json");
  writeFileSync(file, JSON.stringify({ demo: { start: "make demo", url: "http://127.0.0.1:3985" }, scenes: [{ name: "home", path: "/" }], ...extra }));
  return file;
}

function png(width, height, fill) {
  const p = new PNG({ width, height });
  for (let i = 0; i < p.data.length; i += 4) p.data.set(fill, i);
  return p;
}

test("freeze: the last freeze_start without an end is the last change", () => {
  const log = "lavfi.freezedetect.freeze_start: 1.5\nlavfi.freezedetect.freeze_end: 2.0\nlavfi.freezedetect.freeze_start: 6.25\n";
  assert.equal(lastChangeSeconds(log), 6.25);
  assert.equal(lastChangeSeconds("lavfi.freezedetect.freeze_start: 1\nlavfi.freezedetect.freeze_end: 2\n"), null);
  assert.equal(lastChangeSeconds(""), null);
});

test("freeze: loopEnd never cuts at or before the start", () => {
  assert.deepEqual(loopEnd(null, 1, 1.5), []);
  assert.deepEqual(loopEnd(6.25, 1, 1.5), ["-to", "7.75"]);
  assert.deepEqual(loopEnd(0.2, 3, 1), []);
});

test("config: a valid file loads", () => {
  assert.equal(loadConfig(config()).scenes[0].name, "home");
});

test("config: a non-loopback demo url is refused", () => {
  assert.throws(() => loadConfig(config({ demo: { start: "x", url: "https://example.com" } })), /demo\/url/);
});

test("config: duplicate names, two actions in a step, target with clip are all reported", () => {
  const file = config({
    scenes: [
      { name: "a", path: "/", steps: [{ click: "x", hover: "y" }], target: "#t", clip: { x: 0, y: 0, width: 1, height: 1 } },
      { name: "a", path: "/b" },
    ],
  });
  assert.throws(
    () => loadConfig(file),
    (err) => /used twice/.test(err.message) && /exactly one of/.test(err.message) && /either target or clip/.test(err.message),
  );
});

test("config: fill needs a value, and value belongs to fill only", () => {
  assert.throws(() => loadConfig(config({ scenes: [{ name: "a", path: "/", steps: [{ fill: "#q" }] }] })), /fill needs a "value"/);
  assert.throws(() => loadConfig(config({ scenes: [{ name: "a", path: "/", steps: [{ click: "#q", value: "x" }] }] })), /belongs to fill only/);
});

test("config: an unparsable clock is refused", () => {
  assert.throws(() => loadConfig(config({ clock: "yesterday" })), /not a date-time/);
});

test("config: host env is shell-quoted", () => {
  const cfg = { demo: { start: "echo 'hi'; make demo", url: "http://127.0.0.1:1", env: { DEMO_NOW: "2026-10-01T09:00:00Z" } }, baseDeps: [".venv"] };
  const out = hostEnv(cfg);
  assert.match(out, /^DEMO_START='echo '\\''hi'\\''; make demo'$/m);
  assert.match(out, /^export DEMO_NOW='2026-10-01T09:00:00Z'$/m);
  assert.throws(() => hostEnv({ demo: { start: "x", url: "http://127.0.0.1:1", env: { "bad key": "1" } } }), /not a valid variable name/);
  assert.match(hostEnv({ ...cfg, cacheKeyFiles: ["requirements.txt", "frontend/package-lock.json"] }), /^CACHE_KEY_FILES='requirements.txt frontend\/package-lock.json'$/m);
  assert.match(hostEnv(cfg), /^CACHE_KEY_FILES=''$/m);
});

test("config: cacheKeyFiles are repo-relative paths without spaces", () => {
  assert.equal(loadConfig(config({ cacheKeyFiles: ["requirements.txt", "frontend/package-lock.json"] })).cacheKeyFiles.length, 2);
  for (const bad of ["/etc/passwd", "../x", "a/../../x", "has space.txt", "lock*.txt", "-lock.txt", "a?b", "a[b]"]) {
    assert.throws(() => loadConfig(config({ cacheKeyFiles: [bad] })), /cacheKeyFiles/, bad);
  }
});

test("config: baseHarness are repo-relative paths that cannot be the repo or its git data", () => {
  assert.equal(loadConfig(config({ baseHarness: ["scripts/demo", "visual/hooks.mjs"] })).baseHarness.length, 2);
  assert.match(hostEnv({ demo: { start: "x", url: "http://127.0.0.1:1" }, baseHarness: ["scripts/demo", "visual"] }), /^BASE_HARNESS='scripts\/demo visual'$/m);
  assert.match(hostEnv({ demo: { start: "x", url: "http://127.0.0.1:1" } }), /^BASE_HARNESS=''$/m);
  for (const bad of ["/etc", "../x", "a/../../x", "has space", "dir/*", "-x", ".", "./", "a/./b", ".git", ".git/hooks", "a//b"]) {
    assert.throws(() => loadConfig(config({ baseHarness: [bad] })), /baseHarness/, bad);
  }
});

test("profiles: the landing spec is the one personal-landing expects", () => {
  const landing = PROFILES.landing;
  assert.deepEqual(landing.schemes, ["dark"]);
  assert.deepEqual(landing.viewports.desktop, { width: 1600, height: 1000, scale: 2 });
  assert.deepEqual(landing.viewports.mobile, { width: 390, height: 844, scale: 3, mobile: true });
});

test("profiles: file names follow the contract", () => {
  const cfg = { scenes: [{ name: "triage", path: "/triage", tags: ["presentation"] }] };
  assert.deepEqual(variants(cfg, "landing", cfg.scenes[0]).map((v) => v.file), ["triage-desktop.png", "triage-mobile.png"]);
  assert.deepEqual(variants(cfg, "readme", cfg.scenes[0]).map((v) => v.file), ["triage-light-desktop.png", "triage-dark-desktop.png", "triage-light-mobile.png", "triage-dark-mobile.png"]);
  const check = { name: "x", path: "/" };
  assert.deepEqual(variants({ scenes: [check] }, "check", check).map((v) => v.file), ["x.desktop.dark.png", "x.desktop.light.png", "x.phone.dark.png", "x.phone.light.png"]);
});

test("profiles: a scene can narrow viewports and schemes", () => {
  const scene = { name: "x", path: "/", viewports: ["desktop"], schemes: ["dark"] };
  assert.deepEqual(variants({ scenes: [scene] }, "check", scene).map((v) => v.file), ["x.desktop.dark.png"]);
});

test("profiles: a scene's motion reaches its variants and defaults to reduce", () => {
  const plain = { name: "x", path: "/" };
  const normal = { ...plain, motion: "normal" };
  assert.ok(variants({ scenes: [plain] }, "check", plain).every((v) => v.motion === "reduce"));
  assert.ok(variants({ scenes: [normal] }, "check", normal).every((v) => v.motion === "normal"));
  assert.throws(() => loadConfig(config({ scenes: [{ ...plain, motion: "fast" }] })));
});

test("profiles: a loop-only scene (stills: false) renders no stills", () => {
  const scene = { name: "x", path: "/", tags: ["presentation"], stills: false, loop: {} };
  assert.deepEqual(variants({ scenes: [scene] }, "landing", scene), []);
  assert.deepEqual(variants({ scenes: [scene] }, "check", scene), []);
});

test("config: stills: false needs a loop and the presentation tag, and an empty viewports list points at it", () => {
  const loopOnly = { name: "a", path: "/", tags: ["presentation"], stills: false, loop: {} };
  assert.throws(() => loadConfig(config({ scenes: [{ ...loopOnly, loop: undefined }] })), /"stills": false leaves nothing to render/);
  assert.throws(() => loadConfig(config({ scenes: [{ ...loopOnly, tags: undefined }] })), /add the "presentation" tag/); // the default tags render it nowhere
  assert.throws(() => loadConfig(config({ scenes: [{ ...loopOnly, tags: ["check"] }] })), /add the "presentation" tag/);
  assert.throws(() => loadConfig(config({ scenes: [{ name: "a", path: "/", viewports: [], loop: {} }] })), /use "stills": false/);
  assert.throws(() => loadConfig(config({ scenes: [{ ...loopOnly, viewports: [] }] })), /drop it/);
  assert.equal(loadConfig(config({ scenes: [loopOnly] })).scenes[0].stills, false);
});

test("profiles: scenes default to check and audit, --routes narrows by name or path", () => {
  const cfg = { scenes: [{ name: "a", path: "/triage" }, { name: "b", path: "/cases/1" }, { name: "c", path: "/x", tags: ["presentation"] }] };
  assert.deepEqual(selectScenes(cfg, "check").map((s) => s.name), ["a", "b"]);
  assert.deepEqual(selectScenes(cfg, "landing").map((s) => s.name), ["c"]);
  assert.deepEqual(selectScenes(cfg, "check", ["/triage"]).map((s) => s.name), ["a"]);
  assert.deepEqual(selectScenes(cfg, "check", ["/cases"]).map((s) => s.name), ["b"]);
  assert.deepEqual(selectScenes(cfg, "check", ["b"]).map((s) => s.name), ["b"]);
});

test("clip: padRect pads, scrolls into document space and clamps", () => {
  const doc = { scrollX: 0, scrollY: 100, width: 1000, height: 800 };
  assert.deepEqual(padRect({ x: 10, y: 20, width: 100, height: 50 }, doc, 24), { x: 0, y: 96, width: 134, height: 98 });
  assert.deepEqual(padRect({ x: 900, y: 700, width: 100, height: 100 }, { scrollX: 0, scrollY: 0, width: 1000, height: 800 }, 24), { x: 876, y: 676, width: 124, height: 124 });
});

test("diff: identical shots differ by zero pixels, a changed pixel block is found", () => {
  const a = PNG.sync.write(png(40, 40, [10, 20, 30, 255]));
  assert.equal(diffPngs(a, a).pixels, 0);
  const b = png(40, 40, [10, 20, 30, 255]);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) b.data.set([255, 0, 0, 255], (y * 40 + x) * 4);
  const d = diffPngs(a, PNG.sync.write(b));
  assert.equal(d.pixels, 25);
  assert.ok(d.diff);
});

test("diff: different sizes are padded and flagged as resized", () => {
  const d = diffPngs(PNG.sync.write(png(40, 40, [1, 2, 3, 255])), PNG.sync.write(png(40, 60, [1, 2, 3, 255])));
  assert.equal(d.resized, true);
  assert.ok(d.pixels > 0);
});

test("compare: a route that starts answering with an error is called out, and a missing base page is new", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-cmp-"));
  const metrics = { base: {}, head: {} };
  const put = (side, file, status) => {
    const d = path.join(dir, side);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, file), PNG.sync.write(png(20, 20, [9, 9, 9, 255])));
    metrics[side][file] = { status, axe: [], console: [], overflow: false, unnamed: 0 };
    writeFileSync(path.join(d, "metrics.json"), JSON.stringify(metrics[side]));
  };
  put("base", "a.png", 200);
  put("head", "a.png", 500);
  put("base", "b.png", 404); // the page did not exist on the base
  put("head", "b.png", 200);
  const s = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "report") });
  const byFile = Object.fromEntries(s.entries.map((e) => [e.file, e]));
  assert.ok(byFile["a.png"].health.some((h) => /HTTP 500/.test(h)));
  assert.equal(byFile["b.png"].result, "new");
});

test("profiles: --routes tolerates a trailing slash and a query", () => {
  const cfg = { scenes: [{ name: "a", path: "/cases?tab=x" }, { name: "b", path: "/cases/1" }, { name: "c", path: "/casework" }] };
  assert.deepEqual(selectScenes(cfg, "check", ["/cases/"]).map((s) => s.name), ["a", "b"]);
  assert.deepEqual(selectScenes(cfg, "check", ["/cases"]).map((s) => s.name), ["a", "b"]);
});

test("profiles: the landing spec ignores viewport overrides, check does not", () => {
  const cfg = { viewports: { desktop: { width: 1000, height: 700 } }, scenes: [{ name: "x", path: "/" }] };
  assert.equal(variants(cfg, "landing", { name: "x", path: "/" })[0].viewport.width, 1600);
  assert.equal(variants(cfg, "check", { name: "x", path: "/" })[0].viewport.width, 1000);
});

test("capture: sceneUrl stays on a loopback demo", () => {
  assert.equal(sceneUrl("http://127.0.0.1:3985", "/triage?x=1"), "http://127.0.0.1:3985/triage?x=1");
  assert.throws(() => sceneUrl("http://127.0.0.1:3985", "//evil.com/x"), /leaves the demo/);
  assert.throws(() => sceneUrl("http://127.0.0.1:3985", "/\\evil.com/x"), /leaves the demo/);
  assert.throws(() => sceneUrl("https://example.com", "/"), /not a loopback/);
});

test("capture: without host networking the launcher's host alias replaces the loopback host", () => {
  process.env.VISUAL_KIT_HOST_ALIAS = "host.docker.internal";
  try {
    assert.equal(sceneUrl("http://127.0.0.1:3985", "/triage?x=1"), "http://host.docker.internal:3985/triage?x=1");
    assert.throws(() => sceneUrl("https://example.com", "/"), /not a loopback/);
    for (const bad of ["evil.com:80", "http://evil.com", "a/b", "evil.com#", "-x", "x."]) {
      process.env.VISUAL_KIT_HOST_ALIAS = bad;
      assert.throws(() => sceneUrl("http://127.0.0.1:3985", "/"), /not a bare hostname/, bad);
    }
  } finally {
    delete process.env.VISUAL_KIT_HOST_ALIAS;
  }
});

test("config: a scene path that would leave the demo is refused by the schema", () => {
  assert.throws(() => loadConfig(config({ scenes: [{ name: "a", path: "//evil.com/x" }] })), /path/);
});

test("compare: console text cannot break the markdown table", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-md-"));
  for (const side of ["base", "head"]) {
    mkdirSync(path.join(dir, side));
    writeFileSync(path.join(dir, side, "a.png"), PNG.sync.write(png(10, 10, [1, 1, 1, 255])));
  }
  writeFileSync(path.join(dir, "base", "metrics.json"), JSON.stringify({ "a.png": { status: 200, axe: [], console: [], overflow: false, unnamed: 0 } }));
  writeFileSync(path.join(dir, "head", "metrics.json"), JSON.stringify({ "a.png": { status: 200, axe: [], console: ["bad | pipe\nand newline"], overflow: false, unnamed: 0 } }));
  const s = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "r") });
  const md = readFileSync(path.join(dir, "r", "summary.md"), "utf8");
  assert.ok(md.includes("bad \\| pipe and newline"));
  assert.equal(s.entries[0].health.length, 1);
});

test("config: an unknown viewport name is refused (a typo must not make a scene render nothing)", () => {
  assert.throws(() => loadConfig(config({ scenes: [{ name: "a", path: "/", viewports: ["mobil"] }] })), /unknown viewport "mobil"/);
  assert.doesNotThrow(() => loadConfig(config({ viewports: { wide: { width: 2000, height: 1000 } }, scenes: [{ name: "a", path: "/", viewports: ["wide"] }] })));
});

test("compare: a new shot keeps its own findings, and a folder the tool did not write is not deleted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-new-"));
  mkdirSync(path.join(dir, "base"));
  mkdirSync(path.join(dir, "head"));
  writeFileSync(path.join(dir, "head", "b.png"), PNG.sync.write(png(10, 10, [1, 1, 1, 255])));
  writeFileSync(path.join(dir, "head", "metrics.json"), JSON.stringify({ "b.png": { status: 200, axe: [{ id: "color-contrast", impact: "serious", nodes: 3 }], console: ["boom"], overflow: true, unnamed: 2 } }));
  const s = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "report") });
  assert.equal(s.entries[0].result, "new");
  assert.ok(s.entries[0].health.length >= 3, "axe, console and overflow are reported for a new route");
  mkdirSync(path.join(dir, "mine"));
  writeFileSync(path.join(dir, "mine", "precious.txt"), "x");
  assert.throws(() => compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "mine") }), /not written by visual-kit/);
  assert.equal(readFileSync(path.join(dir, "mine", "precious.txt"), "utf8"), "x");
});

test("compare: controls past the viewport edge are called out when they increase", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-off-"));
  for (const side of ["base", "head"]) {
    mkdirSync(path.join(dir, side));
    writeFileSync(path.join(dir, side, "a.png"), PNG.sync.write(png(10, 10, [1, 1, 1, 255])));
  }
  const entry = (offscreen, sample) => ({ "a.png": { status: 200, axe: [], console: [], overflow: false, unnamed: 0, offscreen, offscreenSample: sample } });
  writeFileSync(path.join(dir, "base", "metrics.json"), JSON.stringify(entry(0, [])));
  writeFileSync(path.join(dir, "head", "metrics.json"), JSON.stringify(entry(2, ["select#proceeding", "button.save"])));
  const s = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "r") });
  assert.ok(s.entries[0].health.some((h) => /controls past the viewport edge: 0 → 2 \(select#proceeding, button\.save\)/.test(h)));
  // and the other way round: a fix is reported too
  const fixed = compare({ baseDir: path.join(dir, "head"), headDir: path.join(dir, "base"), outDir: path.join(dir, "r2") });
  assert.ok(fixed.entries[0].health.some((h) => /controls past the viewport edge fixed: 2 → 0 \(was select#proceeding, button\.save\)/.test(h)));
});

/** Plays the launcher's watcher: answers the next request in `dir` with `answer(requestLines)` -> [code, stdout]. */
function answerOnce(dir, answer) {
  const timer = setInterval(() => {
    const req = readdirSync(dir).find((f) => f.startsWith("req-") && !f.endsWith(".tmp"));
    if (!req) return;
    clearInterval(timer);
    const [code, out] = answer(readFileSync(path.join(dir, req), "utf8").split("\n").slice(0, -1));
    writeFileSync(path.join(dir, req.replace("req-", "res-")), `${code}\n${out}`);
    rmSync(path.join(dir, req));
  }, 10);
  return () => clearInterval(timer);
}

test("hostcall: a request carries the name and one argument per line, the answer is the stdout", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-host-"));
  let seen;
  answerOnce(dir, (lines) => ((seen = lines), [0, "done\nlines"]));
  assert.equal(await createHost({ dir })("release", "a b", 3), "done\nlines");
  assert.deepEqual(seen, ["release", "a b", "3"]);
  assert.deepEqual(readdirSync(dir), [], "request and response are cleaned up");
});

test("hostcall: a non-zero exit fails with the code and the output", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-host-"));
  answerOnce(dir, () => [3, "boom"]);
  await assert.rejects(createHost({ dir })("fail"), /failed \(exit 3\): boom/);
});

test("hostcall: no answer within the timeout fails and withdraws the request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-host-"));
  await assert.rejects(createHost({ dir, timeoutSec: 0.2 })("slow"), /no answer from the launcher within 0\.2s/);
  assert.deepEqual(readdirSync(dir), []);
});

test("hostcall: without a channel, a bad name or a multi-line argument it refuses before writing anything", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-host-"));
  await assert.rejects(createHost({ dir: "" })("x"), /no host-hook channel/);
  await assert.rejects(createHost({ dir })("Bad Name"), /lowercase letters/);
  await assert.rejects(createHost({ dir })("ok", "a\nb"), /line break/);
  assert.deepEqual(readdirSync(dir), []);
});

test("config: hostTimeoutSec is a bounded integer", () => {
  assert.equal(loadConfig(config({ hostTimeoutSec: 60 })).hostTimeoutSec, 60);
  assert.throws(() => loadConfig(config({ hostTimeoutSec: 0 })), /hostTimeoutSec/);
});

test("compare: a committed baseline stands in for the base, with its own metrics, and is never reported removed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-baseline-"));
  for (const side of ["base", "head", "baselines"]) mkdirSync(path.join(dir, side));
  const write = (side, file, fill) => writeFileSync(path.join(dir, side, file), PNG.sync.write(png(10, 10, fill)));
  const red = [200, 0, 0, 255];
  const blue = [0, 0, 200, 255];
  write("base", "flagged.png", red); // what the merge base rendered
  write("baselines", "flagged.png", blue); // what the team committed
  write("head", "flagged.png", blue);
  write("base", "plain.png", red);
  write("head", "plain.png", red);
  write("baselines", "gone.png", red); // a baseline whose scene was not rendered this time
  writeFileSync(path.join(dir, "base", "metrics.json"), JSON.stringify({ "flagged.png": { status: 200, overflow: true } }));
  writeFileSync(path.join(dir, "baselines", "metrics.json"), JSON.stringify({ "flagged.png": { status: 200, overflow: false } }));
  writeFileSync(path.join(dir, "head", "metrics.json"), JSON.stringify({ "flagged.png": { status: 200, overflow: false } }));
  const s = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), baselinesDir: path.join(dir, "baselines"), outDir: path.join(dir, "r") });
  const byFile = Object.fromEntries(s.entries.map((e) => [e.file, e]));
  assert.equal(byFile["flagged.png"].result, "same", "compared with the baseline, not the merge base");
  assert.equal(byFile["flagged.png"].baseline, true);
  assert.deepEqual(byFile["flagged.png"].health, [], "the baseline's metrics are the base (no overflow fixed)");
  assert.equal(byFile["plain.png"].baseline, undefined);
  assert.equal(byFile["gone.png"], undefined);
  assert.equal(s.removed, 0);
  // Without the baselines the same head differs from the merge base.
  const without = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "r2") });
  assert.equal(without.entries.find((e) => e.file === "flagged.png").result, "changed");
});

test("compare: a baselines folder that does not exist is an error, not an empty overlay", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-baseline-missing-"));
  for (const side of ["base", "head"]) mkdirSync(path.join(dir, side));
  assert.throws(() => compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), baselinesDir: path.join(dir, "nope"), outDir: path.join(dir, "r") }), /does not exist/);
});

test("compare: a changed shot against its baseline says so in the report", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-baseline-md-"));
  for (const side of ["base", "head", "baselines"]) mkdirSync(path.join(dir, side));
  const write = (side, fill) => writeFileSync(path.join(dir, side, "a.png"), PNG.sync.write(png(10, 10, fill)));
  write("base", [1, 1, 1, 255]);
  write("baselines", [1, 1, 1, 255]);
  write("head", [250, 250, 250, 255]);
  compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), baselinesDir: path.join(dir, "baselines"), outDir: path.join(dir, "r") });
  assert.match(readFileSync(path.join(dir, "r", "summary.md"), "utf8"), /against the committed baseline/);
  assert.match(readFileSync(path.join(dir, "r", "index.html"), "utf8"), /· baseline/);
});

test("config: a baseline scene needs the check tag", () => {
  assert.equal(loadConfig(config({ scenes: [{ name: "a", path: "/", baseline: true }] })).scenes[0].baseline, true);
  assert.throws(() => loadConfig(config({ scenes: [{ name: "a", path: "/", baseline: true, tags: ["presentation"] }] })), /add the "check" tag/);
  assert.throws(() => loadConfig(config({ scenes: [{ name: "a", path: "/", baseline: true, tags: ["check", "presentation"], stills: false, loop: {} }] })), /needs stills/);
});

test("provenance: staleness names what changed, and a runner patch release is not stale", () => {
  const now = { runner: "0.2.1", playwright: "1.64.1", viewports: "aaaa" };
  assert.deepEqual(provenance.staleness({ runner: "0.2.0", playwright: "1.64.1", viewports: "aaaa" }, now), []);
  assert.match(provenance.staleness({ runner: "0.2.0", playwright: "1.63.0", viewports: "aaaa" }, now).join(), /Playwright 1\.63\.0 → 1\.64\.1/);
  assert.match(provenance.staleness({ runner: "0.2.0", playwright: "1.64.1", viewports: "bbbb" }, now).join(), /viewport table/);
  assert.match(provenance.staleness({ runner: "0.1.9", playwright: "1.64.1", viewports: "aaaa" }, now).join(), /visual-kit 0\.1\.9 → 0\.2\.1/);
  assert.match(provenance.staleness(null, now).join(), /no provenance\.json/);
  // Without a config there is no viewport hash to compare: that part is skipped.
  assert.deepEqual(provenance.staleness({ runner: "0.2.0", playwright: "1.64.1", viewports: "bbbb" }, { runner: "0.2.0", playwright: "1.64.1" }), []);
});

test("provenance: the viewport hash follows the effective check table, not key order", () => {
  const base = loadConfig(config());
  const wider = loadConfig(config({ viewports: { desktop: { width: 1600, height: 900, scale: 1 } } }));
  assert.notEqual(provenance.current(base).viewports, provenance.current(wider).viewports);
  assert.equal(provenance.current(base).viewports, provenance.current(loadConfig(config())).viewports);
});

test("compare: stale baselines are a notice in the report, never a verdict", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-stale-"));
  for (const side of ["base", "head", "baselines"]) mkdirSync(path.join(dir, side));
  for (const side of ["base", "head", "baselines"]) writeFileSync(path.join(dir, side, "a.png"), PNG.sync.write(png(10, 10, [1, 1, 1, 255])));
  const cfg = loadConfig(config());
  const run = (out) => compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), baselinesDir: path.join(dir, "baselines"), outDir: path.join(dir, out), cfg });
  // Matching provenance: no notice.
  writeFileSync(path.join(dir, "baselines", "provenance.json"), JSON.stringify(provenance.current(cfg)));
  const fresh = run("fresh");
  assert.deepEqual(fresh.baselines, { stale: false, reasons: [], unchecked: [] });
  assert.doesNotMatch(readFileSync(path.join(dir, "fresh", "summary.md"), "utf8"), /stale/);
  // Another browser build: notice in all three outputs, same verdicts.
  writeFileSync(path.join(dir, "baselines", "provenance.json"), JSON.stringify({ ...provenance.current(cfg), playwright: "0.0.1" }));
  const stale = run("stale");
  assert.equal(stale.baselines.stale, true);
  assert.match(readFileSync(path.join(dir, "stale", "summary.md"), "utf8"), /baselines look stale:\*\* Playwright 0\.0\.1/);
  assert.match(readFileSync(path.join(dir, "stale", "index.html"), "utf8"), /baselines look stale/);
  assert.deepEqual([stale.changed, stale.new, stale.removed, stale.same], [fresh.changed, fresh.new, fresh.removed, fresh.same]);
  // No baselines at all: no `baselines` key.
  const none = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "none") });
  assert.equal(none.baselines, undefined);
});

test("compare: without a config the viewport table is reported unchecked, and an empty baselines folder is never stale", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-unchecked-"));
  for (const side of ["base", "head", "baselines", "empty"]) mkdirSync(path.join(dir, side));
  for (const side of ["base", "head", "baselines"]) writeFileSync(path.join(dir, side, "a.png"), PNG.sync.write(png(10, 10, [1, 1, 1, 255])));
  writeFileSync(path.join(dir, "baselines", "provenance.json"), JSON.stringify(provenance.current(loadConfig(config()))));
  const noConfig = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), baselinesDir: path.join(dir, "baselines"), outDir: path.join(dir, "r1") });
  assert.deepEqual(noConfig.baselines, { stale: false, reasons: [], unchecked: ["viewports"] });
  assert.match(readFileSync(path.join(dir, "r1", "summary.md"), "utf8"), /viewports were not checked/);
  assert.match(readFileSync(path.join(dir, "r1", "index.html"), "utf8"), /viewports were not checked/);
  const empty = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), baselinesDir: path.join(dir, "empty"), outDir: path.join(dir, "r2") });
  assert.deepEqual(empty.baselines, { stale: false, reasons: [], unchecked: [] });
});

test("capture --baseline-only is refused off the check profile", async () => {
  await assert.rejects(capture({ cfg: loadConfig(config()), profile: "audit", baseUrl: "http://127.0.0.1:1", outDir: path.join(mkdtempSync(path.join(tmpdir(), "vk-never-")), "out"), onlyBaseline: true, log() {} }), /--baseline-only is for the check profile/);
});

test("compare CLI: a --config that does not exist is an error, not a silent skip of the viewport check", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-cli-config-"));
  for (const side of ["base", "head", "baselines"]) mkdirSync(path.join(dir, side));
  const args = [path.join(import.meta.dirname, "..", "bin", "visual-kit.mjs"), "compare", "--base", path.join(dir, "base"), "--head", path.join(dir, "head"), "--baselines", path.join(dir, "baselines"), "--out", path.join(dir, "r")];
  const missing = spawnSync("node", [...args, "--config", path.join(dir, "nope.json")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /nope\.json/);
  assert.equal(spawnSync("node", args, { encoding: "utf8" }).status, 0, "without --config the check simply skips the viewport table");
});

test("compare CLI: --fail-on-unstable exits 4 and names each shot that differs between two captures of one tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-unstable-"));
  for (const side of ["first", "second"]) mkdirSync(path.join(dir, side));
  const shot = (side, name, color, w = 10) => writeFileSync(path.join(dir, side, name), PNG.sync.write(png(w, 10, color)));
  const cli = (extra = []) => spawnSync("node", [path.join(import.meta.dirname, "..", "bin", "visual-kit.mjs"), "compare", "--base", path.join(dir, "first"), "--head", path.join(dir, "second"), "--out", path.join(dir, "r"), "--fail-on-unstable", ...extra], { encoding: "utf8" });
  shot("first", "a.png", [1, 1, 1, 255]);
  shot("second", "a.png", [1, 1, 1, 255]);
  assert.equal(cli().status, 0, "identical captures repeat");
  shot("second", "a.png", [250, 250, 250, 255]);
  shot("first", "gone.png", [1, 1, 1, 255]);
  shot("second", "extra.png", [1, 1, 1, 255]);
  const res = cli();
  assert.equal(res.status, 4);
  assert.match(res.stderr, /3 shot\(s\) differ/);
  assert.match(res.stderr, /a\.png: 100 px differ between base and head \(tolerance 20 px at threshold 0\.1\)/);
  assert.match(res.stderr, /gone\.png: only in base \(the first capture\)\n/);
  assert.match(res.stderr, /extra\.png: only in head \(the second capture\), or base answered/);
  assert.equal(cli(["--max-diff-pixels", "100"]).status, 4, "a removed and a new shot still fail");
  const both = cli(["--fail-on-diff"]);
  assert.equal(both.status, 4, "the most specific gate wins");
  assert.match(both.stderr, /determinism failure/);
});

test("compare: the health verdict counts new console errors and serious axe nodes, never pixels or fixes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-gate-"));
  const m = (over) => ({ status: 200, axe: [], console: [], overflow: false, unnamed: 0, ...over });
  const shot = (side, color) => writeFileSync(path.join(dir, side, "a.png"), PNG.sync.write(png(10, 10, color)));
  const run = (base, head, name) => {
    writeFileSync(path.join(dir, "base", "metrics.json"), JSON.stringify({ "a.png": base }));
    writeFileSync(path.join(dir, "head", "metrics.json"), JSON.stringify({ "a.png": head }));
    return compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, name) });
  };
  for (const side of ["base", "head"]) mkdirSync(path.join(dir, side));
  shot("base", [1, 1, 1, 255]);
  shot("head", [250, 250, 250, 255]);
  const pixelsOnly = run(m(), m(), "r1");
  assert.equal(pixelsOnly.changed, 1);
  assert.deepEqual(pixelsOnly.health, { ok: true, console: 0, axe: 0, entries: [] });
  const consoleErr = run(m(), m({ console: ["403 forbidden"] }), "r2");
  assert.equal(consoleErr.health.ok, false);
  assert.equal(consoleErr.health.console, 1);
  assert.match(readFileSync(path.join(dir, "r2", "summary.md"), "utf8"), /Health gate: 1 shot/);
  const axe = (impact, nodes) => m({ axe: [{ id: "color-contrast", impact, nodes }] });
  assert.equal(run(axe("serious", 1), axe("serious", 3), "r3").health.axe, 1);
  assert.equal(run(m(), axe("critical", 1), "r4").health.axe, 1);
  assert.equal(run(m(), axe("moderate", 5), "r5").health.ok, true, "moderate is not gated");
  assert.equal(run(axe("serious", 2), axe("serious", 2), "r6").health.ok, true, "unchanged is not new");
  assert.equal(run(axe("serious", 2), m(), "r7").health.ok, true, "a fixed rule never trips it");
  assert.equal(run(m({ console: ["old"] }), m({ console: ["old"] }), "r8").health.ok, true);
});

test("compare: maxDiffPixels / threshold come from the scene, then the top level, then the default; flags win", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vk-tol-"));
  for (const side of ["base", "head"]) mkdirSync(path.join(dir, side));
  const cfg = { demo: { start: "x", url: "http://127.0.0.1:1" }, maxDiffPixels: 30, scenes: [{ name: "loose", path: "/", viewports: ["desktop"], schemes: ["light"], maxDiffPixels: 60 }, { name: "top", path: "/", viewports: ["desktop"], schemes: ["light"] }] };
  const files = Object.fromEntries(cfg.scenes.map((s) => [s.name, variants(cfg, "check", s)[0].file]));
  // A 10×10 shot whose first `n` pixels differ clearly.
  const shot = (n) => {
    const p = png(10, 10, [0, 0, 0, 255]);
    for (let i = 0; i < n; i++) p.data.set([255, 255, 255, 255], i * 4);
    return PNG.sync.write(p);
  };
  const put = (side, file, n) => writeFileSync(path.join(dir, side, file), shot(n));
  const run = (extra = {}) => compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "r"), cfg, ...extra });
  const result = (s, name) => s.entries.find((e) => e.file === files[name]);
  for (const name of ["loose", "top"]) put("base", files[name], 0);
  put("head", files.loose, 40);
  put("head", files.top, 40);
  let s = run();
  assert.equal(result(s, "loose").result, "same", "40 px is within the scene's 60");
  assert.deepEqual(result(s, "loose").tolerance, { maxDiffPixels: 60, threshold: 0.1 });
  assert.equal(result(s, "top").result, "changed", "40 px is over the top level's 30");
  put("head", files.loose, 70);
  s = run();
  assert.equal(result(s, "loose").result, "changed");
  assert.match(readFileSync(path.join(dir, "r", "summary.md"), "utf8"), /tolerance: 60 px/);
  assert.equal(run({ maxDiffPixels: 100 }).changed, 0, "the flag wins over both");
  // No keys, no cfg: the default of 20 and no tolerance note.
  const plain = compare({ baseDir: path.join(dir, "base"), headDir: path.join(dir, "head"), outDir: path.join(dir, "r2") });
  assert.equal(plain.changed, 2);
  assert.equal(plain.entries[0].tolerance, undefined);
});

test("validate: maxDiffPixels must be a non-negative integer, threshold a number from 0 to 1", () => {
  const ok = loadConfig(config({ maxDiffPixels: 0, threshold: 0.3, scenes: [{ name: "a", path: "/", maxDiffPixels: 60, threshold: 1 }] }));
  assert.equal(ok.scenes[0].maxDiffPixels, 60);
  for (const bad of [{ maxDiffPixels: -1 }, { maxDiffPixels: 1.5 }, { maxDiffPixels: "20" }, { threshold: 2 }, { threshold: -0.1 }]) {
    assert.throws(() => loadConfig(config(bad)), /maxDiffPixels|threshold/, JSON.stringify(bad));
    assert.throws(() => loadConfig(config({ scenes: [{ name: "a", path: "/", ...bad }] })), /maxDiffPixels|threshold/, JSON.stringify(bad));
  }
});

test("capture: a failing step names its action and selector, and the Playwright call log is kept", async () => {
  const timeout = Object.assign(new Error('page.click: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator(\'text="x"\')\n  - element is not visible'));
  const page = { click: async () => { throw timeout; } };
  await assert.rejects(runStep(page, { click: 'text="x"' }), (err) => {
    assert.match(err.message.split("\n")[0], /^step click "text=\\"x\\"": page\.click: Timeout 15000ms exceeded\.$/);
    assert.deepEqual(failureDetail(err), ["Call log:", `- waiting for locator('text="x"')`, "- element is not visible"].map((l) => (l.startsWith("-") ? `  ${l}` : l)));
    return true;
  });
  assert.deepEqual(failureDetail(new Error("one line")), []);
});
