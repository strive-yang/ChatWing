const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const artifacts = path.join(root, "artifacts");
const fixture = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8");
const currentFixture = fs.readFileSync(path.join(__dirname, "fixtures/current-layout.html"), "utf8");
const errors = [];
let context;
let page;

async function waitFor(predicate, description) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  assert.fail(`Timed out: ${description}`);
}

async function reset() {
  await page.goto("https://chatgpt.com/c/chatwing-local-test");
  await page.locator("#chatwing-root").waitFor({ timeout: 7000 });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 9, "initial nine entries");
}

async function open() {
  await page.locator("#chatwing-root .rail").hover();
  await waitFor(async () => await page.locator("#chatwing-root .rail").getAttribute("aria-expanded") === "true", "open directory");
}

before(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const bundledBrowser = chromium.executablePath();
  const executablePath = process.env.CHATWING_BROWSER_PATH || bundledBrowser;
  assert.ok(fs.existsSync(executablePath), "Run npx playwright install chromium, or set CHATWING_BROWSER_PATH to Chrome for Testing / Chromium.");
  context = await chromium.launchPersistentContext("", {
    executablePath,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--no-first-run",
    ],
  });
  // Fulfill locally at the real matched origin, so Chrome itself injects the extension.
  await context.route("https://chatgpt.com/**", route => route.fulfill({
    status: 200, contentType: "text/html; charset=utf-8",
    body: new URL(route.request().url()).pathname.includes("current-renderer") ? currentFixture : fixture,
  }));
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
}, { timeout: 30000 });

after(async () => {
  await context?.close();
});

test("Chrome loads the MV3 extension and identifies only user turns", async () => {
  await reset();
  assert.equal(await page.locator("#chatwing-root .entry").count(), 9);
  assert.equal(await page.locator("#chatwing-root .rail").getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#chatwing-root .panel").evaluate(el => el.inert), true);
  // This catches accidentally mounting the isolated UI into ChatGPT's light DOM.
  assert.equal(await page.evaluate(() => document.querySelectorAll(".entry").length), 0);
  assert.equal(await page.evaluate(() => !!document.getElementById("chatwing-root").shadowRoot), true);
});

test("new ChatGPT renderer extracts both messages from a grouped turn without legacy role attributes", async () => {
  await page.goto("https://chatgpt.com/c/current-renderer");
  await page.locator("#chatwing-root").waitFor({ timeout: 7000 });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "visible conversation must not show zero rounds");
  await open();
  await page.locator("#chatwing-root .entry").first().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "test");
  assert.match(await page.locator("#chatwing-root .answer").textContent(), /测试成功/);
  assert.doesNotMatch(await page.locator("#chatwing-root .question").textContent(), /正常收到/);
});

test("new renderer supports bubbles and markdown without either role-attribute schema", async () => {
  await page.goto("https://chatgpt.com/c/current-renderer");
  await page.locator("#chatwing-root").waitFor();
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('[data-content-search-unit-key], [data-conversation-role]')) {
      node.removeAttribute("data-content-search-unit-key");
      node.removeAttribute("data-conversation-role");
    }
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "fallback bubbles remain indexed");
  await open();
  await page.locator("#chatwing-root .entry").nth(1).hover();
  await waitFor(async () => await page.locator("#chatwing-root .question").textContent() === "接着测试第二轮", "fallback prompt refresh");
  assert.match(await page.locator("#chatwing-root .answer").textContent(), /第二轮回答/);
});

test("virtualized grouped turns keep their question and answer without merging the roles", async () => {
  await page.goto("https://chatgpt.com/c/current-renderer");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "grouped turns initially read");
  await page.locator('[data-turn-key="f17c0cc0-prompt"]').evaluate(el => el.replaceChildren());
  await new Promise(resolve => setTimeout(resolve, 250));
  await open();
  assert.equal(await page.locator("#chatwing-root .entry").count(), 2);
  await page.locator("#chatwing-root .entry").first().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "test");
  assert.match(await page.locator("#chatwing-root .answer").textContent(), /测试成功/);
});

test("an unrelated first main element cannot hide the real conversation", async () => {
  await page.goto("https://chatgpt.com/c/current-renderer");
  await page.locator("#chatwing-root").waitFor();
  await page.evaluate(() => {
    history.pushState({}, "", "/c/current-renderer-wrong-main");
    document.getElementById("thread").removeAttribute("id");
    document.body.prepend(document.createElement("main"));
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "scan the main with actual messages");
  await open();
  await page.locator("#chatwing-root .entry").first().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "test");
});

test("empty-page diagnostics contain only counts, and late role attributes trigger automatic extraction", async () => {
  await page.goto("https://chatgpt.com/c/current-renderer");
  await page.locator("#chatwing-root").waitFor();
  await page.evaluate(() => {
    history.pushState({}, "", "/c/current-renderer-late-roles");
    const thread = document.getElementById("thread");
    thread.replaceChildren();
    for (const text of ["不得出现在诊断里的问题", "不得出现在诊断里的回答"]) {
      const node = document.createElement("div");
      node.textContent = text;
      thread.append(node);
    }
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 0, "unknown markup is not mistaken for a message");
  await open();
  await page.locator("#chatwing-root .load-button").click();
  await page.locator("#chatwing-root .diagnostics summary").click();
  const diagnosticText = await page.locator("#chatwing-root .diagnostics-data").textContent();
  const diagnostic = JSON.parse(diagnosticText);
  assert.equal(diagnostic.version, manifest.version);
  assert.equal(diagnostic.currentRoleMarkers, 0);
  assert.doesNotMatch(diagnosticText, /不得出现在|current-renderer-late-roles/);
  await page.evaluate(() => {
    const nodes = document.getElementById("thread").children;
    nodes[0].setAttribute("data-conversation-role", "user");
    nodes[1].setAttribute("data-conversation-role", "assistant");
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 1, "attribute-only hydration triggers extraction");
  await page.locator("#chatwing-root .entry").first().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "不得出现在诊断里的问题");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "不得出现在诊断里的回答");
});

test("hover opens the directory, previews text, and stays usable inside the preview", async () => {
  await reset();
  await open();
  await page.locator("#chatwing-root .entry").nth(3).hover();
  assert.match(await page.locator("#chatwing-root .question").textContent(), /完整的提问和回答开头/);
  assert.match(await page.locator("#chatwing-root .answer").textContent(), /上下文触手可及/);
  await page.locator("#chatwing-root .preview").hover();
  assert.equal(await page.locator("#chatwing-root .preview").isVisible(), true);
  assert.equal(await page.locator("#chatwing-root .rail").getAttribute("aria-expanded"), "true");
  await page.mouse.move(360, 40);
  await waitFor(async () => await page.locator("#chatwing-root .rail").getAttribute("aria-expanded") === "false", "close after leaving the whole panel");
});

test("click jumps inside the nested conversation scroller and updates the active turn", async () => {
  await reset();
  await open();
  await page.locator("#chatwing-root .entry").nth(3).click();
  await waitFor(async () => Math.abs(await page.locator('[data-testid="conversation-turn-6"]').evaluate(el => el.getBoundingClientRect().top) - 150) < 5, "scroll to the fourth question");
  await waitFor(async () => await page.locator('#chatwing-root .entry').nth(3).getAttribute("aria-current") === "location", "fourth turn active");
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.equal(await page.locator("#chatwing-root .rail").getAttribute("aria-expanded"), "false");
});

test("pinning, keyboard navigation, Escape, and full prompt previews", async () => {
  await reset();
  await open();
  await page.locator("#chatwing-root .pin").click();
  await page.mouse.move(360, 40);
  assert.equal(await page.locator("#chatwing-root .rail").getAttribute("aria-expanded"), "true");
  await page.locator("#chatwing-root .entry").first().focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator("#chatwing-root .entry").nth(1).evaluate(el => el.getRootNode().activeElement === el), true);
  await page.keyboard.press("End");
  assert.equal(await page.locator("#chatwing-root .entry").last().evaluate(el => el.getRootNode().activeElement === el), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#chatwing-root .pin").getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator("#chatwing-root .panel").evaluate(el => el.inert), true);
});

test("new and streaming messages update without parsing prompt HTML", async () => {
  await reset();
  const hostilePrompt = '<img src=x onerror="window.chatwingXss=true"> 保留原文\n第二段\n  保留两格缩进';
  await page.evaluate(question => window.addTurn(question, "正在生成"), hostilePrompt);
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 10, "new question appears");
  await open();
  await page.locator("#chatwing-root .entry").last().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), hostilePrompt);
  assert.equal(await page.evaluate(() => window.chatwingXss), undefined);
  assert.equal(await page.locator("#chatwing-root .question img").count(), 0);
  await page.locator('[data-testid="conversation-turn-19"] .markdown').evaluate(el => { el.textContent = "生成完成，预览也应该同步更新。"; });
  await waitFor(async () => (await page.locator("#chatwing-root .answer").textContent()).includes("生成完成"), "streaming answer refresh");
});

test("persistent turn shells keep cached text while ChatGPT unmounts offscreen content", async () => {
  await reset();
  await page.locator('[data-testid="conversation-turn-0"]').evaluate(el => el.replaceChildren());
  await page.locator('[data-testid="conversation-turn-1"]').evaluate(el => el.replaceChildren());
  await new Promise(resolve => setTimeout(resolve, 250));
  await open();
  await page.locator("#chatwing-root .entry").first().hover();
  assert.match(await page.locator("#chatwing-root .question").textContent(), /长对话更容易回看/);
  assert.match(await page.locator("#chatwing-root .answer").textContent(), /整理成目录/);
});

test("removed and edited branches don't leave stale directory entries", async () => {
  await reset();
  await page.evaluate(() => {
    const turns = [...document.querySelectorAll('#conversation > article')];
    turns.slice(8).forEach(el => el.remove());
    document.querySelector('[data-testid="conversation-turn-6"] [data-user-message-bubble]').textContent = "这是一条编辑后的提问";
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 4, "removed branch discarded");
  assert.match(await page.locator("#chatwing-root .entry").last().textContent(), /编辑后的提问/);
});

test("client-side chat navigation resets the cache, including an empty new chat", async () => {
  await reset();
  await page.evaluate(() => {
    history.pushState({}, "", "/c/a-different-chat");
    document.getElementById("conversation").replaceChildren();
    window.addTurn("新聊天的唯一问题", "新聊天的回答");
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 1, "new chat indexed");
  assert.match(await page.locator("#chatwing-root .entry").first().textContent(), /新聊天的唯一问题/);
  await page.evaluate(() => { history.pushState({}, "", "/"); document.getElementById("conversation").replaceChildren(); });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 0, "empty chat clears directory");
  await open();
  assert.equal(await page.locator("#chatwing-root .empty").isVisible(), true);
});

test("client-side chat switch indexes the visible thread when the previous thread stays mounted", async () => {
  await page.goto("https://chatgpt.com/c/current-renderer");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "original chat indexed");
  await page.evaluate(() => {
    const oldMain = document.querySelector("main");
    const nextMain = oldMain.cloneNode(true);
    oldMain.hidden = true;
    nextMain.querySelector("#thread").lastElementChild.remove();
    nextMain.querySelector('[data-user-message-bubble]').textContent = "新聊天里的唯一问题";
    nextMain.querySelector('.markdown').textContent = "新聊天里的回答";
    history.pushState({}, "", "/c/current-renderer-next-chat");
    document.body.append(nextMain);
    window.sameDocumentSentinel = true;
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 1 && (await page.locator("#chatwing-root .entry").first().textContent()).includes("新聊天里的唯一问题"), "switch chat without reloading the browser");
  await open();
  await page.locator("#chatwing-root .entry").first().hover();
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "新聊天里的回答");
  assert.equal(await page.evaluate(() => window.sameDocumentSentinel), true);
});

test("rapid chat switches react to visibility-only updates and return to the original cached page", async () => {
  await page.goto("https://chatgpt.com/c/current-renderer");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "original thread ready");
  await page.evaluate(() => {
    const original = document.querySelector("main");
    original.id = "chat-a";
    const next = original.cloneNode(true);
    next.id = "chat-b";
    next.style.display = "none";
    next.querySelector("#thread").lastElementChild.remove();
    next.querySelector('[data-user-message-bubble]').textContent = "聊天 B 的唯一问题";
    next.querySelector('.markdown').textContent = "聊天 B 的回答";
    document.body.append(next);
    window.switchChat = name => {
      history.pushState({}, "", `/c/current-renderer-${name}`);
      original.style.display = name === "a" ? "block" : "none";
      next.style.display = name === "b" ? "block" : "none";
    };
  });
  await page.evaluate(() => window.switchChat("b"));
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 1 && (await page.locator("#chatwing-root .entry").first().textContent()).includes("聊天 B"), "style-only switch to B");
  await page.evaluate(() => { window.switchChat("a"); window.switchChat("b"); window.switchChat("a"); });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2 && (await page.locator("#chatwing-root .entry").first().textContent()) === "test", "only the final active chat is indexed");
  await open();
  await page.locator("#chatwing-root .entry").first().hover();
  assert.match(await page.locator("#chatwing-root .answer").textContent(), /测试成功/);
});

test("same-document navigation clears the old list before the new conversation is rendered", async () => {
  await page.goto("https://chatgpt.com/c/current-renderer");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "original thread ready");
  const staleEntryCount = await page.evaluate(() => {
    document.querySelector("main").hidden = true;
    history.pushState({}, "", "/c/current-renderer-loading-next-chat");
    return document.getElementById("chatwing-root").shadowRoot.querySelectorAll(".entry").length;
  });
  assert.equal(staleEntryCount, 0, "URL changes clear the previous chat synchronously");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await page.locator("#chatwing-root .entry").count(), 0);
});

test("legacy role-only markup is indexed", async () => {
  await reset();
  await page.evaluate(() => {
    for (const turn of document.querySelectorAll("#conversation > article")) {
      turn.removeAttribute("data-testid"); turn.removeAttribute("data-turn"); turn.removeAttribute("data-turn-key");
    }
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").first().getAttribute("data-key") === "message-0", "role-only fallback");
  assert.equal(await page.locator("#chatwing-root .entry").count(), 9);
});

test("completion reads lazy content and restores the original reading position", async () => {
  await reset();
  await page.evaluate(() => {
    history.pushState({}, "", "/c/lazy-content-test");
    const turn = document.querySelector('[data-testid="conversation-turn-12"]');
    const message = turn.firstElementChild;
    turn.style.minHeight = `${turn.offsetHeight}px`;
    turn.replaceChildren();
    const scroller = document.getElementById("conversation-scroll");
    scroller.scrollTop = 240;
    scroller.addEventListener("scroll", () => {
      if (turn.getBoundingClientRect().top < 750 && !turn.firstElementChild) turn.append(message);
    });
  });
  await waitFor(async () => (await page.locator("#chatwing-root .entry").nth(6).textContent()).includes("待加载"), "unseen lazy question starts as a placeholder");
  const initialScroll = await page.locator("main").evaluate(el => el.scrollTop);
  await open();
  await page.locator("#chatwing-root .load-button").click();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "停止补全", "completion starts");
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "补全目录", "completion finishes");
  assert.ok(Math.abs(await page.locator("main").evaluate(el => el.scrollTop) - initialScroll) < 5);
  await page.locator("#chatwing-root .entry").nth(6).hover();
  assert.match(await page.locator("#chatwing-root .question").textContent(), /实时更新/);
});

test("stopping completion restores the reading position without leaving a running scan", async () => {
  await reset();
  await page.locator("main").evaluate(el => { el.scrollTop = 700; });
  await open();
  await page.locator("#chatwing-root .load-button").click();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "停止补全", "completion is cancellable");
  await page.locator("#chatwing-root .load-button").click();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "补全目录", "completion stops");
  assert.match(await page.locator("#chatwing-root .notice").textContent(), /已停止补全/);
  assert.ok(Math.abs(await page.locator("main").evaluate(el => el.scrollTop) - 700) < 5);
});

test("jumping during completion cancels the scan and preserves the chosen destination", async () => {
  await reset();
  await open();
  await page.locator("#chatwing-root .load-button").click();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "停止补全", "completion starts before navigation");
  await page.locator("#chatwing-root .entry").nth(3).click();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "补全目录", "scan cancels when navigating");
  await waitFor(async () => Math.abs(await page.locator('[data-testid="conversation-turn-6"]').evaluate(el => el.getBoundingClientRect().top) - 150) < 5, "chosen turn remains in view");
});

test("light, dark, and mobile layouts stay inside the viewport; create previews", async () => {
  await reset();
  await page.locator("main").evaluate(el => { el.scrollTop = 900; });
  await open();
  await page.locator("#chatwing-root .entry").nth(3).hover();
  await page.screenshot({ path: path.join(artifacts, "chatwing-light.png") });
  await page.evaluate(() => { document.documentElement.className = "dark"; });
  await waitFor(async () => await page.locator("#chatwing-root").getAttribute("data-theme") === "dark", "theme follows page");
  await page.screenshot({ path: path.join(artifacts, "chatwing-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.locator("#chatwing-root .entry").nth(3).hover();
  for (const selector of [".panel", ".preview"]) {
    const box = await page.locator(`#chatwing-root ${selector}`).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `${selector} fits horizontally`);
    assert.ok(box.y >= 0 && box.y + box.height <= 844, `${selector} fits vertically`);
  }
  await page.screenshot({ path: path.join(artifacts, "chatwing-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(errors, [], "no uncaught browser errors");
});
