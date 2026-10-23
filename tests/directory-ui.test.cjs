const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const fixture = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8");
let context;
let page;

async function waitFor(predicate, description) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out: ${description}`);
}

async function reset(viewport = { width: 1440, height: 1000 }) {
  await page.setViewportSize(viewport);
  await page.goto("https://chatgpt.com/c/chatwing-directory-ui-test");
  await page.locator("#chatwing-root").waitFor();
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 9, "initial questions indexed");
}

async function open() {
  await page.locator("#chatwing-root .rail").hover();
  await waitFor(async () => await page.locator("#chatwing-root .rail").getAttribute("aria-expanded") === "true", "directory open");
  await page.locator("#chatwing-root .pin").click();
}

before(async () => {
  context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHATWING_BROWSER_PATH || chromium.executablePath(),
    headless: true,
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--no-first-run"],
  });
  await context.route("https://chatgpt.com/**", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture }));
  page = await context.newPage();
}, { timeout: 30000 });

after(async () => { await context?.close(); });

test("wheel scrolling reaches both ends of a long directory with previews on desktop and mobile", async () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 400 }]) {
    await reset(viewport);
    await page.evaluate(() => {
      for (let i = 9; i < 40; i++) window.addTurn(`第 ${i + 1} 轮提问：在长目录中仍需能滚动找到这一项。`, `第 ${i + 1} 轮回答`);
      const scroller = document.getElementById("conversation-scroll");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 40, "all forty questions indexed");
    await open();
    const list = page.locator("#chatwing-root .list");
    const listBox = await list.boundingBox();
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
    await page.mouse.wheel(0, -100000);
    await waitFor(async () => await list.evaluate(el => el.scrollTop) === 0, "wheel reaches first question");
    await page.locator("#chatwing-root .entry").first().hover();
    assert.equal(await page.locator("#chatwing-root .question").textContent(), "我想做一个 ChatGPT 浏览器插件，让长对话更容易回看。");
    const afterPreview = await list.boundingBox();
    await page.mouse.move(afterPreview.x + afterPreview.width / 2, afterPreview.y + afterPreview.height / 2);
    await page.mouse.wheel(0, 100000);
    await waitFor(async () => await list.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1), "wheel reaches last question");
    const lastBox = await page.locator("#chatwing-root .entry").last().boundingBox();
    const finalList = await list.boundingBox();
    assert.ok(lastBox.y >= finalList.y - 1 && lastBox.y + lastBox.height <= finalList.y + finalList.height + 1, "last question is fully visible");
    const panelBox = await page.locator("#chatwing-root .panel").boundingBox();
    assert.ok(panelBox.y >= 0 && panelBox.y + panelBox.height <= viewport.height, "long directory and preview fit viewport");
    assert.ok(await page.locator("main").evaluate(el => el.scrollTop > 0), "directory wheel leaves conversation at its reading position");
  }
});

for (const scrollMain of [false, true]) {
test(`directory and preview scroll when the page ${scrollMain ? "redirects" : "swallows"} wheel events`, async () => {
  await reset();
  await page.evaluate(scrollMain => {
    for (let i = 9; i < 40; i++) window.addTurn(`第 ${i + 1} 轮提问`, "回答");
    document.querySelector('[data-testid="conversation-turn-0"] [data-user-message-bubble]').textContent = "长提问内容。\n".repeat(100);
    document.getElementById("conversation-scroll").scrollTop = 700;
    document.addEventListener("wheel", event => {
      event.preventDefault();
      if (scrollMain) document.getElementById("conversation-scroll").scrollTop += event.deltaY;
    }, { passive: false });
  }, scrollMain);
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 40, "long directory ready");
  await open();
  const list = page.locator("#chatwing-root .list");
  await list.evaluate(el => { el.scrollTop = 0; });
  const listBox = await list.boundingBox();
  await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
  await page.mouse.wheel(0, 500);
  await waitFor(async () => await list.evaluate(el => el.scrollTop > 0), "host page cannot swallow directory wheel scrolling");
  assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 700);
  await page.locator("#chatwing-root .entry").first().hover();
  const question = page.locator("#chatwing-root .question");
  await question.hover();
  await page.mouse.wheel(0, 400);
  await waitFor(async () => await question.evaluate(el => el.scrollTop > 0), "host page cannot swallow preview wheel scrolling");
  assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 700);
});
}

test("upper-left count follows questions, edits, branch deletion, and chat changes", async () => {
  await reset();
  await open();
  const count = page.locator("#chatwing-root .conversation-count");
  await count.waitFor({ timeout: 1500 });
  assert.equal(await count.textContent(), "已读 9 轮");
  const countBox = await count.boundingBox();
  const loadBox = await page.locator("#chatwing-root .load-button").boundingBox();
  assert.ok(countBox.x < loadBox.x, "count is to the left of toolbar controls");
  await page.evaluate(() => window.addTurn("第十轮提问", "回答内容"));
  await waitFor(async () => await count.textContent() === "已读 10 轮", "new question increments count");
  await page.locator('[data-testid="conversation-turn-18"] [data-user-message-bubble]').evaluate(el => { el.textContent = "编辑后的第十轮提问"; });
  await waitFor(async () => (await page.locator("#chatwing-root .entry").last().textContent()).includes("编辑后的"), "edit appears");
  assert.equal(await count.textContent(), "已读 10 轮");
  await page.evaluate(() => [...document.querySelectorAll("#conversation > article")].slice(8).forEach(el => el.remove()));
  await waitFor(async () => await count.textContent() === "已读 4 轮", "deleted branch decrements count");
  await page.evaluate(() => { history.pushState({}, "", "/"); document.getElementById("conversation").replaceChildren(); });
  await waitFor(async () => await count.textContent() === "已读 0 轮", "empty chat clears count");
});
