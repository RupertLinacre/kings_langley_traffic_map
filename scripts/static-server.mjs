import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { isAppAsset } from "./assets.mjs";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
};

export async function createStaticServer(root) {
  const canonicalRoot = await realpath(root);
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-cache");
    const reply = (status, text) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : text);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return reply(405, "Method not allowed\n");
    }
    let path;
    try {
      // Inspect raw segments before URL normalization could hide a traversal.
      path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    } catch {
      return reply(400, "Invalid URL\n");
    }
    if (!path.startsWith("/") || path.includes("\\") || path.includes("\0")
      || path.split("/").some((part) => part === "." || part === "..")) {
      return reply(400, "Invalid path\n");
    }
    const asset = path === "/" ? "index.html" : path.slice(1);
    if (!isAppAsset(asset)) return reply(404, "Not found\n");
    try {
      const candidate = join(canonicalRoot, asset);
      const resolved = await realpath(candidate);
      const localPath = relative(canonicalRoot, resolved);
      if (resolved !== candidate || localPath === ".." || localPath.startsWith(`..${sep}`) || !localPath) {
        return reply(404, "Not found\n");
      }
      const info = await stat(resolved);
      if (!info.isFile()) return reply(404, "Not found\n");
      const body = request.method === "HEAD" ? null : await readFile(resolved);
      response.setHeader("Content-Type", mime[extname(asset)] ?? "application/octet-stream");
      response.setHeader("Content-Length", body?.length ?? info.size);
      response.end(body);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") {
        return reply(404, "Not found\n");
      }
      console.error("Unable to serve asset:", error.message);
      reply(500, "Unable to serve file\n");
    }
  });
}
