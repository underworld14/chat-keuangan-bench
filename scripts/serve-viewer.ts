/**
 * Local static preview for docs/viewer/ (same relative paths as GitHub Pages).
 *
 *   bun run viewer
 *   → http://127.0.0.1:4173/viewer/
 */

import { resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "../docs");
const port = Number(process.env.VIEWER_PORT || 4173);
const hostname = process.env.VIEWER_HOST || "127.0.0.1";

function isInsideRoot(filePath: string): boolean {
  return filePath === root || filePath.startsWith(root + sep);
}

const server = Bun.serve({
  port,
  hostname,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === "/" || pathname === "/viewer") {
      return Response.redirect(new URL("/viewer/", url).toString(), 302);
    }
    if (pathname.endsWith("/")) pathname += "index.html";

    const filePath = resolve(root, "." + pathname);
    if (!isInsideRoot(filePath)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response(`Not found: ${pathname}`, { status: 404 });
    }
    return new Response(file);
  },
});

console.log(`Parse viewer → http://${hostname}:${server.port}/viewer/`);
console.log(`Serving static root: ${root}`);
