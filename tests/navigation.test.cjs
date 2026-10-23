const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const fixture = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8");
const groupedFixture = fs.readFileSync(path.join(__dirname, "fixtures/current-layout.html"), "utf8");
let context;
let page;

async function waitFor(predicate, description) {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out: ${description}`);
}

async function reset() {
  await page.goto("https://chatgpt.com/c/navigation-regression");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 9, "initial directory");
  await page.locator("#chatwing-root .rail").hover();
}

before(async () => {
  context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHATWING_BROWSER_PATH || chromium.executablePath(),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--no-first-run"],
  });
  await context.route("https://chatgpt.com/**", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: route.request().url().includes("grouped-navigation") ? groupedFixture : fixture }));
  page = await context.newPage();
});

after(async () => { await context?.close(); });

test("jump realigns the selected prompt after lazy rendering changes its position", async () => {
  await reset();
  await page.evaluate(() => {
    const scroller = document.querySelector("main");
    scroller.style.overflowAnchor = "none";
    scroller.addEventListener("scroll", () => {
      setTimeout(() => {
        const spacer = document.createElement("div");
        spacer.style.height = "300px";
        spacer.id = "lazy-content";
        document.querySelector('[data-testid="conversation-turn-6"]').before(spacer);
      }, 40);
    }, { once: true });
  });
  await page.locator("#chatwing-root .entry").nth(3).click();
  await page.locator("#lazy-content").waitFor();
  await waitFor(async () => Math.abs(await page.locator('[data-testid="conversation-turn-6"]').evaluate(el => el.getBoundingClientRect().top) - 150) < 5, "selected prompt stays at the jump destination after layout settles");
});

test("a second jump cancels realignment of an earlier destination", async () => {
  await reset();
  await page.locator("#chatwing-root .pin").click();
  await page.locator("#chatwing-root .entry").nth(3).click();
  await page.locator("#chatwing-root .entry").nth(5).click();
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.ok(Math.abs(await page.locator('[data-testid="conversation-turn-10"]').evaluate(el => el.getBoundingClientRect().top) - 150) < 5);
});

test("jump resolves a replacement node before the debounced scan runs", async () => {
  await reset();
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="conversation-turn-6"]');
    target.replaceWith(target.cloneNode(true));
    document.getElementById("chatwing-root").shadowRoot.querySelectorAll(".entry")[3].click();
  });
  await waitFor(async () => Math.abs(await page.locator('[data-testid="conversation-turn-6"]').evaluate(el => el.getBoundingClientRect().top) - 150) < 5, "replacement prompt is resolved immediately");
});

test("manual scrolling cancels pending jump realignment", async () => {
  await reset();
  await page.locator("#chatwing-root .entry").nth(3).click();
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 350);
  await new Promise(resolve => setTimeout(resolve, 250));
  const readingPosition = await page.locator("main").evaluate(el => el.scrollTop);
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "200px";
    document.querySelector("main").style.overflowAnchor = "none";
    document.querySelector('[data-testid="conversation-turn-6"]').before(spacer);
  });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(Math.abs(await page.locator("main").evaluate(el => el.scrollTop) - readingPosition) < 5, "late layout changes do not pull the user back");
});

test("smooth jumps settle on the chosen prompt after a delayed layout change", async () => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  try {
    await reset();
    await page.evaluate(() => {
      const scroller = document.querySelector("main");
      scroller.style.overflowAnchor = "none";
      scroller.addEventListener("scroll", () => {
        setTimeout(() => {
          const spacer = document.createElement("div");
          spacer.style.height = "220px";
          document.querySelector('[data-testid="conversation-turn-6"]').before(spacer);
        }, 180);
      }, { once: true });
    });
    await page.locator("#chatwing-root .entry").nth(3).click();
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.ok(Math.abs(await page.locator('[data-testid="conversation-turn-6"]').evaluate(el => el.getBoundingClientRect().top) - 150) < 5);
  } finally {
    await page.emulateMedia({ reducedMotion: "reduce" });
  }
});

test("switching chats during a smooth jump cancels the previous native scroll", async () => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  try {
    await reset();
    await page.locator("#chatwing-root .entry").nth(5).click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const readingPosition = await page.evaluate(() => {
      const conversation = document.getElementById("conversation");
      conversation.replaceChildren(...[...conversation.children].map(node => node.cloneNode(true)));
      for (const turn of conversation.children) turn.dataset.turnKey = `new-chat-${turn.dataset.turnKey}`;
      history.pushState({}, "", "/c/navigation-regression-new-chat");
      return document.querySelector("main").scrollTop;
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.ok(Math.abs(await page.locator("main").evaluate(el => el.scrollTop) - readingPosition) < 5, "old chat's native smooth scroll cannot move the reused scroller in the new chat");
  } finally {
    await page.emulateMedia({ reducedMotion: "reduce" });
  }
});

test("jump follows a grouped turn when lazy mounting replaces the placeholder key", async () => {
  await page.goto("https://chatgpt.com/c/grouped-navigation");
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 2, "grouped directory ready");
  await page.evaluate(() => {
    const scroller = document.querySelector("main");
    const group = document.createElement("div");
    group.dataset.turnKey = "unread-prompt";
    // The pending shell occupies a virtual height until the real prompt mounts.
    group.style.minHeight = "1400px";
    document.querySelector("#thread").append(group);
    scroller.style.overflowAnchor = "none";
    scroller.addEventListener("scroll", () => {
      setTimeout(() => {
        group.innerHTML = '<div style="height: 240px"></div><div data-content-search-unit-key="unread:0:user"><div data-user-message-bubble="true">旧消息挂载后的真实提问</div></div><div data-content-search-unit-key="unread:1:assistant"><div class="markdown">旧消息的回答</div></div>';
      }, 40);
    }, { once: true });
  });
  await waitFor(async () => await page.locator("#chatwing-root .entry").count() === 3, "unread group remains reachable in directory");
  await page.locator("#chatwing-root .rail").hover();
  await page.locator("#chatwing-root .entry").last().click();
  await waitFor(async () => await page.locator('[data-content-search-unit-key="unread:0:user"]').count() === 1, "prompt mounts after jump");
  await waitFor(async () => Math.abs(await page.locator('[data-content-search-unit-key="unread:0:user"]').evaluate(el => el.getBoundingClientRect().top) - 86) < 5, "jump follows the real prompt within its group");
});
