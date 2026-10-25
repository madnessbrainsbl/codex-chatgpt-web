import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { atomicWriteFile, getConfigDir, getConfigPath, loadConfig, saveConfig } from "../src/config";

const core = getConfigDir();
const config = loadConfig();
const installed = join(core, "versions", `${config.releaseVersion}-win32-x64`);
const embedded = join(process.env.LOCALAPPDATA!, "Programs", "Codex Web GPT", "resources", "runtime");
const targets = [installed, embedded];
const health = await fetch(`http://127.0.0.1:${config.port}/healthz`).then(r => r.json()) as Record<string, unknown>;
if (health.active_browser_turns !== 0) throw Error("Finish active Web turns before installation");
if (process.platform !== "win32" || resolve(core) !== resolve(homedir(), ".codex-chatgpt-web")) {
  throw Error("This local installer is scoped to the existing Windows user installation");
}
const require = createRequire(import.meta.url);
const { validateRuntimeBundle } = require("../launcher/electron/runtime-install.cjs");
const identity = { version: config.releaseVersion, platform: "win32", arch: "x64" };
for (const target of targets) validateRuntimeBundle(target, identity);
const bundles = [
  { name: "cli.js", entry: "../src/cli.ts", target: "bun" as const, format: "esm" as const },
  { name: "browser-helper.cjs", entry: "../src/adapters/chatgpt-web/browser-helper-main.ts", target: "node" as const, format: "cjs" as const },
];
const files = await Promise.all(bundles.map(async bundle => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, bundle.entry)],
    target: bundle.target, format: bundle.format, packages: "external", minify: true });
  if (!build.success || build.outputs.length !== 1) throw Error(`${bundle.name} build failed: ${build.logs.join("; ")}`);
  return { name: bundle.name, data: Buffer.from(await build.outputs[0]!.arrayBuffer()) };
}));
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const backup = join(core, "backups", `text-tools-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(backup, { recursive: true, mode: 0o700 });
copyFileSync(getConfigPath(), join(backup, "config.json"));
for (const [index, target] of targets.entries()) {
  for (const file of files) copyFileSync(join(target, "app", file.name), join(backup, `${index}-${file.name}`));
  copyFileSync(join(target, "manifest.json"), join(backup, `${index}-manifest.json`));
}
try {
  for (const target of targets) {
    const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
    for (const built of files) {
      const file = manifest.files.find((f: { path: string }) => f.path === `app/${built.name}`);
      if (!file) throw Error(`Runtime manifest does not declare ${built.name}`);
      atomicWriteFile(join(target, "app", built.name), built.data);
      file.size = built.data.length;
      file.sha256 = hash(built.data);
    }
    const digest = createHash("sha256");
    for (const entry of manifest.files) digest.update(`${entry.path}\0${entry.size}\0${entry.sha256}\0`);
    manifest.bundleId = digest.digest("hex");
    atomicWriteFile(join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    validateRuntimeBundle(target, identity);
    for (const built of files) {
      if (hash(readFileSync(join(target, "app", built.name))) !== hash(built.data)) throw Error(`${built.name} installation verification failed`);
    }
  }
  const left = JSON.parse(readFileSync(join(installed, "manifest.json"), "utf8"));
  const right = JSON.parse(readFileSync(join(embedded, "manifest.json"), "utf8"));
  if (left.bundleId !== right.bundleId) throw Error("Installed and packaged bundle identities differ");
  if (config.toolTransport !== "text" || config.useSavedChats) {
    saveConfig({ ...config, toolTransport: "text", useSavedChats: false });
  }
  if (!existsSync(getConfigPath()) || loadConfig().toolTransport !== "text") throw Error("Config verification failed");
  console.log(JSON.stringify({ installed: true, useSavedChats: false, backup,
    files: files.map(file => ({ name: file.name, sha256: hash(file.data) })) }));
} catch (error) {
  for (const [index, target] of targets.entries()) {
    for (const file of files) atomicWriteFile(join(target, "app", file.name), readFileSync(join(backup, `${index}-${file.name}`)));
    atomicWriteFile(join(target, "manifest.json"), readFileSync(join(backup, `${index}-manifest.json`)));
  }
  atomicWriteFile(getConfigPath(), readFileSync(join(backup, "config.json")));
  throw error;
}
