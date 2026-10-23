# 开发指南

面向使用者的安装和操作说明见 [README](../README.md) 和 [使用指南](usage.md)。安装扩展不需要 Node.js、Python 或构建步骤。

## 目录与边界

| 路径 | 用途 | 进入安装包 |
| --- | --- | --- |
| `manifest.json` | 扩展声明与版本号 | 是 |
| `content/` | 内容脚本及界面样式 | 仅 manifest 声明的文件 |
| `icons/` | 扩展图标 | 仅 manifest 声明的文件 |
| `LICENSE` | MIT 许可声明 | 是 |
| `README.md`、`docs/`、`CHANGELOG.md` | 用户文档、开发文档与变更记录 | 否 |
| `tests/` | 模拟聊天页面和浏览器测试 | 否 |
| `tools/` | 打包与图标生成工具 | 否 |
| `.github/` | CI、发布工作流和协作模板 | 否 |
| `dist/` | 本地生成的安装包；不提交 Git | 已生成的结果 |
| `artifacts/`、`.cache/`、`node_modules/` | 测试输出、缓存和开发依赖；不提交 Git | 否 |

开发者文档随源码提交，方便贡献者维护；安装 ZIP 使用白名单打包，与源码仓库分开分发。公开文档中的演示图位于 `docs/images/`，不直接引用会被测试覆盖的 `artifacts/`。

## 环境与命令

CI 使用 Node.js 22、Python 3.12；本地至少需要 Node.js 20 和 Python 3.9。开发依赖只有 Playwright，`package-lock.json` 应随源码提交，使用 `npm ci` 安装锁定版本。

在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run check
npx playwright install chromium
npm test
python tools/package.py
```

Linux 首次安装浏览器时可用 `npx playwright install --with-deps chromium` 同时安装系统依赖。打包只使用 Python 标准库，也可以运行 `npm run package`。

`npm run check` 检查两个内容脚本的语法；`npm test` 使用 Node.js 测试运行器，串行执行浏览器测试，输出截图到 `artifacts/`。浏览器使用 Playwright 安装的 Chromium；如需指定兼容的 Chromium / Chrome for Testing，可设置 `CHATWING_BROWSER_PATH` 为可执行文件的绝对路径。不要指向个人浏览器的用户数据目录。

测试创建独立临时浏览器配置，通过路由拦截在匹配的 ChatGPT 域名下提供本地 HTML，让浏览器实际注入扩展；无需登录，不读取真实聊天。覆盖消息识别、动态回答、分支编辑、页面内导航、长对话补全、键盘交互、主题及窄窗口。新增回归还覆盖长目录滚轮首尾可达、宿主滚轮拦截、对话计数、延迟渲染后的跳转校准，以及部分卸载时的消息配对。扫描过滤测试在浏览器内加载相同源码并插入计数探针，验证无关更新不会触发全量扫描。模拟页面通过不代表所有线上页面结构都兼容。

`windowed-layout.html` 另模拟十五轮中每次仅保留五个完整轮次节点，覆盖补全恢复原位后目录不退回五条、旧条目重新挂载，以及编辑和聊天切换时清理缓存。`completion.test.cjs` 覆盖历史分页慢于固定等待时长、反向容器负滚动位置与跳转。调查依据及方案取舍见[长对话虚拟化调查](research/conversation-virtualization.md)。

`completion-cover.test.cjs` 验证阅读保护层确实覆盖正文、其下仍可读取历史、进度使用已读数量，以及停止、成功完成和切换聊天后移除保护层。状态提示不主动抢占焦点，采用 [W3C 状态消息建议](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) 的 `role="status"`；保护层仍基于 DOM 滚动补全，不宣称免滚动取得完整会话。

## 本地调试

1. 在 `chrome://extensions` 启用开发者模式，加载仓库根目录。
2. 修改脚本后，点击扩展卡片的刷新按钮，再刷新 ChatGPT 页面。
3. 若网页改版导致识别失败，先用不含私人信息的模拟内容复现，再添加最小测试夹具。

`content/styles.js` 提供界面样式，`content/content.js` 负责消息识别、缓存、导航与交互。界面通过 Shadow DOM 隔离，聊天文本使用 `textContent` 展示。诊断版本号从扩展 manifest 读取，发版无需额外修改脚本中的版本常量。

新版页面夹具参考了 [公开的页面标记记录](https://github.com/steipete/oracle/issues/517)，并非真实账号聊天的 DOM 抓取。新增夹具同样使用虚构对话，避免提交原始聊天导出、会话地址、登录信息或完整页面快照。

## Git 协作

- `main` 保存可用源码；日常改动使用简短的功能或修复分支，通过 Pull Request 合入。
- 每个提交围绕一个明确改动，说明解决的问题；功能变化同时更新使用文档和 `CHANGELOG.md`。
- 提交源码、测试、公开文档、工具和依赖锁文件；用 `git status --short` 检查待提交内容。
- `.gitignore` 排除生成文件和本地环境；`.gitattributes` 统一文本为 LF、标识二进制资源，减少跨平台无关差异。
- 安装包上传到 GitHub Releases，不把每个版本的 ZIP 累积到 Git 历史。

## 图标

图标 PNG 已提交，正常开发和打包无需重新生成。如需修改图标，在独立 Python 环境安装 Pillow 后运行 `python tools/make-icons.py`，检查生成图片后提交。Pillow 是此可选工具的依赖，不是扩展或打包依赖。

浏览器测试方式参考 [Playwright 扩展测试文档](https://playwright.dev/docs/chrome-extensions)。
