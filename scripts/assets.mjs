import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";

// Keep development serving and production copying on the same explicit policy.
export function isAppAsset(path) {
  return path === "index.html"
    || path === "favicon.svg"
    || /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|js|css|svg|png|webp|woff2)$/.test(path)
    || /^data\/kings-langley\/(?:network\.json|demand\.json|README\.md)$/.test(path);
}

export async function collectAppAssets(root) {
  const files = [];
  const dataDirectory = await lstat(join(root, "data"));
  if (!dataDirectory.isDirectory() || dataDirectory.isSymbolicLink()) {
    throw new Error("App data must be a regular directory.");
  }
  async function walk(relative) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`App assets must not be symbolic links: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && isAppAsset(path)) files.push(path);
    }
  }
  for (const path of ["index.html", "favicon.svg", "src", "data/kings-langley"]) {
    const entry = await lstat(join(root, path));
    if (entry.isSymbolicLink()) throw new Error(`App assets must not be symbolic links: ${path}`);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && isAppAsset(path)) files.push(path);
  }
  return files.sort();
}
