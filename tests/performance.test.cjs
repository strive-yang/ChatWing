const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const fixture = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "content/styles.js"), "utf8");
const source = fs.readFileSync(path.join(root, "content/content.js"), "utf8");
// Count actual scans without exposing a test API in the shipped extension.
assert.ok(source.includes("function scan() {"));
const instrumented = source.replace("function scan() {", "function scan() { window.chatwingScanCount++;");
let browser;
let page;

async function settle() {
  await page.waitForTimeout(260);
}

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHATWING_BROWSER_PATH || chromium.executablePath(), headless: true });
});
after(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await page.setContent(fixture);
  await page.evaluate(() => {
    window.chrome = { runtime: { getManifest: () => ({ version: "test" }) } };
    window.chatwingScanCount = 0;
  });
  await page.addScriptTag({ content: styles });
  await page.addScriptTag({ content: instrumented });
  await settle();
  assert.equal(await page.locator("#chatwing-root .entry").count(), 9);
  await page.evaluate(() => { window.chatwingScanCount = 0; });
});
afterEach(async () => { await page?.close(); });

test("unrelated sidebar text updates do not repeatedly scan the conversation", async () => {
  for (let update = 0; update < 5; update++) {
    await page.evaluate(update => {
      const nav = document.querySelector(".sidebar .nav");
      if (update % 2) nav.firstChild.data = `侧栏更新 ${update}`;
      else nav.textContent = `侧栏更新 ${update}`;
    }, update);
    await settle();
  }
  assert.equal(await page.evaluate(() => window.chatwingScanCount), 0, "five sidebar updates must not cause five full thread scans");
});

test("streaming answers still trigger scans and refresh their matching preview", async () => {
  await page.locator("#chatwing-root .rail").hover();
  await page.locator("#chatwing-root .entry").first().hover();
  await settle();
  await page.evaluate(() => { window.chatwingScanCount = 0; });
  await page.locator(".markdown").first().evaluate(el => { el.textContent = "流式回答已更新"; });
  await settle();
  assert.ok(await page.evaluate(() => window.chatwingScanCount) > 0);
  assert.equal(await page.locator("#chatwing-root .answer").textContent(), "流式回答已更新");
});

test("adding and removing a thread wrapper outside main triggers indexing", async () => {
  await page.evaluate(() => {
    document.querySelector("main").remove();
    const wrapper = document.createElement("section");
    wrapper.id = "replacement-wrapper";
    wrapper.innerHTML = '<div data-message-author-role="user" data-message-id="replacement-question">新挂载的提问</div><div data-message-author-role="assistant" data-message-id="replacement-answer">新挂载的回答</div>';
    document.body.append(wrapper);
  });
  await settle();
  assert.equal(await page.locator("#chatwing-root .entry").count(), 1);
  assert.equal(await page.locator("#chatwing-root .entry").first().textContent(), "新挂载的提问");
  await page.locator("#replacement-wrapper").evaluate(el => el.remove());
  await settle();
  assert.equal(await page.locator("#chatwing-root .entry").count(), 0);
});

test("visibility changes on an ancestor still switch the indexed thread", async () => {
  await page.evaluate(() => {
    const original = document.querySelector("main");
    original.id = "original-thread";
    const wrapper = document.createElement("section");
    wrapper.style.display = "none";
    wrapper.id = "next-wrapper";
    const next = original.cloneNode(true);
    next.id = "next-thread";
    next.querySelector("#conversation").replaceChildren();
    next.querySelector("#conversation").innerHTML = '<article data-turn="user" data-turn-key="next:user"><div data-message-author-role="user">切换后的提问</div></article>';
    wrapper.append(next);
    document.body.append(wrapper);
  });
  await settle();
  assert.equal(await page.locator("#chatwing-root .entry").count(), 9);
  await page.evaluate(() => {
    document.querySelector("#original-thread").hidden = true;
    document.querySelector("#next-wrapper").style.display = "block";
  });
  await settle();
  assert.equal(await page.locator("#chatwing-root .entry").count(), 1);
  assert.equal(await page.locator("#chatwing-root .entry").first().textContent(), "切换后的提问");
});
