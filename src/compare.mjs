import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { MARKER, guardReplace } from "./output.mjs";
import * as provenance from "./provenance.mjs";

const pngs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")).sort() : []);
const readMetrics = (dir) => (existsSync(path.join(dir, "metrics.json")) ? JSON.parse(readFileSync(path.join(dir, "metrics.json"), "utf8")) : {});

/** Pads a PNG with transparent pixels to width × height so two different-sized shots can be compared. */
function pad(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/** Compares two shots; returns the diff pixel count and, when different, the diff image. */
export function diffPngs(baseBuf, headBuf, { threshold = 0.1 } = {}) {
  const base = PNG.sync.read(baseBuf);
  const head = PNG.sync.read(headBuf);
  const width = Math.max(base.width, head.width);
  const height = Math.max(base.height, head.height);
  const a = pad(base, width, height);
  const b = pad(head, width, height);
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(a.data, b.data, diff.data, width, height, { threshold, includeAA: false });
  return {
    pixels,
    resized: base.width !== head.width || base.height !== head.height,
    size: { base: [base.width, base.height], head: [head.width, head.height] },
    diff: pixels ? PNG.sync.write(diff) : null,
  };
}

/** What got worse (or better) between two metrics entries of the same shot. */
function metricDelta(base = {}, head = {}) {
  const out = [];
  if ((head.status ?? 200) >= 400 && !((base.status ?? 200) >= 400)) out.push(`HTTP ${head.status} (the base answered ${base.status ?? "n/a"})`);
  const axeOf = (m) => new Map((m.axe ?? []).map((v) => [v.id, v]));
  const baseAxe = axeOf(base);
  for (const [id, v] of axeOf(head)) {
    const before = baseAxe.get(id)?.nodes ?? 0;
    if (v.nodes > before) out.push(`axe \`${id}\` (${v.impact}): ${before} → ${v.nodes} nodes`);
  }
  const headAxe = axeOf(head);
  for (const [id, v] of baseAxe) {
    if (!headAxe.has(id)) out.push(`axe \`${id}\` fixed (${v.nodes} nodes)`);
  }
  const baseConsole = new Set(base.console ?? []);
  for (const line of head.console ?? []) if (!baseConsole.has(line)) out.push(`new console error: ${line.slice(0, 160)}`);
  if (head.overflow && !base.overflow) out.push("horizontal overflow introduced");
  if (!head.overflow && base.overflow) out.push("horizontal overflow fixed");
  if ((head.offscreen ?? 0) > (base.offscreen ?? 0)) {
    out.push(`controls past the viewport edge: ${base.offscreen ?? 0} → ${head.offscreen} (${(head.offscreenSample ?? []).join(", ")})`);
  }
  if ((head.offscreen ?? 0) < (base.offscreen ?? 0)) out.push(`controls past the viewport edge fixed: ${base.offscreen} → ${head.offscreen ?? 0} (was ${(base.offscreenSample ?? []).join(", ")})`);
  if ((head.unnamed ?? 0) > (base.unnamed ?? 0)) out.push(`unnamed controls: ${base.unnamed ?? 0} → ${head.unnamed}`);
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Compares the shots of `headDir` against `baseDir` and writes a self-contained report to `outDir`:
 * index.html (base / head / diff side by side), summary.json and summary.md.
 *
 * `baselinesDir` (committed baselines, same file names and metrics.json) wins over `baseDir` for the shots it
 * has; those entries are marked `baseline`. A baseline whose shot was not rendered this time is not "removed":
 * baselines only overlay the base, they do not define it.
 *
 * With baselines, `summary.baselines` says whether they are stale (see provenance.mjs); that is a notice in the
 * report, never a verdict. `cfg` (the repo's scenes.json) lets the viewport table take part in that comparison.
 */
export function compare({ baseDir, headDir, outDir, baselinesDir, cfg, threshold = 0.1, maxDiffPixels = 20 }) {
  if (baselinesDir && !existsSync(baselinesDir)) throw new Error(`baselines folder ${baselinesDir} does not exist`);
  guardReplace(outDir);
  rmSync(outDir, { recursive: true, force: true });
  for (const sub of ["base", "head", "diff"]) mkdirSync(path.join(outDir, sub), { recursive: true });
  writeFileSync(path.join(outDir, MARKER), "visual-kit output: this folder is replaced wholesale on every run\n");

  const baseFiles = pngs(baseDir);
  const headFiles = pngs(headDir);
  const baselineFiles = new Set(baselinesDir ? pngs(baselinesDir) : []);
  const baselineMetrics = baselinesDir ? readMetrics(baselinesDir) : {};
  const baseMetrics = { ...readMetrics(baseDir), ...Object.fromEntries(Object.entries(baselineMetrics).filter(([f]) => baselineFiles.has(f))) };
  const headMetrics = readMetrics(headDir);
  const entries = [];

  for (const file of headFiles) {
    copyFileSync(path.join(headDir, file), path.join(outDir, "head", file));
    const baseline = baselineFiles.has(file);
    const fileBaseDir = baseline ? baselinesDir : baseDir;
    const missingInBase = (!baseline && !baseFiles.includes(file)) || (baseMetrics[file]?.status >= 400 && !(headMetrics[file]?.status >= 400));
    const health = metricDelta(missingInBase ? {} : baseMetrics[file], headMetrics[file]);
    if (missingInBase) {
      // A new route is where a check matters most: its findings are the whole story, not a delta.
      entries.push({ file, result: "new", pixels: 0, health });
      continue;
    }
    copyFileSync(path.join(fileBaseDir, file), path.join(outDir, "base", file));
    const d = diffPngs(readFileSync(path.join(fileBaseDir, file)), readFileSync(path.join(headDir, file)), { threshold });
    const changed = d.pixels > maxDiffPixels || d.resized;
    if (d.diff && changed) writeFileSync(path.join(outDir, "diff", file), d.diff);
    entries.push({ file, result: changed ? "changed" : "same", pixels: d.pixels, resized: d.resized, size: d.size, health, ...(baseline ? { baseline: true } : {}) });
  }
  for (const file of baseFiles) {
    if (headFiles.includes(file)) continue;
    copyFileSync(path.join(baseDir, file), path.join(outDir, "base", file));
    entries.push({ file, result: "removed", pixels: 0, health: [] });
  }

  const count = (r) => entries.filter((e) => e.result === r).length;
  // An empty folder (a `.gitkeep`) has no shots to be stale; and without `cfg` the viewport table cannot be
  // compared, which the summary says instead of reading as a clean bill of health.
  const checked = baselinesDir && baselineFiles.size > 0;
  const recorded = checked ? provenance.read(baselinesDir) : null;
  const reasons = checked ? provenance.staleness(recorded, provenance.current(cfg)) : [];
  const unchecked = checked && recorded?.viewports && !cfg ? ["viewports"] : [];
  const summary = { total: entries.length, changed: count("changed"), new: count("new"), removed: count("removed"), same: count("same"), ...(baselinesDir ? { baselines: { stale: reasons.length > 0, reasons, unchecked } } : {}), entries };
  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(outDir, "summary.md"), markdown(summary));
  writeFileSync(path.join(outDir, "index.html"), html(summary));
  return summary;
}

const cellText = (t) => String(t).replace(/\s+/g, " ").replaceAll("|", "\\|");

function markdown(s) {
  const lines = ["## Visual check", ""];
  lines.push(`${s.total} shots compared: **${s.changed} changed**, ${s.new} new, ${s.removed} removed, ${s.same} identical.`, "");
  if (s.baselines?.unchecked?.length) lines.push(`> The committed baselines' ${s.baselines.unchecked.join(", ")} were not checked: \`compare\` ran without \`--config\`.`, "");
  if (s.baselines?.stale) lines.push(`> **The committed baselines look stale:** ${s.baselines.reasons.join("; ")}. Differences below may only be that; regenerate them with \`make visual-baseline\`.`, "");
  if (s.total > 0 && s.new === s.total) lines.push("> **Every shot is new: the base rendered nothing.** The comparison says nothing; look at the base capture above.", "");
  const interesting = s.entries.filter((e) => e.result !== "same" || e.health.length);
  if (!interesting.length) return `${lines.join("\n")}Nothing changed.\n`;
  lines.push("| Shot | Result | Detail |", "| --- | --- | --- |");
  for (const e of interesting) {
    const detail = [e.baseline ? "against the committed baseline" : "", e.result === "changed" ? (e.resized ? `size ${e.size.base.join("×")} → ${e.size.head.join("×")}` : `${e.pixels} px differ`) : "", ...e.health].filter(Boolean).map(cellText).join("<br>");
    lines.push(`| \`${e.file}\` | ${e.result} | ${detail} |`);
  }
  return `${lines.join("\n")}\n`;
}

function html(s) {
  const cell = (dir, file, show) => (show ? `<a href="${dir}/${esc(file)}"><img loading="lazy" src="${dir}/${esc(file)}"></a>` : "<span>—</span>");
  const rows = s.entries
    .filter((e) => e.result !== "same" || e.health.length)
    .map(
      (e) => `<section><h2>${esc(e.file)} <small>${e.result}${e.result === "changed" ? ` · ${e.pixels} px` : ""}${e.baseline ? " · baseline" : ""}</small></h2>
${e.health.length ? `<ul>${e.health.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
<div class="row"><figure><figcaption>base</figcaption>${cell("base", e.file, e.result !== "new")}</figure>
<figure><figcaption>head</figcaption>${cell("head", e.file, e.result !== "removed")}</figure>
<figure><figcaption>diff</figcaption>${cell("diff", e.file, e.result === "changed")}</figure></div></section>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Visual check</title>
<style>body{font:14px system-ui;background:#0f1115;color:#e6e6e6;margin:24px}small{color:#8a8f98;font-weight:400}
.row{display:flex;gap:12px;align-items:flex-start}figure{flex:1;margin:0;min-width:0}img{width:100%;border:1px solid #2a2f37}
figcaption{color:#8a8f98;margin-bottom:4px}section{margin-bottom:40px}li{color:#e0b341}.stale{color:#e0b341}</style>
<h1>Visual check</h1><p>${s.total} shots: ${s.changed} changed, ${s.new} new, ${s.removed} removed, ${s.same} identical.</p>
${s.baselines?.unchecked?.length ? `<p class="stale">The committed baselines' ${esc(s.baselines.unchecked.join(", "))} were not checked: <code>compare</code> ran without <code>--config</code>.</p>` : ""}
${s.baselines?.stale ? `<p class="stale"><b>The committed baselines look stale:</b> ${esc(s.baselines.reasons.join("; "))}. Differences below may only be that; regenerate them with <code>make visual-baseline</code>.</p>` : ""}
${rows || "<p>Nothing changed.</p>"}`;
}
