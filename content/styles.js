/* Styles live inside ChatWing's shadow root; nothing is added to ChatGPT's CSS. */
var CHATWING_CSS = String.raw`
  :host {
    all: initial;
    --cw-bg: #ffffff;
    --cw-raised: #f7f8f7;
    --cw-text: #232826;
    --cw-muted: #7b827e;
    --cw-line: #e9ecea;
    --cw-accent: #18745c;
    --cw-soft: #edf5f0;
    --cw-shadow: 0 8px 28px #162c2412, 0 1px 4px #162c2408;
    position: fixed;
    z-index: 2147483600;
    top: 50%;
    right: 10px;
    transform: translateY(-50%);
    color: var(--cw-text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 13px;
    line-height: 1.55;
    color-scheme: light;
    -webkit-font-smoothing: antialiased;
  }
  :host([data-theme="dark"]) {
    --cw-bg: #252826;
    --cw-raised: #2d312e;
    --cw-text: #ecf0ed;
    --cw-muted: #9ca69f;
    --cw-line: #3b413c;
    --cw-accent: #8dd8b4;
    --cw-soft: #303f35;
    --cw-shadow: 0 8px 28px #0004, 0 1px 4px #0002;
    color-scheme: dark;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible, [tabindex="0"]:focus-visible {
    outline: 2px solid var(--cw-accent);
    outline-offset: 3px;
  }
  [hidden] { display: none !important; }
  svg { display: block; width: 18px; height: 18px; flex: none; }
  .wing { position: relative; width: 24px; }
  .rail {
    width: 24px;
    min-height: 88px;
    padding: 10px 4px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    transition: background .18s;
  }
  .rail:hover, .wing.is-open .rail { background: var(--cw-raised); }
  .ticks { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; width: 16px; }
  .tick { height: 2px; width: 10px; background: var(--cw-muted); opacity: .34; border-radius: 2px; transition: width .2s; }
  .tick:nth-child(3n + 1) { width: 14px; }
  .tick.is-active { background: var(--cw-accent); opacity: 1; width: 16px; height: 3px; }
  .panel {
    position: absolute;
    right: 36px;
    top: 50%;
    width: 224px;
    max-height: min(520px, calc(100dvh - 32px));
    display: flex;
    flex-direction: column;
    border: 1px solid var(--cw-line);
    border-radius: 12px;
    background: var(--cw-bg);
    box-shadow: var(--cw-shadow);
    transform: translate(7px, -50%);
    opacity: 0;
    visibility: hidden;
    transition: opacity .16s, transform .18s, visibility .18s;
  }
  .wing.is-open .panel { opacity: 1; visibility: visible; transform: translate(0, -50%); }
  .panel::after { content: ""; position: absolute; top: 0; bottom: 0; right: -16px; width: 16px; }
  .tools { display: flex; justify-content: flex-end; gap: 2px; padding: 5px 6px 0; flex: none; }
  .icon-button { display: grid; place-items: center; width: 22px; height: 22px; padding: 4px; border: 0; border-radius: 5px; background: transparent; color: var(--cw-muted); }
  .icon-button:hover { background: var(--cw-raised); color: var(--cw-text); }
  .icon-button[aria-pressed="true"] { background: var(--cw-soft); color: var(--cw-accent); }
  .icon-button svg { width: 13px; height: 13px; }
  .load-button[aria-busy="true"] { color: var(--cw-accent); }
  .list { min-height: 48px; overflow: auto; overscroll-behavior: contain; padding: 6px; scrollbar-width: thin; scrollbar-color: var(--cw-line) transparent; }
  ol { margin: 0; padding: 0; list-style: none; }
  li + li { margin-top: 2px; }
  .entry {
    position: relative;
    display: flex;
    align-items: flex-start;
    width: 100%;
    padding: 9px 10px;
    text-align: left;
    border: 0;
    border-radius: 7px;
    background: transparent;
    line-height: 1.55;
  }
  .entry:hover, .entry:focus-visible { background: var(--cw-raised); }
  .entry[aria-current="location"] { background: var(--cw-soft); }
  .label { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; font-size: 12px; }
  .entry.is-pending .label { color: var(--cw-muted); font-style: italic; }
  .empty { padding: 16px 10px; color: var(--cw-muted); text-align: center; font-size: 12px; line-height: 1.9; }
  .diagnostics { margin-top: 16px; text-align: left; font-size: 10px; }
  .diagnostics summary { cursor: pointer; color: var(--cw-accent); }
  .diagnostics pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border-radius: 8px; background: var(--cw-raised); font: 10px/1.8 ui-monospace, monospace; user-select: text; }
  .notice { padding: 8px 12px; border-top: 1px solid var(--cw-line); color: var(--cw-muted); font-size: 11px; }
  .preview {
    position: absolute;
    right: calc(100% + 12px);
    top: 0;
    width: 280px;
    max-height: min(570px, calc(100dvh - 48px));
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--cw-line);
    border-radius: 12px;
    background: var(--cw-bg);
    box-shadow: var(--cw-shadow);
    padding: 16px;
    scrollbar-width: thin;
    scrollbar-color: var(--cw-line) transparent;
  }
  .preview::after { content: ""; position: fixed; width: 14px; height: 100%; right: -14px; top: 0; }
  .question { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.8; scrollbar-width: thin; }
  .answer-section { margin-top: 12px; border-top: 1px solid var(--cw-line); padding-top: 12px; }
  .answer { margin: 0; color: var(--cw-muted); font-size: 12px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; }
  @media (max-width: 640px) {
    .preview { position: static; width: auto; max-height: min(220px, calc(100dvh - 150px)); flex-shrink: 0; margin: 0 6px 6px; box-shadow: none; border-radius: 8px; padding: 12px; }
    .question { max-height: 100px; }
    .answer { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  }
  @media (max-width: 430px) {
    :host { right: 8px; }
    .panel { width: min(224px, calc(100vw - 60px)); right: 34px; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
`;
