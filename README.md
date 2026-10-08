# dsh-link

DeepSeek Harness 移动端 H5 桥接插件：在桌面版设置页新增「Link」栏，让手机浏览器打开一个极简 H5，与 Mac 桌面版正在运行的会话交互（工作区边栏 + 基础聊天 + 流式回复）。

## 状态：可用，H5 已按「桌面版体验」重做 ✅

- host 段、客户端设置栏、H5 SPA 全部完成，零第三方运行时依赖、零构建步骤。
- H5 客户端已升级为桌面级对话视图：Markdown 正文、思考块、工具调用卡片（可展开看参数/输出）、
  流式增量、更早历史分页、会话边栏（头像/状态、筛选/折叠/侧滑手势、设置面板）、发送即插话、深浅色主题、PWA 可加到主屏。
- **图片上传**：手机相册/拍照 → 本地按长边 1568px 压缩 → `/m/api/upload` 换 fileUploads 收据 →
  随 prompt 一起发；历史消息与工具结果里的图片通过 `/m/api/attachment` 拉回显示。
- 149 项本地测试全过（WebSocket 协议 10 + host 集成 33 + 客户端冒烟 6 + Markdown 19 + 事件归约 20 + H5 UI 61）。
- 已装入 desktop profile，并在手机视口（390×844）对真实会话做过全链路自测：
  登录 → 会话列表 → 历史（含工具卡）→ 实时流式 → 分页 → 发送/停止/断线重连。
- **host 段用 TypeScript 编写**，对着 DSH 官方类型（`@deepseek-ai/*@0.2.0-rc.2`）做 `tsc` 检查，
  编译产物在 `dist/`；H5 段保持零构建（运行时直读 + 内容指纹自升级）。

## 形态

双段 Cordis 插件（纯函数 `apply`/`inject`/`name`，对齐官方 `@deepseek-ai/dsh-client-connection` 写法）：

- **host 段**（`src/host/`，进程内全权限）：挂 HTTP 路由 + WebSocket，直连 `sessionController` / `workspaceRegistry` / `credentials` / `connection`。
- **客户端段**（`src/client/client.js`，React）：设置页「Link」栏，展示网络状态、连接密钥、手机地址与操作指引。手写 `window.__ModuleLoader__.load` 产物格式，`require("react")`，无需打包。
- **H5**（`src/public/`）：静态单页，`fetch` + `WebSocket`，移动优先、深浅色自适应、安全区与软键盘适配。
  `app.js`（界面/连接）只负责渲染，事件归约在 `transcript.js`（纯函数）、Markdown 在 `md.js`（纯函数），
  两者都能在 Node 里直接单测。

## 关键架构决定（与最初设计的偏差，均有源码依据）

1. **自建 LAN 监听**，不复用桌面版主 webServer。
   核实发现：桌面版 webServer 只绑 `127.0.0.1:19387`，且 DSH 官方**主动禁止**把主服务绑到 `0.0.0.0`（原因：会把 RCE 暴露到网络）。因此手机无法直接访问主服务上的路由。
   本插件另起一个受「连接密钥」保护的独立监听（默认 `127.0.0.1:19388`，可配置为 `0.0.0.0` 供手机接入），只提供**静态 H5 + 只读/聊天 API**，**不暴露**密钥生成等控制面。
2. **受众隔离的三类路由**：
   | 前缀 | 受众 | 鉴权 | 暴露位置 |
   |---|---|---|---|
   | `/m`（静态 H5） | 手机浏览器 | 公开（无敏感数据） | 回环 + LAN |
   | `/m/api/*`（数据 + WS） | 手机 H5 | 连接密钥（LAN 侧强制） | 回环 + LAN |
   | `/m/link/*`（控制面） | 桌面设置页 | cookie（`connection.admit`） | **仅回环** |
3. **初始历史取自 `follow` 的 `snapshot` 帧**（用真实 cursor、不激活 agent），而非 `page(throughSeq:-1)`（后者经核实会返回空页）。
   更早的历史用 `/m/api/messages?beforeSeq=<最老 seq>` 分页（host 内部按 turn 对齐切页）。
4. **零依赖 WebSocket 服务端**（`src/host/ws-mini.ts`）：`link:` 安装下 `ws` 包不可解析，故自带极简 RFC 6455 实现（文本帧 / 分片 / ping-pong / close / 长度上限）。
5. **进程内调用 Remote 门面必须自己传 `signal`**：`sessionController` / `fileUploads` 这些门面方法的
   签名都以 `signal` 结尾（`prompt(request, signal)`、`upload(agent, request, signal)`），方法体第一行就是
   `signal.throwIfAborted()`；走 RPC 时网关会按描述符自动补上，**进程内直调不会**，漏传就得到一个
   莫名其妙的 `Cannot read properties of undefined (reading 'throwIfAborted')`。
   需要传 signal 的：`prompt` / `page` / `follow` / `list` / `search` / `projections` / `fileUploads.upload|resolve|bindPrompt`；
   不需要的：`create` / `cancel` / `rename` / `fork` / `attachment` / `updateQueue`。
   单测里 mock 也照真实签名断言（少传就 FAIL），避免再退化。
6. **图片走 DSH 自己的上传契约**：`ctx.fileUploads.upload(sessionId, {data: base64, name})` → `receiptId`，
   prompt 的 content 里追加 `{type:"file", receiptId}`（附件由 host 侧 `ctx.attachments` 解析落地）。
   `fileUploads` 用**可选注入**（`ctx.inject(["fileUploads"], …)`），profile 没提供时插件照常工作，
   只是 `/m/api/upload` 返回 503。
7. **H5 只发一次 follow**：`follow` 与 `ensureStream` 互相调用过会在连接建立前刷出上万条 follow，
   host 随之反复重放快照基线并把流式内容冲掉。现在队列去重 + `followedOnSocket` 记忆。
8. **重复快照按「合并」处理**：重连/重新 follow 会重复下发基线，直接 reset 会抹掉已翻出的更早历史与正在流式的条目。
9. **静态资源无感升级**（不需要任何手写版本号，也不新增接口）：
   - 静态资源一律带**内容哈希 ETag** + `Cache-Control: no-cache`：浏览器每次带 `If-None-Match` 问一句，
     没变回 304（只有响应头，几十字节，body 直接来自缓存），变了自动拿到新文件；图片/字体另加长缓存。
   - H5 用**同一套缓存校验**自检：对 5 个静态文件 `fetch(..., {cache:"no-cache"})` 并把内容算成指纹，
     与启动时的指纹比对，变了就 `location.reload()`。触发时机是「回到前台」与「每 5 分钟」，节流 60s，
     正在写草稿会推迟到草稿清空；任一文件没取到就跳过本轮，避免断网误判成「有新版本」而无限自刷。
   - 因此**改完文件不用做任何事**：手机下次切回来自动升级；reload 后用 `dsh-link-session` 回到原会话。

## 安装

已通过以下方式装入本机 desktop profile：

```bash
# 1) 链接插件到 profile（pnpm link）
dsh plugin --profile desktop add /path/to/dsh-link
# 2) 把 dsh-link 加进 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 数组
# 3) 桌面版热重载 profile（编辑 package.json 即触发）后生效
```

卸载：从 `dsh.profile.bundles` 移除 `"dsh-link"`（备份见 `package.json.dsh-link-bak`），并 `dsh plugin --profile desktop remove dsh-link`。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `lanEnabled` | `true` | 是否开启独立监听 |
| `lanPort` | `19388` | 监听端口 |
| `bindHost` | `127.0.0.1` | 绑定地址。**默认仅回环（安全）**；要让手机经内网/Tailscale 接入，改为 `"0.0.0.0"` |

> ⚠️ 改为 `0.0.0.0` 会把（受密钥保护的）只读/聊天口暴露到局域网。内网 HTTP 为明文，建议仅在可信网络使用；对安全有要求请走 Tailscale。手机接入前**务必**先在「设置 → Link」里生成连接密钥。

## 手机连接（bindHost 设为 0.0.0.0 后）

1. 桌面版 设置 → Link，点「生成密钥」并复制。
2. 手机与 Mac 连同一 Wi-Fi（或登录同一 Tailscale 账号）。
3. 手机浏览器打开设置页里列出的地址，如 `http://<内网IP或Tailscale名>:19388/m/`。
4. 输入密钥（自动保存），进入会话边栏，开始聊天。

## 兼容性

dsh-link 依赖 DSH 的**内部 API**（`sessionController` 门面、`fileUploads` 收据、cordis 上下文），
因此与桌面版版本强绑定：

| dsh-link | DeepSeek Harness 桌面版 | 说明 |
|---|---|---|
| 0.1.x | `0.2.0-rc.2` | 当前开发版本，host 段类型即按此版本编写 |

升级桌面版后如果出现接口报错，先跑 `pnpm typecheck`——`@deepseek-ai/*` 的 devDependency 版本要同步改成新版本号。

> 注意 npm 上这些包的 `latest` tag 指向旧版本（如 `dsh-session` 的 latest 是 `0.0.1-rc.1`），
> 必须**写死** `@0.2.0-rc.2` 这类精确版本。

## 故障排查

| 症状 | 原因 | 处置 |
|---|---|---|
| 手机端停在密钥门 / 提示密钥失效 | 密钥在桌面版重新生成过 | 设置 → Link 里复制新密钥重输 |
| 新接口 404（`/m/api/upload`、`/m/api/attachment`） | **host 代码改动没生效**：插件是启动时加载的 | 重启桌面版（重组 profile 不够，见 CONTRIBUTING） |
| 发送消息报 `Cannot read properties of undefined (reading 'throwIfAborted')` | 进程内直调 Remote 门面时漏传 `signal` | `prompt(request, signal)` / `upload(agent, request, signal)`，已在 `types.ts` 固化 |
| 图片发不出去、提示"桌面版还没加载图片接口" | 同上，host 未重载 | 重启桌面版 |
| 历史图片显示成 `🖼 文件名` 而不是缩略图 | 同上（旧版 host 没有附件读取接口） | 重启桌面版 |
| 界面看起来是旧版 | 浏览器缓存了旧 H5 | 现在有内容 ETag + 构建号自检，刷新一次即可；仍异常就清一次站点数据 |
| 手机连不上 | `bindHost` 默认只绑回环 | 在 `cordis.patch.yml` 里改成 `"0.0.0.0"` 或用 Tailscale |

## 开发

```bash
pnpm install      # 只装 dev 依赖，运行时零第三方依赖
pnpm typecheck    # 对 DSH 官方类型做编译期检查
pnpm build        # 编译 host 段到 dist/
pnpm test         # build + 全部测试
```

改 `src/public/*` 保存即生效（手机端自动升级）；改 `src/host/*.ts` 需要重启桌面版。
详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 测试

```bash
pnpm test           # tsc + vitest（149 项）
pnpm test:watch     # 开发时监听
pnpm run coverage   # 带覆盖率报告
```

**149 项测试，全部跑在 6 秒内**，分三层：

| 文件 | 覆盖对象 | 项数 |
|---|---|---|
| `test/md.test.mjs` | Markdown 渲染与转义安全（纯函数） | 19 |
| `test/transcript.test.mjs` | 会话事件归约：历史/实时流/工具卡/分页/附件引用（纯函数） | 20 |
| `test/ws-mini.test.mjs` | 自研 WebSocket 协议一致性（对照 Node 内置客户端） | 10 |
| `test/host-integration.test.mjs` | host 全栈：mock DSH 上下文 + 真实 HTTP/WS（密钥门、静态资源与 ETag、会话 API、图片上传与附件、流式转发） | 33 |
| `test/client-smoke.test.mjs` | 桌面版设置页插件契约 | 6 |
| `test/app-ui.test.mjs` | **H5 客户端 UI 层**（jsdom 跑真实 `index.html` + 真实 `app.js`，只桩掉网络/WS） | 61 |

UI 层测试覆盖的是以前只能手点的部分：密钥门分支、快照渲染（Markdown/工具卡/思考块）、
**host 双层包装的流式帧**（回归）、durable 消息接管流式条目、图片选图→压缩→上传→发 prompt 的顺序、
上传失败回退托盘、旧版 host 下附件接口 404 的降级。

覆盖率基线（`pnpm run coverage`）：整体 **84.4%** 语句，其中 `app.js` 85.8%、`transcript.js` 93.1%、`md.js` 93.2%；
`net.js` 偏低的 34.3% 是 Tailscale 探测分支（依赖本机 CLI，未做单测）。

## 目录

- `src/host/` — host 段：`index.ts`（装配）、`routes.ts`（HTTP 分发）、`stream.ts`（WS follow 桥）、`key-store.ts`（密钥）、`net.ts`（网络探测）、`ws-mini.ts`（零依赖 WS）
- `src/client/client.js` — 设置页「Link」栏（React，手写产物格式）
- `src/public/` — H5 静态单页：`index.html`（结构）、`style.css`（设计系统）、`app.js`（界面/连接/输入）、
  `transcript.js`（事件归约，纯函数）、`md.js`（Markdown，纯函数）、`manifest.webmanifest` + `icon*.png/svg`（加到主屏）
- `src/host/types.ts` — **我们对 DSH 内部 API 的依赖面**（官方类型 + 结构化类型）
- `dist/` — host 段编译产物（gitignore，发布时随包）
- `test/` — 六组自测（见上）
- `docs/H5-bridge-design.md` — 原始设计文档（部分假设已在实现中修正，见上「关键架构决定」）
- `docs/H5-client.md` — H5 客户端实现说明：数据模型、实时流形状、已踩过的坑
- `dsh-investigation/` — 从 app.asar 提取的官方包源码（本地参考，已 gitignore）
- `CONTRIBUTING.md` — 开发环路、类型约定、测试约定

## 许可

[MIT](LICENSE)
