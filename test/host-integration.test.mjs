/**
 * host 段集成自测：用 mock 的 DSH 上下文把整个 host 插件跑起来，
 * 打真实 HTTP / WebSocket 请求验证密钥门、静态服务、会话 API 与流式转发。
 *
 * 运行：node test/host-integration.test.mjs
 */
import { strict as assert } from "node:assert";
import { test, afterAll } from "vitest";
import { apply } from "../dist/host/index.js";
import { LinkRoutes } from "../dist/host/routes.js";


// ─────────────────── mock DSH 上下文 ───────────────────
function makeCtx() {
  const records = new Map();
  const disposers = [];
  const listeners = new Map();

  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, ...args) { for (const h of listeners.get(event) ?? []) h(...args); },
    effect(fn, _label) {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
      return () => {};
    },
    inject(_names, cb) { cb(ctx); },

    connection: {
      // 回环恒可信（cookie 测试用），非回环返回 401
      admit(req) {
        return req.headers["x-test-cookie"] === "good" ? { peer: {} } : { rejection: 401 };
      },
    },

    credentials: {
      async readRecord(key) { return records.get(key); },
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key));
        if (next !== undefined) { records.set(key, next); ctx.emit("credentials/record-updated", key); }
        return records.get(key);
      },
      async deleteRecord(key) { records.delete(key); ctx.emit("credentials/record-updated", key); },
      async listRecords() { return [...records.keys()].map((key) => ({ key, kind: "grant" })); },
    },

    workspaceRegistry: {
      list() {
        return [{ id: "ws1", path: "/tmp/proj", title: "Proj", sessionIds: ["s1"] }];
      },
    },

    sessionController: {
      async list(_req, signal) {
        signal?.throwIfAborted?.();
        return { items: [{ sessionId: "s1", updatedAt: Date.now(), agentAvailable: true, running: false, blank: false, cwd: "/tmp/proj", projections: { asOfSeq: 3, values: { title: "第一个会话" } } }] };
      },
      async create(req) { return { sessionId: req.sessionId ?? "new-session", agentPreset: req.agentPreset }; },
      async prompt(req, signal) {
        signal.throwIfAborted();   // 真实门面就是这样，少了第二个参数会直接 TypeError
        ctx.sessionController.lastPrompt = req;
        assert.ok(req.requestId);
        assert.ok(["queue", "steer"].includes(req.mode));
        assert.ok(Array.isArray(req.content) && req.content.length);
        assert.ok(req.content.every((p) => p.type === "text"
          || (p.type === "file" && typeof p.receiptId === "string")
          || (p.type === "image" && typeof p.data === "string" && /^image\//.test(p.mediaType))));
        return { accepted: true };
      },
      agents: {
        async resolveAgent(sessionId) {
          if (sessionId === "missing") return { error: new Error("session/not-found") };
          return { agent: { id: sessionId } };
        },
      },
      async attachment(req) {
        assert.ok(req.sessionId && req.attachmentId);
        // host 侧返回 base64（真实实现返回 base64 字符串或字节）
        return { attachment: { attachmentId: req.attachmentId, mediaType: "image/png", bytes: 3, name: "t.png" }, data: Uint8Array.from([1, 2, 3]) };
      },
      cancel(req) { assert.ok(req.sessionId); return { accepted: true }; },
      async page(req, signal) {
        signal.throwIfAborted();
        assert.equal(req.address.kind, "session");
        return { records: [{ type: "event", event: { type: "user/message", seq: 0, surfaceOp: "append", data: { role: "user", content: [{ type: "text", text: "older" }] } } }], hasMore: false };
      },
      async *follow(req, signal) {
        assert.ok(signal, "follow 必须收到 signal");
        assert.equal(req.address.kind, "session");
        yield {
          type: "snapshot", header: { id: req.address.sessionId, cwd: "/tmp/proj" }, cursor: 2,
          records: [{ type: "event", event: { type: "user/message", seq: 0, surfaceOp: "append", data: { role: "user", content: [{ type: "text", text: "hi" }] } } }],
          hasMore: false, projections: { asOfSeq: 2, values: {} },
          ...(req.assistantStream ? { assistantStream: { revision: 0 } } : {}),
        };
        if (req.assistantStream) {
          yield { type: "assistant-stream", frame: { type: "start", revision: 1, attemptId: "a1", turn: 0, step: 0, startedAfterSeq: 2 } };
          yield { type: "assistant-stream", frame: { type: "chunk", revision: 2, attemptId: "a1", index: 0, chunk: { type: "text-delta", text: "你好" } } };
          yield { type: "event", event: { type: "assistant/message", seq: 3, surfaceOp: "append", data: { message: { role: "assistant", content: [{ type: "text", text: "你好，世界" }] }, turn: 0, step: 0, stream: [] } } };
        }
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },

    fileUploads: {
      calls: [],
      // 真实签名：upload(agent, request, signal)；实现第一步就是 signal.throwIfAborted()
      async upload(agent, request, signal) {
        signal.throwIfAborted();
        if (typeof agent !== "object" || !agent?.id) {
          throw new Error("expected a resolved agent, got " + typeof agent);
        }
        ctx.fileUploads.calls.push({ agentId: agent.id, request });
        if (request.name === "boom.png") throw new Error("staging failed");
        return {
          receiptId: `receipt-${ctx.fileUploads.calls.length}`,
          file: { attachmentId: "sha256:deadbeef", name: request.name, bytes: Math.round(request.data.length * 0.75) },
        };
      },
    },

    webServer: {
      routes: new Map(),
      upgrades: new Map(),
      register(route) { this.routes.set(`${route.kind} ${route.path}`, route); return () => this.routes.delete(`${route.kind} ${route.path}`); },
      registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path); },
    },
  };

  return { ctx, records, disposers };
}

// LAN 侧用固定测试端口，避免探测 runtime 内部字段。
const LAN_PORT = 19599;

async function http(method, path, { body, headers = {}, port = LAN_PORT } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ─────────────────── 起插件 ───────────────────
const { ctx, disposers } = makeCtx();
await apply(ctx, { lanEnabled: true, lanPort: LAN_PORT, bindHost: "127.0.0.1" });
// 等 LAN server listen
await new Promise((r) => setTimeout(r, 200));


test("回环路由已注册（/m 前缀 + WS upgrade）", async () => {
  assert.ok(ctx.webServer.routes.has("prefix /m"), "应注册 /m 前缀路由");
  assert.ok(ctx.webServer.upgrades.has("/m/api/stream"), "应注册 WS upgrade");
});

test("LAN 静态页可取（/m/ → index.html）", async () => {
  const r = await http("GET", "/m/");
  assert.equal(r.status, 200);
  assert.match(r.text, /DSH\s*Link|dsh-link|<!doctype html>/i);
});

test("LAN 静态资源（app.js / style.css）", async () => {
  const js = await http("GET", "/m/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") || "", /javascript/);
  const css = await http("GET", "/m/style.css");
  assert.equal(css.status, 200);
});

test("代码类资源不缓存（避免手机读到旧 H5），图片长缓存", async () => {
  for (const p of ["/m/app.js", "/m/style.css", "/m/transcript.js", "/m/md.js", "/m/index.html"]) {
    const r = await http("GET", p);
    assert.match(r.headers.get("cache-control") || "", /no-cache/, `${p} 应 no-cache`);
  }
  const png = await http("GET", "/m/icon-180.png");
  assert.match(png.headers.get("cache-control") || "", /max-age=86400/);
});

test("静态资源带内容 ETag，命中 If-None-Match 时回 304 空体", async () => {
  const first = await http("GET", "/m/app.js");
  const etag = first.headers.get("etag");
  assert.ok(etag && etag.startsWith('"'), `应有强 ETag，实际 ${etag}`);

  const again = await http("GET", "/m/app.js", { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304, "内容没变应回 304");
  assert.equal(again.text, "", "304 不应带 body");

  // 弱校验前缀与多值列表也要认得
  const weak = await http("GET", "/m/app.js", { headers: { "if-none-match": `W/${etag}` } });
  assert.equal(weak.status, 304);
  const list = await http("GET", "/m/app.js", { headers: { "if-none-match": `"nope", ${etag}` } });
  assert.equal(list.status, 304);

  const stale = await http("GET", "/m/app.js", { headers: { "if-none-match": '"stale"' } });
  assert.equal(stale.status, 200);
  assert.ok(stale.text.length > 0);

  // 不同文件必须是不同 ETag（否则会把 a.js 的缓存当成 b.js 的）
  const css = await http("GET", "/m/style.css");
  assert.notEqual(css.headers.get("etag"), etag);
});

test("PWA 资源：manifest 类型正确 + 图标可取", async () => {
  const manifest = await http("GET", "/m/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type") || "", /manifest\+json/);
  const parsed = JSON.parse(manifest.text);
  assert.equal(parsed.start_url, "/m/");
  assert.ok(parsed.icons.length >= 2);

  const svg = await http("GET", "/m/icon.svg");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type") || "", /svg/);
});

test("目录穿越被拦截", async () => {
  const r = await http("GET", "/m/../../../../etc/passwd");
  assert.notEqual(r.status, 200);
});

test("未配置密钥时 LAN 的 /m/api/* 一律 403（key-required）", async () => {
  const ping = await http("GET", "/m/api/ping");
  assert.equal(ping.status, 403);
  assert.equal(ping.json.code, "key-required");
  const ws = await http("GET", "/m/api/workspaces");
  assert.equal(ws.status, 403);
});

// 生成密钥（模拟桌面控制面）
let theKey;
test("控制面生成密钥（回环 handler 直调）", async () => {
  const routes = new LinkRoutes({ ctx, keyStore: null, lanPort: () => LAN_PORT, lanEnabled: () => true });
  // 直接复用运行中的 keyStore：通过 credentials 写入等价路径
  const { generateLinkKey, KeyStore, LINK_KEY_RECORD } = await import("../dist/host/key-store.js");
  const ks = new KeyStore(ctx);
  theKey = generateLinkKey();
  await ks.set(theKey);
  // apply() 内部的 keyStore 通过 credentials/record-updated 已热重载
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(theKey.startsWith("link-"));
  assert.ok(LINK_KEY_RECORD.includes("dsh-link"));
  void routes;
});

test("带正确密钥后 ping 通过", async () => {
  const r = await http("GET", "/m/api/ping", { headers: { "x-dsh-link-key": theKey } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("错误密钥被 401", async () => {
  const r = await http("GET", "/m/api/ping", { headers: { "x-dsh-link-key": "wrong" } });
  assert.equal(r.status, 401);
});

test("verify 端点校验密钥", async () => {
  const good = await http("POST", "/m/api/verify", { body: { key: theKey } });
  assert.equal(good.status, 200);
  const bad = await http("POST", "/m/api/verify", { body: { key: "nope" } });
  assert.equal(bad.status, 401);
});

test("workspaces 返回工作区 + 会话", async () => {
  const r = await http("GET", "/m/api/workspaces", { headers: { "x-dsh-link-key": theKey } });
  assert.equal(r.status, 200);
  assert.equal(r.json.workspaces[0].id, "ws1");
  assert.equal(r.json.sessions[0].sessionId, "s1");
  assert.equal(r.json.sessions[0].projections.values.title, "第一个会话");
});

test("messages 初始历史取自 follow 的 snapshot", async () => {
  const r = await http("GET", "/m/api/messages?sessionId=s1", { headers: { "x-dsh-link-key": theKey } });
  assert.equal(r.status, 200);
  assert.equal(r.json.records.length, 1);
  assert.equal(r.json.records[0].event.type, "user/message");
  assert.equal(r.json.cursor, 2);
});

test("messages 分页（beforeSeq）走 page", async () => {
  const r = await http("GET", "/m/api/messages?sessionId=s1&beforeSeq=5", { headers: { "x-dsh-link-key": theKey } });
  assert.equal(r.status, 200);
  assert.equal(r.json.records[0].event.data.content[0].text, "older");
});

test("prompt 通过并 ack", async () => {
  const r = await http("POST", "/m/api/prompt", { headers: { "x-dsh-link-key": theKey }, body: { sessionId: "s1", text: "跑起来" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, true);
});

test("prompt 空内容被拒", async () => {
  const r = await http("POST", "/m/api/prompt", { headers: { "x-dsh-link-key": theKey }, body: { sessionId: "s1", text: "   " } });
  assert.equal(r.status, 400);
});

test("图片上传：走 fileUploads 契约换收据", async () => {
  const before = ctx.fileUploads.calls.length;
  const png = "iVBORw0KGgoAAAANSUhEUg=="; // 任意 base64
  const r = await http("POST", "/m/api/upload", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", name: "photo.jpg", data: png },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.receiptId, `receipt-${before + 1}`);
  const call = ctx.fileUploads.calls.at(-1);
  assert.equal(call.agentId, "s1", "收据必须绑到 session 上（且第一个参数是解析后的 agent 对象）");
  assert.equal(call.request.name, "photo.jpg");
  assert.equal(call.request.data, png, "传给 host 的应是纯 base64（已剥掉 data: 前缀）");
});

test("图片上传：接受 data URL 前缀、拒绝非 base64 与超大图", async () => {
  const ok = await http("POST", "/m/api/upload", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", name: "a.png", data: "data:image/png;base64,iVBORw0KGgo=" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ctx.fileUploads.calls.at(-1).request.data, "iVBORw0KGgo=");

  const bad = await http("POST", "/m/api/upload", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", data: "not base64 !!!" },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error || "", /base64/);

  const missing = await http("POST", "/m/api/upload", {
    headers: { "x-dsh-link-key": theKey },
    body: { data: "AAAA" },
  });
  assert.equal(missing.status, 400);

  // 13MB 解码后超过 12MB 上限
  const huge = "A".repeat(Math.ceil((13 * 1024 * 1024) / 3) * 4);
  const tooBig = await http("POST", "/m/api/upload", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", data: huge },
  });
  assert.equal(tooBig.status, 413);
});

test("图片上传：会话解析失败时给出可读原因", async () => {
  const r = await http("POST", "/m/api/upload", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "missing", name: "a.png", data: "AAAA" },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error || "", /无法解析会话/);
});

test("图片上传：host 报错时把原因透给手机", async () => {
  const r = await http("POST", "/m/api/upload", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", name: "boom.png", data: "AAAA" },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error || "", /staging failed/);
});

test("prompt 带上 receiptIds → content 里是 {type:file,receiptId}", async () => {
  const a = await http("POST", "/m/api/upload", { headers: { "x-dsh-link-key": theKey }, body: { sessionId: "s1", name: "1.png", data: "AAAA" } });
  const b = await http("POST", "/m/api/upload", { headers: { "x-dsh-link-key": theKey }, body: { sessionId: "s1", name: "2.png", data: "BBBB" } });
  const r = await http("POST", "/m/api/prompt", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", text: "看这两张图", mode: "queue", requestId: "req-img", receiptIds: [a.json.receiptId, b.json.receiptId] },
  });
  assert.equal(r.status, 200);
  const sent = ctx.sessionController.lastPrompt;
  assert.equal(sent.content[0].type, "text");
  assert.deepEqual(sent.content.slice(1), [
    { type: "file", receiptId: a.json.receiptId },
    { type: "file", receiptId: b.json.receiptId },
  ]);
});

test("只发图片不写文字也能发送", async () => {
  const r = await http("POST", "/m/api/prompt", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", text: "   ", receiptIds: ["receipt-x"] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(ctx.sessionController.lastPrompt.content, [{ type: "file", receiptId: "receipt-x" }]);
});

test("/m/api/answer 转给官方 userQuestions.answer", async () => {
  const calls = [];
  ctx.remote = {
    userQuestions: {
      // 真实契约：answer(sessionId, callId, answer) → {ok, value}
      answer: (first, callId, answer) => { calls.push({ first, callId, answer }); return { ok: true, value: true }; },
    },
  };
  try {
    const r = await http("POST", "/m/api/answer", {
      headers: { "x-dsh-link-key": theKey },
      body: { sessionId: "s1", callId: "call_ask_1", answers: [{ id: "q1", selected: ["方案 A"], custom: " 自填 " }] },
    });
    assert.equal(r.status, 200, r.text.slice(0, 140));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].callId, "call_ask_1");
    assert.equal(calls[0].first, "s1");        // 第一个参数是 sessionId，不是 agent
    assert.deepEqual(calls[0].answer, { answers: [{ id: "q1", selected: ["方案 A"], custom: " 自填 " }] });

    // 参数不全 / 空答案 → 400
    assert.equal((await http("POST", "/m/api/answer", { headers: { "x-dsh-link-key": theKey }, body: { sessionId: "s1" } })).status, 400);
    assert.equal((await http("POST", "/m/api/answer", { headers: { "x-dsh-link-key": theKey }, body: { sessionId: "s1", callId: "c", answers: [] } })).status, 400);

    // 已超时/被其它端回答 → 409
    ctx.remote.userQuestions.answer = () => ({ ok: false, error: { message: "提问已超时" } });
    const gone = await http("POST", "/m/api/answer", {
      headers: { "x-dsh-link-key": theKey },
      body: { sessionId: "s1", callId: "call_ask_1", answers: [{ id: "q1", selected: ["方案 A"] }] },
    });
    assert.equal(gone.status, 409);
    assert.match(gone.text, /超时/);             // 把桌面端给的原因透出来

    // 无密钥 → 401
    const noKey = await http("POST", "/m/api/answer", { body: { sessionId: "s1", callId: "c", answers: [{ id: "q", selected: ["x"] }] } });
    assert.equal(noKey.status, 401);
  } finally {
    delete ctx.remote;
  }

  // 桌面版没提供该接口 → 503，让手机优雅降级
  const unsupported = await http("POST", "/m/api/answer", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", callId: "c", answers: [{ id: "q", selected: ["x"] }] },
  });
  assert.equal(unsupported.status, 503);
});

test("prompt 接受内联图片 → content 里是 {type:image,...}", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
  const r = await http("POST", "/m/api/prompt", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", text: "看图", mode: "steer", requestId: "req-img-inline", images: [{ data: `data:image/png;base64,${png}`, mediaType: "image/png", name: "a.png" }] },
  });
  assert.equal(r.status, 200, r.text.slice(0, 120));
  const content = ctx.sessionController.lastPrompt.content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image");            // 必须是 image，file 收据那条路读不回来
  assert.equal(content[1].mediaType, "image/png");
  assert.equal(content[1].name, "a.png");
  assert.equal(content[1].data, png);                // data URL 前缀要被剥掉

  // 非图片 mediaType / 空 data 会被丢掉
  const r2 = await http("POST", "/m/api/prompt", {
    headers: { "x-dsh-link-key": theKey },
    body: { sessionId: "s1", text: "x", mode: "steer", requestId: "req-img-bad", images: [{ data: png, mediaType: "text/plain", name: "b.txt" }] },
  });
  assert.equal(r2.status, 200);
  assert.equal(ctx.sessionController.lastPrompt.content.length, 1);   // 只剩 text
});

test("既没文字也没图片仍然拒绝", async () => {
  const r = await http("POST", "/m/api/prompt", { headers: { "x-dsh-link-key": theKey }, body: { sessionId: "s1", text: "" } });
  assert.equal(r.status, 400);
});

test("附件读取：转成 base64 返回", async () => {
  const r = await http("GET", `/m/api/attachment?sessionId=s1&attachmentId=${encodeURIComponent("sha256:deadbeef")}`, { headers: { "x-dsh-link-key": theKey } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data, Buffer.from([1, 2, 3]).toString("base64"));
  assert.equal(r.json.attachment.mediaType, "image/png");

  const missing = await http("GET", "/m/api/attachment?sessionId=s1", { headers: { "x-dsh-link-key": theKey } });
  assert.equal(missing.status, 400);
});

test("图片接口同样受密钥保护", async () => {
  const up = await http("POST", "/m/api/upload", { body: { sessionId: "s1", data: "AAAA" } });
  assert.equal(up.status, 401);                        // 无密钥 → 401
  const att = await http("GET", "/m/api/attachment?sessionId=s1&attachmentId=x");
  assert.equal(att.status, 401);                       // 密钥检查在参数校验之前
  const attNoId = await http("GET", "/m/api/attachment?sessionId=s1", { headers: { "x-dsh-link-key": theKey } });
  assert.equal(attNoId.status, 400);                   // 带密钥但缺 attachmentId → 400
});

test("cancel 通过", async () => {
  const r = await http("POST", "/m/api/cancel", { headers: { "x-dsh-link-key": theKey }, body: { sessionId: "s1" } });
  assert.equal(r.status, 200);
});

test("create 新会话", async () => {
  const r = await http("POST", "/m/api/sessions", { headers: { "x-dsh-link-key": theKey }, body: { cwd: "/tmp/proj" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.sessionId, "new-session");
});

test("控制面 /m/link/* 在 LAN 侧不可见（404）", async () => {
  const r = await http("GET", "/m/link/status", { headers: { "x-dsh-link-key": theKey } });
  assert.equal(r.status, 404);
});

test("WS 流式：auth → follow → 收 snapshot/chunk/event 帧", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${LAN_PORT}/m/api/stream`);
  const frames = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting frames")), 4000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      frames.push(msg);
      // 收到 assistant/message 事件帧即算跑通
      if (msg.type === "frame" && msg.frame.type === "event" && msg.frame.event.type === "assistant/message") {
        clearTimeout(timer); resolve();
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); });
  });
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: "auth", key: theKey }));
  ws.send(JSON.stringify({ type: "follow", sessionId: "s1" }));
  await done;
  ws.close();

  const types = frames.map((f) => f.type);
  assert.ok(types.includes("ready"));
  assert.ok(types.includes("opened"));
  const frameKinds = frames.filter((f) => f.type === "frame").map((f) => f.frame.type);
  assert.ok(frameKinds.includes("snapshot"), "应转发 snapshot 帧");
  assert.ok(frameKinds.includes("assistant-stream"), "应转发 assistant-stream 帧");
});

test("WS 错误密钥被 4401 关闭", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${LAN_PORT}/m/api/stream`);
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: "auth", key: "wrong" }));
  const ev = await new Promise((resolve) => { ws.addEventListener("close", resolve, { once: true }); });
  assert.equal(ev.code, 4401);
});

// LAN 监听与 WS hub 在测试结束后释放，避免 vitest 报未关闭句柄
afterAll(async () => {
  for (const dispose of disposers) {
    try { await dispose(); } catch { /* ignore */ }
  }
});
