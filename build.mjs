import { build } from "esbuild";
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const entries = {
  intercept: "src/intercept.ts",
  content: "src/content.ts",
  background: "src/background.ts",
  offscreen: "src/offscreen.ts",
  "mux-worker": "src/mux-worker.ts",
  popup: "src/pages/popup.ts",
  options: "src/pages/options.ts",
};
await build({
  entryPoints: entries,
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome110",
  sourcemap: false,
  logLevel: "info",
});
if (existsSync("public")) cpSync("public", "dist", { recursive: true });
