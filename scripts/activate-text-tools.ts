import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteFile, getConfigDir, loadConfig } from "../src/config";
import { chromium } from "playwright-core";

const statusPath = resolve(getConfigDir(), "runtime", "text-tools-activation.json");
const writeStatus = (state: string, extra: Record<string, unknown> = {}) => atomicWriteFile(statusPath,
  JSON.stringify({ state, at: new Date().toISOString(), ...extra }, null, 2) + "\n");
let resume: (() => Promise<void>) | undefined;
try {
  const config = loadConfig();
  if (config.toolTransport !== "text" || config.useSavedChats) throw Error("Text tools configuration is not installed");
  const before = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(5_000) }).then(r => r.json()) as Record<string, unknown>;
  if (before.service !== "codex-chatgpt-web" || !Number.isInteger(before.pid)) throw Error("The current runtime could not be identified");
  const control = async (operation: "drain" | "resume") => {
    const response = await fetch(`http://127.0.0.1:${config.port}/admin/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw Error(`Runtime ${operation} failed (${response.status})`);
    return await response.json() as Record<string, unknown>;
  };
  resume = async () => { await control("resume"); };
  writeStatus("draining", { pid: before.pid });
  // Stop accepting new turns while existing streams finish; never cancel active work.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const health = await control("drain");
    if (health.accepting_turns !== false || !Number.isInteger(health.active_http_turns)
      || !Number.isInteger(health.active_browser_turns)) throw Error("Runtime did not acknowledge its drain contract");
    if (health.active_http_turns === 0 && health.active_browser_turns === 0) break;
    if (Date.now() >= deadline) throw Error("Runtime did not finish active requests; no task was stopped");
    await Bun.sleep(100);
  }
  writeStatus("activating");
  const descriptor = JSON.parse(readFileSync(config.browserHostDescriptorPath!, "utf8"));
  const browser = await chromium.connectOverCDP(descriptor.endpoint);
  try {
    const pages = browser.contexts().flatMap(c => c.pages()).filter(p => p.url().includes("app.asar/dist/index.html"));
    if (pages.length !== 1) throw Error("Launcher window is ambiguous");
    // Use the launcher's own setup/drain/restart transaction; never kill active processes.
    await pages[0]!.evaluate(async () => {
      const api = (window as unknown as { codexWebLauncher: { setUseSavedChats(enabled: boolean): Promise<unknown> } }).codexWebLauncher;
      await api.setUseSavedChats(false);
    });
  } finally { await browser.close(); }
  const health = await fetch(`http://127.0.0.1:${config.port}/healthz`).then(r => r.json()) as Record<string, unknown>;
  if (health.pid === before.pid) throw Error("The launcher did not replace the previous runtime process");
  if (health.tool_transport !== "text" || health.use_saved_chats !== false) throw Error("The restarted runtime did not enable Temporary Chat text tools");
  resume = undefined;
  writeStatus("ready", { pid: health.pid, useSavedChats: false, toolTransport: "text" });
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  try { await resume?.(); } catch (failure) { message += `; restoring request acceptance failed: ${String(failure)}`; }
  writeStatus("failed", { error: message });
  process.exitCode = 1;
}
