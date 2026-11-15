# dsh-draft-persistence

[![CI](https://github.com/ShawThua/dsh-draft-persistence/actions/workflows/ci.yml/badge.svg)](https://github.com/ShawThua/dsh-draft-persistence/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-draft-persistence.svg)](https://www.npmjs.com/package/dsh-draft-persistence)

把**未发送的输入框草稿**按会话保存到 DSH 宿主，刷新页面、切换会话、重启宿主、换浏览器/手机后都能拿回来。

[English](README.md) | 中文

## 为什么需要它

DSH 自带草稿持久化，但只写浏览器 `localStorage`（键 `dsh.conversation.<sessionId>`）。`localStorage` **按源隔离**：

- 桌面端宿主每次启动端口随机 → 每次都是新源；
- 手机、另一个浏览器各有一份，互不可见；
- 清站点数据、隐私模式、清理工具会把它丢掉。

这就是「会话日志完好、输入框草稿却消失」的机制。本插件补上缺失的**宿主侧副本**：`$DSH_HOME` 下的一份文件，所有连到这个宿主的浏览器共用。

## 行为

- 跟踪当前打开会话的输入框状态，防抖 **700ms**（持续输入最长 3s 落盘一次）。
- 保存的是语义快照：文本、文件/会话引用 chip、命令 chip、引用块。
- 打开会话时通过 composer 的 `setDraft(snapshot)` 恢复。
- 输入框变空（**发送成功**或手动清空）立即删除记录；发送失败/被拒时文本还在，记录保留。
- 不阻塞输入：全部异步；失败只留 console 警告与日志。

## 环境要求

- DSH **Web** profile（`dsh web --profile web`），在 **0.2.2-rc.1** 与 **0.2.2-rc.3** 上验证。
- Node `^22.19.0 || >=24.0.0`（Host 半边跑在 DSH 进程内，没有独立进程）。
- 零运行时依赖、无需构建。

## 安装

请通过 DSH 插件管理器安装，不要手改 profile 的 `package.json` / `cordis.patch.yml`。

1. 插件管理器（设置 → 插件，或 `plugin_manager` 工具）：
   - npm 包名：`dsh-draft-persistence`
   - 仓库 spec：`ShawThua/dsh-draft-persistence`
   - 本地目录：`link:<checkout 的绝对路径>`
2. 管理器会加依赖、选中 bundle 并重启该插件行。profile 开 HMR 时通常立即生效（结果里 `application: "applied"`），否则重启宿主。
3. 验证：

   ```bash
   curl http://127.0.0.1:7979/dsh-draft/health   # {"ok":true,"drafts":N,...}
   ```

   然后在任意会话打一段字（不发送），等 1 秒刷新页面，文字会回来。

## 原理

```
SessionInputShell（浏览器）
   │  state.subscribe → { draft, draftRev }
   ▼
client.js  createKeeper      防抖 700ms / 最长 3s
   │  POST /dsh-draft/put { sessionId, draft, baseRev, writer }
   ▼
index.js   DraftStore        →  $DSH_HOME/storages/dsh-draft/drafts.json
   ▲                             （临时文件 + rename，串行提交）
   │  GET /dsh-draft/get?sessionId=…
   │  → shell.setDraft(snapshot)   打开会话时恢复
```

- 组件挂在 `conversation.input.dock`（session 作用域），所以**只为当前打开的会话**建 keeper；冷会话不读、不为它创建编辑器。
- Host 用公开的 `ctx.webServer.register` 注册回环路由；Client 只 `require('react')`。两边都没有 `@deepseek-ai/*` 依赖。

### HTTP API（仅回环）

| 方法/路径 | 请求体 | 响应 |
|---|---|---|
| `GET /dsh-draft/health` | – | `{ ok, drafts, chars, file }` |
| `GET /dsh-draft/get?sessionId=` | – | `{ ok, record \| null }` |
| `POST /dsh-draft/put` | `{ sessionId, draft, baseRev, writer, force? }` | `{ ok, rev, updatedAt }` 或 `{ ok, conflict, record }` |
| `POST /dsh-draft/delete` | `{ sessionId }` | `{ ok, deleted }` |
| `GET /dsh-draft/list` | – | 调试：会话 id、revision、字数、前 80 字 |

`draft` 可以是字符串，也可以是 `{ text, references?, command?, quotes? }`。

## 存储与隐私

- 草稿以**明文 JSON** 存在 `$DSH_HOME/storages/dsh-draft/drafts.json`，不加密，且比浏览器标签页活得更久。
- 最多 **400** 个会话（按 `updatedAt` 淘汰），单条最多 **30 万字符**，请求体上限 **2MB**。
- 路由拒绝非回环来源；写请求必须 `content-type: application/json`。跨源页面读不到（无 CORS 头）、也写不进（预检不会被应答）。
- 插件自身不发起任何外网请求。若把 DSH 绑到非回环地址，该路由仍只服务回环来源。

## 细节规则

- **打开即恢复**：输入框为空且未被编辑时采用宿主记录；本机已有文字（比如内置 localStorage 的草稿更新）则本机优先并回写宿主。
- **另一台设备更新**：宿主记录比本机上次成功保存**新 1.5 秒以上**、且用户还没开始输入时，采用宿主记录。
- **冲突**：写入带 `baseRev`；revision 不一致时返回当前记录。本机草稿已被编辑 → 本机 `force` 写入并留 console 警告；否则采用较新的宿主草稿。
- **清空**：任何变成空的输入框都立即删除记录，并在 `visibilitychange` / `pagehide` 时补一次 keepalive 请求，避免“已发送的消息被草稿复活”。

## 限制与非目标

- **不保附件**（浏览器 `File` 对象无法跨刷新），只保文本与引用 chip。
- 没有「已保存 HH:MM」提示，没有草稿列表/历史/加密/按工作区隔离。
- 多端同时编辑是「最后写入者赢 + 冲突检测」，不做合并。

## 开发

```bash
node test/host.test.mjs     # 12 个：存储、原子写、revision、HTTP 路由
node test/client.test.mjs   # 10 个：防抖、恢复、清空、冲突
```

`npm test` 跑两者。注意：Windows 受限沙箱下不要用 `node --test <file>`（test runner 起子进程会 EPERM）。

真机端到端（无头 Chrome + CDP）：输入真实草稿 → 校验宿主副本 → 清 `localStorage` → 刷新 → 校验恢复 → 自动清理。

```bash
DSH_WEB_URL=http://127.0.0.1:7979 \
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
SESSION_TITLE="我的测试会话" OTHER_TITLE="另一个会话" \
node scripts/e2e.mjs
```

Windows 下默认从 `%LOCALAPPDATA%\DSH\portal\url.txt` 读 token；其它平台用 `DSH_TOKEN` 或 `DSH_TOKEN_FILE`。

目录结构：

```
index.js          Host 半边：DraftStore + 回环 HTTP 路由
client.js         Client 半边：conversation.input.dock 里的 keeper 组件
cordis.patch.yml  bundle patch（一行 insert）
locale/           插件列表显示元数据（en、zh）
icon.svg          插件图标
test/             node:test 单测
scripts/e2e.mjs   真机端到端验证脚本
```

## 兼容性

依赖 DSH 0.2.2-rc.1 / rc.3 的公开输入框接口：`ctx.conversation.input.shell(sessionId)` 及其 `state`、`draftSnapshot`、`setDraft(...)`、`conversation.input.dock`（带 `sessionId` prop）。这些是插件公开面，但 DSH 升级仍可能变动；升级后草稿不恢复，先跑 `scripts/e2e.mjs`，若 console 出现 `slot entry crashed in 'conversation.input.dock'` 就是契约变了。

## 卸载

用插件管理器移除 bundle 即可。已存草稿保留在 `$DSH_HOME/storages/dsh-draft/`，要彻底清掉就手动删该目录。

## 许可证

MIT


