import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { compare, diffPngs } from "../src/compare.mjs";
import { padRect } from "../src/clip.mjs";
import { hostEnv, loadConfig } from "../src/config.mjs";
import { lastChangeSeconds, loopEnd } from "../src/freeze.mjs";
import { PROFILES, selectScenes, variants } from "../src/profiles.mjs";

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
