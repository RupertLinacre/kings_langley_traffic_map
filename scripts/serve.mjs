import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createStaticServer } from "./static-server.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const [mode = "dev", ...args] = process.argv.slice(2);
if (mode !== "dev" && mode !== "preview") throw new Error("Mode must be dev or preview.");
let host = "localhost";
let port = mode === "preview" ? 4174 : 4173;
for (let i = 0; i < args.length; i++) {
  const [flag, inline] = args[i].split("=");
  if (flag !== "--host" && flag !== "--port") throw new Error(`Unknown option: ${args[i]}`);
  const value = inline ?? args[++i];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  if (flag === "--host") host = value;
  else {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      throw new Error("--port must be an integer from 1 to 65535.");
    }
    port = Number(value);
  }
}
const root = mode === "preview" ? join(repositoryRoot, "dist") : repositoryRoot;
try {
  const server = await createStaticServer(root);
  server.on("error", (error) => {
    console.error(`Unable to start server: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const address = host.includes(":") ? `[${host}]` : host;
    console.log(`Kings Langley ${mode}: http://${address}:${port}`);
    console.log("Press Ctrl+C to stop.");
  });
} catch (error) {
  console.error(mode === "preview" && error.code === "ENOENT"
    ? "No production build found. Run npm run build first."
    : error.message);
  process.exitCode = 1;
}
