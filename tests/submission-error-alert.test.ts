import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptSubmissionRejectionObserver } from "../src/adapters/chatgpt-web/browser-worker";

const tooLong = "The message you submitted was too long, please edit it and resubmit.";
const tooLongRussian = "Отправленное вами сообщение слишком длинное. Отредактируйте его и отправьте снова.";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("current Russian and English size alerts inside virtualized turns stop retries", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const observer = new ChatGptSubmissionRejectionObserver();
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://chatgpt.com/c/fixture");
    for (const text of [tooLong, tooLongRussian]) {
      await page.locator("main").evaluate(element => { element.innerHTML = '<div data-turn-key="old"><div data-user-message-bubble>Previous input</div></div>'; });
      observer.begin(page);
      await observer.captureAlertBaseline();
      await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
      // The real alert is a service sibling of the message bubble, inside the virtualized turn.
      await page.evaluate(text => {
        document.querySelector("main")!.insertAdjacentHTML("beforeend", `<div data-turn-key="current"><div data-content-search-turn-key="current"><div data-user-message-bubble>Input</div><div><div><aside role="alert"><div>${text}</div></aside></div></div></div></div>`);
      }, text);
      expect(await observer.failure()).toMatchObject({ status: 413, code: "message_length_exceeds_limit", retryable: false });
      observer.begin(page);
      await observer.captureAlertBaseline();
      await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
      expect(await observer.failure()).toBeUndefined();
    }
  } finally { observer.dispose(); await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a new service size alert survives removal of the current conversation DOM (#874)", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const observer = new ChatGptSubmissionRejectionObserver();
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main><div data-turn-key='current'>Response</div></main>" }));
    await page.goto("https://chatgpt.com/c/fixture");
    observer.begin(page);
    await observer.captureAlertBaseline();
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    await page.evaluate(text => {
      document.querySelector("main")!.innerHTML = `<aside role="alert">${text}</aside>`;
    }, tooLong);
    expect(await observer.failure()).toMatchObject({ code: "message_length_exceeds_limit", retryable: false });
  } finally { observer.dispose(); await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("size alerts require a current owned Send and exclude history, quoted text and hidden UI", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const failures: unknown[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => failures.push(error));
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: `<main><aside id="old" role="alert">${tooLong}</aside><div data-turn-key="old-turn"></div></main>` }));
    await page.goto("https://chatgpt.com/c/fixture");
    observer.begin(page);
    await observer.captureAlertBaseline();
    await page.evaluate(text => document.querySelector("main")!.insertAdjacentHTML("beforeend", `<aside id="new" role="alert">${text}</aside>`), tooLong);
    // Background requests and requests from another page do not authorize this alert.
    await page.evaluate(async () => { await fetch("/backend-api/other", { method: "POST" }); });
    const other = await browser.newPage();
    await other.route("**/*", route => route.fulfill({ body: "fixture" }));
    await other.goto("https://chatgpt.com/");
    await other.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    expect(await observer.failure()).toBeUndefined();
    await page.locator("#new").evaluate(element => element.remove());
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    for (const markup of [
      `<div class="markdown"><aside role="alert">${tooLong}</aside></div>`,
      `<div data-user-message-bubble><aside role="alert">${tooLong}</aside></div>`,
      `<div contenteditable="true"><aside role="alert">${tooLong}</aside></div>`,
      `<aside role="alert" hidden>${tooLong}</aside>`,
      `<aside role="alert" style="visibility:hidden">${tooLong}</aside>`,
      `<aside role="alert">The model said: ${tooLong}</aside>`,
      `<div>${tooLong}</div>`,
    ]) {
      await page.evaluate(html => {
        document.querySelector("#variant")?.remove();
        document.querySelector("main")!.insertAdjacentHTML("beforeend", `<section id="variant">${html}</section>`);
      }, markup);
      expect(await observer.failure()).toBeUndefined();
    }
    expect(failures).toHaveLength(0);
    await page.locator('[data-turn-key="old-turn"]').evaluate((element, text) => {
      element.innerHTML = `<aside role="alert">${text}</aside>`;
    }, tooLongRussian);
    expect(await observer.failure()).toBeUndefined();
    await page.evaluate(text => { document.querySelector("#variant")!.innerHTML = `<aside role="alert">${text}</aside>`; }, tooLong);
    expect(await observer.failure()).toMatchObject({ status: 413, code: "message_length_exceeds_limit", retryable: false });
    await observer.failure();
    expect(failures).toHaveLength(1);
    // The next multipart Send records the existing alert as stale and resets the failure.
    observer.begin(page);
    await observer.captureAlertBaseline();
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    expect(await observer.failure()).toBeUndefined();
  } finally { observer.dispose(); await browser.close(); }
}, 20_000);
