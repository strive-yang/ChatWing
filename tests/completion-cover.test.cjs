const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/windowed-layout.html"), "utf8");
let context;
let page;

async function waitFor(predicate, description) {
  const started = Date.now();
  while (Date.now() - started < 7000) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out: ${description}`);
}

async function start() {
  await page.goto("https://chatgpt.com/c/reading-protection");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 5, "latest five rounds ready");
  await page.locator("#chatwing-root .rail").hover();
  await page.locator("#chatwing-root .pin").click();
  const savedTop = await page.locator("main").evaluate(el => el.scrollTop);
  await page.locator("#chatwing-root .load-button").click();
  return savedTop;
}

before(async () => {
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHATWING_BROWSER_PATH || chromium.executablePath(),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--no-first-run"],
  });
  await context.route("https://chatgpt.com/**", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture }));
  page = await context.newPage();
});

after(async () => { await context?.close(); });

test("completion covers the moving transcript, reports real read counts, and can stop in place", async () => {
  const savedTop = await start();
  const cover = page.locator("#chatwing-root .completion-cover");
  assert.equal(await cover.count(), 1, "a reading-protection surface must exist while the transcript is being scrolled");
  assert.equal(await cover.isVisible(), true);
  const painted = await page.evaluate(() => {
    const rect = document.querySelector("main").getBoundingClientRect();
    const shadow = document.getElementById("chatwing-root").shadowRoot;
    return !!shadow.elementFromPoint(rect.left + 60, rect.top + 60)?.closest(".completion-cover");
  });
  assert.equal(painted, true, "the cover actually paints above the moving messages");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() > 5, "reading continues behind the cover");
  const count = await page.locator("#chatwing-root .entry").count();
  assert.equal(await page.locator("#chatwing-root .completion-progress").textContent(), `已读 ${count} 轮`);
  assert.equal(await page.locator("#chatwing-root .preview").isHidden(), true, "growing the list must not open incidental previews during reading protection");
  await page.screenshot({ path: path.join(root, "artifacts", "chatwing-completion.png") });
  await page.locator("#chatwing-root .completion-stop").click();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-busy") === "false", "stop finishes restoring the reader");
  assert.equal(await cover.isHidden(), true);
  assert.ok(Math.abs(await page.locator("main").evaluate(el => el.scrollTop) - savedTop) < 5);
});

test("successful completion removes the cover after restoring the reader and keeps all rounds", async () => {
  const savedTop = await start();
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-busy") === "false", "completion finishes");
  assert.equal(await page.locator("#chatwing-root .completion-cover").isHidden(), true);
  assert.equal(await page.locator("#chatwing-root .entry").count(), 15);
  assert.ok(Math.abs(await page.locator("main").evaluate(el => el.scrollTop) - savedTop) < 5);
});

test("switching chats dismisses the previous chat's reading cover immediately", async () => {
  await start();
  const hidden = await page.evaluate(() => {
    history.pushState({}, "", "/c/reading-protection-next");
    return document.getElementById("chatwing-root").shadowRoot.querySelector(".completion-cover").hidden;
  });
  assert.equal(hidden, true);
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-busy") === "false", "old completion is cleaned up");
});
