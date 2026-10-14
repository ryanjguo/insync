import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

// The server the extension connects to unless the user picks another. Set
// INSYNC_SERVER (e.g. wss://insync-server.fly.dev/ws) to build for a deployed one.
const server = process.env.INSYNC_SERVER ?? "ws://localhost:8080/ws";
if (!/^wss?:\/\/./.test(server))
  throw new Error(`INSYNC_SERVER must be a ws:// or wss:// URL, got ${server}`);

const outdir = new URL("./dist/", import.meta.url).pathname;
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir,
  define: { __INSYNC_SERVER__: JSON.stringify(server) },
  logLevel: "info",
});
cpSync("static", outdir, { recursive: true });
