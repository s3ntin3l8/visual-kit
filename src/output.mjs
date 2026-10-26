import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const MARKER = ".visual-kit";

/** Replacing a folder is only for folders this tool wrote (or empty ones); anything else needs VISUAL_KIT_FORCE=1. */
export function guardReplace(dir) {
  if (!existsSync(dir) || process.env.VISUAL_KIT_FORCE === "1") return;
  if (existsSync(path.join(dir, MARKER)) || readdirSync(dir).length === 0) return;
  throw new Error(`${dir} exists, is not empty and was not written by visual-kit; refusing to replace it (pass --force to allow it once)`);
}
