import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { DEFAULT_TAGS, PROFILES } from "./profiles.mjs";

const schema = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../schema/scenes.schema.json"), "utf8"));
const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);

const ACTIONS = ["click", "hover", "fill", "press", "waitFor", "wait"];

/** Reads and validates a scenes file; throws one readable error listing every problem. */
export function loadConfig(file) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: ${err.code === "ENOENT" ? "not found" : `not valid JSON (${err.message})`}`, { cause: err });
  }
  const problems = [];
  if (!validateSchema(cfg)) {
    for (const e of validateSchema.errors) problems.push(`${e.instancePath || "/"} ${e.message}`);
  }
  if (!problems.length) problems.push(...semanticProblems(cfg));
  if (problems.length) throw new Error(`${file} is invalid:\n  - ${problems.join("\n  - ")}`);
  return cfg;
}

// Rules a JSON Schema cannot say: unique names, one action per step, known viewport names.
function semanticProblems(cfg) {
  const out = [];
  if (cfg.clock !== undefined && Number.isNaN(Date.parse(cfg.clock))) out.push(`clock "${cfg.clock}" is not a date-time (use e.g. 2026-10-01T09:00:00Z)`);
  const knownViewports = new Set([...Object.values(PROFILES).flatMap((p) => Object.keys(p.viewports)), ...Object.keys(cfg.viewports ?? {})]);
  const seen = new Set();
  cfg.scenes.forEach((scene, i) => {
    const where = `scenes[${i}] (${scene.name})`;
    if (seen.has(scene.name)) out.push(`${where}: the name is used twice`);
    seen.add(scene.name);
    (scene.steps ?? []).forEach((step, j) => {
      const actions = ACTIONS.filter((a) => a in step);
      if (actions.length !== 1) out.push(`${where}.steps[${j}] needs exactly one of ${ACTIONS.join(", ")}`);
      else if (actions[0] === "fill" && typeof step.value !== "string") out.push(`${where}.steps[${j}]: fill needs a "value"`);
      else if (actions[0] !== "fill" && "value" in step) out.push(`${where}.steps[${j}]: "value" belongs to fill only`);
    });
    if (scene.viewports?.length === 0) out.push(scene.stills === false ? `${where}: "viewports" is empty; drop it, a loop-only scene has no stills to limit` : `${where}: "viewports" is empty; for a scene that renders only its loop use "stills": false`);
    if (scene.baseline && !(scene.tags ?? DEFAULT_TAGS).includes("check")) out.push(`${where}: "baseline": true is a check feature; add the "check" tag`);
    if (scene.stills === false && !scene.loop) out.push(`${where}: "stills": false leaves nothing to render without a "loop"`);
    // Only presentation profiles record loops: any other tag set leaves a loop-only scene rendering nothing, anywhere.
    if (scene.stills === false && !(scene.tags ?? DEFAULT_TAGS).includes("presentation")) out.push(`${where}: a loop-only scene renders only in landing and readme; add the "presentation" tag`);
    for (const vp of scene.viewports ?? []) {
      if (!knownViewports.has(vp)) out.push(`${where}: unknown viewport "${vp}" (known: ${[...knownViewports].join(", ")})`);
    }
    if (scene.target && scene.clip) out.push(`${where}: use either target or clip, not both`);
    if (scene.loop && (scene.target || scene.clip)) out.push(`${where}: a loop records the whole viewport; drop target/clip`);
    if (scene.emphasis?.spotlight && scene.emphasis.css) out.push(`${where}: emphasis takes spotlight or css, not both`);
  });
  return out;
}

/** Quote for a POSIX shell, single-quoted. */
const q = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;

/** Shell assignments for the host-side launcher (`eval "$(visual-kit env …)"`). */
export function hostEnv(cfg) {
  const lines = [
    `DEMO_START=${q(cfg.demo.start)}`,
    `DEMO_URL=${q(cfg.demo.url)}`,
    `DEMO_READY=${q(cfg.demo.readyOutput ?? "DEMO_READY")}`,
    `DEMO_TIMEOUT=${q(cfg.demo.startTimeoutSec ?? 300)}`,
    `BASE_DEPS=${q((cfg.baseDeps ?? []).join(" "))}`,
    `CACHE_KEY_FILES=${q((cfg.cacheKeyFiles ?? []).join(" "))}`,
  ];
  for (const [k, v] of Object.entries(cfg.demo.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`demo.env key "${k}" is not a valid variable name`);
    lines.push(`export ${k}=${q(v)}`);
  }
  return lines.join("\n");
}
