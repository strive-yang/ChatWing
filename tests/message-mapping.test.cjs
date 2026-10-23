const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-layout.html"), "utf8");
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
  await page.goto("https://chatgpt.com/c/message-mapping-test");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "initial grouped messages");
  await page.locator("#chatwing-root .rail").hover();
  await waitFor(async () => await page.locator("#chatwing-root .rail").getAttribute("aria-expanded") === "true", "directory opens");
  await page.locator("#chatwing-root .pin").click();
}

before(async () => {
  context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHATWING_BROWSER_PATH || chromium.executablePath(),
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
  await context.route("https://chatgpt.com/**", route => route.fulfill({
    status: 200, contentType: "text/html; charset=utf-8", body: fixture,
  }));
  page = await context.newPage();
}, { timeout: 30000 });

after(async () => { await context?.close(); });

test("partially virtualized grouped turns never attach an answer to the preceding question", async () => {
  await reset();
  await page.locator('[data-content-search-unit-key="b809bd10:0:user"]').evaluate(el => el.remove());
  // Allow the bounded mutation scan to run, then inspect the actual directory preview.
  await page.waitForTimeout(300);
  await page.locator("#chatwing-root .entry").first().hover();
  assert.doesNotMatch(await page.locator("#chatwing-root .answer").textContent(), /第二轮回答/, "the second group's answer must not be quoted as the first answer");
  assert.equal(await page.locator("#chatwing-root .entry").count(), 2, "a known question survives partial virtualization of its own group");
  await page.locator("#chatwing-root .entry").nth(1).hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "接着测试第二轮");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "这是第二轮回答。");
});

test("an initially unread assistant-only group does not contaminate the preceding preview", async () => {
  await reset();
  await page.evaluate(() => {
    history.pushState({}, "", "/c/message-mapping-orphan-group");
    document.querySelector('[data-content-search-unit-key="b809bd10:0:user"]').remove();
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 1, "only the loaded question is listed");
  await page.locator("#chatwing-root .entry").first().hover();
  assert.doesNotMatch(await page.locator("#chatwing-root .answer").textContent(), /第二轮回答/, "an orphan answer belongs to its own group");
});

test("a restored grouped question keeps its own answer through partial and full virtualization", async () => {
  await reset();
  await page.locator('[data-turn-key="b809bd10-prompt"]').evaluate(group => {
    window.savedGroupedQuestion = group.firstElementChild;
    window.savedGroupedAnswer = group.lastElementChild;
    window.savedGroupedQuestion.remove();
  });
  await page.waitForTimeout(300);
  await page.locator('[data-turn-key="b809bd10-prompt"]').evaluate(group => {
    group.replaceChildren(window.savedGroupedQuestion);
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#chatwing-root .entry").count(), 2);
  await page.locator("#chatwing-root .entry").nth(1).hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "接着测试第二轮");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "这是第二轮回答。");
  await page.locator('[data-turn-key="b809bd10-prompt"]').evaluate(group => group.replaceChildren());
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#chatwing-root .entry").count(), 2);
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "这是第二轮回答。");
  await page.locator('[data-turn-key="b809bd10-prompt"]').evaluate(group => {
    group.append(window.savedGroupedQuestion, window.savedGroupedAnswer);
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#chatwing-root .entry").count(), 2);
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "接着测试第二轮");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "这是第二轮回答。");
});

test("replacing a grouped branch never retains the previous question or answer", async () => {
  await reset();
  await page.locator('[data-turn-key="b809bd10-prompt"]').evaluate(group => {
    const question = group.firstElementChild;
    question.setAttribute("data-content-search-unit-key", "edited:0:user");
    question.firstElementChild.textContent = "编辑后的问题";
    group.lastElementChild.remove();
  });
  await waitFor(async () => (await page.locator("#chatwing-root .entry").last().textContent()).includes("编辑后的问题"), "edited grouped question replaces its old identity");
  assert.equal(await page.locator("#chatwing-root .entry").count(), 2);
  await page.locator("#chatwing-root .entry").last().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "编辑后的问题");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "暂无回答");
  await page.locator('[data-turn-key="b809bd10-prompt"]').evaluate(group => group.remove());
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 1, "removed group clears cached branch");
});

test("editing a question with the same message identity clears its unloaded old answer", async () => {
  await reset();
  await page.locator('[data-turn-key="b809bd10-prompt"]').evaluate(group => {
    group.querySelector('[data-user-message-bubble]').textContent = "原 ID 下编辑后的提问";
    group.lastElementChild.replaceChildren();
  });
  await waitFor(async () => (await page.locator("#chatwing-root .entry").last().textContent()).includes("原 ID 下编辑后的提问"), "same-identity question edit is indexed");
  await page.locator("#chatwing-root .entry").last().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "原 ID 下编辑后的提问");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "暂无回答");
});

test("an empty question shell is virtualization rather than an edit of the cached question", async () => {
  await reset();
  await page.locator('[data-turn-key="b809bd10-prompt"]').evaluate(group => {
    group.firstElementChild.replaceChildren();
    group.lastElementChild.remove();
  });
  await page.waitForTimeout(300);
  await page.locator("#chatwing-root .entry").last().hover();
  assert.equal(await page.locator("#chatwing-root .entry").count(), 2);
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "接着测试第二轮");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "这是第二轮回答。");
});

test("initially empty grouped shells remain navigable beyond the latest five mounted questions", async () => {
  await reset();
  await page.evaluate(() => {
    const question = document.querySelector('[data-content-search-unit-key$=":user"]').cloneNode(true);
    const answer = document.querySelector('[data-content-search-unit-key$=":assistant"]').cloneNode(true);
    const thread = document.getElementById("thread");
    window.mountLazyGroup = index => {
      const group = document.querySelector(`[data-turn-key="lazy-${index}"]`);
      const nextQuestion = question.cloneNode(true);
      const nextAnswer = answer.cloneNode(true);
      nextQuestion.setAttribute("data-content-search-unit-key", `lazy-${index}:0:user`);
      nextAnswer.setAttribute("data-content-search-unit-key", `lazy-${index}:1:assistant`);
      nextQuestion.querySelector('[data-user-message-bubble]').textContent = `第 ${index + 1} 轮提问`;
      nextAnswer.querySelector('.markdown').textContent = `第 ${index + 1} 轮回答`;
      group.replaceChildren(nextQuestion, nextAnswer);
    };
    history.pushState({}, "", "/c/message-mapping-latest-five");
    thread.replaceChildren();
    for (let index = 0; index < 12; index++) {
      const group = document.createElement("div");
      group.setAttribute("data-turn-key", `lazy-${index}`);
      thread.append(group);
      if (index >= 7) window.mountLazyGroup(index);
    }
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#chatwing-root .entry").count(), 12, "all stable group shells have a directory entry even when only the latest five have content");
  assert.equal(await page.locator("#chatwing-root .entry.is-pending").count(), 7);
  await page.locator("#chatwing-root .entry").first().hover();
  assert.match(await page.locator("#chatwing-root .question").textContent(), /尚未加载/);
  await page.evaluate(() => window.mountLazyGroup(0));
  await waitFor(async () => (await page.locator("#chatwing-root .entry").first().textContent()) === "第 1 轮提问", "the placeholder becomes its mounted question");
  assert.equal(await page.locator("#chatwing-root .entry").count(), 12, "hydration replaces the placeholder rather than adding a duplicate");
  assert.equal(await page.locator("#chatwing-root .entry.is-pending").count(), 6);
  await page.locator("#chatwing-root .entry").first().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "第 1 轮提问");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "第 1 轮回答");
  await page.evaluate(() => [...document.querySelectorAll("#thread > [data-turn-key]")].slice(0, 3).forEach(group => group.remove()));
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 9, "deleting empty or loaded group shells removes their entries");
});
