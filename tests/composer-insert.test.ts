import { afterEach, expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, insertPlainTextIntoComposer } from "../src/adapters/chatgpt-web/browser-worker";
import { adapterFailureFromMessage, httpStatusFromTerminalError } from "../src/lib/errors";

/**
 * The composer insert runs inside the page, where the caret state is whatever the last UI
 * interaction left behind. Effort selection closes a menu immediately before a staged part is
 * attached, so these fixtures model the focus and selection states that actually occur there.
 */
interface FakeSelection {
  isCollapsed: boolean;
  anchorNode: object | null;
  removeAllRanges(): void;
  addRange(range: object): void;
}

const originals = { document: globalThis.document, window: globalThis.window };
afterEach(() => {
  (globalThis as Record<string, unknown>).document = originals.document;
  (globalThis as Record<string, unknown>).window = originals.window;
});

function harness(options: {
  focusable: boolean;
  caretInsideComposer: boolean;
  collapsed?: boolean;
  execCommandResult?: boolean;
}) {
  const inside = { name: "text-node-inside-composer" };
  const composer = {
    focus() { if (options.focusable) fakeDocument.activeElement = composer; },
    contains: (node: object | null) => node === inside || node === composer,
  };
  const calls: Array<{ command: string; value: string }> = [];
  const selection: FakeSelection = {
    isCollapsed: options.collapsed ?? true,
    anchorNode: options.caretInsideComposer ? inside : { name: "node-in-the-effort-menu" },
    removeAllRanges() { selection.anchorNode = null; },
    addRange() { selection.anchorNode = inside; selection.isCollapsed = true; },
  };
  const fakeDocument = {
    activeElement: null as unknown,
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command: string, _ui: boolean, value: string) {
      calls.push({ command, value });
      return options.execCommandResult ?? true;
    },
  };
  (globalThis as Record<string, unknown>).document = fakeDocument;
  (globalThis as Record<string, unknown>).window = { getSelection: () => selection };
  return { composer: composer as unknown as HTMLElement, calls, selection, fakeDocument };
}

test("places the caret itself when focus has not yet produced one in the composer", () => {
  // A focusable composer may be ready before the browser has placed a caret inside it.
  const { composer, calls, selection } = harness({ focusable: true, caretInsideComposer: false });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeTrue();
  expect(calls).toEqual([{ command: "insertText", value: "staged part" }]);
  expect(selection.isCollapsed).toBeTrue();
});

test("leaves an existing caret inside the composer exactly where it is", () => {
  const { composer, calls, selection } = harness({ focusable: true, caretInsideComposer: true });
  const anchorBefore = selection.anchorNode;

  expect(insertPlainTextIntoComposer(composer, "second part")).toBeTrue();
  expect(selection.anchorNode).toBe(anchorBefore);
  expect(calls).toEqual([{ command: "insertText", value: "second part" }]);
});

test("refuses to insert when the composer cannot take focus at all", () => {
  // A covered or detached composer must still fail rather than have text typed somewhere else.
  const { composer, calls } = harness({ focusable: false, caretInsideComposer: false });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeFalse();
  expect(calls).toEqual([]);
});

test("reports a genuinely rejected edit as a failure", () => {
  const { composer } = harness({
    focusable: true,
    caretInsideComposer: true,
    execCommandResult: false,
  });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeFalse();
});

test("a missing composer reaches Codex as a browser failure instead of model capacity", () => {
  const message = "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.";
  const failure = adapterFailureFromMessage(message);
  expect(failure).toMatchObject({ httpStatus: 502, error: { message, code: "upstream_server_error" } });
  expect(httpStatusFromTerminalError(failure.error)).toBe(502);
  expect(adapterFailureFromMessage("The server is busy").error.code).toBe("server_is_overloaded");
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("saved-thread hydration never inserts into its optimistic composer", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: `
      <div data-map-composer-conversation="local-chatgpt:optimistic">
        <form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="min-height:40px"></div></form>
      </div>
      <div data-map-composer-conversation="server-thread" hidden>
        <form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="min-height:40px"></div></form>
      </div>
      <script>
        const outgoing=document.querySelector('[data-map-composer-conversation="local-chatgpt:optimistic"]');
        const current=document.querySelector('[data-map-composer-conversation="server-thread"]');
        const hydrate=()=>{outgoing.hidden=true;current.hidden=false;};
        outgoing.addEventListener('input',()=>{if(outgoing.textContent.trim())setTimeout(hydrate,0);});
        setTimeout(hydrate,500);
      </script>` }));
    await page.goto("https://chatgpt.com/c/server-thread");
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName: "Codex Native2" } }) as any;
    const prompt = "Literal `context` and spaces.\n".repeat(5_000).slice(0, 127_393);
    await worker.insertPromptText(page, prompt);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('[data-map-composer-conversation="server-thread"]')!.hidden);
    const observed = await worker.attachedPromptText(page);
    expect({ chars: observed.length, exact: observed === prompt }).toEqual({ chars: prompt.length, exact: true });
    expect((await page.locator('[data-map-composer-conversation="local-chatgpt:optimistic"] [contenteditable]').textContent())?.length).toBe(0);
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("saved-thread composer scope keeps legacy editors and excludes other conversations", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: "" }));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    for (const path of ["/c/current", "/g/g-p-0123456789abcdef0123456789abcdef-demo/c/current"]) {
      await page.goto("https://chatgpt.com" + path);
      await page.setContent(`<div data-map-composer-conversation="other"><form data-chatgpt-composer>
        <div data-composer-markdown contenteditable="true" role="textbox">Other draft</div>
      </form></div><form><div id="prompt-textarea" contenteditable="true">Legacy draft</div></form>`);
      const composer = await worker.activeComposer(page, 500);
      expect(await composer.innerText()).toBe("Legacy draft");
      await page.locator('#prompt-textarea').evaluate(element => element.remove());
      const error = await worker.activeComposer(page, 100).then(() => undefined, (error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.cause.message).toContain("count was 0");
      expect(await page.locator('[data-map-composer-conversation="other"]').innerText()).toContain("Other draft");
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("retained chats keep their sole local composer after acquiring a conversation URL", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: `
      <div data-map-composer-conversation="local-chatgpt:temporary">
        <form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="min-height:40px"></div></form>
      </div>` }));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    for (const path of ["/g/g-p-0123456789abcdef0123456789abcdef-demo/c/current", "/c/current", "/c/current?temporary-chat=true"]) {
      await page.goto("https://chatgpt.com" + path);
      const composer = await worker.activeComposer(page, 1_000);
      expect(await composer.isEditable()).toBeTrue();
      await worker.insertPromptText(page, "Real tool result");
      expect(await worker.attachedPromptText(page)).toBe("Real tool result");
      await page.locator("body").evaluate(element => element.insertAdjacentHTML("beforeend", `
        <form><div id="prompt-textarea" contenteditable="true">Other draft</div></form>`));
      await expect(worker.activeComposer(page, 500)).rejects.toBeInstanceOf(Error);
      expect(await page.locator("#prompt-textarea").innerText()).toBe("Other draft");
      await page.locator("#prompt-textarea").evaluate(element => element.parentElement!.remove());
      await page.locator("body").evaluate(element => element.insertAdjacentHTML("beforeend", `
        <div data-map-composer-conversation="other" hidden></div>`));
      await expect(worker.activeComposer(page, 500)).rejects.toBeInstanceOf(Error);
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a selected connector never appends a new request to an old draft", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { appName: "Codex Native2" },
    });
    const prompt = "Task context\n".repeat(5_000) + "\nrequest_id: current";
    for (const modern of [false, true]) {
      const pill = modern
        ? '<span app-mention-path="app://fixture" app-mention-display-name="Codex Native2" contenteditable="false">Codex Native2</span>'
        : '<span data-id="plugin:fixture" data-keyword="Codex Native2" contenteditable="false">Codex Native2</span>';
      for (const staleDraft of ["", prompt.replace("current", "earlier")]) {
        await page.setContent(`<form><div id="prompt-textarea" contenteditable="true" style="min-height:40px"></div></form>
          <div id="mention-menu" hidden><div class="__menu-item" tabindex="0" data-highlighted><span>Codex Native2</span></div></div>`);
        await page.locator("#prompt-textarea").evaluate((element, { pill, staleDraft }) => {
          element.innerHTML = pill;
          element.appendChild(document.createTextNode(staleDraft ? " " + staleDraft : ""));
          const menu = document.getElementById("mention-menu")!;
          element.addEventListener("input", () => { menu.hidden = element.textContent !== "@codex"; });
          element.addEventListener("keydown", event => {
            if ((event as KeyboardEvent).key !== "Enter" || menu.hidden) return;
            event.preventDefault();
            element.innerHTML = pill;
            menu.hidden = true;
          });
        }, { pill, staleDraft });
        await worker.attachPrompt(page, prompt, true);
        expect(await worker.attachedPromptText(page)).toBe(prompt);
        expect(await worker.connectorIsSelected(page.locator("#prompt-textarea"))).toBeTrue();
      }
    }
  } finally { await browser.close(); }
}, 45_000);
