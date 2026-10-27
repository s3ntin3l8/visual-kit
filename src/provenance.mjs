// What a committed baseline set was rendered with, so a check can say "these baselines are stale"
// instead of showing an unexplained diff after an image bump. Written by `capture --baseline-only`,
// read by `compare --baselines`; the verdicts never depend on it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { viewportsFor } from "./profiles.mjs";

export const FILE = "provenance.json";
const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v && typeof v === "object" ? sorted(v) : v]));

/**
 * The inputs that decide how a shot renders: the runner, the pinned Playwright (and with it the browser the image
 * ships), and the viewport table of the `check` profile for this repo's config. Fonts come from the image's apt
 * packages and are not versioned: regenerate on any image bump, as CONTRACT.md says.
 */
export function current(cfg) {
  return { runner: pkg.version, playwright: pkg.dependencies.playwright, ...(cfg ? { viewports: hash(sorted(viewportsFor(cfg, "check"))) } : {}) };
}

export function write(dir, cfg) {
  writeFileSync(path.join(dir, FILE), `${JSON.stringify(current(cfg), null, 2)}\n`);
}

/** The recorded provenance, or null when the set has none (or it cannot be read). */
export function read(dir) {
  const file = path.join(dir, FILE);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const minor = (v) => String(v).split(".").slice(0, 2).join(".");

/** Why a recorded provenance no longer matches the current one; empty when it does. A runner patch release does not count. */
export function staleness(recorded, now) {
  if (!recorded) return [`no ${FILE} next to the baselines (captured before it existed, or edited by hand)`];
  const reasons = [];
  if (recorded.playwright !== now.playwright) reasons.push(`Playwright ${recorded.playwright ?? "unknown"} → ${now.playwright}`);
  if (now.viewports && recorded.viewports !== now.viewports) reasons.push("the check viewport table changed");
  if (minor(recorded.runner) !== minor(now.runner)) reasons.push(`visual-kit ${recorded.runner ?? "unknown"} → ${now.runner}`);
  return reasons;
}
