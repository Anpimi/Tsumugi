import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("storybook/package.json");
const manifest = require(manifestPath);
if (typeof manifest.bin !== "string") throw new Error("The pinned Storybook CLI has an unexpected entry point");
const mode = process.argv[2];
if (mode !== "dev" && mode !== "build") throw new Error("Use dev or build");
const args = mode === "dev" ? ["dev", "--host", "127.0.0.1", "--port", "16061", "--exact-port", "--ci", "--no-open"] : ["build"];
const child = spawn(process.execPath, [resolve(dirname(manifestPath), manifest.bin), ...args, ...process.argv.slice(3)], {
  stdio: "inherit", env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "true" },
});
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
