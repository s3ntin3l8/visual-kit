// Needs Chromium and ffmpeg: run it in the image (see README) or where `npx playwright install chromium` ran.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

function serve(port, accent) {
  const child = spawn("node", ["fixtures/serve.mjs"], { env: { ...process.env, FIXTURE_PORT: String(port), ...(accent ? { FIXTURE_ACCENT: accent } : {}) }, stdio: ["ignore", "pipe", "inherit"] });
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

  test("check: --routes narrows the run", async () => {
    const r = await capture({ cfg, profile: "check", baseUrl: "http://127.0.0.1:4173", outDir: path.join(work, "routes"), routes: ["/settings.html"], log() {} });
    assert.deepEqual(r.files.every((f) => f.startsWith("settings.")), true);
  });

  test("landing: dark only, 1600x1000 @2x and 390x844 @3x, a loop triplet, a sharp section shot", async () => {
    const out = path.join(work, "landing");
    const r = await capture({ cfg, profile: "landing", baseUrl: "http://127.0.0.1:4173", outDir: out, log() {} });
    assert.deepEqual(r.failures, []);
    assert.deepEqual(readdirSync(out).filter((f) => f !== ".visual-kit").sort(), ["home-desktop.png", "home-mobile.png", "home.jpg", "home.mp4", "home.webm", "list-desktop.png", "list-mobile.png", "menu-desktop.png", "menu-mobile.png"]);
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

  test("a failing scene is reported and the others still render", async () => {
    const broken = { ...cfg, scenes: [{ name: "broken", path: "/", viewports: ["desktop"], schemes: ["dark"], steps: [{ click: "#does-not-exist" }] }, cfg.scenes[3]] };
    const r = await capture({ cfg: broken, profile: "check", baseUrl: "http://127.0.0.1:4173", outDir: path.join(work, "broken"), log() {} });
    assert.ok(r.failures.length > 0);
    assert.ok(r.files.some((f) => f.startsWith("settings.")));
  });
});
