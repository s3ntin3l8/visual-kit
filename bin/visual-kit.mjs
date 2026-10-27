#!/usr/bin/env node
// visual-kit: runs inside the image. The host-side launcher (host/run.sh) boots the demo and
// calls these subcommands; see CONTRACT.md.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { capture } from "../src/capture.mjs";
import { compare } from "../src/compare.mjs";
import { hostEnv, loadConfig } from "../src/config.mjs";
import { PROFILES } from "../src/profiles.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage:
  visual-kit capture <${Object.keys(PROFILES).join("|")}> --config FILE --url URL --out DIR [--routes a,b] [--baseline-only]
  visual-kit compare --base DIR --head DIR --out DIR [--baselines DIR [--config FILE]] [--max-diff-pixels N] [--fail-on-diff]
  visual-kit env --config FILE      shell assignments for the host launcher
  visual-kit host-files             tar of host/ on stdout (the launcher the Makefile extracts)
  visual-kit validate --config FILE
  visual-kit version`;

const options = {
  config: { type: "string", default: "visual/scenes.json" },
  url: { type: "string" },
  out: { type: "string" },
  routes: { type: "string", default: "" },
  base: { type: "string" },
  head: { type: "string" },
  baselines: { type: "string" },
  "baseline-only": { type: "boolean", default: false },
  "max-diff-pixels": { type: "string", default: "20" },
  "fail-on-diff": { type: "boolean", default: false },
};

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  const [command, arg] = positionals;
  switch (command) {
    case "version":
      console.log(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
      return 0;
    case "host-files":
      return spawnSync("tar", ["-C", path.join(root, "host"), "-cf", "-", "."], { stdio: "inherit" }).status ?? 1;
    case "validate":
      loadConfig(values.config);
      console.log(`${values.config}: ok`);
      return 0;
    case "env":
      console.log(hostEnv(loadConfig(values.config)));
      return 0;
    case "capture": {
      if (!PROFILES[arg]) throw new Error(`capture needs a profile: ${Object.keys(PROFILES).join(" | ")}`);
      if (!values.url || !values.out) throw new Error("capture needs --url and --out");
      const cfg = loadConfig(values.config);
      const hooksFile = path.join(path.dirname(values.config), "hooks.mjs");
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
      const maxDiffPixels = Number(values["max-diff-pixels"]);
      if (!Number.isInteger(maxDiffPixels) || maxDiffPixels < 0) throw new Error(`--max-diff-pixels must be a non-negative integer, got "${values["max-diff-pixels"]}"`);
      const s = compare({ baseDir: path.resolve(values.base), headDir: path.resolve(values.head), outDir: path.resolve(values.out), baselinesDir: values.baselines && path.resolve(values.baselines), cfg: values.baselines && values.config && existsSync(values.config) ? loadConfig(values.config) : undefined, maxDiffPixels });
      console.log(`visual-kit: ${s.total} compared: ${s.changed} changed, ${s.new} new, ${s.removed} removed, ${s.same} identical`);
      return values["fail-on-diff"] && (s.changed || s.removed) ? 2 : 0;
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
