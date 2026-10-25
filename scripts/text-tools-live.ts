import { resolve } from "node:path";
import { defaultBrokerEndpoint, loadConfig } from "../src/config";
import { startServer } from "../src/server";

const config = loadConfig();
// Isolate continuation/diagnostic state; keep the launcher's existing authenticated browser.
const state = resolve(import.meta.dir, "../.text-tools-live");
process.env.CODEX_CHATGPT_WEB_HOME = state;
startServer({
  ...config, mode: "browser-only", toolTransport: "text", useSavedChats: false,
  port: 17842, brokerSocketPath: defaultBrokerEndpoint(state),
  experimentalBiggerContext: config.experimentalBiggerContext,
});
