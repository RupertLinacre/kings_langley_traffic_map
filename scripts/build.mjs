import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAppAssets } from "./assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Output is fixed relative to this script, never taken from a CLI argument.
const output = join(root, "dist");
const existing = await lstat(output).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
  throw new Error("Refusing to replace dist: expected a regular directory.");
}
const assets = await collectAppAssets(root);
const staging = await mkdtemp(join(root, ".dist-build-"));
try {
  for (const asset of assets) {
    const destination = join(staging, asset);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, asset), destination, { dereference: false });
  }
  // Copy everything successfully before replacing the previous build.
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  console.log(`Built ${assets.length} app assets in dist/.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
