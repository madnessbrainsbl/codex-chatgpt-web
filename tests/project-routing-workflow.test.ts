import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

test("unbound projects ask once, persist an explicit reply, and continue the original task without restarting", async () => {
  const temp = mkdtempSync(join(tmpdir(), "chat-project-routing-"));
  const root = join(temp, "workspace");
  const statePath = join(temp, "native.json");
  const configPath = join(temp, "config.json");
  const id = randomUUID();
  writeFileSync(statePath, JSON.stringify({ "local-projects": { project: { name: "Example", rootPaths: [root] } },
    "thread-project-assignments": { [id]: { projectKind: "local", projectId: "project" } } }));
  writeFileSync(configPath, JSON.stringify({ projectChatRouting: true, savedChatProjects: [], unrelated: "preserve" }));
  const environment = spyOn(ChatGptThreadEnvironmentStore.prototype, "resolve").mockReturnValue({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  });
  let sends = 0;
  const url = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-example/project";
  const browser = spyOn(ChatGptBrowserWorker, "forProvider").mockImplementation((provider: any) => {
    expect(provider.chatgptWeb.useTemporaryChats).toBeTrue();
    return { appName: "Codex Native2", async run(turn: any) {
      sends++;
      expect(turn.projectUrl).toBe(url);
      const prompt = (await turn.prepare()).text;
      expect(prompt).toContain("ORIGINAL_TASK");
      expect(prompt).toContain("routing setup is complete");
      const answer = '{"kind":"final","text":"Task continued"}'; turn.onTextDelta(answer); return answer;
    } } as any;
  });
  try {
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `routing-workflow://${id}`,
      chatgptWeb: { projectChatRouting: true, nativeProjectStatePath: statePath, projectRoutingConfigPath: configPath,
        textToolsEnabled: true, useTemporaryChats: true, solAvailable: true, localToolsEnabled: false } } as any);
    const parsed: any = { modelId: "gpt-5.6-sol", options: { reasoning: "high" }, context: {
      messages: [{ role: "user", content: "ORIGINAL_TASK", timestamp: 1 }], tools: [] },
      _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: id }) },
        input: [{ type: "message", role: "user", content: "ORIGINAL_TASK", internal_chat_message_metadata_passthrough: { turn_id: id } }] } };
    const events: any[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, event => events.push(event));
    const question = events.filter(event => event.type === "text_delta").map(event => event.text).join("");
    expect(question).toContain("Создай");
    expect(sends).toBe(0);
    parsed.context.messages.push({ role: "assistant", content: [{ type: "text", text: question }], timestamp: 2 },
      { role: "user", content: url, timestamp: 3 });
    parsed._rawBody.input.push({ type: "message", role: "assistant", content: question },
      { type: "message", role: "user", content: url, internal_chat_message_metadata_passthrough: { turn_id: id } });
    const canonical = JSON.stringify(parsed);
    const answer: any[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, event => answer.push(event));
    expect(sends).toBe(1);
    expect(answer.some(event => event.type === "error")).toBeFalse();
    expect(JSON.stringify(parsed)).toBe(canonical);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ unrelated: "preserve", savedChatProjects: [{ root, url }] });
    chatGptTurnSessions.clear();
    await adapter.runTurn(parsed, { headers: new Headers() }, () => {});
    expect(sends).toBe(2);
  } finally {
    browser.mockRestore(); environment.mockRestore(); chatGptTurnSessions.clear(); rmSync(temp, { recursive: true, force: true });
  }
});

test.each(["standalone", "bound", "native-chatgpt", "compaction-unbound", "unsolicited-link"])("general routing keeps %s in its intended scope", async scenario => {
  const temp = mkdtempSync(join(tmpdir(), "chat-routing-scope-"));
  const root = join(temp, "workspace");
  const configPath = join(temp, "config.json");
  const statePath = join(temp, "native.json");
  const id = randomUUID();
  const url = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project";
  const unbound = scenario === "compaction-unbound" || scenario === "unsolicited-link";
  writeFileSync(configPath, JSON.stringify({ savedChatProjects: unbound ? [] : [{ root, url }] }));
  writeFileSync(statePath, JSON.stringify({ "local-projects": { local: { name: "Example", rootPaths: [root] } },
    "projectless-thread-ids": scenario === "standalone" ? [id] : [],
    "thread-project-assignments": scenario === "standalone" ? {} : { [id]: scenario === "native-chatgpt"
      ? { projectKind: "chatgpt", projectId: "g-p-0123456789abcdef0123456789abcdef" }
      : { projectKind: "local", projectId: "local" } } }));
  const environment = spyOn(ChatGptThreadEnvironmentStore.prototype, "resolve").mockReturnValue({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  });
  let sends = 0;
  const browser = spyOn(ChatGptBrowserWorker, "forProvider").mockImplementation((provider: any) => {
    expect(provider.chatgptWeb.useTemporaryChats).toBeTrue();
    expect(provider.chatgptWeb.experimentalFreshConversationPerTurn).toBeFalse();
    return { appName: "Codex Native2", async run(turn: any) {
      sends++;
      expect(turn.projectUrl).toBe(scenario === "standalone" ? undefined : url);
      await turn.prepare(); const answer = '{"kind":"final","text":"ok"}'; turn.onTextDelta(answer); return answer;
    } } as any;
  });
  try {
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `routing-scope://${id}`,
      chatgptWeb: { projectChatRouting: true, nativeProjectStatePath: statePath, projectRoutingConfigPath: configPath,
        textToolsEnabled: true, useTemporaryChats: true, experimentalFreshConversationPerTurn: true, solAvailable: true } } as any);
    const content = scenario === "unsolicited-link" ? url : "Inspect the workspace";
    const parsed: any = { modelId: "gpt-5.6-sol", options: {}, _compactionRequest: scenario === "compaction-unbound",
      context: { messages: [{ role: "user", content, timestamp: 1 }], tools: [{ name: "unused", parameters: {} }] },
      _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: id }) },
        input: [{ type: "message", role: "user", content, internal_chat_message_metadata_passthrough: { turn_id: id } }] } };
    const events: any[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, event => events.push(event));
    expect(sends).toBe(unbound ? 0 : 1);
    expect(events.some(event => event.type === "error")).toBe(scenario === "compaction-unbound");
    if (unbound) expect(JSON.parse(readFileSync(configPath, "utf8")).savedChatProjects).toEqual([]);
  } finally {
    browser.mockRestore(); environment.mockRestore(); chatGptTurnSessions.clear(); rmSync(temp, { recursive: true, force: true });
  }
});
