// A tiny static "demo" for visual-kit's own tests: serves fixtures/site and prints DEMO_READY.
// FIXTURE_ACCENT recolours the accent, which is the known change the self-test looks for.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const accent = process.env.FIXTURE_ACCENT ?? "#1a73e8";
const port = Number(process.env.FIXTURE_PORT ?? 4173);
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

createServer((req, res) => {
  const name = new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html");
  try {
    const file = path.join(site, path.normalize(name));
    if (!file.startsWith(site)) throw new Error("outside");
    const body = readFileSync(file, "utf8").replaceAll("__ACCENT__", accent);
    res.writeHead(200, { "content-type": `${types[path.extname(file)] ?? "text/plain"}; charset=utf-8` }).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`DEMO_READY url=http://127.0.0.1:${port}`));
process.on("SIGTERM", () => process.exit(0));
