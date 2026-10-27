import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const POLL_MS = 50;

/**
 * The runner's end of the host-hook channel: a request file in a directory the launcher mounts, answered by
 * the launcher's watcher running the repo's `visual/host-hooks.sh` on the host (CONTRACT.md, "Host hooks").
 * Without a channel (`dir` unset) every call throws: the repo has no host hooks.
 */
export function createHost({ dir = process.env.VISUAL_KIT_HOSTCALL, timeoutSec = 30 } = {}) {
  let counter = 0;
  return async function host(name, ...args) {
    if (!dir) throw new Error(`host("${name}"): this repo has no visual/host-hooks.sh (the launcher mounts the channel only when it exists)`);
    if (!NAME.test(name)) throw new Error(`host("${name}"): a hook name is lowercase letters, digits, dots, dashes and underscores`);
    const lines = args.map(String);
    if (lines.some((a) => /[\r\n]/.test(a))) throw new Error(`host("${name}"): arguments cannot contain a line break`);
    const n = `${process.pid}-${++counter}`;
    const req = path.join(dir, `req-${n}`);
    const res = path.join(dir, `res-${n}`);
    writeFileSync(`${req}.tmp`, `${[name, ...lines].join("\n")}\n`);
    renameSync(`${req}.tmp`, req);
    const deadline = Date.now() + timeoutSec * 1000;
    while (!existsSync(res)) {
      if (Date.now() > deadline) {
        rmSync(req, { force: true });
        throw new Error(`host("${name}"): no answer from the launcher within ${timeoutSec}s`);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    const [code, ...rest] = readFileSync(res, "utf8").split("\n");
    rmSync(res, { force: true });
    const out = rest.join("\n");
    if (code !== "0") throw new Error(`host("${name}") failed (exit ${code}): ${out.slice(0, 300)}`);
    return out;
  };
}
