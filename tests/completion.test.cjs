const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
let context;
let page;

const fixture = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; }
main { height: 600px; overflow-y: auto; overflow-anchor: none; }
[data-turn-key] { height: 160px; padding: 20px; box-sizing: border-box; }
</style></head><body>
<main data-scroll-root><div id="thread"></div></main>
<script>
const scroller = document.querySelector('main');
const thread = document.getElementById('thread');
const makeGroup = index => {
  const group = document.createElement('div');
  group.dataset.turnKey = 'round-' + index;
  group.innerHTML = '<div data-content-search-unit-key="round-' + index + ':0:user"><div data-user-message-bubble="true">第 ' + (index + 1) + ' 轮提问</div></div><div data-content-search-unit-key="round-' + index + ':1:assistant"><div class="markdown">第 ' + (index + 1) + ' 轮回答</div></div>';
  return group;
};
for (let index = 10; index < 15; index++) thread.append(makeGroup(index));
scroller.scrollTop = scroller.scrollHeight;
let requested = false;
scroller.addEventListener('scroll', () => {
  if (scroller.scrollTop > 2 || requested) return;
  requested = true;
  thread.setAttribute('aria-busy', 'true');
  // Loading a history page can take longer than the directory's fixed top wait.
  setTimeout(() => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 10; index++) fragment.append(makeGroup(index));
    thread.prepend(fragment);
    thread.setAttribute('aria-busy', 'false');
  }, 2500);
});
</script></body></html>`;

const reverseFixture = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; }
main { height: 600px; overflow-y: auto; overflow-anchor: none; display: flex; flex-direction: column-reverse; }
#thread { flex: none; }
[data-turn-key], .unmounted-history { height: 160px; padding: 20px; box-sizing: border-box; }
</style></head><body><main data-scroll-root><div id="thread"></div></main><script>
const scroller = document.querySelector('main');
const thread = document.getElementById('thread');
const makeGroup = index => {
  const group = document.createElement('div');
  group.dataset.turnKey = 'round-' + index;
  group.innerHTML = '<div data-content-search-unit-key="round-' + index + ':0:user"><div data-user-message-bubble="true">第 ' + (index + 1) + ' 轮提问</div></div><div data-content-search-unit-key="round-' + index + ':1:assistant"><div class="markdown">第 ' + (index + 1) + ' 轮回答</div></div>';
  return group;
};
for (let index = 0; index < 10; index++) {
  const placeholder = document.createElement('div');
  placeholder.className = 'unmounted-history';
  thread.append(placeholder);
}
for (let index = 10; index < 15; index++) thread.append(makeGroup(index));
scroller.addEventListener('scroll', () => {
  if (scroller.scrollTop >= -300 || !thread.querySelector('.unmounted-history')) return;
  thread.querySelectorAll('.unmounted-history').forEach((placeholder, index) => placeholder.replaceWith(makeGroup(index)));
});
</script></body></html>`;

async function waitFor(predicate, description) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out: ${description}`);
}

before(async () => {
  context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHATWING_BROWSER_PATH || chromium.executablePath(),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--no-first-run"],
  });
  await context.route("https://chatgpt.com/**", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: route.request().url().includes("reverse-scroll") ? reverseFixture : fixture }));
  page = await context.newPage();
}, { timeout: 30000 });

after(async () => { await context?.close(); });

test("completion waits for a pending older-history page instead of reporting only the latest five", async () => {
  await page.goto("https://chatgpt.com/c/slow-history-page");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 5, "five initial questions");
  await page.locator("#chatwing-root .rail").hover();
  await page.locator("#chatwing-root .load-button").click();
  await waitFor(async () => await page.locator("#thread").getAttribute("aria-busy") === "true", "history starts loading at the top");
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-busy") === "false", "completion finishes");
  assert.equal(await page.locator("#chatwing-root .entry").count(), 15, "completion must include the requested older page before it reports success");
  assert.equal(await page.locator("#thread").getAttribute("aria-busy"), "false", "completion cannot finish while the thread still announces loading");
});

test("completion reaches older turns in a column-reverse transcript with negative scrollTop", async () => {
  await page.goto("https://chatgpt.com/c/reverse-scroll");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 5, "five latest questions initially mounted");
  assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 0, "zero is the latest edge of the reverse scroller");
  await page.locator("#chatwing-root .rail").hover();
  await page.locator("#chatwing-root .load-button").click();
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 15, "completion must scroll negatively to load the older ten turns");
  await waitFor(async () => await page.locator("#chatwing-root .load-button").getAttribute("aria-busy") === "false", "reverse completion finishes");
  assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 0, "reverse completion restores the latest reading position");
  await page.locator("#chatwing-root .entry").nth(3).click();
  await waitFor(async () => Math.abs(await page.locator('[data-content-search-unit-key="round-3:0:user"]').evaluate(el => el.getBoundingClientRect().top) - 86) < 5, "jump uses the negative range to reach the chosen older prompt");
});
