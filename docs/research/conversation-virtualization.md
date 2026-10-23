# 长对话目录在补全后退回五轮：调查记录

调查日期：2026-10-22。范围：ChatWing 0.1.3 的 DOM 目录、滚动补全与缓存。未读取真实账号聊天、登录令牌或私有网络响应。

## 最有区分力的本地证据

用户反馈：同一聊天实际有十几轮，目录显示五轮；点击圆形箭头后，补全过程中条目增多，结束后又退回五轮。该反馈说明至少一部分旧消息曾被插件成功识别；它比截图中的单次计数更能区分原因。来源：本次用户报告。

0.1.3 的 `content/content.js` 在扫描时用当前 `collectEntries()` 结果替换 `state.entries`，并删除本次没有看到的消息缓存及分组快照。**代码审查结论，已由模拟页面复现**：若网页卸载整个轮次容器，恢复阅读位置后的下一次扫描会把已经读到的旧消息丢掉。上一轮“只清空正文、保留所有轮次外壳”的测试不能覆盖这种情况。模拟验证符合用户反馈，但尚未直接检查其账号的真实 DOM。

本地夹具 `tests/fixtures/windowed-layout.html` 一共十五轮，任意时刻仅挂载五轮完整容器，其余由匿名占位块维持滚动高度。修复前，`node --test --test-name-pattern='completion keeps' tests/windowed-conversation.test.cjs` 的恢复位置断言通过，但目录断言失败：实际五条，期望十五条。修复后，`node --test --test-concurrency=1 tests/completion.test.cjs tests/windowed-conversation.test.cjs` 首轮五项验证通过，覆盖累积目录、恢复位置、离屏旧条目跳转、慢历史批次和负滚动范围。浏览器路径通过 `CHATWING_BROWSER_PATH` 指定。

0.1.4 最终验证：`npm run check` 通过；`npm test` 全部 51 项通过，含编辑旧分支、重新补全清理已移除轮次，以及切换聊天清空离屏缓存。安装 ZIP 已核对完整性和运行文件与源码一致。真实账号页面尚未直接验证。

## 公开的一手实现证据

- 导出器作者在真实登录页验证了长对话分批加载，并在源码中采用“滚动一个重叠窗口、捕获内容、继续移动”的扫描方式。`captureMessage` 把已读内容写入独立的 `state.messages`，使用 `seen` 去重；最终恢复滚动位置时没有用恢复后的可见 DOM 覆写这份结果。这是“累积逻辑目录而非反复替换当前窗口”的直接实现参考。[源码：captureMessage / sweep](https://github.com/rashidazarang/chatgpt-chat-exporter/blob/master/src/extraction-engine.js#L1442)
- 同一源码记录了反向布局下旧历史延迟分批到达的情况，采用向上扫描与等待历史增长。**适用边界**：这是该作者在其页面上的观察，不是 OpenAI 对所有账号布局的保证。[源码：反向扫描](https://github.com/rashidazarang/chatgpt-chat-exporter/blob/master/src/extraction-engine.js#L3365)
- `MutationObserver` 报告的是节点和属性变化；节点离开观察树后，也不会持续观察其后续变化。**推论**：DOM 节点被移除不能单独证明对应的会话消息被用户删除。[MDN：observe](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe)
- 浏览器允许 `column-reverse` 容器的 `scrollTop` 为负，且底部为零。把所有目标一律钳制到非负值不能覆盖这种布局；这是独立的滚动兼容问题，应另用反向夹具验证。[MDN：scrollTop](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTop)

## 推荐修复路径（工程判断）

1. **把逻辑目录与当前挂载节点分开。** 补全期间按稳定消息 ID / 分组 ID 累积内容和顺序；补全结束恢复阅读位置后继续保留结果。不能把“未在当前 DOM 看到”当作自动删除条件。
2. **为断开的锚点提供定位流程。** 保留消息身份和读取时的位置，点击旧目录项时先使对应区域重新挂载，再按身份解析真实节点并校准。不能只保存已经断开的 `Element`。
3. **单独处理分支变化。** 地址切换必须清空当前聊天的索引；编辑问题、替换分支应依据可观察到的身份或内容变化重建相关部分。仅从 DOM 缺席无法可靠区分卸载与删除，避免无条件保留导致旧分支混入。
4. **诚实显示计数。** 未完成扫描时显示“已读取 N 轮”或“至少 N 轮”；DOM 扫描结束本身不能证明站点没有尚未提供的历史。不宣称获得模型完整 Session 上下文。

验证应覆盖：仅五轮容器挂载 → 补全读到全部轮次 → 恢复原位置仍保留全部 → 滚目录能访问首末项 → 点击旧项重新挂载并定位正确 → 切换聊天和编辑分支不会引用旧内容。

## 为什么不直接读取“完整 Session”

Chrome 内容脚本默认运行在隔离环境，与页面共享 DOM，但不直接共享页面 JavaScript 变量。因此读取 React 内部状态或拦截页面的 `fetch` 不是给现有 DOM 选择器换个名字，需要另外的页面桥接和数据契约。[Chrome 内容脚本文档](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

公开项目确实有另一条路线：TurboRender 在页面环境里包装 `fetch` / XHR，读取或改写 conversation payload，并维护自己的会话缓存；它还依赖 React Router loader 数据。**工程判断**：这会引入内部数据结构耦合与页面请求干预，不适合作为本次缓存缺失修复的默认手段。[TurboRender bootstrap 源码](https://github.com/mo2g/ChatGPT-TurboRender/blob/main/lib/main-world/conversation-bootstrap.ts)

OpenAI 官方的 Conversation state 文档描述的是开发者在 Responses / Conversations API 中管理模型输入与状态。该文档没有建立“可用 ChatGPT 网页聊天 ID 调用一个受支持接口读取完整网页历史”的契约；不能将这套 API 当作浏览器 DOM 的替代。[OpenAI 官方 Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

结论：本次反馈优先指向“读取过的历史在虚拟化后被目录丢弃”。尚无证据说明模型的 Session 上下文只剩五轮，也不能保证 DOM 方案一次读取站点尚未提供的全部历史。

## 后续兼容性线索

其他集成作者记录过账号间不同的 ChatGPT DOM：旧 role 属性、`data-turn-key` 分组，以及 `ol[data-conversation-transcript] > li[data-message-role]`。这些记录说明选择器需要兼容多个布局，但不是本次“补全后退回五轮”的直接证据。应与缓存修复分别复现、分别验证。[Oracle issue #517](https://github.com/steipete/oracle/issues/517)、[导出器作者的发布审计](https://github.com/rashidazarang/chatgpt-chat-exporter/blob/master/docs/RELEASE_AUDIT.md)
