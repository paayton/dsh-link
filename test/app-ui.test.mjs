// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:19388/m/?debug=1" }
/**
 * H5 客户端（src/public/app.js）的 UI 层测试。
 *
 * 这是之前最大的测试空白：md/transcript 是纯函数、host 有集成测试，
 * 但「事件流 → DOM」这一层只有手点浏览器。这里用 jsdom 跑真实的 index.html
 * 结构 + 真实的 app.js，只把网络/WebSocket 换成可控桩。
 *
 * app.js 在 `?debug=1` 下会把现场挂到 `window.__dshLink`（state / t / stats），
 * 测试就靠它断言内部状态。每个用例前 `vi.resetModules()`，拿到一份全新的 app。
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(resolve(ROOT, "src/public/index.html"), "utf8");
const BODY_HTML = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));

const SESSION = "session-test-0001";
const WORKSPACE = { id: "ws1", path: "/tmp/proj", title: "Proj", sessionIds: [SESSION] };

/** 确定性的内存 Storage（jsdom 的 localStorage 在本环境取不到）。 */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/** 最小 Response 形状：app.js 只用到 status / ok / headers.get / json / text。 */
function jsonRes(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** 可编程的 WebSocket 桩：记录发出的帧，并能向页面推服务端帧。 */
class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  /** 服务端 → 页面 */
  push(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  /** host 的 frame 信封：{type:"frame", sessionId, frame} */
  pushFrame(sessionId, frame) { this.push({ type: "frame", sessionId, frame }); }
  sentOf(type) { return this.sent.filter((m) => m.type === type); }
}

/** jsdom 不会真的解码图片，给 prepareImage 一个能 onload 的假 Image。 */
class FakeImage {
  constructor() { this.naturalWidth = 1200; this.naturalHeight = 800; }
  set src(value) { this._src = value; setTimeout(() => this.onload?.(), 0); }
  get src() { return this._src; }
}

function ev(type, seq, data) { return { type, seq, time: 1790000000000 + seq, data }; }

/** 常用事件样本 */
const EVENTS = {
  user: (seq, text) => ({ type: "event", event: { ...ev("user/message", seq, { content: [{ type: "text", text }], source: { kind: "user" } }), surfaceOp: "append" } }),
  assistant: (seq, content) => ({ type: "event", event: ev("assistant/message", seq, { turn: 1, step: 1, message: { role: "assistant", content, source: { model: "deepseek-flash" } } }) }),
  toolCall: (seq, id, name, args) => ({ type: "event", event: ev("tool/call", seq, { turn: 1, step: 1, callId: id, name, arguments: args }) }),
  toolResult: (seq, id, text, isError = false) => ({ type: "event", event: ev("tool/result", seq, { turn: 1, step: 1, message: { role: "tool", toolCallId: id, content: [{ type: "text", text }], isError } }) }),
};

/**
 * 起一份全新的 app。返回页面里的现场句柄。
 * @param {{ key?: string|null, routes?: Record<string, (init) => any> }} opts
 */
async function bootApp(opts = {}) {
  const key = opts.key === undefined ? "link-test" : opts.key;
  const calls = [];

  document.body.innerHTML = BODY_HTML;
  // vitest 的 jsdom 环境里 `window.localStorage` 的 getter 返回 undefined
  // （真实实现挂在 `window._localStorage` 上），这里换成一个确定性的内存实现，
  // 同时挂到 window 与全局，保证 app.js 里的裸 `localStorage` 也能用。
  const storage = memoryStorage();
  for (const target of [window, globalThis]) {
    Object.defineProperty(target, "localStorage", { value: storage, configurable: true, writable: true });
  }
  if (key) storage.setItem("dsh-link-key", key);

  // 清掉上一条用例留下的视口伪造：否则 .kb（键盘态）会一直挂着，
  // 而"正在输入"会改变发送/停止按钮的显示，造成串扰
  try { delete window.visualViewport; } catch { window.visualViewport = undefined; }
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 844 });
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.Image = FakeImage;
  FakeWebSocket.instances = [];

  const defaultRoutes = {
    "/m/api/ping": () => jsonRes({ ok: true, keyRequired: true }),
    "/m/api/workspaces": () => jsonRes({
      workspaces: [WORKSPACE],
      sessions: [{ sessionId: SESSION, updatedAt: Date.now(), running: false, cwd: "/tmp/proj", projections: { values: { title: "测试会话" } } }],
    }),
    "/m/api/messages": () => jsonRes({ records: [], hasMore: false, cursor: 0 }),
  };
  const routes = { ...defaultRoutes, ...(opts.routes || {}) };

  window.fetch = vi.fn(async (url, init = {}) => {
    const path = String(url).split("?")[0];
    calls.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[path];
    if (!handler) return jsonRes({ ok: false, error: "not found" }, 404);
    return handler(init);
  });

  window.WebSocket = FakeWebSocket;
  // jsdom 没实现 createObjectURL，附件水合会在这里断掉
  if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:mock";
  if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};
  vi.resetModules();
  await import("../src/public/app.js");

  const hook = () => window.__dshLink;
  const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

  return { key, calls, hook, socket, callsTo: (path) => calls.filter((c) => c.path === path) };
}

/** 等页面把某件事做完（默认等到 #main 显示）。 */
async function waitFor(fn, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    try {
      const value = fn();
      if (value) return value;
    } catch { /* 继续等 */ }
    if (Date.now() - started > timeout) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const $ = (id) => document.getElementById(id);
const turns = (sel = ".turn") => [...document.querySelectorAll(`#messages ${sel}`)];

describe("输入区", () => {
  test("没有排队/插话选择器，提示文案说明发送即插话", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    expect(document.getElementById("mode-seg")).toBeNull();
    expect(document.body.textContent).not.toContain("排队");
    // Agent 运行中：占位符与提示都指向"插话"
    await waitFor(() => app.socket());
    const bar = $("composer-hint").parentElement;
    expect(bar.hidden).toBe(true);                       // 空闲：提示行为空 → 不占高度
    await waitFor(() => app.socket());
    app.socket().pushFrame(SESSION, { type: "event", event: ev("turn/start", 2, { turn: 1 }) });
    await waitFor(() => $("input").placeholder.includes("插话"));
    // 运行中不再挂"Agent 正在运行"那行，提示行保持收起
    expect($("composer-hint").textContent).toBe("");
    expect(bar.hidden).toBe(true);
  });
});

describe("回到底部按钮的未读角标", () => {
  /** jsdom 没有布局，scrollHeight/clientHeight 恒为 0；这里伪造出"能滚动"的样子。 */
  function fakeScrollable(el, scrollHeight = 2000, clientHeight = 600) {
    let top = 0;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = v; } });
  }

  const chunk = (i, text) => ({ type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: i, time: i, chunk: { type: "text-delta", index: 0, text } } });

  test("流式分片不计数；每落地一条助手消息才 +1", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    const ws = app.socket();
    ws.pushFrame(SESSION, { type: "snapshot", cursor: 1, records: [EVENTS.user(1, "在吗")] });
    await waitFor(() => turns().length === 1);

    // 离开底部（滚上去）→ 未读开始累计
    ws.pushFrame(SESSION, { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: 0, time: 1, chunk: { type: "block-start", index: 0, blockType: "text" } } });
    const m = $("messages");
    fakeScrollable(m);
    m.scrollTop = 0;                     // 2000 - 0 - 600 = 1400 > 120 → 判为"离开底部"
    m.dispatchEvent(new Event("scroll"));
    await waitFor(() => app.hook().state.pinned === false);

    // 50 个分片：不该动角标
    for (let i = 1; i <= 50; i += 1) ws.pushFrame(SESSION, chunk(i, "字"));
    await new Promise((r) => setTimeout(r, 120));
    expect(app.hook().state.unread).toBe(0);
    expect($("bottom-badge").hidden).toBe(true);

    // 两条成条消息 → 角标 2
    ws.pushFrame(SESSION, EVENTS.assistant(90, [{ type: "text", text: "第一条" }]));
    ws.pushFrame(SESSION, EVENTS.assistant(91, [{ type: "text", text: "第二条" }]));
    await waitFor(() => app.hook().state.unread === 2);
    expect($("bottom-badge").hidden).toBe(false);
    expect($("bottom-badge").textContent).toBe("2");
    expect($("btn-bottom").hidden).toBe(false);
  });

  test("回到最底部后角标清零并收起", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    const ws = app.socket();
    ws.pushFrame(SESSION, { type: "snapshot", cursor: 1, records: [EVENTS.user(1, "在吗")] });
    const m = $("messages");
    fakeScrollable(m);
    await waitFor(() => turns().length === 1);
    m.scrollTop = 0;
    m.dispatchEvent(new Event("scroll"));
    await waitFor(() => app.hook().state.pinned === false);
    ws.pushFrame(SESSION, EVENTS.assistant(90, [{ type: "text", text: "新回复" }]));
    await waitFor(() => $("bottom-badge").hidden === false);

    m.scrollTop = m.scrollHeight;
    m.dispatchEvent(new Event("scroll"));
    await waitFor(() => app.hook().state.pinned === true);
    expect(app.hook().state.unread).toBe(0);
    expect($("bottom-badge").hidden).toBe(true);
  });
});

describe("运行中：输入时显示发送（插话）、收起时显示停止", () => {
  const startTurn = async (app) => {
    await waitFor(() => app.socket());
    app.socket().pushFrame(SESSION, { type: "event", event: ev("turn/start", 2, { turn: 1 }) });
  };

  test("未输入时是停止按钮", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await startTurn(app);
    await waitFor(() => !$("btn-stop").hidden);
    expect($("btn-send").hidden).toBe(true);
  });

  test("聚焦输入框后换成发送按钮（不用先停止）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await startTurn(app);
    await waitFor(() => !$("btn-stop").hidden);

    $("input").focus();
    await waitFor(() => !$("btn-send").hidden);
    expect($("btn-stop").hidden).toBe(true);

    // 收起键盘（失焦）且没有内容 → 回到停止
    $("input").blur();
    await waitFor(() => !$("btn-stop").hidden);
    expect($("btn-send").hidden).toBe(true);
  });

  test("只点击输入区（不带 input 事件）也要换成发送", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await startTurn(app);
    await waitFor(() => !$("btn-stop").hidden);

    $("input").focus();
    $("composer").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !$("btn-send").hidden);
    expect($("btn-stop").hidden).toBe(true);
  });

  test("只是打了字也该显示发送", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await startTurn(app);
    await waitFor(() => !$("btn-stop").hidden);

    $("input").value = "插一句";
    $("input").dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => !$("btn-send").hidden);
    expect($("btn-stop").hidden).toBe(true);
  });
});

describe("草稿暂存", () => {
  test("打字后写草稿；发送成功清掉；切走再回来能恢复", async () => {
    const app = await bootApp({ routes: { "/m/api/prompt": () => jsonRes({ ok: true, accepted: true }) } });
    await waitFor(() => !$("main").hidden);

    // 打字 → 300ms 后落盘
    $("input").value = "没发出去的草稿";
    $("input").dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const saved = JSON.parse(window.localStorage.getItem("dsh-link-draft") || "null");
    expect(saved?.text).toBe("没发出去的草稿");
    expect(saved?.sessionId).toBe(SESSION);

    // 清空输入 → 草稿移除
    $("input").value = "";
    $("input").dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    expect(window.localStorage.getItem("dsh-link-draft")).toBeNull();

    // 再打一段然后发送成功 → 草稿必须清掉
    $("input").value = "要发出去的";
    $("input").dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    expect(JSON.parse(window.localStorage.getItem("dsh-link-draft")).text).toBe("要发出去的");
    $("composer").requestSubmit();
    await waitFor(() => app.callsTo("/m/api/prompt").length === 1);
    expect(window.localStorage.getItem("dsh-link-draft")).toBeNull();
  });

  test("超大草稿不写盘（避免撑爆 localStorage 配额）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    $("input").value = "x".repeat(1_600_000);
    $("input").dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    expect(window.localStorage.getItem("dsh-link-draft")).toBeNull();
  });
});

describe("粘贴发图", () => {
  test("粘贴板里的图片直接进托盘，文字粘贴不受影响", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);

    // 图片粘贴 → 进托盘
    const file = new File([new Uint8Array([1, 2, 3])], "pasted.png", { type: "image/png" });
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    ev.clipboardData = { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] };
    $("input").dispatchEvent(ev);
    await waitFor(() => app.hook().state.attach.length === 1);
    expect(ev.defaultPrevented).toBe(true);
    expect(app.hook().state.attach[0].name).toBe("pasted.png");

    // 纯文字粘贴 → 不拦、不进托盘
    const ev2 = new Event("paste", { bubbles: true, cancelable: true });
    ev2.clipboardData = { items: [{ kind: "string", type: "text/plain" }] };
    $("input").dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    expect(app.hook().state.attach.length).toBe(1);
  });
});

describe("会话信息（右上角「…」）", () => {
  test("副标题只留运行状态；信息在弹框里", async () => {
    const app = await bootApp({
      routes: {
        "/m/api/workspaces": () => jsonRes({
          workspaces: [WORKSPACE],
          sessions: [{
            sessionId: SESSION, updatedAt: Date.now(), running: false, cwd: "/tmp/proj",
            projections: {
              values: {
                title: "测试会话",
                agentPreset: "standard",
                agentTeam: { members: [{ id: "a", name: "lead", role: "lead" }], tasks: ["t1"] },
                modelSelection: { next: { provider: "p", model: "deepseek-flash", reasoningEffort: "high" } },
                tokenUsage: { uncachedInputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000 },
              },
            },
          }],
        }),
      },
    });
    await waitFor(() => !$("main").hidden);
    // 副标题只留项目名（+ 运行时状态点），不堆标签
    expect($("chat-sub").querySelectorAll(".chip").length).toBe(0);
    expect($("chat-sub").querySelector(".sub-name").textContent).toBe("Proj");
    expect($("chat-sub").querySelector(".sub-dot")).toBeNull();   // 该会话未运行
    expect($("chat-sub").textContent).not.toContain("更新于");

    $("btn-info").click();
    await waitFor(() => !$("info").hidden);
    const text = $("info-body").textContent;
    expect(text).toContain("standard");            // dsh 模式
    expect(text).toContain("lead");                // 智能体成员
    expect(text).toContain("1 个任务");            // 后台任务
    expect(text).toContain("deepseek-flash");      // 模型
    expect(text).toContain("high");                // reasoning effort
    expect(text).toContain(SESSION);               // 会话 ID
    expect(text).toContain("/tmp/proj");           // 工作目录
    // 分组标题
    expect([...$("info-body").querySelectorAll(".set-label")].map((n) => n.textContent)).toEqual(["运行", "用量", "位置"]);
    // 会话 ID / 路径可点复制，且长值换行不省略
    expect($("info-body").querySelector('[data-copy="' + SESSION + '"]')).toBeTruthy();
    expect($("info-body").querySelector(".row-value.wrap")).toBeTruthy();
    // 右上角 ✕ 能关
    $("info-close").click();
    await waitFor(() => $("info").hidden);

    // 点弹框外部关闭
    $("info").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => $("info").hidden);
  });
});

describe("副标题的状态点", () => {
  test("会话在跑时，项目名旁边出现呼吸点", async () => {
    const app = await bootApp({
      routes: {
        "/m/api/workspaces": () => jsonRes({
          workspaces: [WORKSPACE],
          sessions: [{ sessionId: SESSION, updatedAt: Date.now(), running: true, cwd: "/tmp/proj", projections: { values: { title: "测试会话" } } }],
        }),
      },
    });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => $("chat-sub").querySelector(".sub-dot"));
    expect($("chat-sub").querySelector(".sub-name").textContent).toBe("Proj");
  });
});

describe("输入区的「+」", () => {
  test("图标是加号；按下时不抢输入框焦点，选完把焦点还回去", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);

    // 加号：只有一条 path（M12 5v14M5 12h14），没有图片那种 rect/circle
    const svg = $("btn-attach").querySelector("svg");
    expect(svg.querySelectorAll("rect, circle").length).toBe(0);
    expect(svg.querySelector("path").getAttribute("d")).toContain("M12 5v14");

    // 输入框聚焦 → 按「+」：pointerdown 的默认行为被拦（不会失焦）
    $("input").focus();
    const ev = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    $("btn-attach").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($("input"));

    // 从选择器返回（change）后，焦点被还回输入框
    $("input").blur();
    Object.defineProperty($("file-input"), "files", { value: [], configurable: true });
    $("file-input").dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    expect(document.activeElement).toBe($("input"));
  });
});

describe("顶栏", () => {
  test("没有「已连接」胶囊；连接状态改在抽屉头部显示", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    expect(document.getElementById("conn-pill")).toBeNull();
    $("btn-menu").click();
    await waitFor(() => !$("drawer").hidden);
    // jsdom 里 WS 握手时序不定，断言"有内容且在抽屉里"即可（具体文案由真机验证）
    expect($("drawer-status").textContent.length).toBeGreaterThan(0);
    expect($("drawer-status").textContent).toContain("工作区");
    expect($("drawer-status").dataset.state).toBeTruthy();
  });
});

describe("调试浮层", () => {
  const panel = () => [...document.body.children].find((n) => n.classList?.contains("dbg"));

  test("有收起/关闭按钮：收起隐藏日志，关闭移除浮层", async () => {
    // 用 ?debug=1 打开（bootApp 的 URL 自带 debug=1）
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    const box = panel();
    expect(box).toBeTruthy();
    expect(box.querySelector('[data-dbg="toggle"]').textContent).toBe("收起");
    expect(box.querySelector(".dbg-body").textContent.length).toBeGreaterThan(0);

    // 收起 → 日志区隐藏，按钮变「展开」
    box.querySelector('[data-dbg="toggle"]').click();
    await waitFor(() => box.classList.contains("collapsed"));
    expect(box.querySelector('[data-dbg="toggle"]').textContent).toBe("展开");

    // 展开 → 恢复
    box.querySelector('[data-dbg="toggle"]').click();
    await waitFor(() => !box.classList.contains("collapsed"));

    // 关闭 → 整个浮层移除，并且写入"已关闭"标记（下次启动不再自动开）
    box.querySelector('[data-dbg="close"]').click();
    await waitFor(() => !panel());
    expect(window.localStorage.getItem("dsh-link-debug")).toBe("0");
  });
});

describe("图片占位", () => {
  const imageEvent = (seq) => ({
    type: "event",
    event: {
      ...ev("user/message", seq, {
        content: [{ type: "image", attachment: { attachmentId: "sha256:abc", mediaType: "image/png", name: "shot.png" } }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
  });

  test("未取到字节前用透明占位图，而不是没有 src（避免先闪破图）", async () => {
    const app = await bootApp({
      routes: {
        "/m/api/attachment": () => new Promise(() => {}),   // 一直挂起：停留在占位状态
      },
    });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 2, records: [imageEvent(1)] });
    await waitFor(() => document.querySelector("#messages img[data-attachment]"));

    const img = document.querySelector("#messages img[data-attachment]");
    expect(img.getAttribute("src")).toBeTruthy();
    expect(img.getAttribute("src").startsWith("data:image/gif")).toBe(true);
    expect(img.classList.contains("pending")).toBe(true);
  });

  test("取到字节后标记 data-ready 并换成 blob，避免重复抓取", async () => {
    let calls = 0;
    const app = await bootApp({
      routes: {
        "/m/api/attachment": () => {
          calls += 1;
          return jsonRes({ ok: true, attachment: { attachmentId: "sha256:abc", mediaType: "image/png" }, data: "aGVsbG8=" });
        },
      },
    });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 2, records: [imageEvent(1)] });
    await waitFor(() => document.querySelector("#messages img[data-attachment][data-ready]"));

    const img = document.querySelector("#messages img[data-attachment]");
    expect(img.dataset.ready).toBe("1");
    expect(img.classList.contains("pending")).toBe(false);
    const first = calls;
    await app.hook().hydrateAttachments();          // 再水合一次不应该重复请求
    expect(calls).toBe(first);
  });
});

describe("ask_user_question 卡片", () => {
  const ASK_ARGS = JSON.stringify({
    questions: [{
      id: "q1",
      header: "选择方案",
      question: "用哪种方式实现？",
      options: [
        { label: "方案 A", description: "改动小" },
        { label: "方案 B", description: "更彻底" },
      ],
    }],
  });
  const CALL_ID = "call_ask_1";
  const askCall = (seq) => ({ type: "event", event: ev("tool/call", seq, { turn: 1, step: 1, callId: CALL_ID, name: "ask_user_question", arguments: ASK_ARGS }) });
  const askResult = (seq, selected) => ({
    type: "event",
    event: ev("tool/result", seq, {
      turn: 1, step: 1,
      message: {
        role: "tool", toolCallId: CALL_ID, isError: false,
        content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "q1", selected }] }) }],
      },
    }),
  });
  const withAsk = (seq) => ({
    type: "event",
    event: ev("assistant/message", seq, {
      turn: 1, step: 1,
      message: { role: "assistant", content: [{ type: "tool-call", id: CALL_ID, name: "ask_user_question", arguments: ASK_ARGS }], source: { model: "m" } },
    }),
  });

  test("把问题、选项摊开渲染，而不是塞在 JSON 里", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());

    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 3, records: [withAsk(1), askCall(2)] });
    await waitFor(() => document.querySelector("#messages .ask"));

    const card = document.querySelector("#messages .ask");
    expect(card.classList.contains("pending")).toBe(true);
    expect(card.querySelector(".ask-badge").textContent).toContain("需要你选择");
    expect(card.querySelector(".ask-head").textContent).toBe("选择方案");
    expect(card.querySelector(".ask-title").textContent).toContain("用哪种方式实现");
    const opts = [...card.querySelectorAll(".ask-opt")];
    expect(opts.map((o) => o.querySelector(".ask-label").textContent)).toEqual(["方案 A", "方案 B"]);
    expect(opts[0].querySelector(".ask-desc").textContent).toBe("改动小");
    // 不应再出现原始 JSON 的工具卡
    expect(document.querySelector("#messages details.tool")).toBeNull();
  });

  test("回执到达后标出被选中的选项并锁定其余选项", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());

    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 3, records: [withAsk(1), askCall(2)] });
    await waitFor(() => document.querySelector("#messages .ask.pending"));
    app.socket().pushFrame(SESSION, askResult(3, ["方案 B"]));

    await waitFor(() => document.querySelector("#messages .ask.done"));
    const card = document.querySelector("#messages .ask");
    const opts = [...card.querySelectorAll(".ask-opt")];
    expect(opts[1].classList.contains("picked")).toBe(true);
    expect(opts[1].querySelector(".ask-mark").textContent).toBe("✓");
    expect(opts[0].classList.contains("picked")).toBe(false);
    expect(opts[0].classList.contains("readonly")).toBe(true);   // 纯展示，不可点
    expect(card.querySelector(".ask-foot").textContent).toContain("已完成选择");
    expect(card.querySelector(".ask-opt").tagName).toBe("DIV");   // 不是 button，不会误导点击
  });

  test("待答时自动弹层；先选后发，且不碰输入框", async () => {
    const app = await bootApp({ routes: { "/m/api/prompt": () => jsonRes({ ok: true, accepted: true }) } });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());

    // 先空快照（历史里没有这个提问），再实时推入 → 只有"新到"的才弹层
    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 3, records: [] });
    app.socket().pushFrame(SESSION, askCall(2));
    await waitFor(() => !$("ask").hidden, 2000);              // 自动弹出
    const opts = [...$("ask-body").querySelectorAll("[data-ask-pick]")];
    expect(opts.map((o) => o.querySelector(".ask-label").textContent)).toEqual(["方案 A", "方案 B"]);

    const send = $("ask-foot").querySelector("#ask-send");
    expect(send.disabled).toBe(true);                         // 没选之前不能发

    opts[1].click();                                          // 只选中，不发送
    expect(app.callsTo("/m/api/prompt").length).toBe(0);
    expect(opts[1].classList.contains("picked")).toBe(true);
    expect(opts[0].classList.contains("picked")).toBe(false);
    expect(send.disabled).toBe(false);
    expect($("input").value).toBe("");                        // 关键：不往输入框里塞字

    send.click();
    await waitFor(() => app.callsTo("/m/api/prompt").length === 1);
    expect(app.callsTo("/m/api/prompt")[0].body.text).toBe("方案 B");
    await waitFor(() => $("ask").hidden);                      // 发送后收起
    expect($("input").value).toBe("");
  });

  test("走官方 answer 接口：带 callId 和 answers，不再发消息", async () => {
    const app = await bootApp({
      routes: {
        "/m/api/answer": (req) => jsonRes({ ok: true, accepted: true }),
        "/m/api/prompt": () => jsonRes({ ok: true, accepted: true }),
      },
    });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    // 先空快照（历史里没有这个提问），再实时推入 → 只有"新到"的才弹层
    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 3, records: [] });
    app.socket().pushFrame(SESSION, askCall(2));
    await waitFor(() => !$("ask").hidden, 2000);

    $("ask-body").querySelector('[data-ask-pick="方案 A"]').click();
    $("ask-foot").querySelector("#ask-send").click();
    await waitFor(() => app.callsTo("/m/api/answer").length === 1);

    const body = app.callsTo("/m/api/answer")[0].body;
    expect(body.callId).toBe("call_ask_1");
    expect(body.sessionId).toBe(SESSION);
    expect(body.answers).toEqual([{ id: "q1", selected: ["方案 A"] }]);
    expect(app.callsTo("/m/api/prompt").length).toBe(0);      // 不再走发消息
    await waitFor(() => $("ask").hidden);
  });

  test("多选问题可以选多项", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    const args = JSON.stringify({ questions: [{ id: "q1", header: "功能", question: "要哪些？", multiSelect: true,
      options: [{ label: "甲" }, { label: "乙" }, { label: "丙" }] }] });
    app.socket().pushFrame(SESSION, {
      type: "snapshot", cursor: 3,
      records: [],
    });
    app.socket().pushFrame(SESSION, { type: "event", event: ev("tool/call", 2, { turn: 1, step: 1, callId: "call_multi_sel", name: "ask_user_question", arguments: args }) });
    await waitFor(() => !$("ask").hidden, 2000);

    const q = (label) => $("ask-body").querySelector('[data-ask-pick="' + label + '"]');
    q("甲").click(); q("丙").click();
    expect(q("甲").classList.contains("picked")).toBe(true);
    expect(q("丙").classList.contains("picked")).toBe(true);
    expect(q("乙").classList.contains("picked")).toBe(false);
    expect(q("甲").querySelector(".ask-mark").classList.contains("box")).toBe(true);   // 方框=多选
    q("甲").click();                                          // 再点取消
    expect(q("甲").classList.contains("picked")).toBe(false);
    expect(q("丙").classList.contains("picked")).toBe(true);
  });

  test("接口不可用（404）时退回发消息", async () => {
    const app = await bootApp({ routes: { "/m/api/prompt": () => jsonRes({ ok: true, accepted: true }) } });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    // 先空快照（历史里没有这个提问），再实时推入 → 只有"新到"的才弹层
    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 3, records: [] });
    app.socket().pushFrame(SESSION, askCall(2));
    await waitFor(() => !$("ask").hidden, 2000);
    $("ask-body").querySelector('[data-ask-pick="方案 B"]').click();
    $("ask-foot").querySelector("#ask-send").click();
    await waitFor(() => app.callsTo("/m/api/prompt").length === 1);
    expect(app.callsTo("/m/api/prompt")[0].body.text).toBe("方案 B");
  });

  test("多个问题时，每个都要选才允许发送", async () => {
    const app = await bootApp({ routes: { "/m/api/prompt": () => jsonRes({ ok: true, accepted: true }) } });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    const args = JSON.stringify({
      questions: [
        { id: "q1", header: "颜色", question: "要哪个颜色？", options: [{ label: "红" }, { label: "蓝" }] },
        { id: "q2", header: "尺寸", question: "要多大？", options: [{ label: "大" }, { label: "小" }] },
      ],
    });
    app.socket().pushFrame(SESSION, {
      type: "snapshot", cursor: 3,
      records: [],
    });
    app.socket().pushFrame(SESSION, { type: "event", event: ev("tool/call", 2, { turn: 1, step: 1, callId: "call_multi", name: "ask_user_question", arguments: args }) });
    await waitFor(() => !$("ask").hidden, 2000);
    const send = $("ask-foot").querySelector("#ask-send");
    expect($("ask-body").querySelectorAll(".ask-q").length).toBe(2);

    $("ask-body").querySelector('[data-ask-q="q1"][data-ask-pick="红"]').click();
    expect(send.disabled).toBe(true);                          // 只答了一个
    $("ask-body").querySelector('[data-ask-q="q2"][data-ask-pick="大"]').click();
    expect(send.disabled).toBe(false);

    send.click();
    await waitFor(() => app.callsTo("/m/api/prompt").length === 1);
    expect(app.callsTo("/m/api/prompt")[0].body.text).toBe("颜色：红\n尺寸：大");
  });

  test("答案回来后不再弹层", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    // 先空快照（历史里没有这个提问），再实时推入 → 只有"新到"的才弹层
    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 3, records: [] });
    app.socket().pushFrame(SESSION, askCall(2));
    await waitFor(() => !$("ask").hidden, 2000);

    app.socket().pushFrame(SESSION, askResult(3, ["方案 A"]));
    await waitFor(() => $("ask").hidden, 2000);
    expect($("ask").hidden).toBe(true);                       // 关键：结果回来后不再弹出
    expect(app.hook().t.calls.get("call_ask_1").result).toBeTruthy();
  });

  test("卡片上的「回答」打开弹层（历史提问也能手动进入）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());

    app.socket().pushFrame(SESSION, { type: "snapshot", cursor: 3, records: [withAsk(1), askCall(2)] });
    await waitFor(() => document.querySelector("#messages .ask.pending"));
    expect($("ask").hidden).toBe(true);                       // 历史里的不自动弹

    document.querySelector("#messages .ask-open").click();     // 点「回答」
    await waitFor(() => !$("ask").hidden);
    expect($("ask-body").querySelectorAll("[data-ask-pick]").length).toBe(2);
  });

  test("密钥失效(401) → 回到密钥门并说明原因，不谎报网络问题", async () => {
    const app = await bootApp({ routes: { "/m/api/ping": () => jsonRes({ ok: false }, 401) } });
    await waitFor(() => !$("gate").hidden);
    expect($("gate-error").hidden).toBe(false);
    expect($("gate-error").textContent).toContain("已失效");
    expect($("main").hidden).toBe(true);
    // 不应该继续去拉会话列表
    expect(app.callsTo("/m/api/workspaces").length).toBe(0);
  });

  test("无密钥且服务端要求密钥 → 停在门禁，不发数据请求", async () => {
    const app = await bootApp({ key: null, routes: { "/m/api/ping": () => jsonRes({ ok: false }, 401) } });
    await waitFor(() => !$("gate").hidden);
    expect(app.callsTo("/m/api/workspaces").length).toBe(0);
  });
});

describe("快照渲染", () => {
  test("用户气泡 / Markdown 正文 / 工具卡 / 思考块都渲染出来", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());

    app.socket().pushFrame(SESSION, {
      type: "snapshot",
      cursor: 5,
      hasMore: false,
      records: [
        EVENTS.user(1, "**你好**"),
        EVENTS.assistant(2, [
          { type: "reasoning", text: "先想一下" },
          { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls -la","description":"列目录"}' },
        ]),
        EVENTS.toolCall(3, "c1", "bash", '{"command":"ls -la"}'),
        EVENTS.toolResult(4, "c1", "a.txt\nb.txt"),
        EVENTS.assistant(5, [{ type: "text", text: "看完了\n\n- 一项\n- 两项" }]),
      ],
    });

    await waitFor(() => turns().length >= 3);

    const userBubble = document.querySelector(".turn.user .bubble");
    expect(userBubble.querySelector("strong")?.textContent).toBe("你好");

    const reasoning = document.querySelector(".reasoning");
    expect(reasoning).toBeTruthy();
    expect(reasoning.querySelector("summary").textContent).toContain("思考");

    const tool = document.querySelector(".tool");
    expect(tool).toBeTruthy();
    expect(tool.dataset.status).toBe("ok");             // 结果已回来 → 对勾
    expect(tool.querySelector(".tool-name").textContent).toBe("bash");
    // 摘要取命令本身（durable 的 tool/call 是权威参数，覆盖了助手消息里那份）
    expect(tool.querySelector(".tool-arg").textContent).toContain("ls -la");
    // 展开后有参数区与结果区
    const body = tool.querySelector(".tool-body").textContent;
    expect(body).toContain("ls -la");
    expect(body).toContain("a.txt");

    const items = turns(".turn.assistant .prose li");
    expect(items.map((li) => li.textContent)).toEqual(["一项", "两项"]);
  });

  test("工具结果失败 → 卡片标红", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    app.socket().pushFrame(SESSION, {
      type: "snapshot",
      cursor: 3,
      records: [
        EVENTS.assistant(1, [{ type: "tool-call", id: "c9", name: "bash", arguments: "{}" }]),
        EVENTS.toolResult(2, "c9", "boom", true),
      ],
    });
    await waitFor(() => document.querySelector('.tool[data-status="err"]'));
    expect(document.querySelector(".tool").dataset.status).toBe("err");
  });
});

describe("实时流", () => {
  test("host 的**双层包装** assistant-stream 帧能驱动流式正文（回归）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    const ws = app.socket();

    ws.pushFrame(SESSION, { type: "snapshot", cursor: 1, records: [EVENTS.user(1, "在吗")] });
    await waitFor(() => turns().length === 1);

    // 关键：{type:"assistant-stream", frame:{type:"chunk", attemptId, chunk}} —— 少剥一层就全丢
    ws.pushFrame(SESSION, { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: 0, time: 1, chunk: { type: "block-start", index: 0, blockType: "text" } } });
    ws.pushFrame(SESSION, { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: 1, time: 2, chunk: { type: "text-delta", index: 0, text: "正在" } } });
    ws.pushFrame(SESSION, { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: 2, time: 3, chunk: { type: "text-delta", index: 0, text: "回答" } } });

    await waitFor(() => document.querySelector('#messages .turn[data-key^="live:"]'));
    await waitFor(() => document.querySelector('#messages .turn[data-key^="live:"] .prose')?.textContent.includes("正在回答"));
    expect(document.querySelector('#messages .turn[data-key^="live:"] .cursor')).toBeTruthy();
  });

  test("durable 的 assistant/message 到达后接管流式条目，不出现两份", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    const ws = app.socket();

    ws.pushFrame(SESSION, { type: "snapshot", cursor: 1, records: [EVENTS.user(1, "在吗")] });
    ws.pushFrame(SESSION, { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: 0, time: 1, chunk: { type: "block-start", index: 0, blockType: "text" } } });
    ws.pushFrame(SESSION, { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: 1, time: 2, chunk: { type: "text-delta", index: 0, text: "半截" } } });
    await waitFor(() => document.querySelector('#messages .turn[data-key^="live:"]'));

    ws.pushFrame(SESSION, EVENTS.assistant(9, [{ type: "text", text: "完整回答" }]));
    await waitFor(() => document.querySelector('#messages .turn[data-key="a:9"]'));

    expect(document.querySelector('#messages .turn[data-key^="live:"]')).toBeNull();
    const texts = turns(".turn.assistant .prose").map((n) => n.textContent);
    expect(texts.filter((t) => t.includes("完整回答")).length).toBe(1);
    expect(texts.some((t) => t.includes("半截"))).toBe(false);
  });
});

describe("侧边栏", () => {
  /** 打开抽屉并等索引真正到位（renderDrawer 依赖 state.sessions）。 */
  const openDrawer = async (app, minItems = 1) => {
    $("btn-menu").click();
    await waitFor(() => document.querySelectorAll("#drawer-list .item").length >= minItems);
    return $("drawer");
  };
  const groups = () => [...document.querySelectorAll("#drawer-list .ws-group")];
  const items = () => [...document.querySelectorAll("#drawer-list .item")];

  test("分组标题、计数与「其它会话」都渲染出来", async () => {
    const app = await bootApp({
      routes: {
        "/m/api/workspaces": () => jsonRes({
          workspaces: [WORKSPACE, { id: "ws2", path: "/tmp/other-proj", title: "other-proj", sessionIds: [] }],
          sessions: [
            { sessionId: SESSION, updatedAt: Date.now(), running: true, cwd: "/tmp/proj", projections: { values: { title: "会话甲" } } },
            { sessionId: "session-orphan", updatedAt: Date.now() - 3600e3, cwd: "/tmp", projections: { values: { title: "无主会话" } } },
          ],
        }),
      },
    });
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 2);

    expect(groups().length).toBe(2);
    expect(groups()[0].querySelector(".ws-name").textContent).toBe("Proj");
    expect(groups()[0].querySelector(".ws-count").textContent).toBe("1");
    expect(document.querySelector("#drawer-list .ws-section").textContent).toContain("其它会话");
    expect(items().map((n) => n.querySelector(".label").textContent)).toEqual(["会话甲", "无主会话"]);
    expect(document.querySelector("#drawer-list .item .run")).toBeTruthy();   // 运行中红点
  });

  test("路径只在有歧义（末段重名/与标题不符）时出现", async () => {
    const app = await bootApp({
      routes: {
        "/m/api/workspaces": () => jsonRes({
          workspaces: [
            { id: "a", path: "/Users/me/work/app", title: "app", sessionIds: [] },
            { id: "b", path: "/Users/me/oss/app", title: "app", sessionIds: [] },   // 末段重名 → 两个都显示路径
            { id: "c", path: "/tmp/only", title: "我的项目", sessionIds: [] },      // 标题≠末段 → 显示
          ],
          sessions: [],
        }),
      },
    });
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 0);                              // 这组工作区没有会话，不按条目数等待
    await waitFor(() => groups().length === 3);
    const paths = [...document.querySelectorAll("#drawer-list .ws-path")].map((n) => n.textContent);
    expect(paths).toEqual(["…/work/app", "…/oss/app", "tmp/only"]);
  });

  test("折叠后该组的会话收起，再次点击展开", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await openDrawer(app);
    const head = groups()[0].querySelector(".ws-head");

    head.click();
    await waitFor(() => groups()[0].classList.contains("collapsed"));
    head.click();
    await waitFor(() => !groups()[0].classList.contains("collapsed"));
  });

  test("筛选：匹配会话标题所在工作区，清空按钮跟着出现", async () => {
    const app = await bootApp({
      routes: {
        "/m/api/workspaces": () => jsonRes({
          workspaces: [WORKSPACE, { id: "ws2", path: "/tmp/other-proj", title: "other-proj", sessionIds: ["s-x"] }],
          sessions: [
            { sessionId: SESSION, updatedAt: Date.now(), cwd: "/tmp/proj", projections: { values: { title: "会话甲" } } },
            { sessionId: "s-x", updatedAt: Date.now(), cwd: "/tmp/other-proj", projections: { values: { title: "会话乙" } } },
          ],
        }),
      },
    });
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 2);

    $("drawer-filter").value = "乙";
    $("drawer-filter").dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => items().length === 1);
    expect(items()[0].querySelector(".label").textContent).toBe("会话乙");
    expect(groups().length).toBe(1);                       // 没命中的工作区整组隐藏
    expect($("drawer-filter-clear").hidden).toBe(false);

    $("drawer-filter-clear").click();
    await waitFor(() => items().length === 2);
    expect($("drawer-filter").value).toBe("");
    expect($("drawer-filter-clear").hidden).toBe(true);
  });

  /** 模拟一次拖拽（jsdom 没有 PointerEvent，用 MouseEvent 带坐标即可）。 */
  function firePointer(type, x, y) {
    document.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }
  /** 快滑：几步内甩完，速度远高于阈值 → 按"甩动方向"决定开合。
      （每步留几毫秒：jsdom 里同一轮派发的时间戳可能完全相同，会退化成慢拖） */
  async function swipe(fromX, fromY, toX, toY, steps = 4, stepDelay = 6) {
    firePointer("pointerdown", fromX, fromY);
    for (let i = 1; i <= steps; i += 1) {
      await new Promise((r) => setTimeout(r, stepDelay));
      firePointer("pointermove", fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps);
    }
    firePointer("pointerup", toX, toY);
  }
  /** 慢拖：每步之间留时间，速度低 → 按"拖了多远"决定开合。 */
  async function swipeSlow(fromX, fromY, toX, toY, steps = 4, stepDelay = 70) {
    firePointer("pointerdown", fromX, fromY);
    for (let i = 1; i <= steps; i += 1) {
      await new Promise((r) => setTimeout(r, stepDelay));
      firePointer("pointermove", fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps);
    }
    firePointer("pointerup", toX, toY);
  }

  test("从左缘右滑超过阈值 → 打开抽屉", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    expect($("drawer").hidden).toBe(true);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    await swipe(6, 400, 260, 408);
    expect($("drawer").hidden).toBe(false);          // 拖动过程中就已可见
    await waitFor(() => !$("drawer").classList.contains("settling"), 1500);
    await waitFor(() => $("drawer").style.transform === "");
    expect($("scrim").hidden).toBe(false);
  });

  test("从左缘右滑不够 → 回弹关闭", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    await swipeSlow(6, 400, 70, 402);                // 慢慢拖了 64px（不到 35%）
    expect($("drawer").hidden).toBe(false);          // 拖动时可见
    await waitFor(() => $("drawer").hidden, 1500);   // 松手后吸附回关闭
    expect($("scrim").hidden).toBe(true);
  });

  test("快速短滑也生效：一甩就开，不用拖过半屏", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    await swipe(4, 400, 74, 404);                          // 只滑 70px，但很快
    await waitFor(() => !$("drawer").hidden, 1500);
    await waitFor(() => !$("drawer").classList.contains("settling"), 1500);
    expect($("drawer").hidden).toBe(false);
    expect($("scrim").hidden).toBe(false);
  });

  test("打开状态下快速左甩 → 立即关闭（哪怕只甩了一点）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 1);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    await swipe(120, 500, 40, 502);                        // 距离很短，但速度高
    await waitFor(() => $("drawer").hidden, 1500);
    expect($("scrim").hidden).toBe(true);
  });

  test("起手不在左缘 → 不触发（避免误开）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await swipe(120, 400, 360, 402);
    expect($("drawer").hidden).toBe(true);
  });

  test("纵向滑动 → 让给列表滚动，不打开抽屉", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await swipe(6, 400, 20, 520);                          // 竖直为主
    expect($("drawer").hidden).toBe(true);
  });

  test("抽屉打开时左滑 → 关闭", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 1);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    await swipe(300, 500, 40, 505);
    await waitFor(() => $("drawer").hidden, 1500);
    expect($("scrim").hidden).toBe(true);
  });

  test("拖完那一下的 click 被吞掉（不会误切会话）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const opened = app.state ? null : null;
    await swipe(6, 400, 300, 402);
    const currentBefore = $("chat-title").textContent;
    // 浏览器在拖动结束后会补一个 click，落在抽屉条目上
    const item = document.querySelector("#drawer-list .item");
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 120));
    expect($("chat-title").textContent).toBe(currentBefore);
  });

  test("抽屉头是头像+状态，底部是「设置」入口", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 1);
    const head = document.querySelector("#drawer .drawer-head");
    expect(head.querySelector(".avatar img")).toBeTruthy();
    expect(head.querySelector(".drawer-brand").textContent).toBe("DSHLink");
    expect($("drawer-status").textContent).toContain("工作区");   // 已连接 · N 个工作区
    expect($("drawer").querySelector(".drawer-foot .act-label").textContent).toBe("设置");
    expect(document.getElementById("btn-logout")).toBeNull();      // 已从设置里移除
  });

  test("顶栏不再有「…」，设置里能看到本会话操作与外观", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    expect(document.getElementById("btn-more")).toBeNull();
    await openDrawer(app, 1);
    $("btn-settings").click();
    await waitFor(() => !$("settings").hidden);
    expect($("settings-origin").textContent).toContain("/m/");
    expect($("settings-status").textContent.length).toBeGreaterThan(0);
    const acts = [...document.querySelectorAll("#settings [data-act]")].map((b) => b.dataset.act);
    expect(acts).toEqual(["reload", "copy-id", "top"]);
    // 外观：iOS 设置页那种"行 + 当前值"，点一下循环
    expect(["跟随系统", "浅色", "深色"]).toContain($("theme-value").textContent);
    const beforeTheme = $("theme-value").textContent;
    $("row-theme").click();
    expect($("theme-value").textContent).not.toBe(beforeTheme);
    // 分组标题照着参考图
    expect([...document.querySelectorAll("#settings .set-label")].map((n) => n.textContent))
      .toEqual(["连接", "会话", "外观", "关于"]);
    // 打开设置时抽屉应当收起
    expect($("drawer").hidden).toBe(true);
  });

  test("设置页有右上角圆形关闭；点面板外也能关", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 1);
    $("btn-settings").click();
    await waitFor(() => !$("settings").hidden);

    // 点面板内部不关
    $("settings").querySelector(".page-head .page-title").click();
    await new Promise((r) => setTimeout(r, 80));
    expect($("settings").hidden).toBe(false);

    // 右上角 ✕ 关闭
    $("settings-close").click();
    await waitFor(() => $("settings").hidden);

    // 再开一次，点面板外（遮罩）关闭
    $("btn-settings").click();
    await waitFor(() => !$("settings").hidden);
    $("settings").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => $("settings").hidden);
  });

  test("设置面板下滑超过阈值 → 关闭；不足 → 回弹", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 1);
    $("btn-settings").click();
    await waitFor(() => !$("settings").hidden);

    const card = $("settings").querySelector(".sheet-card");
    const fire = (type, y) => card.dispatchEvent(new MouseEvent(type, { clientX: 100, clientY: y, bubbles: true, cancelable: true }));

    // ① 慢拖 20px → 回弹（必须留真实时间差，否则同一轮派发会被算成"快甩"）
    fire("pointerdown", 400);
    await new Promise((r) => setTimeout(r, 90));
    fire("pointermove", 420);
    await new Promise((r) => setTimeout(r, 90));
    fire("pointerup", 420);
    await waitFor(() => card.style.transform === "", 800);
    expect($("settings").hidden).toBe(false);

    // ② 下滑超过卡片 25% → 关闭
    fire("pointerdown", 300);
    for (let y = 320; y <= 700; y += 60) fire("pointermove", y);
    expect(card.style.transform).toContain("translateY");
    fire("pointerup", 700);
    await waitFor(() => $("settings").hidden, 1200);
    await waitFor(() => card.style.transform === "", 800);
  });

  test("设置面板向上拖不接管（让给内容滚动）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await openDrawer(app, 1);
    $("btn-settings").click();
    await waitFor(() => !$("settings").hidden);
    const card = $("settings").querySelector(".sheet-card");
    const fire = (type, y) => card.dispatchEvent(new MouseEvent(type, { clientX: 100, clientY: y, bubbles: true, cancelable: true }));
    fire("pointerdown", 600);
    fire("pointermove", 400);
    fire("pointerup", 400);
    await new Promise((r) => setTimeout(r, 120));
    expect(card.style.transform).toBe("");
    expect($("settings").hidden).toBe(false);
  });

  test("设置里点「回到顶部」后自动关闭", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    const m = $("messages");
    m.scrollTop = 500;
    await openDrawer(app, 1);
    $("btn-settings").click();
    await waitFor(() => !$("settings").hidden);
    $("settings").querySelector('[data-act="top"]').click();
    await waitFor(() => $("settings").hidden);
    expect(m.scrollTop).toBe(0);
  });

  test("「新建会话」行能打开选择器", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await openDrawer(app);
    const action = [...document.querySelectorAll("#drawer-list .drawer-action")][0];
    expect(action.querySelector(".act-label").textContent).toBe("新建会话");
    action.click();
    await waitFor(() => !$("picker").hidden);
  });
});

describe("视口与输入区状态", () => {
  /** 伪造可视区尺寸（jsdom 没有布局，只能自己造） */
  function fakeViewport({ innerHeight, visualHeight, offsetTop = 0, layoutHeight = innerHeight, standalone = false }) {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: layoutHeight });
    Object.defineProperty(window, "screen", { configurable: true, value: { height: innerHeight } });
    window.matchMedia = (q) => ({ matches: standalone && /standalone|fullscreen/.test(q), addEventListener() {}, removeEventListener() {} });
    window.visualViewport = {
      height: visualHeight, offsetTop, width: 390,
      addEventListener() {}, removeEventListener() {},
    };
  }

  test("地址栏收起后（可视区比布局视口大）主框架跟更大的那个，避免底部露白", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    fakeViewport({ innerHeight: 900, visualHeight: 900, layoutHeight: 812 });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-h")).toBe("900px");
    expect($("main").classList.contains("kb")).toBe(false);
  });

  test("加到主屏(standalone)时以屏幕高度兜底", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    fakeViewport({ innerHeight: 780, visualHeight: 780, layoutHeight: 780, standalone: true });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-h")).toBe("780px");
  });

  test("键盘弹出时精确贴合可视区并打上 .kb（否则输入框会被键盘挡住）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    fakeViewport({ innerHeight: 900, visualHeight: 460, layoutHeight: 900 });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-h")).toBe("460px");
    expect($("main").classList.contains("kb")).toBe(true);
  });

  test("turn/end 之后发送按钮恢复，不再卡在红色停止（回归）", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    const ws = app.socket();

    ws.pushFrame(SESSION, { type: "snapshot", cursor: 1, records: [EVENTS.user(1, "在吗")] });
    ws.pushFrame(SESSION, { type: "event", event: ev("turn/start", 2, { turn: 1 }) });
    ws.pushFrame(SESSION, { type: "event", event: ev("step/start", 3, { turn: 1, step: 1 }) });
    ws.pushFrame(SESSION, { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: 0, time: 1, chunk: { type: "block-start", index: 0, blockType: "text" } } });
    ws.pushFrame(SESSION, { type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", index: 1, time: 2, chunk: { type: "text-delta", index: 0, text: "回答" } } });

    await waitFor(() => !$("btn-stop").hidden);                 // 运行中：红色停止
    expect($("btn-send").hidden).toBe(true);
    expect($("composer-hint").textContent).toBe("");          // 运行中不再挂提示行
    // 等流式那一次的 rAF 落定再送 turn/end —— 否则挂起的 rAF 回调会顺手刷新按钮，
    // 把「先算状态后冻结」这个 bug 掩盖掉（真机上 rAF 早就跑完了）
    await waitFor(() => document.querySelector('#messages .turn[data-key^="live:"]'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    ws.pushFrame(SESSION, { type: "event", event: ev("turn/end", 9, { turn: 1, reason: { kind: "completed" } }) });

    await waitFor(() => !$("btn-send").hidden);                 // 结束后：恢复发送
    expect($("btn-stop").hidden).toBe(true);
    expect($("composer-hint").textContent).toBe("");
    // 冻结后的流式条目会保留（避免内容闪没），但不能再挂着"正在生成…"和光标
    const frozen = document.querySelector('#messages .turn[data-key^="live:"]');
    expect(frozen?.textContent).not.toContain("正在生成");
    expect(frozen?.querySelector(".cursor")).toBeNull();
  });

  test("重连拿到空闲会话的快照（仍带 assistantStream.revision）不能点亮停止按钮", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    const ws = app.socket();

    // 真实 host 的快照：空闲时也带 assistantStream:{revision}，最后一条是 turn/end
    ws.pushFrame(SESSION, {
      type: "snapshot",
      cursor: 12,
      hasMore: false,
      assistantStream: { revision: 47879 },
      records: [
        { type: "event", event: ev("turn/start", 8, { turn: 1 }) },
        { type: "event", event: { ...ev("user/message", 9, { content: [{ type: "text", text: "在吗" }], source: { kind: "user" } }), surfaceOp: "append" } },
        { type: "event", event: ev("turn/end", 12, { turn: 1, reason: { kind: "completed" } }) },
      ],
    });

    await waitFor(() => turns().length >= 1);
    expect($("btn-stop").hidden).toBe(true);            // 空闲：应该是发送按钮
    expect($("btn-send").hidden).toBe(false);
    expect(app.hook().t.running).toBe(false);

    // 再重连一次（同一份空闲快照），仍然不能被点亮
    ws.pushFrame(SESSION, {
      type: "snapshot",
      cursor: 12,
      hasMore: false,
      assistantStream: { revision: 47880 },
      records: [
        { type: "event", event: ev("turn/start", 8, { turn: 1 }) },
        { type: "event", event: ev("turn/end", 12, { turn: 1, reason: { kind: "completed" } }) },
      ],
    });
    await new Promise((r) => setTimeout(r, 60));
    expect($("btn-stop").hidden).toBe(true);
  });

  test("索引刷新发现会话已结束（漏掉 turn/end）时也把红按钮收回去", async () => {
    let running = true;
    const app = await bootApp({
      routes: {
        "/m/api/workspaces": () => jsonRes({
          workspaces: [WORKSPACE],
          sessions: [{ sessionId: SESSION, updatedAt: Date.now(), running, cwd: "/tmp/proj", projections: { values: { title: "测试会话" } } }],
        }),
      },
    });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    app.socket().pushFrame(SESSION, { type: "event", event: ev("turn/start", 2, { turn: 1 }) });
    await waitFor(() => !$("btn-stop").hidden);

    running = false;                                            // host 侧已经跑完了
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => !$("btn-send").hidden);
    expect($("btn-stop").hidden).toBe(true);
  });
});

describe("图片附件", () => {
  /** 造一个 File 塞进 <input type=file>（jsdom 里 files 是只读的，用 defineProperty） */
  function pickFile(name = "photo.jpg", type = "image/jpeg") {
    const file = new File([new Uint8Array([1, 2, 3])], name, { type });
    const input = $("file-input");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  test("选图后进入托盘，压缩走 canvas 失败时回退原图", async () => {
    const app = await bootApp();
    await waitFor(() => !$("main").hidden);
    pickFile();
    await waitFor(() => app.hook().state.attach.length === 1);

    const [item] = app.hook().state.attach;
    expect(item.name).toBe("photo.jpg");
    expect(item.base64.length).toBeGreaterThan(0);
    expect($("attach-tray").hidden).toBe(false);
    expect(document.querySelectorAll("#attach-tray .attach-item").length).toBe(1);

    // 点 × 可以移除
    document.querySelector("#attach-tray .attach-x").click();
    expect(app.hook().state.attach.length).toBe(0);
    expect($("attach-tray").hidden).toBe(true);
  });

  test("发送：图片内联进 prompt（不再先上传换收据）", async () => {
    const app = await bootApp({
      routes: { "/m/api/prompt": () => jsonRes({ ok: true, accepted: true }) },
    });
    await waitFor(() => !$("main").hidden);
    pickFile();
    await waitFor(() => app.hook().state.attach.length === 1);

    $("input").value = "这张图是什么？";
    $("composer").requestSubmit();
    await waitFor(() => app.callsTo("/m/api/prompt").length === 1);

    // 关键：不再走上传接口——走收据落库的是 type:"file"，官方附件接口读不回来
    expect(app.callsTo("/m/api/upload").length).toBe(0);
    const prompt = app.callsTo("/m/api/prompt")[0].body;
    expect(prompt.text).toBe("这张图是什么？");
    expect(Array.isArray(prompt.images)).toBe(true);
    expect(prompt.images.length).toBe(1);
    expect(prompt.images[0].name).toBe("photo.jpg");
    expect(String(prompt.images[0].mediaType)).toContain("image/");
    expect(typeof prompt.images[0].data).toBe("string");
    expect(prompt.images[0].data.length).toBeGreaterThan(0);
    expect(prompt.receiptIds).toBeUndefined();

    // 乐观气泡立刻带本地预览，托盘清空
    const bubble = document.querySelector(".turn.user .attach-img");
    expect(bubble?.getAttribute("src")?.startsWith("data:")).toBe(true);
    expect($("attach-tray").hidden).toBe(true);
  });

  test("发送失败 → 提示可读原因，且图片回到托盘", async () => {
    const app = await bootApp({
      routes: { "/m/api/prompt": () => jsonRes({ ok: false, error: "图太大" }, 400) },
    });
    await waitFor(() => !$("main").hidden);
    pickFile();
    await waitFor(() => app.hook().state.attach.length === 1);

    $("input").value = "带图";
    $("composer").requestSubmit();
    await waitFor(() => !$("toast").hidden);

    expect($("toast").textContent).toContain("发送失败");
    expect(app.hook().state.attach.length).toBe(1);       // 图片回托盘，不用重挑
    expect($("attach-tray").hidden).toBe(false);
  });

  test("旧版 host 下附件接口 404：只探一次并降级为文件名标签", async () => {
    const app = await bootApp({
      routes: { "/m/api/attachment": () => jsonRes({ ok: false }, 404) },
    });
    await waitFor(() => !$("main").hidden);
    await waitFor(() => app.socket());
    app.socket().pushFrame(SESSION, {
      type: "snapshot",
      cursor: 2,
      records: [
        {
          type: "event",
          event: {
            ...ev("user/message", 1, {
              content: [{ type: "image", attachment: { attachmentId: "sha256:abc", mediaType: "image/png", name: "shot.png" } }],
              source: { kind: "user" },
            }),
            surfaceOp: "append",
          },
        },
      ],
    });

    await waitFor(() => document.querySelector("#messages .attach-chip"));
    await app.hook().hydrateAttachments();
    expect(document.querySelector("#messages .attach-chip").textContent).toContain("shot.png");
    // 只探一次：再渲染一轮不应该再打接口
    const before = app.callsTo("/m/api/attachment").length;
    app.hook().renderAll();
    await app.hook().hydrateAttachments();
    expect(app.callsTo("/m/api/attachment").length).toBe(before);
    expect(document.querySelectorAll("#messages img[data-attachment]").length).toBe(0);
  });
});
