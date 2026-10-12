import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const outdir = new URL("./dist/", import.meta.url).pathname;
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir,
  logLevel: "info",
});
cpSync("static", outdir, { recursive: true });
