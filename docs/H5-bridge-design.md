# DeepSeek Harness「Link」移动端桥接 · 实现设计文档

> 目标：一个**极简 H5 网页**，只用于与 **Mac 桌面版**（Electron，`desktop` profile，监听 `127.0.0.1:19387`）里正在运行的会话交互——左侧「工作区 + 会话」边栏 + 当前会话基础聊天。H5 本身**不加载插件**、不涉及工具/文件/子代理/设置。
>
> 插件形态：一个**「host 桥 + 客户端设置面板」双段插件**。安装后，桌面版 **设置页新增「Link」栏**，用来：查看内网/Tailscale 网络状态、生成连接密钥、查看手机连接地址与操作指引。手机 H5 通过**内网 IP 或 Tailscale** 两种方式连入，有密钥时需输密钥（自动保存）。

---

## 0. 关于「参考 hermeslink」

本设计的形态（设置面板 + 网络状态 + 密钥/扫码 + 手机连接指引）按你描述的目标实现。当前会话的 Web 搜索端点不可用（API 401）、GitHub 域名解析被沙箱拦截，**无法抓取 hermeslink 源码逐条对照**；因此下方所有具体签名以 dsh 源码为准，hermeslink 仅作为交互形态参考。如你有 hermeslink 的仓库地址，我可以再对齐其细节。

---

## 1. 架构总览

```
桌面版设置页「Link」栏（客户端插件，React）
        │  fetch('/m/link/*')（同源，cookie 已认证）
        ▼
   ┌──────────────────────────────────────────────┐
   │  dsh-link（host 插件，进程内全权限）          │
   │  · webServer.register/registerUpgrade 挂路由 │
   │  · credentials 存连接密钥                    │
   │  · os.networkInterfaces / tailscale status  │
   │  · sessionController / workspaceRegistry    │
   └──────────────────────────────────────────────┘
        │  ▲                    │  ▲
  /m/ 静态H5   /m/api/*（密钥）   /m/link/*（cookie）
        │                        │
   手机浏览器 H5               桌面设置页
  （fetch + WebSocket）        （同源 fetch）
```

**两个鉴权受众，完全分离：**

| 路由前缀 | 受众 | 鉴权 |
|---|---|---|
| `/m/`（静态 H5 SPA 文件） | 手机浏览器 | 公开（无需鉴权，页面本身不含敏感数据） |
| `/m/api/*`（H5 数据 API + WS） | 手机 H5 | **连接密钥**（`X-Dsh-Link-Key` 头 / WS 首帧） |
| `/m/link/*`（Link 控制：状态/生成密钥/清除密钥） | 桌面设置页 | **已有 cookie**（`connection.admit`） |

> 关键简化：手机侧**不再走桌面版的 token→cookie 流程**。连接密钥就是手机端的自足鉴权，天然规避了 `trustedHosts`/cookie authority 绑定那一整套复杂度。密钥门本身已防 DNS-rebinding 与跨站（恶意站点拿不到密钥，也无法读 H5 的 localStorage）。

---

## 2. 服务签名速查（精确，来源标注）

> 提取物是编译产物（带 JSDoc），**无 `.d.ts`**。「【逐字】」= 源码 JSDoc/实现逐字；「【反推】」= 精确 TS 类型被擦除、从运行时校验代码重建。

### 2.1 `ctx.sessionController`（服务名 `sessionController`）★ 桥的聊天主入口
`@deepseek-ai/dsh-api-session-controller`，类 `SessionController extends TypertRemoteService`，`super(ctx,'sessionController',{namespace:'session'})`。进程内**直接** `await ctx.sessionController.xxx(...)`：

| 方法 | 签名 |
|---|---|
| `create` | `create({workspaceId?; cwd?; sessionId?; agentPreset?}): Promise<{sessionId; agentPreset?}>`（幂等，已存在则 adopt/resume） |
| `prompt` | `prompt({requestId; sessionId; mode:"queue"\|"steer"; content: ContentBlock[]; clientTimeZone?}, signal?): Promise<{accepted:true}>`（只回 ack，回复走 follow） |
| `follow` | `follow({address:{kind:"session",sessionId}; assistantStream?:true; maxMessages?; turnWindow?}, signal?): AsyncGenerator<FollowFrame>` ★流式 |
| `page` | `page({address; throughSeq; beforeSeq?; maxMessages?; turnWindow?}, signal?): Promise<{records; hasMore}>`（冷安全分页） |
| `cancel` | `cancel({sessionId}): {accepted:true}` |
| `list` | `list(_req, signal): Promise<{items: SessionSummary[]}>`（含冷会话，不激活 agent） |
| 其它 | `projections`/`control`/`inspect`/`rename`/`fork`/`selectModel`/`search` 等（MVP 不用） |

`ContentBlock`（MVP）：`{type:"text"; text:string}`（另有 image/file，MVP 不用）。
`SessionSummary`（:1870 反推）：`{sessionId; updatedAt; agentAvailable; running; blank; cwd?; projections?}`，**标题在 `projections.values.title`**。

### 2.2 `ctx.workspaceRegistry`（服务名 `workspaceRegistry`）
`@deepseek-ai/dsh-workspace`。`list(): Workspace[]`（同步）、`get(id)`、`create(path,title?)`、`archivedSessionIds`/`pinnedSessionIds`。
`Workspace = {id; path; title; sessionIds: string[]; ...}`。
> ★ 工作区↔会话**非外键**：归属 = 「会话 header 的 `cwd` realpath === 工作区 `path`」；`sessionIds` 为有序数组。

### 2.3 `ctx.agents` / `ctx.sessions`（一般不必直接用）
- `ctx.agents`：`create/resume(options): Promise<{agent,dispose}>`、`get(id): Agent`、`list()`；`Agent = {id; session; status:"idle"|"running"; followup(input); steer(input); cancel(...)}`。
- `ctx.sessions`：只存 live 会话；`get(id)`、`list()`、`flush(session)`；读历史用 `session.deriveMessages()`（模型视图）或 `sessionController.page/follow`（人类视图）。⚠ `snapshotEvents/eventAt/ownEvents` 已 `@deprecated`。
- **冷会话**：重启后 `ctx.sessions.get(id)` 返回 undefined；只读用 `sessionController.page/follow`（不激活 agent），要对话则由 `prompt` 内部 `agents.resume`。

### 2.4 `ctx.webServer`（服务名 `webServer`）★ 路由入口【逐字】
```js
register({kind:"exact"|"prefix"; path; handler:(req,res)=>Promise<void>}) → disposer
registerUpgrade({path; handler:(req,socket,head)=>Promise<void>}) → disposer   // WebSocket
registerFallback(handler) → disposer（全进程唯一）
tapIndex(html=>html) → disposer
get port(); get host()
```
匹配（:323）：**exact 先查，再最长前缀**。→ 因此 `/m`（静态前缀）+ 若干 `/m/api/*`（exact）可共存，exact 优先。

### 2.5 `ctx.credentials`（服务名 `credentials`）★ 存连接密钥
`@deepseek-ai/dsh-credentials`。【逐字（README + 实现）】：
```js
import { credentialKey } from "@deepseek-ai/dsh-credentials";
const KEY = credentialKey("dsh-link", "link-key");
await ctx.credentials.readRecord(KEY)                      // CredentialRecord | undefined
await ctx.credentials.modifyRecord(KEY, (current) =>       // 唯一写路径；返回 undefined 保持原状
  current === undefined
    ? Promise.resolve({ kind: "grant", payload: { secret } })
    : Promise.resolve(undefined)
);                                                          // 返回提交后的 record
await ctx.credentials.listRecords()                        // [{ key, kind }]（不含 value）
await ctx.credentials.deleteRecord(KEY)
```
（`modifyRecord` 的读-改-写是跨进程独占的，参考 `dsh-client-connection` 存 cookie secret 的写法。）

### 2.6 `ctx.connection`（服务名 `connection`）★ `/m/link/*` 鉴权
```js
admit(req) → { peer } | { rejection: 403 | 401 }     // 403=信任墙，401=cookie 无效
authenticatedUrl(baseUrl) → string                   // 加 ?token=（本设计不再用于手机侧）
```
配置 `trustedHosts: string[]`。桌面设置页同源（`127.0.0.1`）→ 回环恒可信，`/m/link/*` 用 `admit` 无需额外配 trustedHosts。

### 2.7 客户端插件相关（服务名）
- `ctx.slots`（`dsh-client-ui-slots`）：`slots.register(options, Component)` / `slots.inject(slotName, factory)`。
- `ctx.locale`（`dsh-client-locale`）：`locale.register("settings.link", {en, zh})` / `locale.bind("settings.link")`。
- `ctx.settings`（host，`dsh-settings`，服务名 `settings`）：`configure(presentation, owner)` / `update(ns, patch, expectedRevision)`；非密钥的 Link 状态（如开关）可存这里。

---

## 3. 插件形态（双段）

### 3.1 `package.json`
```jsonc
{
  "name": "@your/dsh-link",
  "type": "module",
  "main": "lib/index.js",          // host 段
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"  // 客户端段
  },
  "dsh": {
    "client": {                    // 客户端段声明
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-primitives"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-host-webserver": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-connection": "0.2.0-rc.2",
    "@deepseek-ai/dsh-api-session-controller": "0.2.0-rc.2",
    "@deepseek-ai/dsh-workspace": "0.2.0-rc.2",
    "@deepseek-ai/dsh-credentials": "0.2.0-rc.2"
  },
  "dependencies": { "ws": "^8.18.0" }
}
```
加载：加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`。

### 3.2 host 段 `lib/index.js`（骨架）
```js
import { Service } from "@deepseek-ai/cordis";
import { WebSocketServer } from "ws";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const execFileAsync = promisify(execFile);
const STATIC_ROOT = new URL("./public/", import.meta.url);
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml", ".json":"application/json; charset=utf-8" };
const LINK_KEY_RECORD = credentialKey("dsh-link", "link-key");

export default class LinkBridge extends Service {
  static inject = ["webServer", "connection", "sessionController", "workspaceRegistry", "credentials"];

  constructor(ctx) {
    super(ctx, "linkBridge");
    this.wss = new WebSocketServer({ noServer: true });
    this.follows = new Map();
    this.registerStatic();      // /m 前缀
    this.registerApi();         // /m/api/* exact（密钥门）
    this.registerLink();        // /m/link/* exact（cookie 门）
    this.registerStream();      // /m/api/stream upgrade
    this.wss.on("connection", (ws) => this.onWs(ws));
  }

  /* ---------- 通用 ---------- */
  sendJson(res, status, body) {
    res.writeHead(status, { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" });
    res.end(JSON.stringify(body));
  }
  async readJson(req) {
    const c = []; for await (const b of req) c.push(b);
    try { return JSON.parse(Buffer.concat(c).toString("utf8") || "{}"); } catch { return null; }
  }
  cookieGuard(req, res) {           // /m/link/* 用
    const a = this.ctx.connection.admit(req);
    if (a.rejection !== undefined) { res.writeHead(a.rejection); res.end(); return false; }
    return true;
  }

  /* ---------- 密钥读写 ---------- */
  async readKey() {
    const r = await this.ctx.credentials.readRecord(LINK_KEY_RECORD);
    return r?.payload?.secret;                     // 无密钥 → undefined（H5 免密钥，仅回环可用）
  }
  keyMatches(key) {                                 // 常数时间比较
    return this._keyBuf && key ? timingSafeEqual(sha256(key), this._keyBuf) : false;
  }
  async reloadKey() {
    const k = await this.readKey();
    this._keyBuf = k ? sha256(k) : undefined;
  }
  keyGuard(req) {                                   // /m/api/* 用（从 header 取密钥）
    if (!this._keyBuf) return true;                 // 未设密钥：放行（建议仅回环场景）
    const key = req.headers["x-dsh-link-key"] || req.headers["authorization"]?.replace(/^Bearer /, "");
    return this.keyMatches(String(key ?? ""));
  }

  /* ---------- 网络检测 ---------- */
  lanIps() {
    const out = [];
    for (const addrs of Object.values(networkInterfaces()))
      for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
    return out;
  }
  async tailscaleStatus() {
    try {
      const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 3000 });
      const j = JSON.parse(stdout);
      return {
        running: j.BackendState === "Running",
        dnsName: j.Self?.DNSName ?? null,          // e.g. "my-mac.tailxxxx.ts.net"
        ips: j.Self?.TailscaleIPs ?? [],
        online: j.Self?.Online ?? false,
        health: Array.isArray(j.Health) ? j.Health : [],
      };
    } catch { return { running: false, dnsName: null, ips: [], online: false, health: [] }; }
  }
  async linkStatus() {
    const port = this.ctx.webServer.port;
    const lan = this.lanIps();
    const ts = await this.tailscaleStatus();
    return {
      port,
      keySet: (await this.readKey()) !== undefined,
      lan: { ips: lan, urls: lan.map((ip) => `http://${ip}:${port}/m/`) },
      tailscale: {
        running: ts.running, online: ts.online, dnsName: ts.dnsName, ips: ts.ips,
        urls: ts.dnsName ? [`http://${ts.dnsName}:${port}/m/`] : [],
      },
    };
  }

  /* 注册路由（静态/API/控制/WS）—— 见第 4 节 */
  registerStatic() { /* prefix "/m" 服务 H5 静态文件 */ }
  registerApi()    { /* exact：ping/verify/workspaces/messages/sessions/prompt/cancel */ }
  registerLink()   { /* exact：status/generate-key/clear-key，cookieGuard */ }
  registerStream() { /* upgrade "/m/api/stream"，密钥首帧 */ }
  onWs(ws) { /* {type:"auth",key} → {type:"follow",sessionId} */ }
}

function sha256(s) { return createHash("sha256").update(String(s)).digest(); }
```

---

## 4. 路由明细（host 段）

### 4.1 静态 H5（公开）
```js
registerStatic() {
  this.ctx.webServer.register({ kind: "prefix", path: "/m", handler: async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;              // "/m/…"
    let rel = (pathname === "/m" || pathname === "/m/") ? "/index.html" : pathname.slice("/m".length);
    if (!rel.startsWith("/")) rel = "/" + rel;
    const root = resolve(new URL(STATIC_ROOT).pathname);
    const abs = resolve(root, "." + rel);
    if (!abs.startsWith(root + sep)) { res.writeHead(404); return res.end(); }  // 防目录穿越
    try {
      const body = await readFile(abs);
      res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  }});
}
```

### 4.2 H5 数据 API（密钥门）—— 全部 exact，query/body 传参，无路径参数
```js
registerApi() {
  const r = this.ctx.webServer;
  const api = (path, handler) => r.register({ kind: "exact", path, handler });

  api("/m/api/ping", async (req, res) => {          // H5 用来校验已存密钥
    this.sendJson(res, this.keyGuard(req) ? 200 : 401, { ok: this.keyGuard(req) });
  });

  api("/m/api/verify", async (req, res) => {        // 密钥输入页：POST {key}
    const body = await this.readJson(req);
    this.sendJson(res, this.keyMatches(String(body?.key ?? "")) ? 200 : 401,
      { ok: this.keyMatches(String(body?.key ?? "")) });
  });

  api("/m/api/workspaces", async (req, res) => {
    if (!this.keyGuard(req)) return this.sendJson(res, 401, { ok: false });
    const workspaces = this.ctx.workspaceRegistry.list().map(w => ({
      id: w.id, path: w.path, title: w.title, sessionIds: w.sessionIds }));
    const { items } = await this.ctx.sessionController.list({}, undefined);
    this.sendJson(res, 200, { workspaces, sessions: items });
  });

  api("/m/api/messages", async (req, res) => {
    if (!this.keyGuard(req)) return this.sendJson(res, 401, { ok: false });
    const u = new URL(req.url, "http://x");
    const result = await this.ctx.sessionController.page({
      address: { kind: "session", sessionId: u.searchParams.get("sessionId") },
      throughSeq: -1,
      beforeSeq: u.searchParams.has("beforeSeq") ? Number(u.searchParams.get("beforeSeq")) : undefined,
      maxMessages: Number(u.searchParams.get("maxMessages") ?? 50),
    }, undefined);
    this.sendJson(res, 200, result);
  });

  api("/m/api/sessions", async (req, res) => {
    if (!this.keyGuard(req)) return this.sendJson(res, 401, { ok: false });
    const b = await this.readJson(req);
    this.sendJson(res, 200, await this.ctx.sessionController.create({
      sessionId: b?.sessionId, cwd: b?.cwd, agentPreset: b?.agentPreset }));
  });

  api("/m/api/prompt", async (req, res) => {
    if (!this.keyGuard(req)) return this.sendJson(res, 401, { ok: false });
    const b = await this.readJson(req);
    this.sendJson(res, 200, await this.ctx.sessionController.prompt({
      requestId: b?.requestId ?? randomUUID(), sessionId: b.sessionId,
      mode: b?.mode === "steer" ? "steer" : "queue",
      content: [{ type: "text", text: String(b?.text ?? "") }],
      clientTimeZone: b?.clientTimeZone }, undefined));
  });

  api("/m/api/cancel", async (req, res) => {
    if (!this.keyGuard(req)) return this.sendJson(res, 401, { ok: false });
    const b = await this.readJson(req);
    this.sendJson(res, 200, this.ctx.sessionController.cancel({ sessionId: b.sessionId }));
  });
}
```

### 4.3 Link 控制 API（cookie 门，桌面设置页专用）
```js
registerLink() {
  const r = this.ctx.webServer;
  r.register({ kind: "exact", path: "/m/link/status", handler: async (req, res) => {
    if (!this.cookieGuard(req)) return;
    this.sendJson(res, 200, await this.linkStatus());
  }});
  r.register({ kind: "exact", path: "/m/link/generate-key", handler: async (req, res) => {
    if (!this.cookieGuard(req)) return;
    const key = "link-" + randomBytes(18).toString("base64url");
    await this.ctx.credentials.modifyRecord(LINK_KEY_RECORD, () =>
      Promise.resolve({ kind: "grant", payload: { secret: key } }));
    await this.reloadKey();
    this.sendJson(res, 200, { key });
  }});
  r.register({ kind: "exact", path: "/m/link/clear-key", handler: async (req, res) => {
    if (!this.cookieGuard(req)) return;
    await this.ctx.credentials.deleteRecord(LINK_KEY_RECORD);
    await this.reloadKey();
    this.sendJson(res, 200, { ok: true });
  }});
}
```

### 4.4 WebSocket（`/m/api/stream`，密钥走首帧）
```js
registerStream() {
  this.ctx.webServer.registerUpgrade({ path: "/m/api/stream", handler: (req, socket, head) => {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }});
}
onWs(ws) {
  this.follows.set(ws, new Map());
  ws.on("message", async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "auth") {                    // 首帧鉴权
      ws.linkAuthed = this.keyMatches(String(m.key ?? ""));
      if (!ws.linkAuthed) ws.close(4401, "invalid link key");
      return;
    }
    if (!ws.linkAuthed && this._keyBuf) return ws.close(4401, "invalid link key");
    if (m.type === "follow") this.startFollow(ws, m.sessionId);
    else if (m.type === "unfollow") this.stopFollow(ws, m.sessionId);
  });
  ws.on("close", () => { for (const ac of this.follows.get(ws)?.values() ?? []) ac.abort(); this.follows.delete(ws); });
}
async startFollow(ws, sessionId) {
  this.stopFollow(ws, sessionId);
  const ac = new AbortController();
  this.follows.get(ws).set(sessionId, ac);
  ws.send(JSON.stringify({ type: "opened", sessionId }));
  try {
    for await (const frame of this.ctx.sessionController.follow(
      { address: { kind: "session", sessionId }, assistantStream: true }, ac.signal))
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "frame", sessionId, frame }));
  } catch (e) { if (!ac.signal.aborted) ws.send(JSON.stringify({ type: "error", sessionId, message: String(e) })); }
}
stopFollow(ws, sessionId) { this.follows.get(ws)?.get(sessionId)?.abort(); this.follows.get(ws)?.delete(sessionId); }
```

---

## 5. 客户端段：设置页「Link」栏

`lib/client.js` 导出 `{ apply, inject }`（参照 `dsh-client-ui-settings-account` 的 `settings.section` 模式）。

```js
const inject = ["slots", "locale"];   // 服务名注入

function apply(ctx) {
  ctx.effect(() => ctx.locale.register("settings.link", { en, zh }), "link: dictionaries");
  const t = ctx.locale.bind("settings.link");

  // —— 与 host 段通信：直接 fetch 同源 /m/link/* ——
  const ops = {
    status: async () => (await fetch("/m/link/status")).json(),
    generateKey: async () => (await fetch("/m/link/generate-key", { method: "POST" })).json(),
    clearKey: async () => (await fetch("/m/link/clear-key", { method: "POST" })).json(),
  };

  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "link",
    order: 50,                       // 顺序：排在 General/Models 等之后
    label: () => t("nav"),           // 侧边导航文字，如「Link / 连接」
    locale: "settings.link",
    inject: () => ops,               // LinkSection 的 props
  }, LinkSection));
}

export { apply, inject };
```

`LinkSection`（React 组件，只列结构）：
```
· 连接方式卡片
    [内网 IP]  192.168.x.x:19387  （无则提示「未连接局域网」）
    [Tailscale] ● 已运行  my-mac.tailxxxx.ts.net:19387
                ● 未安装/未登录 → 显示安装引导
· 连接密钥
    [生成密钥] → 显示一次 key + 复制按钮（也可做二维码）
    [清除密钥]（清空后 H5 免密钥，仅建议纯内网/本机场景）
    keySet ? 「已启用」 : 「未启用」
· 手机操作流程（静态步骤文案，见第 7 节）
```

> 注意：设置面板用 `fetch` 调 `/m/link/*` 而非 Typert Remote，是刻意为之——桥已有 webServer + 同源 cookie 鉴权，比新增一套 `@Remote` + wire zod + client 镜像简单得多。（若想走更「原生」的 `ctx.remote.link.*`，再补 `TypertRemoteService` 即可，属可选优化。）

---

## 6. 连接密钥：生成 / 存储 / 校验 / 自动保存

- **生成**：`"link-" + randomBytes(18).toString("base64url")`（约 24 字符，易手输）。
- **存储**：`ctx.credentials.modifyRecord(credentialKey("dsh-link","link-key"), ...)`（跨进程独占、持久化、与 cookie secret 同级安全）。
- **校验**：host 启动时 `reloadKey()` 把 key 哈希成 `sha256` 缓存在内存；每次请求 `timingSafeEqual(sha256(输入), 缓存)` 常数时间比较。
- **门控语义**：`keySet === true` → `/m/api/*` + WS 必须携带密钥；`keySet === false` → 放行（配合「仅本机/纯内网」场景）。
- **自动保存**：H5 把 key 存 `localStorage["dsh-link-key"]`（origin 作用域）。首次输对后 `setItem`；下次打开先用存的 key 调 `/m/api/ping` 校验，401 才重新弹输入框。
  - 注意：`http://192.168.x.x:19387` 与 `http://<tailscale-host>:19387` 是**不同 origin**，localStorage 各自独立，换入口要重输一次。

---

## 7. 手机连接操作流程（写进 Link 面板 + H5 欢迎页）

**方式 A · Tailscale（推荐，安全）**
1. 手机装 Tailscale App，用与 Mac 相同的账号登录（进入同一 tailnet）。
2. 桌面端 设置 → Link 确认 Tailscale 状态「运行中」，记下 MagicDNS 名（如 `my-mac.tailxxxx.ts.net`，插件从 `tailscale status --json` 的 `Self.DNSName` 自动读取，无需手配）。
3. 手机浏览器打开 `http://my-mac.tailxxxx.ts.net:19387/m/`。
4. 若 Link 已启用密钥：输入密钥 → 自动保存 → 进入会话边栏。
   > Tailscale 走 WireGuard：端到端加密 + 仅 tailnet 内可达 + MagicDNS 域名解析，这是「安全」的来源；密钥在此之上再加一道应用层门。

**方式 B · 内网 IP（便捷）**
1. 手机与 Mac 连同一 Wi-Fi。
2. 桌面端 设置 → Link 查看「内网 IP」列表，取其一（如 `http://192.168.1.50:19387/m/`）。
3. 手机浏览器打开，同上输密钥。
   > 内网 HTTP 明文、无端到端加密，只建议在可信家庭/办公网使用；对安全有要求请用 Tailscale。

**桌面端「生成密钥」后的完整链路**
```
设置 → Link → [生成密钥] → 得到 key + 可扫二维码
   ↓
手机 H5 → 输 key（或扫二维码）→ localStorage 自动保存
   ↓
fetch('/m/api/workspaces') 带 X-Dsh-Link-Key 头 → 会话边栏
   ↓
发消息 POST /m/api/prompt + WS /m/api/stream 收流式
```

---

## 8. H5 前端要点（静态 SPA，fetch + WebSocket）

- **边栏**：`GET /m/api/workspaces` → `{workspaces, sessions}`；把 `sessions` 按 `sessionId` 归入各 `workspace.sessionIds`（无 cwd 的会话单独一组）。标题取 `session.projections?.values?.title`，缺省回退 `sessionId`。
- **历史**：`GET /m/api/messages?sessionId=`（`page`）→ `records` 过滤 `user/message`、`assistant/message`（`surfaceOp==="append"`），从 `message.content` 里 `type:"text"` 取文本。
- **发消息 + 流式**：`POST /m/api/prompt`（body `{sessionId, text, requestId}`）→ `{accepted:true}`；随后 WS 连接 `/m/api/stream`，先 `{type:"auth", key}` 再 `{type:"follow", sessionId}`。
- **渲染流式**：WS 收 `{type:"frame", frame}`：
  - `frame.type === "assistant-stream" && frame.frame.type === "chunk" && frame.frame.chunk.type === "text-delta"` → 追加 `chunk.text` 到「正在生成」气泡；
  - `frame.type === "event" && event.type === "assistant/message"` → 用最终 `message` 收尾气泡；
  - `frame.frame.type === "end"` → 本次回复结束。
- **密钥门**：启动时读 `localStorage["dsh-link-key"]` → `GET /m/api/ping`（带 `X-Dsh-Link-Key`）→ 200 直接进，401 弹输入框 → `POST /m/api/verify` 验 key → 存 localStorage。
- MVP 可先只渲染最终 `assistant/message`（不做逐字流式），跑通后再加 `text-delta`。

---

## 9. 调用顺序配方（聊天主链路）

```
1. 列边栏   : workspaceRegistry.list() + sessionController.list({}, signal)
2. 读历史   : sessionController.page({address:{kind:"session",sessionId}, throughSeq:-1, maxMessages}, signal)
3. 建/恢复  : sessionController.create({sessionId?, cwd?, agentPreset?})   // 新会话才需；prompt 内部会 resume 冷会话
4. 发消息   : sessionController.prompt({requestId, sessionId, mode:"queue", content:[{type:"text",text}], clientTimeZone}, signal)
5. 收流式   : for await (f of sessionController.follow({address, assistantStream:true}, signal))
6. 停止     : sessionController.cancel({sessionId})
```

---

## 10. 未确定项 / 风险（诚实标注）

1. **hermeslink 未能抓取**（搜索端点 401 + GitHub 域名被沙箱拦截）：本设计按你描述的目标形态实现，未逐条对照其源码。
2. **`.d.ts` 全缺**：`SessionEventMap`/`SessionHeader`/`Message`/`ContentBlock` 等精确 TS 类型被擦除，本文这些类型是重建，方法名/参数名/返回值语义有源码行号可核对。
3. **`sessionPersistence`/`sessionQuery`/`sessionProjections` 三包未提取**：桥只经 `sessionController` 间接用，不需直接调；若想绕过直接碰冷存储需补提取。
4. **`snapshotEvents`/`eventAt`/`ownEvents` 已 @deprecated**：不要新写对这些方法的调用。
5. **`tailscale` CLI 依赖**：需在 PATH 或配置 CLI 绝对路径（macOS App Store 版路径不同）；插件应对「未安装」优雅降级（返回 running:false）。
6. **`credentials` 记录 shape**：`{kind:"grant", payload}` 已按 `dsh-client-connection` 现有写法抄录；`modifyRecord` 返回提交后 record。
7. **设置面板 order/文案**：`settings.section` 槽的 `order` 语义与各现有 section 的相对排序需装好后实测微调。
8. **`ws` 依赖**：显式声明在 `dependencies`（desktop 运行时已通过 `dsh-api-gateway` 内置，但插件依赖要显式化）。

---

## 11. MVP 落地清单

- [ ] 建插件包 + `package.json`（3.1 节），`lib/index.js`（host）+ `lib/client.js`（客户端）+ `lib/public/`（H5 静态产物）。
- [ ] host：静态 `/m`、`/m/api/*`（ping/verify/workspaces/messages/sessions/prompt/cancel）、`/m/link/*`（status/generate-key/clear-key）、WS `/m/api/stream`。
- [ ] 客户端：`settings.section` 槽注册「Link」栏，展示内网/Tailscale 状态 + 密钥 + 连接地址 + 手机流程。
- [ ] H5：边栏 + 气泡 + 输入框 + 密钥门 + `text-delta` 流式。
- [ ] 装进 desktop profile，本机 `127.0.0.1:19387/m/` 全链路自测 → 内网 IP 自测 → Tailscale 自测。
