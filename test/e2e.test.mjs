// Needs Chromium and ffmpeg: run it in the image (see README) or where `npx playwright install chromium` ran.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { PNG } from "pngjs";
import { capture } from "../src/capture.mjs";
import { compare } from "../src/compare.mjs";
import { loadConfig } from "../src/config.mjs";

const cfg = loadConfig("fixtures/visual/scenes.json");
const work = mkdtempSync(path.join(tmpdir(), "vk-e2e-"));
// Chromium rounds the phone viewport at @3x, so heights can land one pixel short.
const near = (actual, expected) => actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) <= 1);
const size = (file) => {
  const p = PNG.sync.read(readFileSync(file));
  return [p.width, p.height];
};

function serve(port, accent, extraEnv = {}) {
  const child = spawn("node", ["fixtures/serve.mjs"], { env: { ...process.env, FIXTURE_PORT: String(port), ...(accent ? { FIXTURE_ACCENT: accent } : {}), ...extraEnv }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => /DEMO_READY/.test(String(c)) && resolve(child));
    child.once("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  });
}

describe("e2e", () => {
  let base, head;
  before(async () => {
    base = await serve(4173);
    head = await serve(4174, "#e8431a");
  });
  after(() => {
    base?.kill();
    head?.kill();
  });

  test("check: the same page renders identically twice (the determinism contract)", async () => {
    const a = await capture({ cfg, profile: "check", baseUrl: "http://127.0.0.1:4173", outDir: path.join(work, "a"), log() {} });
    const b = await capture({ cfg, profile: "check", baseUrl: "http://127.0.0.1:4173", outDir: path.join(work, "b"), log() {} });
    assert.deepEqual(a.failures, []);
    assert.equal(a.files.length, 12); // 3 scenes × 2 viewports × 2 schemes
    const s = compare({ baseDir: path.join(work, "a"), headDir: path.join(work, "b"), outDir: path.join(work, "same-report") });
    assert.equal(s.changed, 0);
    assert.equal(s.same, 12);
    assert.ok(b.metrics["home.desktop.dark.png"].axe);
    assert.equal(b.metrics["home.desktop.dark.png"].unnamed, 1); // the icon button without a name
  });

  test("check: a known colour change is found, and only where it shows", async () => {
    await capture({ cfg, profile: "check", baseUrl: "http://127.0.0.1:4174", outDir: path.join(work, "c"), log() {} });
    const s = compare({ baseDir: path.join(work, "a"), headDir: path.join(work, "c"), outDir: path.join(work, "diff-report") });
    const byFile = Object.fromEntries(s.entries.map((e) => [e.file, e.result]));
    assert.equal(byFile["home.desktop.dark.png"], "changed");
    assert.equal(byFile["settings.desktop.dark.png"], "same"); // the accent colour is not on that page
    assert.ok(existsSync(path.join(work, "diff-report", "diff", "home.desktop.dark.png")));
    assert.ok(existsSync(path.join(work, "diff-report", "index.html")));
  });

  test("baselines: only flagged scenes are captured, and a check compares them against the committed files", async () => {
    const baselines = path.join(work, "baselines");
    // The committed baselines come from the page as the team wants it (the accent server); the merge base ("a") has the old look.
    const made = await capture({ cfg, profile: "check", baseUrl: "http://127.0.0.1:4174", outDir: baselines, onlyBaseline: true, log() {} });
    assert.deepEqual(made.failures, []);
    assert.deepEqual(made.files.sort(), ["home.desktop.dark.png", "home.desktop.light.png", "home.phone.dark.png", "home.phone.light.png"]);
    assert.ok(existsSync(path.join(baselines, "metrics.json")));
    const s = compare({ baseDir: path.join(work, "a"), headDir: path.join(work, "c"), baselinesDir: baselines, outDir: path.join(work, "baseline-report") });
    const byFile = Object.fromEntries(s.entries.map((e) => [e.file, e]));
    assert.equal(byFile["home.desktop.dark.png"].result, "same", "the head matches the baseline although it differs from the merge base");
    assert.equal(byFile["home.desktop.dark.png"].baseline, true);
    assert.equal(byFile["settings.desktop.dark.png"].baseline, undefined, "unflagged scenes behave as before");
    assert.ok(s.entries.filter((e) => e.file.startsWith("home.")).every((e) => e.result === "same" && e.baseline), "every home shot matches its baseline");
    assert.equal(byFile["menu.desktop.dark.png"].result, "changed", "an unflagged scene is still compared with the merge base");
    // A failing flagged scene must not replace the committed set with a partial one.
    const before = readdirSync(baselines).sort();
    const broken = { ...cfg, scenes: cfg.scenes.map((x) => (x.name === "home" ? { ...x, steps: [{ click: "#does-not-exist" }] } : x)) };
    const failed = await capture({ cfg: broken, profile: "check", baseUrl: "http://127.0.0.1:4174", outDir: baselines, onlyBaseline: true, log() {} });
    assert.ok(failed.failures.length > 0);
    assert.deepEqual(readdirSync(baselines).sort(), before, "the committed set is untouched");
    await assert.rejects(capture({ cfg: { ...cfg, scenes: cfg.scenes.map((x) => ({ ...x, baseline: undefined })) }, profile: "check", baseUrl: "http://127.0.0.1:4174", outDir: path.join(work, "none"), onlyBaseline: true, log() {} }), /flagged "baseline": true/);
  });

  test("check: --routes narrows the run", async () => {
    const r = await capture({ cfg, profile: "check", baseUrl: "http://127.0.0.1:4173", outDir: path.join(work, "routes"), routes: ["/settings.html"], log() {} });
    assert.deepEqual(r.files.every((f) => f.startsWith("settings.")), true);
  });

  test("landing: dark only, 1600x1000 @2x and 390x844 @3x, a loop triplet, a sharp section shot", async () => {
    const out = path.join(work, "landing");
    const r = await capture({ cfg, profile: "landing", baseUrl: "http://127.0.0.1:4173", outDir: out, log() {} });
    assert.deepEqual(r.failures, []);
    assert.deepEqual(readdirSync(out).filter((f) => f !== ".visual-kit").sort(), ["home-desktop.png", "home-mobile.png", "home.jpg", "home.mp4", "home.webm", "list-desktop.png", "list-mobile.png", "menu-desktop.png", "menu-mobile.png", "reel.jpg", "reel.mp4", "reel.webm"]); // reel is loop-only: no reel*.png
    assert.ok(near(size(path.join(out, "home-desktop.png")), [3200, 2000]));
    assert.ok(near(size(path.join(out, "home-mobile.png")), [1170, 2532]));
    const [w, h] = size(path.join(out, "menu-desktop.png"));
    assert.ok(w < 3200 && h < 2000, "a target scene is cut to the element, at device scale");
  });

  test("readme: light and dark for each viewport", async () => {
    const out = path.join(work, "readme");
    await capture({ cfg, profile: "readme", baseUrl: "http://127.0.0.1:4173", outDir: out, log() {} });
    assert.ok(readdirSync(out).includes("home-light-desktop.png"));
    assert.ok(readdirSync(out).includes("home-dark-mobile.png"));
  });

  test("spotlight dims the page around an absolutely positioned popover and leaves it where it is", async () => {
    const out = path.join(work, "spot");
    const r = await capture({ cfg, profile: "audit", baseUrl: "http://127.0.0.1:4173", outDir: out, routes: ["spot-plain", "spot-menu"], log() {} });
    assert.deepEqual(r.failures, []);
    const px = (file, x, y) => {
      const p = PNG.sync.read(readFileSync(path.join(out, file)));
      const i = (y * p.width + x) * 4;
      return [p.data[i], p.data[i + 1], p.data[i + 2]];
    };
    const plain = "spot-plain.desktop.dark.png";
    const spot = "spot-menu.desktop.dark.png";
    assert.deepEqual(px(spot, 1400, 70), px(plain, 1400, 70), "inside the menu: untouched");
    assert.ok(px(spot, 200, 400)[0] < px(plain, 200, 400)[0], "outside the menu: dimmed");
  });

  test("a failed presentation run leaves the previous output untouched", async () => {
    const out = path.join(work, "deliverable");
    const first = await capture({ cfg, profile: "landing", baseUrl: "http://127.0.0.1:4173", outDir: out, log() {} });
    assert.deepEqual(first.failures, []);
    const before = readdirSync(out).sort();
    assert.ok(before.includes(".visual-kit"));
    const broken = { ...cfg, scenes: [{ ...cfg.scenes[0], steps: [{ click: "#does-not-exist" }], viewports: ["desktop"] }, cfg.scenes[1]] };
    const second = await capture({ cfg: broken, profile: "landing", baseUrl: "http://127.0.0.1:4173", outDir: out, log() {} });
    assert.ok(second.failures.length > 0);
    assert.deepEqual(readdirSync(out).sort(), before, "the complete set is still there");
    assert.ok(!existsSync(`${out}.staging`));
  });

  test("a run that renders nothing never replaces a complete output", async () => {
    const out = path.join(work, "nothing");
    await capture({ cfg, profile: "landing", baseUrl: "http://127.0.0.1:4173", outDir: out, log() {} });
    const before = readdirSync(out).sort();
    // Light-only scenes belong to no landing variant (landing is dark only): zero variants, zero files.
    const light = { ...cfg, scenes: cfg.scenes.map((s) => ({ ...s, schemes: ["light"], loop: undefined })) };
    const r = await capture({ cfg: light, profile: "landing", baseUrl: "http://127.0.0.1:4173", outDir: out, log() {} });
    assert.ok(r.failures.some((f) => /nothing was rendered/.test(f)));
    assert.deepEqual(readdirSync(out).sort(), before);
  });

  test("a folder the tool did not write is not replaced without --force", async () => {
    const out = path.join(work, "handmade");
    mkdirSync(out);
    writeFileSync(path.join(out, "precious.png"), "x");
    await assert.rejects(capture({ cfg, profile: "landing", baseUrl: "http://127.0.0.1:4173", outDir: out, routes: ["home"], log() {} }), /not written by visual-kit/);
    assert.ok(existsSync(path.join(out, "precious.png")));
    process.env.VISUAL_KIT_FORCE = "1";
    try {
      await capture({ cfg, profile: "landing", baseUrl: "http://127.0.0.1:4173", outDir: out, routes: ["home"], log() {} });
    } finally {
      delete process.env.VISUAL_KIT_FORCE;
    }
    assert.ok(!existsSync(path.join(out, "precious.png")));
  });

  test("a control cut off at the viewport edge is found even though the page never scrolls", async () => {
    const out = path.join(work, "wide");
    const r = await capture({ cfg, profile: "audit", baseUrl: "http://127.0.0.1:4173", outDir: out, routes: ["wide"], log() {} });
    assert.deepEqual(r.failures, []);
    const m = r.metrics;
    assert.equal(m["wide.phone.dark.png"].overflow, false, "the document itself does not scroll");
    assert.equal(m["wide.phone.dark.png"].offscreen, 2, "the clipped select and the one a clipping card holds inside a scroll row, not the scroller's button or the hidden drawer");
    assert.deepEqual(m["wide.phone.dark.png"].offscreenSample, ["select#clipped", "select#clipped-in-row"]);
    assert.deepEqual(m["wide.phone.dark.png"].unnamedSample, ["select#unnamed"], "option text does not name a select");
    assert.equal(m["wide.desktop.dark.png"].offscreen, 0, "it fits on a desktop");
  });

  test("host hook: a scene settles on what the host script did, and without the channel it fails clearly", async () => {
    const demoDir = mkdtempSync(path.join(work, "demo-"));
    const channel = mkdtempSync(path.join(work, "hostcall-"));
    const hosted = await serve(4175, undefined, { FIXTURE_FLAG: path.join(demoDir, "flag") });
    // The launcher's watcher, in JS: run the fixture's host-hooks.sh for each request and answer it.
    const watcher = setInterval(() => {
      for (const f of readdirSync(channel).filter((n) => n.startsWith("req-") && !n.endsWith(".tmp"))) {
        const [name, ...args] = readFileSync(path.join(channel, f), "utf8").split("\n").slice(0, -1);
        const r = spawnSync("bash", ["fixtures/visual/host-hooks.sh", name, demoDir, ...args], { encoding: "utf8" });
        writeFileSync(path.join(channel, f.replace("req-", "res-")), `${r.status}\n${r.stdout}`);
        rmSync(path.join(channel, f));
      }
    }, 20);
    const run = (outName) => capture({ cfg, profile: "audit", baseUrl: "http://127.0.0.1:4175", outDir: path.join(work, outName), routes: ["hosted"], hooksFile: "fixtures/visual/hooks.mjs", log() {} });
    try {
      process.env.VISUAL_KIT_HOSTCALL = channel;
      const ok = await run("hosted");
      assert.deepEqual(ok.failures, []);
      assert.deepEqual(ok.files, ["hosted.desktop.dark.png"]);
      assert.ok(existsSync(path.join(demoDir, "flag")), "the host script ran in the demo's directory");
      delete process.env.VISUAL_KIT_HOSTCALL;
      const none = await run("hosted-nochannel");
      assert.ok(none.failures.some((f) => /no host-hook channel/.test(f)), none.failures.join("; "));
    } finally {
      delete process.env.VISUAL_KIT_HOSTCALL;
      clearInterval(watcher);
      hosted.kill();
    }
  });

  test("a failing scene is reported and the others still render", async () => {
    const broken = { ...cfg, scenes: [{ name: "broken", path: "/", viewports: ["desktop"], schemes: ["dark"], steps: [{ click: "#does-not-exist" }] }, cfg.scenes[3]] };
    const r = await capture({ cfg: broken, profile: "check", baseUrl: "http://127.0.0.1:4173", outDir: path.join(work, "broken"), log() {} });
    assert.ok(r.failures.length > 0);
    assert.ok(r.files.some((f) => f.startsWith("settings.")));
  });
});
