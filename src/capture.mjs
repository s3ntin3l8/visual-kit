import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PROFILES, selectScenes, variants } from "./profiles.mjs";
import { padRect } from "./clip.mjs";
import { pageMetrics } from "./metrics.mjs";
import { recordLoop } from "./loop.mjs";
import { MARKER, guardReplace } from "./output.mjs";

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

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The scene's URL on the demo. Refuses a non-loopback demo and a scene path that leaves it (`//host/x`). */
export function sceneUrl(baseUrl, scenePath) {
  const base = new URL(baseUrl);
  if (!LOOPBACK.has(base.hostname)) throw new Error(`${baseUrl} is not a loopback address; visual-kit only captures an isolated local demo`);
  const url = new URL(scenePath, base);
  if (url.origin !== base.origin) throw new Error(`scene path "${scenePath}" leaves the demo (${url.origin})`);
  // Without host networking (Docker Desktop) the demo is reached through the host alias the launcher sets.
  const alias = process.env.VISUAL_KIT_HOST_ALIAS;
  if (alias) {
    if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(alias)) throw new Error(`VISUAL_KIT_HOST_ALIAS "${alias}" is not a bare hostname`);
    url.hostname = alias;
  }
  return url.toString();
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
  const response = await page.goto(sceneUrl(baseUrl, scene.path), { waitUntil: "load" });
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
      const todo = variants(cfg, profileName, scene);
      if (!todo.length && !(profile.loops && scene.loop)) log(`  skip ${scene.name}: none of its viewports/schemes belong to the ${profileName} profile`);
      for (const variant of todo) {
        const label = `${scene.name} (${variant.vp}, ${variant.scheme})`;
        const context = await newContext(browser, cfg, variant);
        try {
          const { page, response, consoleErrors } = await openScene({ context, cfg, scene, variant, hooks, baseUrl });
          for (const step of scene.steps ?? []) await runStep(page, step);
          if (typeof scene.settle === "number") await page.waitForTimeout(scene.settle);
          else if (scene.settle) await page.waitForSelector(scene.settle, { state: "visible" });
          if (scene.steps?.length || scene.settle !== undefined) await settlePage(page, scene, hooks);
          // Measured before the shot: a spotlight overlay or injected CSS is decoration, not the page.
          if (profileName === "check" || profileName === "audit") {
            metrics[variant.file] = { status: response?.status() ?? 0, ...(await pageMetrics(page)), console: consoleErrors };
          }
          await shoot(page, scene, variant, profile.fullPage, cfg, path.join(stage, variant.file));
          files.push(variant.file);
          log(`  ok  ${label}`);
        } catch (err) {
          // A shot without its metrics would read as "no violations before" in the report: drop it.
          rmSync(path.join(stage, variant.file), { force: true });
          delete metrics[variant.file];
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

  if (Object.keys(metrics).length) writeFileSync(path.join(stage, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);

  // A check compares whatever rendered (a scene the base lacks fails there and shows as "new"), so its
  // partial output is useful. Everything else is a deliverable: a partial set must never replace a
  // complete one, so on any failure the previous output stays untouched.
  const publishPartial = profileName === "check";
  // Nothing rendered is a failure of its own (every scene filtered out, a typo): never publish it over a
  // complete set.
  if (!files.length && !failures.length) failures.push(`nothing was rendered for the ${profileName} profile (check the scenes' viewports, schemes and tags)`);
  if (failures.length && (!publishPartial || !files.length)) {
    rmSync(stage, { recursive: true, force: true });
    if (!publishPartial) log(`  output left untouched: ${path.relative(process.cwd(), outDir) || outDir}`);
    return { files: publishPartial ? files : [], metrics, failures };
  }
  guardReplace(outDir);
  writeFileSync(path.join(stage, MARKER), "visual-kit output: this folder is replaced wholesale on every run\n");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.dirname(outDir), { recursive: true });
  renameSync(stage, outDir);
  return { files, metrics, failures };
}
