import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lastChangeSeconds, loopEnd } from "./freeze.mjs";
import { viewportFor } from "./profiles.mjs";

function ffmpeg(args) {
  const res = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (res.error || res.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

/** When the video at `src` last changed, in seconds, or null if it never settles. */
function videoLastChange(src) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-i", src, "-vf", "freezedetect=n=-60dB:d=1", "-map", "0:v", "-f", "null", "-"], { encoding: "utf8" });
  if (res.error || res.status !== 0) throw new Error(`ffmpeg freezedetect on ${src} failed`);
  return lastChangeSeconds(res.stderr);
}

/**
 * Records a scene's steps as a silent loop: `<scene>.webm` (VP9), `<scene>.mp4` (H.264)
 * and a `<scene>.jpg` poster of the last frame. The page load is trimmed off the front and
 * the end is cut `tailSec` after the last on-screen change.
 */
export async function recordLoop({ browser, cfg, scene, profile, profileName, baseUrl, hooks, openScene, newContext, runStep, outDir, log }) {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) throw new Error("ffmpeg not found, so the loop cannot be encoded");
  const vpName = Object.keys(profile.viewports)[0];
  const variant = { vp: vpName, scheme: profile.schemes[profile.schemes.length - 1], viewport: viewportFor(cfg, profileName, vpName) };
  // Playwright records in CSS pixels whatever the device scale, so the loop is 1x.
  const size = { width: variant.viewport.width, height: variant.viewport.height };
  const videoDir = mkdtempSync(path.join(tmpdir(), "visual-kit-loop-"));
  const tailSec = scene.loop.tailSec ?? 1.5;
  try {
    const context = await newContext(browser, cfg, variant, { recordVideo: { dir: videoDir, size } });
    const startedAt = Date.now();
    let offset;
    try {
      const { page } = await openScene({ context, cfg, scene, variant, hooks, baseUrl });
      // Everything before this point (load, settle) is trimmed off.
      offset = (Date.now() - startedAt) / 1000;
      await page.waitForTimeout(600);
      for (const step of scene.steps ?? []) await runStep(page, step);
      await page.waitForTimeout(tailSec * 1000);
    } finally {
      await context.close(); // finalises the video file
    }

    const raw = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
    if (!raw) throw new Error(`${scene.name}: the browser wrote no recording`);
    const src = path.join(videoDir, raw);
    const base = path.join(outDir, scene.name);
    const end = loopEnd(videoLastChange(src), offset, tailSec);
    const input = ["-ss", offset.toFixed(2), ...end, "-i", src, "-an"];
    try {
      ffmpeg([...input, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-row-mt", "1", `${base}.webm`]);
      // H.264 needs even dimensions.
      ffmpeg([...input, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${base}.mp4`]);
      ffmpeg(["-sseof", "-0.5", "-i", src, "-frames:v", "1", "-q:v", "3", `${base}.jpg`]);
    } catch (err) {
      // All three or none: never leave a loop a consumer would half-read.
      for (const ext of ["webm", "mp4", "jpg"]) rmSync(`${base}.${ext}`, { force: true });
      throw err;
    }
    log(`  ok  ${scene.name} loop (${profileName})`);
    return [`${scene.name}.webm`, `${scene.name}.mp4`, `${scene.name}.jpg`];
  } finally {
    rmSync(videoDir, { recursive: true, force: true });
  }
}
