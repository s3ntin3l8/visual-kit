import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PROFILES, selectScenes, variants } from "./profiles.mjs";
import { padRect } from "./clip.mjs";
import { pageMetrics } from "./metrics.mjs";
import { recordLoop } from "./loop.mjs";

const STEP_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 30_000;
const BASE_STYLE = `
  *, *::before, *::after { animation-delay: 0s !important; animation-duration: 0s !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
`;

async function runStep(page, step) {
  if ("click" in step) await page.click(step.click);
  else if ("hover" in step) await page.hover(step.hover);
  else if ("fill" in step) await page.fill(step.fill, step.value);
  else if ("press" in step) await page.keyboard.press(step.press);
  else if ("waitFor" in step) await page.waitForSelector(step.waitFor, { state: "visible" });
  else await page.waitForTimeout(step.wait);
}

/** Generic readiness: fonts painted, nothing marked busy, the network quiet. The app's hook adds its own. */
export async function settlePage(page, scene, hooks) {
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: SETTLE_TIMEOUT_MS })
    .catch(() => {
      throw new Error(`${scene.name}: the page still has aria-busy="true" after ${SETTLE_TIMEOUT_MS / 1000}s`);
    });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  if (hooks?.settle) await hooks.settle({ page, scene });
}

/** Arbitrary CSS from the scene's emphasis, injected before the shot. */
function emphasisCss(emphasis) {
  return emphasis?.css ?? "";
}

/**
 * Dims everything except `selector`: a transparent overlay over the element's box whose huge spread
 * shadow covers the rest of the document. It is an extra element, so the target keeps its own
 * positioning (a popover stays where it is) and the overlay sits above the whole page whatever the
 * stacking context of the target.
 */
async function spotlight(page, selector, dim) {
  await page.evaluate(
    ({ selector, dim }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`spotlight: ${selector} not found`);
      const r = el.getBoundingClientRect();
      const overlay = document.createElement("div");
      overlay.setAttribute("data-visual-kit", "spotlight");
      Object.assign(overlay.style, {
        position: "absolute",
        left: `${r.left + scrollX}px`,
        top: `${r.top + scrollY}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        borderRadius: "6px",
        pointerEvents: "none",
        zIndex: "2147483647",
        boxShadow: `0 0 0 100vmax rgba(0, 0, 0, ${dim})`,
      });
      document.body.append(overlay);
    },
    { selector, dim },
  );
}

async function newContext(browser, cfg, variant, extra = {}) {
  const { viewport, scheme } = variant;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale ?? 1,
    isMobile: viewport.mobile ?? false,
    hasTouch: viewport.mobile ?? false,
    colorScheme: scheme,
    reducedMotion: "reduce",
    locale: cfg.locale,
    storageState: cfg.storageState ? path.resolve(cfg.storageState) : undefined,
    ...extra,
  });
  if (cfg.clock) await context.clock.setFixedTime(new Date(cfg.clock));
  return context;
}

async function loadHooks(file) {
  if (!file || !existsSync(file)) return null;
  return import(pathToFileURL(path.resolve(file)).href);
}

/** Opens the scene, runs its steps and leaves the page ready to be shot. */
async function openScene({ context, cfg, scene, variant, hooks, baseUrl }) {
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
  if (scene.localStorage) {
    await page.addInitScript((items) => {
      for (const [k, v] of Object.entries(items)) window.localStorage.setItem(k, v);
    }, scene.localStorage);
  }
  await hooks?.beforeScene?.({ context, page, scene, variant, cfg });
  const response = await page.goto(new URL(scene.path, baseUrl).toString(), { waitUntil: "load" });
  await page.addStyleTag({ content: BASE_STYLE });
  await settlePage(page, scene, hooks);
  return { page, response, consoleErrors };
}

async function shoot(page, scene, variant, fullPage, cfg, outFile) {
  const css = emphasisCss(scene.emphasis);
  if (css) await page.addStyleTag({ content: css });
  if (scene.emphasis?.spotlight) await spotlight(page, scene.emphasis.spotlight, scene.emphasis.dim ?? 0.55);
  const mask = [...(cfg.mask ?? []), ...(scene.mask ?? [])].map((sel) => page.locator(sel));
  const options = { path: outFile, animations: "disabled", caret: "hide", mask, maskColor: "#ff00ff" };
  if (scene.target) {
    const locator = page.locator(scene.target).first();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`${scene.name}: target ${scene.target} is not visible`);
    const doc = await page.evaluate(() => ({ scrollX: scrollX, scrollY: scrollY, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    // Document coordinates only apply together with fullPage.
    await page.screenshot({ ...options, fullPage: true, clip: padRect(box, doc, scene.padding ?? 24) });
  } else if (scene.clip) {
    await page.screenshot({ ...options, fullPage: true, clip: scene.clip });
  } else {
    await page.screenshot({ ...options, fullPage: scene.fullPage ?? fullPage });
  }
}

/**
 * Renders a profile's scenes against a running demo into `outDir`.
 * Returns { files, metrics, failures }. A scene that fails is reported, the rest still render.
 */
export async function capture({ cfg, profile: profileName, baseUrl, outDir, routes = [], hooksFile, log = console.log }) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile "${profileName}" (${Object.keys(PROFILES).join(" | ")})`);
  const scenes = selectScenes(cfg, profileName, routes);
  if (!scenes.length) throw new Error(`no scene matches profile "${profileName}"${routes.length ? ` and --routes ${routes.join(",")}` : ""}`);

  const hooks = await loadHooks(hooksFile);
  // Stage then swap, so a failed run never leaves a half-written output folder.
  const stage = `${outDir}.staging`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const browser = await chromium.launch();
  const metrics = {};
  const files = [];
  const failures = [];
  try {
    for (const scene of scenes) {
      for (const variant of variants(cfg, profileName, scene)) {
        const label = `${scene.name} (${variant.vp}, ${variant.scheme})`;
        const context = await newContext(browser, cfg, variant);
        try {
          const { page, response, consoleErrors } = await openScene({ context, cfg, scene, variant, hooks, baseUrl });
          for (const step of scene.steps ?? []) await runStep(page, step);
          if (typeof scene.settle === "number") await page.waitForTimeout(scene.settle);
          else if (scene.settle) await page.waitForSelector(scene.settle, { state: "visible" });
          if (scene.steps?.length || scene.settle !== undefined) await settlePage(page, scene, hooks);
          await shoot(page, scene, variant, profile.fullPage, cfg, path.join(stage, variant.file));
          files.push(variant.file);
          if (profileName === "check" || profileName === "audit") {
            metrics[variant.file] = { status: response?.status() ?? 0, ...(await pageMetrics(page)), console: consoleErrors };
          }
          log(`  ok  ${label}`);
        } catch (err) {
          failures.push(`${label}: ${String(err.message).split("\n")[0]}`);
          log(`  FAIL ${label}: ${String(err.message).split("\n")[0]}`);
        } finally {
          await context.close();
        }
      }
      if (profile.loops && scene.loop) {
        try {
          const made = await recordLoop({ browser, cfg, scene, profile, profileName, baseUrl, hooks, openScene, newContext, runStep, outDir: stage, log });
          files.push(...made);
        } catch (err) {
          failures.push(`${scene.name} loop: ${String(err.message).split("\n")[0]}`);
          log(`  FAIL ${scene.name} loop: ${String(err.message).split("\n")[0]}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (Object.keys(metrics).length) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(stage, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  }
  if (failures.length && !files.length) {
    rmSync(stage, { recursive: true, force: true });
    return { files, metrics, failures };
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.dirname(outDir), { recursive: true });
  renameSync(stage, outDir);
  return { files, metrics, failures };
}
