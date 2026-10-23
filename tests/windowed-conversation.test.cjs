const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/windowed-layout.html"), "utf8");
let context;
let page;

async function waitFor(predicate, description, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out: ${description}`);
}

async function reset() {
  await page.goto("https://chatgpt.com/c/windowed-conversation-regression");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 5, "initial latest five rounds");
}

async function openPinned() {
  await page.locator("#chatwing-root .rail").hover();
  await page.locator("#chatwing-root .pin").click();
}

async function complete() {
  await openPinned();
  await page.locator("#chatwing-root .load-button").click();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "停止补全", "completion starts");
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "补全目录", "completion finishes", 12000);
}

before(async () => {
  context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHATWING_BROWSER_PATH || chromium.executablePath(),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--no-first-run"],
  });
  await context.route("https://chatgpt.com/**", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture }));
  page = await context.newPage();
}, { timeout: 30000 });

after(async () => { await context?.close(); });

test("reading an older window retains the latest rounds after their entire shells unmount", async () => {
  await reset();
  assert.equal(await page.locator('[data-turn-key]').count(), 5, "the fixture never provides unloaded turn shells");
  await page.locator("main").evaluate(el => { el.scrollTop = 0; });
  await page.locator('[data-turn-key="window-0-prompt"]').waitFor();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await page.locator('[data-turn-key]').count(), 5);
  assert.equal(await page.locator("#chatwing-root .entry").count(), 10, "both disjoint visited windows remain in the directory instead of reverting to five");
  const labels = await page.locator("#chatwing-root .entry").allTextContents();
  assert.equal(labels[0], "第 1 轮的知识点提问");
  assert.equal(labels.at(-1), "第 15 轮的知识点提问");
});

test("completion keeps all fifteen rounds after restoring the latest five mounted rounds", async () => {
  await reset();
  const initialTop = await page.locator("main").evaluate(el => el.scrollTop);
  await complete();
  assert.ok(Math.abs(await page.locator("main").evaluate(el => el.scrollTop) - initialTop) < 5, "completion restores the user's reading position");
  assert.equal(await page.locator('[data-turn-key]').count(), 5, "the page still mounts only five rounds after completion");
  assert.equal(await page.locator("#chatwing-root .entry").count(), 15, "completion retains all read rounds rather than shrinking back to the mounted five");
  assert.match(await page.locator("#chatwing-root .conversation-count").textContent(), /15/);
  const labels = await page.locator("#chatwing-root .entry").allTextContents();
  assert.deepEqual(labels, Array.from({ length: 15 }, (_, index) => `第 ${index + 1} 轮的知识点提问`));
  await page.locator("#chatwing-root .entry").first().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "第 1 轮的知识点提问");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "第 1 轮的对应回答");
});

test("a cached offscreen directory entry remounts and jumps to its own prompt", async () => {
  await reset();
  await complete();
  const chosen = page.locator("#chatwing-root .entry").filter({ hasText: /^第 3 轮的知识点提问$/ });
  assert.equal(await chosen.count(), 1, "the earlier prompt remains in the directory");
  assert.equal(await page.locator('[data-turn-key="window-2-prompt"]').count(), 0, "the chosen prompt's original node has been completely removed");
  await chosen.click();
  const prompt = page.locator('[data-content-search-unit-key="window-2:0:user"]');
  await waitFor(async () => await prompt.count() === 1, "jump remounts the chosen old prompt");
  await waitFor(async () => Math.abs(await prompt.evaluate(el => el.getBoundingClientRect().top) - 150) < 5, "chosen old prompt is aligned rather than an unrelated current node");
  assert.equal(await page.locator("#chatwing-root .entry").count(), 15, "jumping among virtual windows keeps the complete directory");
});

test("editing a loaded question removes the cached continuation of its old branch", async () => {
  await reset();
  await complete();
  await page.evaluate(() => window.editRound(10, "编辑后的第十一轮提问"));
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 11, "cached messages after the edited question are discarded");
  await page.locator("#chatwing-root .entry").last().hover();
  assert.equal(await page.locator("#chatwing-root .question").textContent(), "编辑后的第十一轮提问");
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "暂无回答");
});

test("a new completed scan discards rounds removed from the conversation", async () => {
  await reset();
  await complete();
  await page.evaluate(() => window.truncateRounds(11));
  // The page provides no deletion signal for offscreen nodes. A fresh traversal
  // must replace old membership with the rounds actually encountered this time.
  await page.locator("#chatwing-root .load-button").click();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "停止补全", "fresh completion starts");
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-label") === "补全目录", "fresh completion finishes", 12000);
  assert.equal(await page.locator("#chatwing-root .entry").count(), 11, "new traversal removes unseen stale continuation");
});

test("switching to an empty chat clears cached offscreen history", async () => {
  await reset();
  await complete();
  await page.evaluate(() => {
    history.pushState({}, "", "/");
    document.querySelector("#thread").replaceChildren();
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 0, "new chat clears all fifteen cached rounds");
  assert.equal(await page.locator("#chatwing-root .conversation-count").textContent(), "已读 0 轮");
});
