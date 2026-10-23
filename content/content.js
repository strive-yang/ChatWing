(() => {
  "use strict";

  const HOST_ID = "chatwing-root";
  if (document.getElementById(HOST_ID)) return;

  const TURN_SELECTOR = '[data-testid^="conversation-turn-"], [data-turn-key], [data-turn="user"], [data-turn="assistant"]';
  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const CURRENT_ROLE_SELECTOR = '[data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"], [data-conversation-role="user"], [data-conversation-role="assistant"]';
  const MESSAGE_SELECTOR = `${ROLE_SELECTOR}, ${CURRENT_ROLE_SELECTOR}, [data-user-message-bubble="true"], .markdown`;
  const cache = new Map();
  const groupSnapshots = new Map();
  const state = { entries: [], active: -1, previewKey: null, pinned: false, open: false, loading: false };
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.dataset.version = chrome.runtime.getManifest().version;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CHATWING_CSS;
  shadow.append(style);

  // Only this static, extension-owned template is parsed as HTML. Messages always use textContent.
  const template = document.createElement("template");
  template.innerHTML = `
    <div class="wing">
      <button class="rail" aria-label="展开 ChatWing 对话目录" aria-expanded="false" aria-controls="cw-panel">
        <span class="ticks" aria-hidden="true"></span>
      </button>
      <section id="cw-panel" class="panel" aria-label="ChatWing 对话目录" inert>
          <div class="tools">
            <span class="conversation-count" title="当前分支已读取的提问轮数；点击圆形箭头补全历史" aria-live="polite" aria-atomic="true">已读 0 轮</span>
            <button class="icon-button load-button" aria-label="补全目录" title="补全未加载的消息">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.5 7a6 6 0 1 0 .4 5M15.5 3.5V7H12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="icon-button pin" aria-label="固定目录" aria-pressed="false" title="固定目录">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7 3 7 0-1 5 3 3v1H5v-1l3-3-1-5ZM10.5 12v5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>
            </button>
            <button class="icon-button close" aria-label="收起目录" title="收起目录">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
          </div>
        <nav class="list" aria-label="当前聊天的提问"><ol></ol><div class="empty">暂无消息<details class="diagnostics"><summary>查看识别状态</summary><pre class="diagnostics-data"></pre></details></div></nav>
          <div class="notice" role="status" aria-live="polite" hidden></div>
        <aside class="preview" aria-label="消息预览" tabindex="0" hidden>
          <p class="question"></p>
          <div class="answer-section"><p class="answer"></p></div>
        </aside>
      </section>
    </div>
    <div class="completion-cover" role="region" aria-label="目录补全进度" hidden>
      <div class="completion-status">
        <p class="completion-title">正在整理历史目录</p>
        <p class="completion-progress" role="status" aria-live="polite" aria-atomic="true"></p>
        <button class="completion-stop">停止并回到原位</button>
      </div>
    </div>`;
  shadow.append(template.content.cloneNode(true));
  document.body.append(host);

  const ui = {};
  for (const name of ["wing", "rail", "ticks", "panel", "pin", "close", "list", "empty", "load-button", "notice", "preview", "question", "answer", "conversation-count", "completion-cover", "completion-progress", "completion-stop"]) {
    ui[name] = shadow.querySelector(`.${name}`);
  }
  ui.ol = shadow.querySelector("ol");
  let route = routeKey();
  let scanTimer = 0;
  let closeTimer = 0;
  let scrollFrame = 0;
  let renderSignature = "";
  let loadController = null;
  let jumpController = null;
  let restoreAfterLoad = true;
  let noticeTimer = 0;
  let lastScanScroller = null;
  let lastScanTop = 0;
  let windowed = false;
  let loadSeen = null;
  let loadViewport = null;
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  function routeKey() {
    return location.pathname + location.search;
  }

  function updateTheme() {
    const root = document.documentElement;
    const declared = root.getAttribute("data-theme") || document.body.getAttribute("data-theme");
    const classes = `${root.className} ${document.body.className}`;
    const dark = declared === "dark" || /\bdark\b/.test(classes);
    const light = declared === "light" || /\blight\b/.test(classes);
    const scheme = getComputedStyle(root).colorScheme;
    host.dataset.theme = dark ? "dark" : light ? "light" : scheme === "dark" ? "dark" : scheme === "light" ? "light" : systemTheme.matches ? "dark" : "light";
  }

  function setOpen(open) {
    clearTimeout(closeTimer);
    const wasOpen = state.open;
    state.open = open;
    ui.wing.classList.toggle("is-open", open);
    ui.rail.setAttribute("aria-expanded", String(open));
    ui.rail.setAttribute("aria-label", open ? "收起 ChatWing 对话目录" : "展开 ChatWing 对话目录");
    ui.panel.inert = !open;
    if (!open) hidePreview();
    else if (!wasOpen) {
      const active = ui.ol.querySelector('[aria-current="location"]');
      if (active) {
        const delta = active.getBoundingClientRect().top - ui.list.getBoundingClientRect().top;
        if (delta < 0 || delta + active.offsetHeight > ui.list.clientHeight) ui.list.scrollTop += delta - 12;
      }
    }
  }

  function setPinned(pinned) {
    state.pinned = pinned;
    ui.pin.setAttribute("aria-pressed", String(pinned));
    ui.pin.setAttribute("aria-label", pinned ? "取消固定目录" : "固定目录");
    ui.pin.title = pinned ? "取消固定目录" : "固定目录";
  }

  function closePanel() {
    setPinned(false);
    setOpen(false);
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!state.pinned && !ui.wing.matches(":hover") && !ui.panel.contains(shadow.activeElement)) setOpen(false);
    }, 260);
  }

  function messageText(node, role) {
    if (!node) return "";
    const body = role === "user"
      ? node.querySelector('[data-user-message-bubble], .whitespace-pre-wrap') || node
      : node.querySelector(".markdown") || node;
    const clone = body.cloneNode(true);
    clone.querySelectorAll('button, svg, script, style, textarea, input, select, .sr-only, [aria-hidden="true"], [hidden]').forEach(el => el.remove());
    clone.querySelectorAll("br").forEach(el => el.replaceWith("\n"));
    clone.querySelectorAll("p, li, pre, blockquote, h1, h2, h3, h4, tr, div").forEach(el => el.append("\n"));
    return clone.textContent.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function roleOf(node) {
    if (!node) return null;
    const explicit = node.getAttribute("data-message-author-role") || node.getAttribute("data-conversation-role") || node.getAttribute("data-turn");
    if (explicit === "user" || explicit === "assistant") return explicit;
    const unitRole = node.getAttribute("data-content-search-unit-key")?.match(/:(user|assistant)$/)?.[1];
    if (unitRole) return unitRole;
    if (node.matches('[data-user-message-bubble="true"]')) return "user";
    if (node.matches(".markdown")) return "assistant";
    return null;
  }

  function outermost(nodes, boundary) {
    const selected = new Set(nodes);
    return nodes.filter(node => {
      for (let parent = node.parentElement; parent && parent !== boundary; parent = parent.parentElement) {
        if (selected.has(parent)) return false;
      }
      return true;
    });
  }

  function describeMessage(anchor, index) {
    const source = anchor.matches(MESSAGE_SELECTOR) ? anchor : anchor.querySelector(MESSAGE_SELECTOR);
    const role = roleOf(anchor) || roleOf(source) || anchor.getAttribute("data-turn-key")?.match(/:(user|assistant)$/)?.[1];
    const groupKey = anchor.closest("[data-turn-key]")?.getAttribute("data-turn-key");
    const key = anchor.getAttribute("data-content-search-unit-key") || anchor.getAttribute("data-turn-key") || anchor.getAttribute("data-turn-id") || anchor.getAttribute("data-testid") || anchor.id || source?.getAttribute("data-message-id") || (groupKey && role ? `${groupKey}:${role}` : `position-${index}`);
    return { anchor, source: source || anchor, key, role: role || cache.get(key)?.role };
  }

  function collectMessages() {
    const visibility = new WeakMap();
    const isActive = node => {
      if (!node || node === document.documentElement) return true;
      if (visibility.has(node)) return visibility.get(node);
      const style = getComputedStyle(node);
      const active = !node.hidden && !node.inert && node.getAttribute("aria-hidden") !== "true" && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && isActive(node.parentElement);
      visibility.set(node, active);
      return active;
    };
    // Some layouts render the thread outside the first <main> element.
    const main = [...document.querySelectorAll('#thread, main, [role="main"]'), document.body]
      .find(root => isActive(root) && [...root.querySelectorAll(`${TURN_SELECTOR}, ${MESSAGE_SELECTOR}`)].some(isActive)) || document.body;
    const groups = outermost([...main.querySelectorAll(TURN_SELECTOR)].filter(isActive), main);
    const messages = [];
    const seenGroups = new Set();
    for (const group of groups) {
      const groupKey = group.getAttribute("data-turn-key");
      const units = outermost([...group.querySelectorAll(MESSAGE_SELECTOR)].filter(isActive), group);
      const roles = new Set(units.map(roleOf).filter(Boolean));
      const groupRole = roleOf(group) || groupKey?.match(/:(user|assistant)$/)?.[1];
      if (roles.size > 1 || (groupKey && !groupRole)) {
        // Current ChatGPT groups the user prompt AND the response under one key.
        const boundaryKey = groupKey || describeMessage(group, messages.length).key;
        seenGroups.add(boundaryKey);
        const parts = units.map((unit, index) => describeMessage(unit, messages.length + index));
        let previous = groupSnapshots.get(boundaryKey) || [];
        const question = parts.find(part => part.role === "user");
        const oldQuestion = previous.find(part => part.role === "user");
        if (question && oldQuestion) {
          const saved = cache.get(oldQuestion.key);
          const changedText = saved?.text && question.source.textContent.trim() && question.source.textContent !== saved.raw && messageText(question.source, "user") !== saved.text;
          // An edited branch must not inherit the old answer while it generates.
          if (question.key !== oldQuestion.key || changedText) {
            for (const part of previous) if (part.role === "assistant") cache.delete(part.key);
            previous = [];
          }
        }
        const merged = ["user", "assistant"].flatMap(role => {
          const live = parts.filter(part => part.role === role);
          return live.length ? live : previous.filter(part => part.role === role).map(part => ({ ...part, anchor: group, source: null }));
        });
        // A stable turn shell still identifies a navigable round before ChatGPT
        // mounts its messages. Do not reduce a long thread to its visible turns.
        if (!merged.length && !units.length) merged.push({ key: `${boundaryKey}:user`, role: "user", anchor: group, source: null });
        messages.push(...merged.map(part => ({ ...part, groupKey: boundaryKey, orderAnchor: group })));
        groupSnapshots.set(boundaryKey, merged.map(({ key, role }) => ({ key, role })));
      } else messages.push(describeMessage(group, messages.length));
    }
    const loose = [...main.querySelectorAll(MESSAGE_SELECTOR)].filter(node => {
      if (!isActive(node)) return false;
      const group = node.closest(TURN_SELECTOR);
      return !group || !main.contains(group);
    });
    messages.push(...outermost(loose, main).map((node, index) => describeMessage(node, messages.length + index)));
    for (const key of groupSnapshots.keys()) if (!seenGroups.has(key)) groupSnapshots.delete(key);
    return messages.sort((a, b) => {
      const left = a.orderAnchor || a.anchor;
      const right = b.orderAnchor || b.anchor;
      return left === right ? 0 : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function collectEntries() {
    const seen = new Set();
    const entries = [];
    let current = null;

    for (const { anchor, source, key, role, groupKey } of collectMessages()) {
      const previous = cache.get(key);
      if (role !== "user" && role !== "assistant") continue;
      const raw = source?.textContent || "";
      // Streaming changes one answer; avoid cloning every old message on each update.
      const extracted = !raw ? "" : previous?.role === role && previous.raw === raw ? previous.text : messageText(source, role);
      const text = role === "assistant" ? extracted.slice(0, 600) : extracted;
      const record = { role, raw, text: text || (previous?.role === role ? previous.text : "") || "" };
      cache.set(key, record);
      seen.add(key);

      if (role === "user") {
        const attachment = anchor.querySelector("img[alt]")?.getAttribute("alt");
        current = {
          key, anchor, groupKey,
          question: record.text,
          label: record.text.replace(/\s+/g, " ").slice(0, 100) || (attachment ? `图片：${attachment}` : "提问内容待加载"),
          answer: "",
          pending: !record.text,
        };
        entries.push(current);
      } else if (current && current.groupKey === groupKey && record.text) {
        current.answer = `${current.answer}${current.answer ? "\n\n" : ""}${record.text}`.slice(0, 600);
      }
    }
    // A removed shell may be an edited/deleted branch; don't retain its old messages.
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    return entries;
  }

  function reconcileEntries(mounted) {
    if (!mounted.length) {
      windowed = false;
      lastScanScroller = null;
      return [];
    }
    const container = scrollContainer(mounted[0].anchor);
    const top = container.scrollTop;
    const identity = entry => entry.groupKey || entry.key;
    const previous = new Map(state.entries.map(entry => [identity(entry), entry]));
    const liveKeys = new Set(mounted.map(identity));
    const missing = state.entries.some(entry => !liveKeys.has(identity(entry)));
    const arriving = mounted.some(entry => !previous.has(identity(entry)));
    const scrolled = container === lastScanScroller && Math.abs(top - lastScanTop) > 2;
    if (container !== lastScanScroller) windowed = false;
    // A scrolling window can remove the entire turn, not just its contents.
    // Only retain missing turns after observing that window move; ordinary
    // branch deletions in a fully mounted thread still remove their entries.
    if (missing && arriving && (scrolled || state.loading)) windowed = true;
    lastScanScroller = container;
    lastScanTop = top;
    const live = mounted.map(entry => ({ ...entry, container,
      position: top + entry.anchor.getBoundingClientRect().top - viewportTop(container) }));
    if (!windowed) return live;

    const edited = live.find(entry => {
      const old = previous.get(identity(entry));
      return old?.question && entry.question && old.question !== entry.question;
    });
    const retained = state.entries.filter(entry => !edited || entry.position < previous.get(identity(edited)).position);
    const merged = new Map(retained.map(entry => [identity(entry), {
      ...entry, anchor: entry.anchor?.isConnected ? entry.anchor : null,
    }]));
    for (const entry of live) {
      const old = merged.get(identity(entry));
      merged.set(identity(entry), old && entry.pending ? {
        ...entry, question: old.question, label: old.label, answer: old.answer, pending: old.pending,
      } : entry);
    }
    return [...merged.values()].sort((a, b) => a.position - b.position);
  }

  function scan() {
    clearTimeout(scanTimer);
    scanTimer = 0;
    checkRoute();
    const previousKey = state.entries[state.active]?.key;
    const previousPreview = state.entries.find(item => item.key === state.previewKey);
    const mounted = collectEntries();
    if (loadSeen) for (const entry of mounted) loadSeen.add(entry.groupKey || entry.key);
    state.entries = reconcileEntries(mounted);
    if (!state.entries.length) {
      // Counts only: do not include conversation IDs, prompts, answers or tokens.
      shadow.querySelector(".diagnostics-data").textContent = JSON.stringify({
        version: host.dataset.version,
        documentState: document.readyState,
        turnGroups: document.querySelectorAll(TURN_SELECTOR).length,
        legacyRoleMarkers: document.querySelectorAll(ROLE_SELECTOR).length,
        currentRoleMarkers: document.querySelectorAll(CURRENT_ROLE_SELECTOR).length,
        userBubbles: document.querySelectorAll('[data-user-message-bubble="true"]').length,
        answerBlocks: document.querySelectorAll(".markdown").length,
      }, null, 2);
    }
    state.active = state.entries.findIndex(entry => entry.key === previousKey);
    const signature = JSON.stringify(state.entries.map(entry => [entry.key, entry.label, entry.pending]));
    if (signature !== renderSignature) {
      renderSignature = signature;
      renderList();
    }
    if (state.previewKey) {
      const entry = state.entries.find(item => item.key === state.previewKey) ||
        (previousPreview?.groupKey && state.entries.find(item => item.groupKey === previousPreview.groupKey));
      if (entry) {
        state.previewKey = entry.key;
        updatePreview(entry);
      } else hidePreview();
    }
    updateActive();
    updateCompletionCover();
  }

  function scheduleScan() {
    // A bounded delay also updates during a continuously streaming answer.
    if (!scanTimer) scanTimer = setTimeout(scan, 180);
  }

  function renderList() {
    ui["conversation-count"].textContent = `已读 ${state.entries.length} 轮`;
    const fragment = document.createDocumentFragment();
    state.entries.forEach((entry, index) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.className = `entry${entry.pending ? " is-pending" : ""}`;
      button.dataset.key = entry.key;
      button.setAttribute("aria-label", entry.label);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = entry.label;
      button.append(label);
      button.addEventListener("pointerenter", () => showPreview(entry.key));
      button.addEventListener("focus", () => showPreview(entry.key));
      button.addEventListener("click", () => jumpTo(entry.key));
      button.addEventListener("keydown", event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...ui.ol.querySelectorAll("button")];
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
        buttons[next]?.focus();
      });
      li.append(button);
      fragment.append(li);
    });
    const scrollTop = ui.list.scrollTop;
    const focusedKey = shadow.activeElement?.dataset.key;
    ui.ol.replaceChildren(fragment);
    ui.list.scrollTop = scrollTop;
    if (focusedKey) [...ui.ol.querySelectorAll("button")].find(button => button.dataset.key === focusedKey)?.focus({ preventScroll: true });
    ui.empty.hidden = state.entries.length > 0;
    updateControls();
    const ticks = document.createDocumentFragment();
    for (let i = 0; i < Math.min(9, state.entries.length || 5); i++) {
      const tick = document.createElement("span");
      tick.className = "tick";
      ticks.append(tick);
    }
    ui.ticks.replaceChildren(ticks);
  }

  function updateControls() {
    const label = state.loading ? "停止补全" : state.entries.length ? "补全目录" : "重新检测";
    ui["load-button"].setAttribute("aria-label", label);
    ui["load-button"].setAttribute("aria-busy", String(state.loading));
    ui["load-button"].title = label;
    ui["conversation-count"].title = `ChatWing ${host.dataset.version} · 当前分支已读取的提问轮数；点击圆形箭头补全历史`;
  }

  function updateCompletionCover() {
    if (!loadViewport || ui["completion-cover"].hidden) return;
    const rect = loadViewport === document.scrollingElement
      ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      : loadViewport.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    Object.assign(ui["completion-cover"].style, {
      left: `${left - hostRect.left}px`, top: `${top - hostRect.top}px`,
      width: `${Math.max(0, Math.min(innerWidth, rect.right) - left)}px`,
      height: `${Math.max(0, Math.min(innerHeight, rect.bottom) - top)}px`,
    });
    const progress = `已读 ${state.entries.length} 轮`;
    if (ui["completion-progress"].textContent !== progress) ui["completion-progress"].textContent = progress;
  }

  function setCompletionCover(container) {
    loadViewport = container;
    if (!container && ui["completion-cover"].contains(shadow.activeElement)) {
      (state.open ? ui["load-button"] : ui.rail).focus({ preventScroll: true });
    }
    ui["completion-cover"].hidden = !container;
    updateCompletionCover();
  }

  function scrollContainer(element) {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY;
      if ((/(auto|scroll)/.test(overflow) || (overflow === "hidden" && parent.hasAttribute("data-scroll-root"))) && parent.scrollHeight > parent.clientHeight + 1) return parent;
    }
    return document.scrollingElement || document.documentElement;
  }

  function viewportTop(container) {
    return container === document.scrollingElement ? 0 : container.getBoundingClientRect().top;
  }

  function scrollBounds(container) {
    const extent = Math.max(0, container.scrollHeight - container.clientHeight);
    const style = getComputedStyle(container);
    const reverse = (style.display.includes("flex") && style.flexDirection === "column-reverse") || container.scrollTop < 0;
    return reverse ? { min: -extent, max: 0 } : { min: 0, max: extent };
  }

  function clampScrollTop(container, top) {
    const { min, max } = scrollBounds(container);
    return Math.max(min, Math.min(max, top));
  }

  function updateActive() {
    scrollFrame = 0;
    if (!state.entries.length) {
      state.active = -1;
      return;
    }
    const firstMounted = state.entries.findIndex(entry => entry.anchor?.isConnected);
    if (firstMounted < 0) return;
    const container = scrollContainer(state.entries[firstMounted].anchor);
    const threshold = viewportTop(container) + Math.min(150, container.clientHeight * .23);
    let active = firstMounted;
    state.entries.forEach((entry, index) => {
      if (entry.anchor?.isConnected && entry.anchor.getBoundingClientRect().top <= threshold) active = index;
    });
    state.active = active;
    [...ui.ol.querySelectorAll(".entry")].forEach((button, index) => {
      if (index === active) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    });
    const tickIndex = state.entries.length < 2 ? 0 : Math.round(active / (state.entries.length - 1) * (ui.ticks.children.length - 1));
    [...ui.ticks.children].forEach((tick, index) => tick.classList.toggle("is-active", index === tickIndex));
  }

  function updatePreview(entry) {
    ui.question.textContent = entry.question || "内容尚未加载，点击定位。";
    ui.answer.textContent = entry.answer ? `${entry.answer.slice(0, 480)}${entry.answer.length > 480 ? "…" : ""}` : "暂无回答";
  }

  function positionPreview() {
    if (innerWidth <= 640 || ui.preview.hidden) return;
    const panelRect = ui.panel.getBoundingClientRect();
    // The preview can be taller than the directory; keep both inside the viewport.
    ui.preview.style.top = `${Math.max(16 - panelRect.top, Math.min(0, innerHeight - 16 - panelRect.top - ui.preview.offsetHeight))}px`;
  }

  function showPreview(key) {
    if (state.loading) return;
    const entry = state.entries.find(item => item.key === key);
    if (!entry) return;
    state.previewKey = key;
    updatePreview(entry);
    ui.preview.hidden = false;
    positionPreview();
  }

  function hidePreview() {
    state.previewKey = null;
    ui.preview.hidden = true;
  }

  function notify(message, persistent = false) {
    clearTimeout(noticeTimer);
    ui.notice.textContent = message;
    ui.notice.title = message;
    ui.notice.hidden = !message;
    if (!persistent) noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 5000);
  }

  async function jumpTo(key) {
    restoreAfterLoad = false;
    loadController?.abort();
    setCompletionCover(null);
    jumpController?.abort();
    const requested = state.entries.find(item => item.key === key);
    const requestedRoute = route;
    // Resolve against the current DOM, including a render that has not reached
    // the debounced observer yet. A clicked key must never use an old anchor.
    scan();
    const entry = route === requestedRoute ? (state.entries.find(item => item.key === key) ||
      (requested?.groupKey && state.entries.find(item => item.groupKey === requested.groupKey))) : null;
    if (!entry) {
      scheduleScan();
      notify("消息已变化，目录正在更新。");
      return;
    }
    const container = entry.anchor?.isConnected ? scrollContainer(entry.anchor) : entry.container;
    if (!container?.isConnected) return;
    const controller = new AbortController();
    jumpController = controller;
    const { signal } = controller;
    const stopScroll = () => container.scrollTo({ top: container.scrollTop, behavior: "instant" });
    signal.addEventListener("abort", stopScroll, { once: true });
    const savedRoute = route;
    const targetTop = item => clampScrollTop(container,
      item.anchor?.isConnected ? container.scrollTop + item.anchor.getBoundingClientRect().top - viewportTop(container) - 86 : item.position - 86);
    container.scrollTo({ top: targetTop(entry), behavior: reducedMotion.matches ? "instant" : "smooth" });
    const bubble = entry.anchor?.querySelector('[data-user-message-bubble], [data-message-author-role="user"]') || entry.anchor;
    if (bubble && !reducedMotion.matches) bubble.animate([
      { outline: "2px solid transparent", outlineOffset: "6px" },
      { outline: "2px solid #6aa98b", outlineOffset: "6px", offset: .18 },
      { outline: "2px solid transparent", outlineOffset: "6px" },
    ], { duration: 1700, easing: "ease-out" });
    if (!state.pinned) {
      if (ui.panel.contains(shadow.activeElement)) ui.rail.focus({ preventScroll: true });
      setOpen(false);
    }
    const stopOnInput = event => {
      if (event.composedPath().includes(host)) return;
      if (event.type !== "keydown" || ["Escape", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) controller.abort();
    };
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) document.addEventListener(type, stopOnInput, { capture: true, passive: true });
    try {
      // Let native smooth scrolling finish before correcting lazy-rendered
      // layout shifts. Corrections are bounded and stop on any user scroll.
      let previousTop = container.scrollTop;
      let stable = 0;
      for (let attempt = 0; attempt < 20 && stable < 2 && !signal.aborted; attempt++) {
        await delay(60, signal);
        const nextTop = container.scrollTop;
        stable = Math.abs(nextTop - previousTop) < 1 ? stable + 1 : 0;
        previousTop = nextTop;
      }
      for (let attempt = 0; attempt < 10 && !signal.aborted && routeKey() === savedRoute; attempt++) {
        if (scanTimer) scan();
        const current = state.entries.find(item => item.key === entry.key) ||
          (entry.groupKey && state.entries.find(item => item.groupKey === entry.groupKey));
        if (!current) break;
        const top = targetTop(current);
        if (Math.abs(container.scrollTop - top) > 2) container.scrollTo({ top, behavior: "instant" });
        await delay(100, signal);
      }
    } finally {
      signal.removeEventListener("abort", stopScroll);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) document.removeEventListener(type, stopOnInput, true);
      if (jumpController === controller) jumpController = null;
    }
  }

  function delay(ms, signal) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  function historyBusy(container) {
    return container.getAttribute("aria-busy") === "true" ||
      !!container.querySelector('#thread[aria-busy="true"], [data-conversation-transcript][aria-busy="true"], [data-scroll-root][aria-busy="true"]');
  }

  async function waitForHistory(container, ms, signal) {
    await delay(ms, signal);
    const started = Date.now();
    while (!signal.aborted && historyBusy(container) && Date.now() - started < 6000) await delay(100, signal);
    return signal.aborted || !historyBusy(container);
  }

  async function loadConversation() {
    if (state.loading) {
      loadController?.abort();
      return;
    }
    scan();
    const active = state.entries[state.active];
    const entry = active?.anchor?.isConnected ? active : state.entries.find(item => item.anchor?.isConnected);
    if (!entry) return;
    jumpController?.abort();
    const container = scrollContainer(entry.anchor);
    const savedTop = container.scrollTop;
    const savedAnchor = entry.anchor;
    const savedOffset = savedAnchor.getBoundingClientRect().top - viewportTop(container);
    const savedRoute = route;
    loadController = new AbortController();
    restoreAfterLoad = true;
    const { signal } = loadController;
    state.loading = true;
    loadSeen = new Set();
    for (const item of state.entries) if (item.anchor?.isConnected) loadSeen.add(item.groupKey || item.key);
    updateControls();
    hidePreview();
    setCompletionCover(container);
    notify("");
    const stopOnInput = event => {
      // Our own buttons cancel in their click handlers; cancelling on pointerdown
      // would finish first and make the following click start a second scan.
      if (["pointerdown", "touchstart"].includes(event.type) && event.composedPath().includes(host)) return;
      if (event.type !== "keydown" || ["Escape", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) loadController?.abort();
    };
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) document.addEventListener(type, stopOnInput, { capture: true, passive: true });
    let complete = false;
    let waiting = false;
    try {
      const started = Date.now();
      let firstKey = null;
      // Give ChatGPT time to prepend older turns when the top edge is reached.
      for (let pass = 0; pass < 120 && Date.now() - started < 90000 && !signal.aborted; pass++) {
        container.scrollTo({ top: scrollBounds(container).min, behavior: "instant" });
        if (!await waitForHistory(container, 600, signal)) { waiting = true; break; }
        if (routeKey() !== savedRoute) break;
        scan();
        const nextKey = `${container.scrollHeight}:${state.entries.find(item => item.anchor?.isConnected)?.key}`;
        if (nextKey && nextKey === firstKey) break;
        firstKey = nextKey;
      }
      let stableBottom = 0;
      for (let step = 0; step < 240 && Date.now() - started < 90000 && !signal.aborted && !waiting; step++) {
        if (routeKey() !== savedRoute) break;
        scan();
        const bottom = scrollBounds(container).max;
        if (container.scrollTop >= bottom - 3) {
          stableBottom++;
          if (stableBottom >= 3) { complete = true; break; }
        } else stableBottom = 0;
        container.scrollTo({ top: Math.min(bottom, container.scrollTop + Math.max(160, container.clientHeight * .75)), behavior: "instant" });
        if (!await waitForHistory(container, 160, signal)) waiting = true;
      }
    } finally {
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) document.removeEventListener(type, stopOnInput, true);
      if (complete && !signal.aborted && routeKey() === savedRoute) {
        state.entries = state.entries.filter(item => loadSeen.has(item.groupKey || item.key));
      }
      loadSeen = null;
      if (routeKey() === savedRoute) {
        if (restoreAfterLoad) {
          const restored = savedAnchor.isConnected ? container.scrollTop + savedAnchor.getBoundingClientRect().top - viewportTop(container) - savedOffset : savedTop;
          container.scrollTo({ top: clampScrollTop(container, restored), behavior: "instant" });
          // Let the host remount the restored window before revealing it.
          if (!document.hidden) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
      }
      setCompletionCover(null);
      state.loading = false;
      loadController = null;
      updateControls();
      if (routeKey() === savedRoute) {
        scan();
        const pending = state.entries.filter(item => item.pending).length;
        notify(waiting ? `已读取 ${state.entries.length} 轮，页面仍在加载，可稍后继续补全。` : complete ? `已读取 ${state.entries.length} 轮${pending ? `，仍有 ${pending} 条需页面加载` : "，已回到原位"}。` : restoreAfterLoad ? "已停止补全，并回到原位。" : "已停止补全。");
      }
    }
  }

  function checkRoute() {
    const next = routeKey();
    if (next === route) return false;
    loadController?.abort();
    setCompletionCover(null);
    jumpController?.abort();
    route = next;
    cache.clear();
    groupSnapshots.clear();
    lastScanScroller = null;
    windowed = false;
    state.entries = [];
    state.active = -1;
    renderSignature = "";
    hidePreview();
    notify("");
    ui.list.scrollTop = 0;
    renderList();
    return true;
  }

  ui.wing.addEventListener("pointerenter", () => { scan(); setOpen(true); });
  // Keep ChatGPT's page-level wheel handlers from taking over our scroll areas.
  for (const area of [ui.list, ui.preview]) area.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
  ui.wing.addEventListener("pointerleave", scheduleClose);
  ui.wing.addEventListener("focusout", scheduleClose);
  ui.rail.addEventListener("focus", () => setOpen(true));
  ui.rail.addEventListener("click", () => { setPinned(!state.pinned); setOpen(true); });
  ui.pin.addEventListener("click", () => { setPinned(!state.pinned); setOpen(true); });
  ui.close.addEventListener("click", () => { ui.rail.focus({ preventScroll: true }); closePanel(); });
  ui["completion-stop"].addEventListener("click", () => loadController?.abort());
  ui["load-button"].addEventListener("click", () => {
    if (state.loading || state.entries.length) loadConversation();
    else {
      scan();
      if (!state.entries.length) notify("仍未识别到消息，可展开「查看识别状态」检查。", true);
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    loadController?.abort();
    jumpController?.abort();
    if (state.open) {
      if (ui.panel.contains(shadow.activeElement)) ui.rail.focus({ preventScroll: true });
      closePanel();
    }
  });
  document.addEventListener("pointerdown", event => {
    if (state.open && !event.composedPath().includes(host) && !state.pinned) closePanel();
  });
  document.addEventListener("scroll", event => {
    if (event.target === host) return;
    if (!scrollFrame) scrollFrame = requestAnimationFrame(updateActive);
  }, { capture: true, passive: true });
  window.addEventListener("resize", () => { positionPreview(); updateActive(); updateCompletionCover(); });
  window.addEventListener("popstate", () => { checkRoute(); scheduleScan(); });
  window.addEventListener("hashchange", scheduleScan);
  window.navigation?.addEventListener("currententrychange", () => { checkRoute(); scheduleScan(); });
  window.addEventListener("pageshow", scheduleScan);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleScan(); });
  systemTheme.addEventListener("change", updateTheme);
  new MutationObserver(records => {
    const conversationSelector = `main, #thread, [role="main"], ${TURN_SELECTOR}, ${MESSAGE_SELECTOR}`;
    const containsConversation = node => node.nodeType === Node.ELEMENT_NODE && (node.matches(conversationSelector) || !!node.querySelector(conversationSelector));
    const changed = records.some(record => {
      if (record.type === "childList") {
        return !!record.target.closest?.(conversationSelector) || [...record.addedNodes, ...record.removedNodes].some(containsConversation);
      }
      if (record.type === "characterData") return !!record.target.parentElement?.closest(conversationSelector);
      if (!["class", "style", "hidden", "inert", "aria-hidden"].includes(record.attributeName)) return true;
      const target = record.target;
      return target.matches(`main, #thread, [role="main"], ${TURN_SELECTOR}, ${MESSAGE_SELECTOR}`) || !!target.querySelector(`${TURN_SELECTOR}, ${MESSAGE_SELECTOR}`);
    });
    if (changed) scheduleScan();
  }).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["data-message-author-role", "data-conversation-role", "data-content-search-unit-key", "data-user-message-bubble", "data-turn", "data-turn-key", "data-turn-id", "data-testid", "class", "style", "hidden", "inert", "aria-hidden"],
  });
  const themeObserver = new MutationObserver(updateTheme);
  for (const target of [document.documentElement, document.body]) themeObserver.observe(target, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  // pushState is called in the page's world, not the extension's isolated world.
  setInterval(() => {
    if (document.hidden) return;
    if (!host.isConnected) document.body.append(host);
    if (checkRoute()) scan();
  }, 800);
  updateTheme();
  scan();
})();
