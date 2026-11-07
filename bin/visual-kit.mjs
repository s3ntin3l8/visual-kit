#!/usr/bin/env node
// visual-kit: runs inside the image. The host-side launcher (host/run.sh) boots the demo and
// calls these subcommands; see CONTRACT.md.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { capture } from "../src/capture.mjs";
import { DEFAULT_MAX_DIFF_PIXELS, compare } from "../src/compare.mjs";
import { hostEnv, loadConfig } from "../src/config.mjs";
import { PROFILES } from "../src/profiles.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage:
  visual-kit capture <${Object.keys(PROFILES).join("|")}> --config FILE --url URL --out DIR [--routes a,b] [--baseline-only]
  visual-kit compare --base DIR --head DIR --out DIR [--config FILE] [--baselines DIR] [--max-diff-pixels N] [--threshold T] [--fail-on-diff] [--fail-on-health] [--fail-on-unstable]
  visual-kit env --config FILE      shell assignments for the host launcher
  visual-kit host-files             tar of host/ on stdout (the launcher the Makefile extracts)
  visual-kit validate --config FILE
  visual-kit version`;

const options = {
  config: { type: "string" },
  url: { type: "string" },
  out: { type: "string" },
  routes: { type: "string", default: "" },
  base: { type: "string" },
  head: { type: "string" },
  baselines: { type: "string" },
  "baseline-only": { type: "boolean", default: false },
  "max-diff-pixels": { type: "string" },
  threshold: { type: "string" },
  "fail-on-diff": { type: "boolean", default: false },
  "fail-on-health": { type: "boolean", default: false },
  "fail-on-unstable": { type: "boolean", default: false },
};

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  const [command, arg] = positionals;
  const configPath = values.config ?? "visual/scenes.json";
  switch (command) {
    case "version":
      console.log(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
      return 0;
    case "host-files":
      return spawnSync("tar", ["-C", path.join(root, "host"), "-cf", "-", "."], { stdio: "inherit" }).status ?? 1;
    case "validate":
      loadConfig(configPath);
      console.log(`${configPath}: ok`);
      return 0;
    case "env":
      console.log(hostEnv(loadConfig(configPath)));
      return 0;
    case "capture": {
      if (!PROFILES[arg]) throw new Error(`capture needs a profile: ${Object.keys(PROFILES).join(" | ")}`);
      if (!values.url || !values.out) throw new Error("capture needs --url and --out");
      const cfg = loadConfig(configPath);
      const hooksFile = path.join(path.dirname(configPath), "hooks.mjs");
      const routes = values.routes.split(",").map((r) => r.trim()).filter(Boolean);
      const { files, failures } = await capture({ cfg, profile: arg, baseUrl: values.url, outDir: path.resolve(values.out), routes, hooksFile, onlyBaseline: values["baseline-only"] });
      console.log(`visual-kit: ${files.length} file(s) -> ${values.out}`);
      if (failures.length) {
        console.error(`visual-kit: ${failures.length} capture(s) failed:\n  - ${failures.join("\n  - ")}`);
        return 1;
      }
      return 0;
    }
    case "compare": {
      if (!values.base || !values.head || !values.out) throw new Error("compare needs --base, --head and --out");
      // Flags win over scenes.json; without them compare() resolves each shot's scene, then the top level, then the default.
      let maxDiffPixels;
      if (values["max-diff-pixels"] !== undefined) {
        maxDiffPixels = Number(values["max-diff-pixels"]);
        if (values["max-diff-pixels"].trim() === "" || !Number.isInteger(maxDiffPixels) || maxDiffPixels < 0) throw new Error(`--max-diff-pixels must be a non-negative integer, got "${values["max-diff-pixels"]}"`);
      }
      let threshold;
      if (values.threshold !== undefined) {
        threshold = Number(values.threshold);
        if (values.threshold.trim() === "" || !(threshold >= 0 && threshold <= 1)) throw new Error(`--threshold must be a number from 0 to 1, got "${values.threshold}"`);
      }
      const s = compare({ baseDir: path.resolve(values.base), headDir: path.resolve(values.head), outDir: path.resolve(values.out), baselinesDir: values.baselines && path.resolve(values.baselines), cfg: values.config ? loadConfig(values.config) : undefined, maxDiffPixels, threshold });
      console.log(`visual-kit: ${s.total} compared: ${s.changed} changed, ${s.new} new, ${s.removed} removed, ${s.same} identical`);
      // --base and --head are two captures of one tree: any shot that is not the same is nondeterminism, not a change.
      if (values["fail-on-unstable"]) {
        const unstable = s.entries.filter((e) => e.result !== "same");
        if (unstable.length) {
          const why = (e) => (e.result !== "changed" ? `${e.file}: ${e.result === "new" ? "only in the second run" : "only in the first run"}` : `${e.file}: ${e.resized ? "different size" : `${e.pixels} px differ`} (tolerance ${(e.tolerance ?? { maxDiffPixels: DEFAULT_MAX_DIFF_PIXELS }).maxDiffPixels} px)`);
          console.error(`visual-kit: determinism failure: ${unstable.length} shot(s) differ between two captures of the same tree:\n  - ${unstable.map(why).join("\n  - ")}`);
          return 4;
        }
      }
      if (values["fail-on-diff"] && (s.changed || s.removed)) return 2;
      if (values["fail-on-health"] && !s.health.ok) {
        console.error(`visual-kit: health gate: ${s.health.entries.length} shot(s) with new findings (${s.health.console} console, ${s.health.axe} axe)`);
        return 3;
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return command ? 64 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`visual-kit: ${err.message}`);
    process.exit(1);
  },
);
