import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { textToolEvents, textToolContextMessages } from "../src/adapters/chatgpt-web/text-tools";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, providerConfig } from "../src/config";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../src/responses/compaction";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";
import { resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import * as launcherHost from "../src/launcher-browser-host";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

const usage = { inputTokens: 1, outputTokens: 1 };

test("browser projection bounds large tool results without changing native history or error status", () => {
  const messages: any[] = [{ role: "toolResult", toolCallId: "read", toolName: "exec_command",
    isError: true, timestamp: 1, content: "BEGIN\n" + "large output\n".repeat(10000) + "\nEND" }];
  const before = JSON.stringify(messages);
  const projected = textToolContextMessages(messages);
  expect(JSON.stringify(messages)).toBe(before);
  expect(projected[0]).toMatchObject({ role: "toolResult", toolCallId: "read", isError: true });
  const content = projected[0]!.content as string;
  expect(content.length).toBeLessThan(13000);
  expect(content).toStartWith("BEGIN\n");
  expect(content).toEndWith("\nEND");
  expect(content).toContain("omitted");
  messages[0].content = [{ type: "text", text: "A".repeat(10000) }, { type: "image", imageUrl: "https://example.org/evidence.png" },
    { type: "text", text: "B".repeat(10000) }];
  const mixed = textToolContextMessages(messages)[0]!.content;
  expect(JSON.stringify(mixed).length).toBeLessThan(13000);
  expect(mixed).toContainEqual({ type: "image", imageUrl: "https://example.org/evidence.png" });
});

test("saved chats can use validated native text tools without enabling MCP", () => {
  expect(() => createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: "https://chatgpt.com",
    chatgptWeb: { textToolsEnabled: true, localToolsEnabled: false, useSavedChats: true, solAvailable: true },
  })).not.toThrow();
});
function request(): CodexParsedRequest {
  const id = randomUUID();
  return {
    modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
    context: {
      messages: [{ role: "user", content: "Read the current directory, then report it.", timestamp: 1 }],
      tools: [{ namespace: "functions", name: "exec_command", description: "Run a shell command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false } }],
    },
    _rawBody: {
      prompt_cache_key: id,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: id }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read the current directory, then report it." }],
        internal_chat_message_metadata_passthrough: { turn_id: id } }],
    },
  };
}

test("a trusted workspace routes to its saved project while other workspaces keep their privacy mode", async () => {
  const root = resolve("test-workspaces", "hh");
  const projectUrl = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-demo/project";
  let cwd = root;
  const environment = spyOn(ChatGptThreadEnvironmentStore.prototype, "resolve").mockImplementation(() => ({
    cwd, roots: [cwd], writableRoots: [cwd], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  }));
  const routes: (string | undefined)[] = [];
  const browser = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({ appName: "Codex Native2",
    async run(turn: any) {
      routes.push(turn.projectUrl);
      await turn.prepare();
      const answer = '{"kind":"final","text":"ok"}';
      turn.onTextDelta(answer); return answer;
    },
  } as any);
  try {
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `project-test://${randomUUID()}`,
      chatgptWeb: { textToolsEnabled: true, localToolsEnabled: false, useSavedChats: false, solAvailable: true,
        savedChatProjects: [{ root, url: projectUrl }] } });
    for (cwd of [root, resolve(root, "src"), root + "-other"]) {
      const events: AdapterEvent[] = [];
      await adapter.runTurn(request(), { headers: new Headers() }, event => events.push(event));
      expect(events.some(event => event.type === "error")).toBeFalse();
    }
    expect(routes).toEqual([projectUrl, projectUrl, undefined]);
  } finally { browser.mockRestore(); environment.mockRestore(); }
});

test.each(["project", "standalone"])("%s checkpoint uses the existing chat and only its unseen suffix before rollover", async scope => {
  const release = spyOn(launcherHost, "releaseLauncherRetainedConversation").mockResolvedValue(0);
  const root = resolve("test-workspaces", "checkpoint");
  const projectUrl = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-demo/project";
  const environment = spyOn(ChatGptThreadEnvironmentStore.prototype, "resolve").mockReturnValue({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  });
  const keys: unknown[] = [];
  const prompts: string[] = [];
  const browser = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({ appName: "Codex Native2",
    async run(turn: any) {
      keys.push(turn.conversationKey);
      expect(turn.projectUrl).toBe(scope === "project" ? projectUrl : undefined);
      const reused = keys.length === 2;
      const compiled = await (reused ? turn.prepareResume() : turn.prepare());
      if (turn.compaction) expect(compiled.multipart).toBeUndefined();
      await turn.onPreparedSelected?.(reused);
      prompts.push(compiled.text);
      const answer = turn.compaction ? "The diagnostic completed. Continue its pending verification." : '{"kind":"final","text":"done"}';
      turn.onTextDelta(answer); return answer;
    },
  } as any);
  try {
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `project-checkpoint://${randomUUID()}`,
      chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: "synthetic-project-descriptor.json",
        experimentalBiggerContext: true,
        textToolsEnabled: true, localToolsEnabled: false, useSavedChats: scope === "standalone", solAvailable: true,
        savedChatProjects: scope === "project" ? [{ root, url: projectUrl }] : [] } });
    const parsed = request();
    parsed.context.messages[0]!.content = "UNIQUE_INITIAL_PROJECT_CONTEXT";
    await adapter.runTurn(parsed, { headers: new Headers() }, () => {});
    const compact = structuredClone(parsed);
    compact._compactionRequest = true;
    compact.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: 2 });
    (compact._rawBody as any).input.push({ type: "message", role: "user", content: COMPACT_PROMPT });
    const events: AdapterEvent[] = [];
    await adapter.runTurn(compact, { headers: new Headers() }, event => events.push(event));
    expect(events.some(event => event.type === "error")).toBeFalse();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(prompts[1]).toContain(COMPACT_PROMPT.split("\n")[0]!);
    expect(prompts[1]).not.toContain("UNIQUE_INITIAL_PROJECT_CONTEXT");
    expect(release).toHaveBeenCalledTimes(1);
    const next = structuredClone(parsed);
    const summary = `${SUMMARY_PREFIX}\nThe diagnostic completed. Continue its pending verification.`;
    next.context.messages.push({ role: "user", content: summary, timestamp: 3 });
    (next._rawBody as any).input.push({ type: "message", role: "user", content: summary });
    await adapter.runTurn(next, { headers: new Headers() }, () => {});
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBeDefined();
    expect(keys[2]).not.toBe(keys[0]);
    expect(prompts[2]).toContain("Continue its pending verification");
    expect(release).toHaveBeenCalledTimes(1);
  } finally { browser.mockRestore(); environment.mockRestore(); release.mockRestore(); }
});

test("valid call is relayed to native Codex; malformed, unknown and invalid calls fail closed", () => {
  const parsed = request();
  const answer = JSON.stringify({ kind: "tool", name: "functions__exec_command", arguments: { cmd: "pwd" } });
  expect(textToolEvents(answer, parsed, "stable-id", usage)).toEqual([
    { type: "tool_call_start", id: "stable-id", name: "functions__exec_command" },
    { type: "tool_call_delta", arguments: '{"cmd":"pwd"}' },
    { type: "tool_call_end" }, { type: "done", stopReason: "tool_use", endTurn: false, usage },
  ]);
  expect(textToolEvents("```json\n" + answer + "\n```", parsed, "stable-id", usage)).toEqual(textToolEvents(answer, parsed, "stable-id", usage));
  for (const invalid of [answer.replace("functions__exec_command", "invented_tool"), answer.replace('"pwd"', "42"),
    JSON.stringify({ kind: "tool", name: "functions__exec_command", arguments: { cmd: "pwd", extra: true } }),
  ]) expect(() => textToolEvents(invalid, parsed, "id", usage)).toThrow();
  parsed.options.toolChoice = "none";
  expect(() => textToolEvents(answer, parsed, "id", usage)).toThrow();
});

test("invalid auto-mode envelopes finish clearly without executing a local tool", () => {
  const parsed = request();
  const response = "I could not format the tool request.";
  const expected: AdapterEvent[] = [
    { type: "text_delta", text: "ChatGPT Web returned an invalid tool response. No local tool was run; retry the original request.", phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true, usage },
  ];
  const events = textToolEvents(response, parsed, "id", usage);
  expect(textToolEvents(response + "\n```json\n{not-json}\n```", parsed, "id", usage)).toEqual(expected);
  expect(textToolEvents(response.slice(0, -1), parsed, "id", usage)).toEqual(expected);
  expect(events).toEqual(expected);
  expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
  parsed.options.toolChoice = "required";
  expect(() => textToolEvents("I could not format the tool request.", parsed, "id", usage)).toThrow();
  parsed.options.toolChoice = "auto";
  parsed.options.outputFormat = { type: "json_schema", name: "result", strict: true, schema: { type: "object" } };
  expect(() => textToolEvents(response, parsed, "id", usage)).toThrow();
});

test("one redundant closing brace after a complete envelope preserves the exact validated call", () => {
  const parsed = request();
  const cmd = "Get-Content 'C:\\sample\\file.txt'\nWrite-Output '{\"value\":\"quoted\"}'";
  const valid = JSON.stringify({ kind: "tool", name: "functions__exec_command", arguments: { cmd } });
  const expected = textToolEvents(valid, parsed, "id", usage);
  for (const answer of [valid + "}", "```json\n" + valid + "}\n```", valid + "\n}\n"]) {
    expect(textToolEvents(answer, parsed, "id", usage)).toEqual(expected);
  }
  parsed.options.toolChoice = "required";
  for (const answer of [valid + "}}", valid + valid, valid + "} trailing", valid.slice(0, -1),
    valid.replace("functions__exec_command", "unknown") + "}",
    JSON.stringify({ kind: "tool", name: "functions__exec_command", arguments: { cmd: 42 } }) + "}",
  ]) expect(() => textToolEvents(answer, parsed, "id", usage)).toThrow();
});

test("freeform input survives exactly; tool choice is enforced", () => {
  const parsed = request();
  parsed.context.tools = [{ name: "apply_patch", description: "Patch", parameters: {}, freeform: true }];
  const input = "*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch\n";
  const events = textToolEvents(JSON.stringify({ kind: "tool", name: "apply_patch", arguments: { input } }), parsed, "id", usage);
  expect(events[1]).toEqual({ type: "tool_call_delta", arguments: JSON.stringify({ input }) });
  parsed.options.toolChoice = { allowedTools: [], mode: "auto" };
  expect(() => textToolEvents(JSON.stringify({ kind: "tool", name: "apply_patch", arguments: { input } }), parsed, "id", usage)).toThrow();
  parsed.options.toolChoice = "required";
  expect(() => textToolEvents('{"kind":"final","text":"done"}', parsed, "id", usage)).toThrow();
});

test("compiler exposes real schemas without a connector or read-only restriction", () => {
  const parsed = request();
  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false }, undefined, { textTools: true });
  expect(compiled.text).toContain("functions__exec_command");
  expect(compiled.text).toContain("exactly ONE JSON object");
  expect(compiled.text).not.toContain("cannot access the local");
  expect(compiled.turnToken).toBeUndefined();
  const config = { ...defaultConfig(), toolTransport: "text" as const, useSavedChats: false };
  expect(providerConfig(config).chatgptWeb).toMatchObject({ localToolsEnabled: false, textToolsEnabled: true, useSavedChats: false });
});

afterEach(() => { chatGptTurnSessions.clear(); });

test("an explicit single-question request streams plain text before browser completion", async () => {
  let release!: () => void;
  const completed = new Promise<void>(resolve => { release = resolve; });
  const events: AdapterEvent[] = [];
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({
    appName: "Codex Native2",
    async run(turn: any) {
      const compiled = await turn.prepare();
      expect(compiled.text).not.toContain("exactly ONE JSON object");
      expect(turn.retainConversation).not.toBeTrue();
      turn.onTextDelta("First sentence. ");
      await completed;
      turn.onTextDelta("Second sentence.");
      return "First sentence. Second sentence.";
    },
  } as any);
  try {
    const parsed = request();
    parsed.options.toolChoice = "none";
    parsed.context.tools = [];
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `plain-test://${randomUUID()}`,
      chatgptWeb: { textToolsEnabled: true, localToolsEnabled: false, useSavedChats: false, solAvailable: true } });
    const pending = adapter.runTurn(parsed, { headers: new Headers() }, event => events.push(event));
    try {
      for (let i = 0; i < 30 && !events.some(event => event.type === "text_delta"); i++) await Bun.sleep(10);
      expect(events.some(event => event.type === "text_delta" && event.text === "First sentence. ")).toBeTrue();
      expect(events.some(event => event.type === "done")).toBeFalse();
    } finally { release(); await pending; }
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("First sentence. Second sentence.");
    expect(events.filter(event => event.type === "done")).toHaveLength(1);
  } finally { release(); spy.mockRestore(); }
});

test.each(["advertised-tools", "implicit-choice", "history"])("%s preserves validated JSON transport", async scenario => {
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({
    appName: "Codex Native2",
    async run(turn: any) {
      expect((await turn.prepare()).text).toContain("exactly ONE JSON object");
      const answer = '{"kind":"final","text":"done"}';
      turn.onTextDelta(answer); return answer;
    },
  } as any);
  try {
    const parsed = request();
    parsed.options.toolChoice = "none";
    if (scenario !== "advertised-tools") parsed.context.tools = [];
    if (scenario === "implicit-choice") delete parsed.options.toolChoice;
    if (scenario === "history") parsed.context.messages.push({ role: "user", content: "Follow-up", timestamp: 2 });
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `guard-test://${randomUUID()}`,
      chatgptWeb: { textToolsEnabled: true, localToolsEnabled: false, useSavedChats: false, solAvailable: true } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, event => events.push(event));
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe("done");
    expect(events.some(event => event.type === "error")).toBeFalse();
  } finally { spy.mockRestore(); }
});

test("remote text-tool compaction excludes checkpoint-covered history before browser preflight", async () => {
  const parsed = request(); parsed._compactionRequest = true; parsed._chatgptModelFamily = "6";
  delete parsed.context.tools;
  parsed.context.messages = [
    { role: "user", timestamp: 1, content: [{ type: "text", text: "Covered earlier data: " + "old ".repeat(62000) },
      ...Array.from({ length: 10 }, (_, i) => ({ type: "image" as const, imageUrl: `https://example.org/old-${i}.png` }))] },
    { role: "developer", timestamp: 2, content: "Preserve the sandbox" },
    { role: "user", timestamp: 3, content: "Active task: finish the current check" },
    { role: "user", timestamp: 4, content: `${SUMMARY_PREFIX}\nCHECKPOINT_EVIDENCE: earlier findings and constraints.` },
    { role: "toolResult", timestamp: 5, toolName: "exec_command", toolCallId: "recent", isError: false, content: "RECENT_RESULT " + "new ".repeat(20000) },
    { role: "user", timestamp: 6, content: COMPACT_PROMPT },
  ];
  (parsed._rawBody as any).input.push({ type: "compaction_trigger" });
  const canonical = JSON.stringify(parsed);
  let compiledTokens = 0;
  let sends = 0;
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({ appName: "Codex Native2", async run(turn: any) {
    sends++;
    const compiled = await turn.prepare();
    compiledTokens = estimateCompiledChatGptWebInputTokens(compiled, turn.modelId);
    const messages = compiledChatGptWebMessages(compiled);
    assertChatGptWebMultipartInputWithinLimits(compiledTokens, Math.max(...messages.map(text => estimateTokens(text))),
      turn.modelId, "high", turn.capabilities, Math.max(...messages.map(text => text.length)), 6, undefined, "6");
    expect(compiled.images).toHaveLength(0);
    const payload = JSON.stringify(compiled);
    for (const evidence of ["Preserve the sandbox", "Active task", "CHECKPOINT_EVIDENCE", "RECENT_RESULT"]) expect(payload).toContain(evidence);
    expect(payload.includes("exactly ONE JSON object")).toBeFalse();
    const summary = "CHECKPOINT_OK: preserve the sandbox; finish the check using RECENT_RESULT.";
    turn.onTextDelta(summary); return summary;
  } } as any);
  try {
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `compact-test://${randomUUID()}`,
      chatgptWeb: { textToolsEnabled: true, localToolsEnabled: false, useSavedChats: false, solAvailable: true, experimentalBiggerContext: true } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, event => events.push(event));
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
    expect(events.find(event => event.type === "done")).toMatchObject({ usage: { inputTokens: compiledTokens } });
    expect(events.some(event => event.type === "text_delta" && event.text.startsWith("CHECKPOINT_OK"))).toBeTrue();
    expect(JSON.stringify(parsed)).toBe(canonical);
    const replay: AdapterEvent[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, event => replay.push(event));
    expect(sends).toBe(1);
    expect(replay.filter(event => event.type !== "heartbeat")).toEqual(events.filter(event => event.type !== "heartbeat"));
  } finally { spy.mockRestore(); }
});

test("text compaction keeps original evidence when no readable checkpoint covers it", () => {
  const parsed = request(); parsed._compactionRequest = true;
  parsed.context.messages.unshift({ role: "user", timestamp: 0, content: [
    { type: "text", text: "Original uncovered evidence" }, { type: "image", imageUrl: "https://example.org/evidence.png" },
  ] });
  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    undefined, { textTools: true, experimentalMultipartParts: 6 });
  expect(JSON.stringify(compiled)).toContain("Original uncovered evidence");
  expect(compiled.images).toHaveLength(1);
});

test("a compaction checkpoint replaces covered user history in the browser, preserving the active request", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", content: [{ type: "text", text: "covered old attachment " + "old ".repeat(40000) },
      { type: "image", imageUrl: "https://example.org/covered.png" }], timestamp: 1 },
    { role: "developer", content: "Preserve the sandbox", timestamp: 2 },
    { role: "user", content: "Continue the active task", timestamp: 3 },
    { role: "user", content: `${SUMMARY_PREFIX}\nCheckpoint: earlier evidence and remaining work.`, timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "Latest steering" },
      { type: "image", imageUrl: "https://example.org/current.png" }], timestamp: 5 },
  ];
  const before = JSON.stringify(parsed);
  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false }, undefined, { textTools: true });
  expect(compiled.text.includes("covered old attachment")).toBeFalse();
  for (const text of ["Preserve the sandbox", "Continue the active task", "Checkpoint: earlier evidence", "Latest steering"]) expect(compiled.text).toContain(text);
  expect(JSON.stringify(parsed)).toBe(before);
  expect(compiled.images.map(image => image.imageUrl)).toEqual(["https://example.org/current.png"]);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(15000);
});

test.each(["direct", "helper"])("%s: text tools retain one Temporary Chat and count its transcript", async transport => {
  const keys: string[] = [];
  const prompts: string[] = [];
  const sizes: number[] = [];
  let firstAnswer = "";
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({
    appName: "Codex Native2",
    async run(turn: any) {
      expect(turn.retainConversation).toBeTrue();
      expect(typeof turn.conversationKey).toBe("string");
      keys.push(turn.conversationKey);
      const reused = prompts.length > 0;
      if (transport === "direct") await turn.onPreparedSelected?.(reused);
      const compiled = await (prompts.length ? turn.prepareResume() : turn.prepare());
      if (transport === "helper") await turn.onPreparedSelected?.(reused);
      prompts.push(compiled.text);
      sizes.push(estimateCompiledChatGptWebInputTokens(compiled, turn.modelId));
      const answer = prompts.length === 1
        ? '{"kind":"tool","name":"functions__exec_command","arguments":{"cmd":"pwd"}}'
        : '{"kind":"final","text":"retained result"}';
      if (prompts.length === 1) firstAnswer = answer;
      turn.onTextDelta(answer); return answer;
    },
  } as any);
  try {
    const parsed = request();
    parsed.context.systemPrompt = ["Unique original system instruction"];
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `retention-test://${randomUUID()}`,
      chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: "synthetic-descriptor.json",
        textToolsEnabled: true, localToolsEnabled: false, useSavedChats: false, solAvailable: true } });
    const first: AdapterEvent[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, e => first.push(e));
    const call = first.find(e => e.type === "tool_call_start");
    if (call?.type !== "tool_call_start") throw Error("Expected a real tool request");
    const next = structuredClone(parsed);
    next.context.messages.forEach(message => { message.timestamp += 100; });
    next.context.messages.push({ role: "toolResult", toolCallId: call.id, toolName: "exec_command", content: "Only new tool result", isError: false, timestamp: 2 });
    (next._rawBody as any).input.push({ type: "function_call_output", call_id: call.id, output: "Only new tool result" });
    const final: AdapterEvent[] = [];
    await adapter.runTurn(next, { headers: new Headers() }, e => final.push(e));
    expect(final).toContainEqual({ type: "text_delta", text: "retained result", phase: "final_answer" });
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    expect(prompts[1]).toContain("Only new tool result");
    expect(prompts[1]).not.toContain("Read the current directory");
    expect(prompts[1]).not.toContain("Unique original system instruction");
    expect(prompts[1]).not.toContain("Run a shell command");
    expect(final.find(e => e.type === "done")).toMatchObject({ usage: {
      inputTokens: sizes[0]! + estimateTokens(firstAnswer) + sizes[1]! - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
    } });
    const steering = structuredClone(next);
    steering.context.systemPrompt!.push("Updated approval policy");
    steering.context.tools![0]!.description = "Updated tool schema";
    steering.context.messages.push({ role: "user", content: "New user instruction", timestamp: 300 });
    (steering._rawBody as any).input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "New user instruction" }] });
    const third: AdapterEvent[] = [];
    await adapter.runTurn(steering, { headers: new Headers() }, e => third.push(e));
    expect(third.some(e => e.type === "error")).toBeFalse();
    expect(keys[2]).toBe(keys[0]);
    for (const text of ["Updated approval policy", "Updated tool schema", "New user instruction"]) expect(prompts[2]).toContain(text);
    expect(prompts[2]).not.toContain("Only new tool result");
    const freshUser = structuredClone(steering);
    freshUser.context.messages.push({ role: "user", content: "Inspect the actual local process now", timestamp: 400 });
    (freshUser._rawBody as any).input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the actual local process now" }] });
    const fourth: AdapterEvent[] = [];
    await adapter.runTurn(freshUser, { headers: new Headers() }, e => fourth.push(e));
    expect(keys[3]).toBe(keys[0]);
    expect(prompts[3]).toContain("Updated tool schema");
    expect(prompts[3]).toContain("functions__exec_command");
    expect(prompts[3]).toContain("Inspect the actual local process now");
    expect(prompts[3]).not.toContain("New user instruction");
  } finally { spy.mockRestore(); }
});

test("an upload quota is replayed as a terminal error without another browser attempt", async () => {
  let sends = 0;
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({
    appName: "Codex Native2",
    async run() {
      sends++;
      throw new ChatGptWebAdapterError("ChatGPT file-upload limit: try again at 16:04", {
        status: 429, errorType: "rate_limit_error", code: "upload_quota_exceeded", retryable: false,
      });
    },
  } as any);
  try {
    const parsed = request();
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `quota-test://${randomUUID()}`,
      chatgptWeb: { textToolsEnabled: true, localToolsEnabled: false, useSavedChats: false, solAvailable: true } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const events: AdapterEvent[] = [];
      await adapter.runTurn(parsed, { headers: new Headers() }, e => events.push(e));
      expect(events.find(e => e.type === "error")).toMatchObject({
        status: 429, errorType: "rate_limit_error", code: "upload_quota_exceeded", retryable: false,
      });
      expect(events.some(e => e.type === "tool_call_start" || e.type === "text_delta")).toBeFalse();
    }
    expect(sends).toBe(1);
  } finally { spy.mockRestore(); }
});

test("text tool schemas count toward multipart planning and native auto-compaction usage", () => {
  const parsed = request();
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 5 }, (_, index) => ({
    role: "user", content: `record ${index}: ${"word ".repeat(10_000)}`, timestamp: index + 1,
  }));
  parsed.context.tools![0]!.description = "schema documentation ".repeat(20_000);
  const caps = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  expect(resolveBiggerContextMultipartParts(parsed, caps)).toBeUndefined();
  const parts = resolveBiggerContextMultipartParts(parsed, caps, false, undefined, true);
  expect(parts).toBeDefined();
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { textTools: true, experimentalMultipartParts: parts });
  expect(compiled.multipart).toBeDefined();
  const actual = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  expect(actual).toBeGreaterThan(90_000);
  expect(estimateChatGptWebUsage(parsed, {}, caps, true, false, undefined, true).inputTokens).toBe(actual);
});

test("adapter replays identical call IDs and runs a new browser round only after a tool result", async () => {
  let sends = 0;
  const inputTokens: number[] = [];
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({
    appName: "Codex Native2",
    async run(turn: any) {
      const compiled = await turn.prepare();
      inputTokens.push(estimateCompiledChatGptWebInputTokens(compiled, turn.modelId));
      expect(compiled.turnToken).toBeUndefined();
      expect(turn.capabilities.localToolsEnabled).toBeFalse();
      const answer = sends++ === 0
        ? '{"kind":"tool","name":"functions__exec_command","arguments":{"cmd":"pwd"}}'
        : '{"kind":"final","text":"Actual result: test-directory"}';
      turn.onTextDelta(answer);
      return answer;
    },
  } as any);
  try {
    const parsed = request();
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `text-test://${randomUUID()}`,
      chatgptWeb: { textToolsEnabled: true, localToolsEnabled: false, useSavedChats: false, solAvailable: true } });
    let interruptedCallId: string | undefined;
    await expect(adapter.runTurn(parsed, { headers: new Headers() }, event => {
      if (event.type === "tool_call_start") {
        interruptedCallId = event.id;
        throw Error("Synthetic disconnected observer");
      }
    })).rejects.toThrow();
    const events: AdapterEvent[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, e => events.push(e));
    const replay: AdapterEvent[] = [];
    await adapter.runTurn(parsed, { headers: new Headers() }, e => replay.push(e));
    expect(sends).toBe(1);
    expect(replay.filter(e => e.type !== "heartbeat")).toEqual(events.filter(e => e.type !== "heartbeat"));
    const call = events.find(e => e.type === "tool_call_start");
    if (call?.type !== "tool_call_start") throw Error("Expected native tool call");
    if (!interruptedCallId) throw Error("Expected interrupted native tool call");
    expect(call.id).toBe(interruptedCallId);
    expect(events.find(e => e.type === "done")).toMatchObject({ usage: { inputTokens: inputTokens[0] } });
    expect(events.some(e => e.type === "text_delta" && e.text.includes('"kind"'))).toBeFalse();
    const continued = structuredClone(parsed);
    continued.context.messages.push({ role: "toolResult", toolCallId: call.id, toolName: "exec_command", content: "test-directory", isError: false, timestamp: 2 });
    (continued._rawBody as any).input.push({ type: "function_call_output", call_id: call.id, output: "test-directory" });
    const final: AdapterEvent[] = [];
    await adapter.runTurn(continued, { headers: new Headers() }, e => final.push(e));
    expect(sends).toBe(2);
    expect(final.find(e => e.type === "done")).toMatchObject({ usage: { inputTokens: inputTokens[1] } });
    expect(final).toContainEqual({ type: "text_delta", text: "Actual result: test-directory", phase: "final_answer" });
    expect(final.some(e => e.type === "tool_call_start")).toBeFalse();
  } finally { spy.mockRestore(); }
});
