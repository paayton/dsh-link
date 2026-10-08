/* DSH Link · 移动端 H5 客户端
 *
 * 纯静态、无依赖。鉴权 = 连接密钥（localStorage 自动保存）。
 * 与桌面版 host 插件通过 /m/api/* 通信，会话历史与流式都走一条 WebSocket
 * （`follow`），更早的历史用 HTTP 分页补齐。
 *
 * 结构：
 *   历史/实时事件 ──> transcript.js（纯归约） ──> 本文件的渲染层
 *   Markdown 正文 ──> md.js（纯函数）
 */
import { renderMarkdown, escapeHtml } from "./md.js";
import * as md from "./md.js";
import {
  createTranscript, resetTranscript, applyEvent, applyChunk,
  applySnapshot, prependPage, freezeLive,
} from "./transcript.js";

// ── 调试浮层：手机上直接显示错误与关键步骤 ──
// 开启方式：URL 加 ?debug=1，或**点抽屉顶部「DSH Link」5 下**（加到主屏后 URL 是固定书签，
// 带不了参数，而且独立 App 的存储在 iOS 上和 Safari 是分开的，所以必须给个 App 内开关）。
const DEBUG_STORAGE = "dsh-link-debug";
let DEBUG = /[?&]debug=1/.test(location.search) || (() => { try { return localStorage.getItem(DEBUG_STORAGE) === "1"; } catch { return false; } })();
// 浮层贴顶显示：探针场景下不能让它挡住底部的排查对象
let DEBUG_TOP = /[?&]probe=1/.test(location.search) || DEBUG;
let dbgBox = null;
let probeTimer = 0;
let lastProbe = "";
let dbgBody = null;

/** 关掉调试浮层（右上角 ✕ 与"点品牌名 5 下"共用）。 */
function disableDebug() {
  DEBUG = false;
  try { localStorage.setItem(DEBUG_STORAGE, "0"); } catch { /* ignore */ }
  dbgBox?.remove();
  dbgBox = null;
  dbgBody = null;
  lastProbe = "";
}

function dbg(msg) {
  if (!DEBUG) return;
  if (!dbgBox) {
    dbgBox = document.createElement("div");
    dbgBox.className = `dbg ${DEBUG_TOP ? "top" : "bottom"}`;
    dbgBox.innerHTML = '<div class="dbg-head">'
      + '<span class="dbg-title">调试</span>'
      + '<button class="dbg-btn" type="button" data-dbg="toggle">收起</button>'
      + '<button class="dbg-btn dbg-close" type="button" data-dbg="close" aria-label="关闭调试">✕</button>'
      + '</div><div class="dbg-body"></div>';
    (document.body || document.documentElement).appendChild(dbgBox);
    dbgBody = dbgBox.querySelector(".dbg-body");
    dbgBox.addEventListener("click", (ev) => {
      const act = ev.target?.closest?.("[data-dbg]")?.dataset?.dbg;
      if (act === "toggle") {
        const collapsed = dbgBox.classList.toggle("collapsed");
        dbgBox.querySelector('[data-dbg="toggle"]').textContent = collapsed ? "展开" : "收起";
      } else if (act === "close") {
        disableDebug();
      }
    });
  }
  dbgBody.textContent += `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
  if (!dbgBox.classList.contains("collapsed")) dbgBody.scrollTop = dbgBody.scrollHeight;
}
window.addEventListener("error", (e) => dbg("ERROR: " + (e.message || e.error) + " @" + (e.filename || "") + ":" + (e.lineno || "")));
window.addEventListener("unhandledrejection", (e) => dbg("REJECT: " + (e.reason && e.reason.message ? e.reason.message : e.reason)));

const KEY_STORAGE = "dsh-link-key";
const THEME_STORAGE = "dsh-link-theme";
const SESSION_STORAGE = "dsh-link-session";
const PAGE_SIZE = 50;
const HEARTBEAT_MS = 25000;
const VERSION_POLL_MS = 5 * 60 * 1000;
// 手机上先把图片缩到长边 1568px / JPEG 0.85 再传：一张 4MB 的原图通常降到 200~400KB，
// 既省流量也让 agent 端读图更快；解码失败或已经很小就原样上传。
const IMAGE_MAX_EDGE = 1568;
const IMAGE_QUALITY = 0.85;
const IMAGE_KEEP_UNDER = 600 * 1024;

const API = {
  ping: "/m/api/ping",
  verify: "/m/api/verify",
  workspaces: "/m/api/workspaces",
  messages: "/m/api/messages",
  sessions: "/m/api/sessions",
  prompt: "/m/api/prompt",
  cancel: "/m/api/cancel",
  upload: "/m/api/upload",
  answer: "/m/api/answer",
  attachment: "/m/api/attachment",
  stream: "/m/api/stream",
};

// ───────────────────────── 状态 ─────────────────────────
let key = "";
try { key = localStorage.getItem(KEY_STORAGE) || ""; } catch { /* 隐私模式 */ }

const t = createTranscript();
const state = {
  workspaces: [],
  sessions: [],
  titles: new Map(),   // sessionId -> title
  current: null,
  ws: null,
  wsReady: false,
  wsQueue: [],
  gen: 0,
  following: null,
  followedOnSocket: null,
  reconnectTimer: 0,
  reconnectDelay: 800,
  heartbeat: 0,
  historyTimer: 0,
  pinned: true,
  unread: 0,
  filter: "",
  collapsed: new Set(),
  theme: "auto",
  connText: "",
  askPicks: {},
  askArmed: false,
  askDismissed: null,
  lastSentAt: 0,
  toolExpand: new Set(),
  attach: [],       // 待发送的图片：{id, name, dataUrl, base64, bytes, width, height, status}
  uploading: false,
};
try { state.theme = localStorage.getItem(THEME_STORAGE) || "auto"; } catch { /* ignore */ }

const itemEls = new Map(); // itemKey -> HTMLElement

// ───────────────────────── DOM ─────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  gate: $("gate"), gateInput: $("gate-input"), gateSubmit: $("gate-submit"),
  gateError: $("gate-error"), gateSub: $("gate-sub"), gateOrigin: $("gate-origin"),
  main: $("main"),
  title: $("chat-title"), sub: $("chat-sub"),
  drawer: $("drawer"), scrim: $("scrim"), drawerList: $("drawer-list"), drawerFilter: $("drawer-filter"),
  filterClear: $("drawer-filter-clear"),
  messages: $("messages"), input: $("input"), composer: $("composer"),
  send: $("btn-send"), stop: $("btn-stop"), hint: $("composer-hint"),
  toBottom: $("btn-bottom"), badge: $("bottom-badge"),
  attachTray: $("attach-tray"), fileInput: $("file-input"), attachBtn: $("btn-attach"),
  picker: $("picker"), pickerList: $("picker-list"), drawerStatus: $("drawer-status"),
  info: $("info"), infoBody: $("info-body"), ask: $("ask"), askBody: $("ask-body"), askFoot: $("ask-foot"),
  settings: $("settings"),
  toast: $("toast"),
};

// ───────────────────────── 工具 ─────────────────────────
let toastTimer = 0;
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      // 无用户手势时这个 Promise 可能既不 resolve 也不 reject，超时后走兜底
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 400)),
      ]);
      return true;
    }
  } catch { /* 继续兜底 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

function fmtClock(ts) {
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(n)) return "";
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${n} tokens`;
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k tokens`;
  return `${(n / 1e6).toFixed(1)}M tokens`;
}

function relTime(ts) {
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(n)) return "";
  const d = Date.now() - n;
  if (d < 60e3) return "刚刚";
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} 天前`;
  const date = new Date(n);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function truncate(s, n) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// ───────────────────────── 请求 ─────────────────────────
async function request(url, { method = "GET", body, allow401 = false } = {}) {
  const headers = {};
  if (key) headers["X-Dsh-Link-Key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  if (res.status === 401 && !allow401) {
    showGate("密钥无效或已失效，请重新输入");
    throw new Error("unauthorized");
  }
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok && !allow401) throw new Error((data && data.error) || (data && data.message) || `HTTP ${res.status}`);
  return { status: res.status, ok: res.ok, data };
}

// ───────────────────────── 视图：主题 / 视口 ─────────────────────────
function applyTheme() {
  const root = document.documentElement;
  if (state.theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", state.theme);
  const labels = { auto: "跟随系统", light: "浅色", dark: "深色" };
  const value = document.getElementById("theme-value");
  if (value) value.textContent = labels[state.theme] || labels.auto;
  // 状态栏（非 translucent 样式）取 theme-color：跟着我们的主题走，而不是只跟系统走
  const dark = state.theme === "dark"
    || (state.theme === "auto" && window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
  const meta = document.getElementById("theme-color");
  if (meta) meta.setAttribute("content", dark ? "#0b0f16" : "#f6f7f9");
}

// 系统主题变化时（theme=auto）同步状态栏颜色
try {
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
    if (state.theme === "auto") applyTheme();
  });
} catch { /* ignore */ }

/**
 * 视口同步：只在「软键盘/视觉视口真的把可视区压小」时才把 .main 钉到
 * `--app-h/--app-top`（iOS 上键盘不会改变布局视口，必须手动贴）。
 * 键盘收起后立刻撤掉这两个变量，交回 CSS 的 100dvh——
 * 曾经因为变量残留，输入框下面会留一条空白。
 */
function syncViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  const layoutH = document.documentElement.clientHeight || window.innerHeight;

  if (!vv) {
    root.setProperty("--app-h", `${Math.round(layoutH)}px`);
    root.setProperty("--app-top", "0px");
    el.main.classList.remove("kb");
  } else {
    const shrunk = window.innerHeight - vv.height;
    const keyboardOpen = shrunk > 80 || vv.offsetTop > 0;
    if (keyboardOpen) {
      // 键盘弹出：iOS 上布局视口不变、只有可视区变矮，必须精确贴合
      root.setProperty("--app-h", `${Math.round(vv.height)}px`);
      root.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
      el.main.classList.add("kb");
    } else {
      // 键盘收起：取「布局视口」和「可视区」的较大值。
      // ⚠️ 绝不要拿 screen.height 当地板：iOS 独立模式（black-translucent）实测
      // screen=874 而 layoutViewport=812（正好差一条状态栏 62px），页面画不到那 62px。
      // 按 screen 铺只会把输入框推到画不出来的地方（实测 composerBottom=874 > 可绘制区）。
      root.setProperty("--app-h", `${Math.round(Math.max(layoutH, vv.height))}px`);
      root.setProperty("--app-top", "0px");
      el.main.classList.remove("kb");
    }
  }
  if (state.pinned) scrollToBottom(true);
  syncComposerHeight();      // 键盘/安全区变化会改输入区高度，按钮要跟着挪
  updateStreamUI();          // 键盘弹起=正在输入 → 显示发送而不是停止
}


/** 真机视口指标一行（?debug=1 时打出来，按屏幕截图读数用）。 */
function probeLine() {
  const vv = window.visualViewport;
  const measure = (css) => {
    const el = document.createElement("div");
    el.style.cssText = `position:fixed;left:-9999px;top:0;width:0;${css}`;
    (document.body || document.documentElement).appendChild(el);
    const h = Math.round(el.getBoundingClientRect().height);
    el.remove();
    return h;
  };
  const cs = getComputedStyle(document.documentElement);
  return [
    `VIEW inner=${window.innerHeight}`,
    `vv=${vv ? Math.round(vv.height) : "-"}`,
    `vvTop=${vv ? Math.round(vv.offsetTop) : "-"}`,
    `lay=${document.documentElement.clientHeight}`,
    `100vh=${measure("height:100vh")}`,
    `100dvh=${measure("height:100dvh")}`,
    `screen=${window.screen?.height}x${window.screen?.width}`,
    `dpr=${window.devicePixelRatio}`,
    `safeT=${measure("height:env(safe-area-inset-top,0px)")}`,
    `safeB=${measure("height:env(safe-area-inset-bottom,0px)")}`,
    `appH=${cs.getPropertyValue("--app-h").trim() || "-"}`,
    `scrH=${cs.getPropertyValue("--screen-h").trim() || "-"}`,
    `standalone=${window.matchMedia?.("(display-mode: standalone)")?.matches}/${window.navigator.standalone === true}`,
    `mainH=${Math.round(el.main.getBoundingClientRect().height)}`,
    `composerBottom=${Math.round(el.composer.getBoundingClientRect().bottom)}`,
    `drawerBottom=${Math.round(el.drawer.getBoundingClientRect().bottom)}`,
    `docH=${Math.round(document.documentElement.getBoundingClientRect().height)}`,
  ].join(" ");
}

/** 点抽屉顶部品牌名 5 下：开关调试浮层（主屏 App 里唯一可行的入口）。 */
function installDebugGesture() {
  const brand = document.querySelector(".drawer-brand");
  if (!brand) return;
  let taps = 0;
  let timer = 0;
  brand.addEventListener("click", () => {
    taps += 1;
    clearTimeout(timer);
    timer = setTimeout(() => { taps = 0; }, 1500);
    if (taps < 5) return;
    taps = 0;
    DEBUG = !DEBUG;
    DEBUG_TOP = DEBUG;               // 手势开启时也贴顶，别挡住底部
    try { localStorage.setItem(DEBUG_STORAGE, DEBUG ? "1" : "0"); } catch { /* ignore */ }
    if (!DEBUG) { disableDebug(); return; }
    lastProbe = "";
    dbg("调试已开启 · 再点 5 下品牌名可关闭");
    probeSoon();
  });
}

/** 抽屉头部的状态行：连接状态 · 工作区数量 */
function updateDrawerStatus() {
  if (!el.drawerStatus) return;
  const conn = state.connText || "连接中…";
  const ws = state.workspaces.length;
  el.drawerStatus.textContent = ws ? `${conn} · ${ws} 个工作区` : conn;
  el.drawerStatus.dataset.state = state.connState || "on";
}

function setConn(name, text) {
  // 顶栏那个"已连接"胶囊已去掉：状态只在抽屉头部显示（点一下可手动重连）
  state.connState = name;
  state.connText = text;
  updateDrawerStatus();
}

function isRunning() {
  return Boolean(t.running || t.live);
}

// ───────────────────────── 密钥门 ─────────────────────────
function showGate(hint) {
  disconnectStream();
  el.main.hidden = true;
  el.gate.hidden = false;
  el.gateOrigin.textContent = location.origin;
  if (hint) {
    el.gateError.textContent = hint;
    el.gateError.hidden = false;
  } else {
    el.gateError.hidden = true;
  }
  setTimeout(() => el.gateInput.focus(), 60);
}

function hideGate() {
  el.gate.hidden = true;
  el.main.hidden = false;
  syncViewport();
}

function gateNote(msg, isErr) {
  el.gateError.textContent = msg;
  el.gateError.hidden = false;
  el.gateError.style.color = isErr ? "var(--danger)" : "var(--fg-dim)";
}

el.gateSubmit.addEventListener("click", async () => {
  const value = el.gateInput.value.trim();
  if (!value) { el.gateInput.focus(); gateNote("请先输入密钥", true); return; }
  el.gateSubmit.disabled = true;
  el.gateSubmit.textContent = "连接中…";
  gateNote("正在校验密钥…", false);
  try {
    const res = await request(API.verify, { method: "POST", body: { key: value }, allow401: true });
    if (!res.ok) { gateNote(`密钥不正确（服务端返回 ${res.status}）`, true); return; }
    key = value;
    try { localStorage.setItem(KEY_STORAGE, key); } catch { /* ignore */ }
    el.gateInput.value = "";
    gateNote("密钥正确，正在载入会话…", false);
    hideGate();
    await boot();
  } catch (err) {
    gateNote("连接失败：" + (err && err.message ? err.message : err), true);
  } finally {
    el.gateSubmit.disabled = false;
    el.gateSubmit.textContent = "连接";
  }
});

el.gateInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); el.gateSubmit.click(); }
});

// ───────────────────────── 抽屉 ─────────────────────────
/** iOS 独立模式（black-translucent）下布局视口比屏幕矮一条状态栏，那条带子页面画不到、
    只会露出 canvas 底色。抽屉/底部浮层是白底时，把 html/body 底色也切成白底，带子就隐形了。 */
function syncSurface() {
  const elevated = !el.drawer.hidden || !el.picker.hidden || !el.settings.hidden || !el.info.hidden || !el.ask.hidden;
  document.documentElement.classList.toggle("surface-elev", elevated);
}

function openDrawer(open) {
  clearTimeout(drawerSettleTimer);
  // 手势可能留下了内联的位移/透明度，正常开关时一并清掉，回到 CSS 定义的状态
  el.drawer.style.transform = "";
  el.scrim.style.opacity = "";
  el.drawer.classList.remove("dragging", "settling");
  el.scrim.classList.remove("dragging", "settling");
  // no-enter 只在真正关闭时清掉：手势打开后若立刻清掉，入场动画会重播一次（"闪一下"）
  if (!open) {
    el.drawer.classList.remove("no-enter");
    el.scrim.classList.remove("no-enter");
  }
  el.main.classList.remove("push-live");
  el.drawer.style.transition = "";
  el.scrim.style.transition = "";
  document.documentElement.style.setProperty("--push", open ? `${DRAWER_PUSH}px` : "0px");
  el.drawer.hidden = !open;
  el.scrim.hidden = !open;
  // 刻意不自动 focus 搜索框：真机上那会在拉开抽屉的瞬间顶出软键盘
  if (open) {
    updateFilterClear();
    probeSoon();
  }
  syncSurface();
}

/* ───────── 抽屉手势：左缘右滑打开 / 抽屉上左滑关闭 ─────────
   跟手拖动 + 速度判定（快滑不看距离）+ 距离/速度自适应的收尾动画。
   方向判定之前不接管，纵向滑动照常交给列表滚动。 */
const DRAWER_EDGE = 26;        // 距屏幕左缘多少像素内算"从边缘起手"
const DRAWER_SLOP = 8;         // 判定方向前允许的抖动
const DRAWER_FLICK = 0.45;     // px/ms：超过就算"快滑"，按方向决定开合
const DRAWER_MIN_MS = 150;     // 收尾动画时长下限
const DRAWER_MAX_MS = 320;     // 上限
const DRAWER_PUSH = 24;        // 主内容被"推开"的最大位移（视差）
let drawerDrag = null;
let drawerSettleTimer = 0;
let swallowClick = false;

function drawerWidth() {
  const w = el.drawer.getBoundingClientRect().width;
  return w || Math.min(window.innerWidth * 0.88, 344);
}

/** 最近 100ms 的平均速度（px/ms，正数向右）。停住不动再松手会被判为 0。 */
function drawerVelocity(drag) {
  const list = drag.samples;
  if (list.length < 2) return 0;
  const last = list[list.length - 1];
  let first = list[0];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (last.t - list[i].t > 100) break;
    first = list[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

function applyDrawerProgress(drag, offset) {
  const w = drag.w;
  const progress = Math.max(0, Math.min(1, 1 + offset / w));
  el.drawer.style.transform = `translateX(${offset}px)`;
  el.scrim.style.opacity = String(progress);
  // 主内容轻轻被推开（iOS 抽屉的层次感来源）
  document.documentElement.style.setProperty("--push", `${(progress * DRAWER_PUSH).toFixed(1)}px`);
}

function drawerPointerDown(e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const open = !el.drawer.hidden;
  const w = drawerWidth();
  // 起手就在控件上（按钮/label/输入框）就别当手势：☰ 正好在左缘手势区里，
  // 手指稍动一下就会被当成抽屉拖拽，点击被吞掉——这是"点不准"的主要来源。
  if (e.target?.closest?.("button, label, a, input, textarea, select, [role=button]")) return;
  // 关着：只有从左缘起手才可能拉开；开着：抽屉内或遮罩上都能划回去
  if (open ? e.clientX > w + 40 : e.clientX > DRAWER_EDGE) return;
  clearTimeout(drawerSettleTimer);
  drawerDrag = {
    open, x0: e.clientX, y0: e.clientY, w, decided: false,
    offset: open ? 0 : -w, samples: [{ x: e.clientX, t: e.timeStamp }],
  };
}

function drawerPointerMove(e) {
  const drag = drawerDrag;
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;

  if (!drag.decided) {
    if (Math.abs(dx) < DRAWER_SLOP && Math.abs(dy) < DRAWER_SLOP) return;
    if (Math.abs(dy) > Math.abs(dx)) { drawerDrag = null; return; }   // 纵向 → 让给滚动
    if (drag.open ? dx > 0 : dx < 0) { drawerDrag = null; return; }   // 方向反了 → 放弃
    drag.decided = true;
    el.drawer.hidden = false;
    el.scrim.hidden = false;
    el.drawer.classList.add("dragging", "no-enter");
    el.scrim.classList.add("dragging", "no-enter");
    el.main.classList.add("push-live");      // 拖动期间视差不要过渡，直接跟手
  }
  if (e.cancelable) e.preventDefault();

  drag.samples.push({ x: e.clientX, t: e.timeStamp });
  if (drag.samples.length > 6) drag.samples.shift();

  drag.offset = drag.open
    ? Math.min(0, Math.max(-drag.w, dx))                       // 已打开：从 0 往左
    : Math.max(-drag.w, Math.min(0, dx - drag.w));             // 已关闭：从 -w 往右
  applyDrawerProgress(drag, drag.offset);
}

function drawerPointerUp() {
  const drag = drawerDrag;
  drawerDrag = null;
  if (!drag || !drag.decided) return;

  const v = drawerVelocity(drag);                       // 正 = 还在往右
  const progress = Math.max(0, Math.min(1, 1 + drag.offset / drag.w));
  const flick = Math.abs(v) >= DRAWER_FLICK;
  // 快滑只看方向（短促一划就该生效）：往右甩=开、往左甩=关。
  // 慢拖才看拖了多远，两个模式的门槛不同（关到一半 vs 开过 35%）。
  const open = flick ? v > 0 : (drag.open ? progress < 0.5 : progress > 0.35);

  const target = open ? 0 : -drag.w;
  const remain = Math.abs(target - drag.offset);
  const speed = Math.max(Math.abs(v), 0.7);             // 慢拖时别把时长算到上限
  const duration = Math.round(Math.min(DRAWER_MAX_MS, Math.max(DRAWER_MIN_MS, remain / speed)));
  settleDrawer(open, duration, drag);

  // 拖完这一下不要再触发条目点击（否则松手会顺带切会话/关抽屉）
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 100);   // 只吞紧接着那一下，窗口大了会误吞正常点击
}

function settleDrawer(open, duration, drag) {
  const w = drag?.w ?? drawerWidth();
  el.drawer.classList.remove("dragging");
  el.scrim.classList.remove("dragging");
  el.drawer.classList.add("settling");      // 压住入场动画，避免和收尾过渡打架
  el.scrim.classList.add("settling");
  el.main.classList.remove("push-live");
  el.drawer.style.transition = `transform ${duration}ms ${open ? "cubic-bezier(.16,1,.3,1)" : "cubic-bezier(.32,0,.24,1)"}`;
  el.scrim.style.transition = `opacity ${duration}ms ease-out`;
  el.drawer.style.transform = `translateX(${open ? 0 : -w}px)`;
  el.scrim.style.opacity = open ? "1" : "0";
  document.documentElement.style.setProperty("--push", `${open ? DRAWER_PUSH : 0}px`);
  clearTimeout(drawerSettleTimer);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.drawer.removeEventListener("transitionend", onEnd);
    openDrawer(open);
  };
  const onEnd = (e) => { if (e.target === el.drawer && e.propertyName === "transform") finish(); };
  el.drawer.addEventListener("transitionend", onEnd);
  // 兜底：transitionend 偶尔不触发（元素被隐藏/被打断），给足余量
  drawerSettleTimer = setTimeout(finish, duration + 120);
}

document.addEventListener("pointerdown", drawerPointerDown, { capture: true, passive: true });
document.addEventListener("pointermove", drawerPointerMove, { capture: true, passive: false });
document.addEventListener("pointerup", drawerPointerUp, { capture: true });
document.addEventListener("pointercancel", drawerPointerUp, { capture: true });
// iOS 上真正能拦住滚动的是 touchmove 的 preventDefault（pointermove 不一定拦得住）
document.addEventListener("touchmove", (e) => {
  if (drawerDrag?.decided && e.cancelable) e.preventDefault();
}, { passive: false });
// 拖动结束时浏览器还会补一个 click，这里吞掉它
document.addEventListener("click", (e) => {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

function sessionTitle(s) {
  const fromProjection = s?.projections?.values?.title;
  const fromEvent = state.titles.get(s?.sessionId);
  const title = (typeof fromEvent === "string" && fromEvent.trim()) || (typeof fromProjection === "string" && fromProjection.trim());
  return title || s?.sessionId || "";
}

function workspaceOf(sessionId) {
  return state.workspaces.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId)) || null;
}

function renderDrawer() {
  const q = state.filter.trim().toLowerCase();
  const byId = new Map(state.sessions.map((s) => [s.sessionId, s]));
  // 先登记「被任何工作区认领过」的会话：它们不属于「其它会话」，
  // 否则筛选时被跳过的分组里的会话会漏到下面去，用户会看到不匹配的结果。
  const known = new Set();
  for (const ws of state.workspaces) {
    for (const id of Array.isArray(ws.sessionIds) ? ws.sessionIds : []) known.add(id);
  }
  const frag = document.createDocumentFragment();

  // 末段重名（如两个项目都叫 app）时才需要路径来区分；否则路径纯属噪音
  const tailCount = new Map();
  for (const ws of state.workspaces) {
    const tail = String(ws.path || "").split("/").filter(Boolean).pop() || "";
    if (tail) tailCount.set(tail.toLowerCase(), (tailCount.get(tail.toLowerCase()) || 0) + 1);
  }

  // 顶部固定一行「新建会话」：抽屉一拉开就能开新会话，不用先关掉再点顶栏
  frag.appendChild(drawerAction({
    icon: '<path d="M12 5v14M5 12h14"/>',
    label: "新建会话",
    onClick: openPicker,
  }));

  for (const ws of state.workspaces) {
    const ids = (Array.isArray(ws.sessionIds) ? ws.sessionIds : []).filter((id) => {
      if (!byId.has(id)) return false;
      if (!q) return true;
      return sessionTitle(byId.get(id)).toLowerCase().includes(q)
        || (ws.title || "").toLowerCase().includes(q)
        || (ws.path || "").toLowerCase().includes(q);
    });
    if (q && !ids.length) continue;

    const group = document.createElement("div");
    group.className = "ws-group" + (state.collapsed.has(ws.id) ? " collapsed" : "");

    // 整块（标题 + 路径）吸顶，滚动时始终知道自己在哪个工作区
    const bar = document.createElement("div");
    bar.className = "ws-bar";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "ws-head";
    head.innerHTML = '<span class="ws-caret"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span>';
    const name = document.createElement("span");
    name.className = "ws-name";
    name.textContent = ws.title || shortPath(ws.path) || "未命名工作区";
    const count = document.createElement("span");
    count.className = "ws-count";
    count.textContent = String(ids.length);
    head.append(name, count);
    head.addEventListener("click", () => {
      if (state.collapsed.has(ws.id)) state.collapsed.delete(ws.id);
      else state.collapsed.add(ws.id);
      renderDrawer();
    });
    bar.appendChild(head);

    const short = shortPath(ws.path);
    const lastSegment = String(ws.path || "").split("/").filter(Boolean).pop() || "";
    const titleMismatch = lastSegment.toLowerCase() !== String(ws.title || "").trim().toLowerCase();
    const ambiguous = (tailCount.get(lastSegment.toLowerCase()) || 0) > 1;
    if (short && (titleMismatch || ambiguous)) {
      const path = document.createElement("div");
      path.className = "ws-path";
      path.textContent = short;
      path.title = ws.path || "";
      bar.appendChild(path);
    }

    group.appendChild(bar);

    if (!ids.length) {
      const empty = document.createElement("div");
      empty.className = "ws-empty";
      empty.textContent = "暂无会话";
      group.appendChild(empty);
    }
    for (const id of ids) group.appendChild(sessionItem(byId.get(id)));
    frag.appendChild(group);
  }

  const orphans = state.sessions.filter((s) => {
    if (known.has(s.sessionId)) return false;
    if (!q) return true;
    return sessionTitle(s).toLowerCase().includes(q);
  });
  if (orphans.length) {
    const head = document.createElement("div");
    head.className = "ws-section";
    head.innerHTML = '<span>其它会话</span>';
    const count = document.createElement("span");
    count.className = "ws-count";
    count.textContent = String(orphans.length);
    head.appendChild(count);
    frag.appendChild(head);
    for (const s of orphans) frag.appendChild(sessionItem(s));
  }

  if (!state.workspaces.length && !state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = q ? "没有匹配的会话" : "还没有工作区。请先在桌面版里创建。";
    frag.appendChild(empty);
  }

  el.drawerList.replaceChildren(frag);
}

/** 抽屉里的一行「动作」（新建、清除密钥等），样式与普通条目区分开。 */
function drawerAction({ icon, label, onClick, danger = false }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "drawer-action" + (danger ? " danger" : "");
  row.innerHTML = `<span class="act-ico"><svg viewBox="0 0 24 24">${icon}</svg></span><span class="act-label"></span>`;
  row.querySelector(".act-label").textContent = label;
  row.addEventListener("click", onClick);
  return row;
}

/** 工作区路径只留最后两段：面板里够用，又不至于把整行塞满。 */
function shortPath(path) {
  const full = String(path || "");
  if (!full) return "";
  const parts = full.split("/").filter(Boolean);
  if (!parts.length) return full;
  return parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}

function sessionItem(s) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "item";
  if (s.sessionId === state.current) row.dataset.active = "1";
  if (s.running) row.dataset.running = "1";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = sessionTitle(s);
  row.appendChild(label);

  if (s.running) {
    const run = document.createElement("span");
    run.className = "run";
    run.title = "正在运行";
    row.appendChild(run);
  } else if (s.updatedAt) {
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = relTime(s.updatedAt);
    row.appendChild(meta);
  }
  row.addEventListener("click", () => { openDrawer(false); openSession(s.sessionId); });
  return row;
}

async function loadIndex() {
  const { data, status } = await request(API.workspaces);
  dbg(`loadIndex: ${status} ws=${(data?.workspaces || []).length} sessions=${(data?.sessions || []).length}`);
  state.workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
  state.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  updateDrawerStatus();
  for (const s of state.sessions) {
    const title = sessionTitle(s);
    if (title && !state.titles.has(s.sessionId)) state.titles.set(s.sessionId, title);
  }
  // 兜底：host 说会话没在跑、本地也没有流式条目时，把运行标志校正回来
  // （断线期间错过 turn/end 的话，停止按钮会一直红着）
  const currentSession = state.sessions.find((s) => s.sessionId === state.current);
  if (currentSession && currentSession.running === false && !t.live && t.running) {
    t.running = false;
    updateStreamUI();
  }
  renderDrawer();
  updateHeader();
}

// ───────────────────────── 头部 ─────────────────────────
/** 会话信息弹框：数据全来自会话 projections（/m/api/workspaces 已返回），无需额外接口。 */
function infoRowsHtml() {
  const s = state.infoSession || {};
  const v = s.projections?.values || {};

  const row = (label, value, opts = {}) => {
    if (value === undefined || value === null || value === "") return "";
    const cls = `row-value${opts.mono ? " mono" : ""}${opts.wrap ? " wrap" : ""}`;
    const attrs = opts.copy ? ` data-copy="${escapeHtml(String(value))}"` : "";
    return `<div class="set-row static"${attrs}><span class="row-label">${escapeHtml(label)}</span>`
      + `<span class="${cls}">${escapeHtml(String(value))}</span></div>`;
  };
  const group = (title, rows) => {
    const inner = rows.filter(Boolean).join("");
    return inner ? `<div class="set-label">${escapeHtml(title)}</div><div class="set-group">${inner}</div>` : "";
  };

  const members = Array.isArray(v.agentTeam?.members) ? v.agentTeam.members : [];
  const tasks = Array.isArray(v.agentTeam?.tasks) ? v.agentTeam.tasks.length : 0;
  const sel = v.modelSelection?.next || v.modelSelection?.lastUsed;
  const u = v.tokenUsage;
  const cp = v.contextPressure;
  const k = (n) => `${Math.round((n || 0) / 1000)}k`;

  const run = group("运行", [
    row("dsh 模式", v.agentPreset),
    row("智能体成员", members.length ? members.map((m) => m?.name || m?.role || "?").join("、") : "无"),
    row("后台任务", tasks || v.subagent ? `${tasks} 个任务${v.subagent ? " · 子智能体运行中" : ""}` : "无"),
    row("模型", sel ? `${sel.model}${sel.reasoningEffort ? ` · ${sel.reasoningEffort}` : ""}` : ""),
  ]);
  const usage = group("用量", [
    u ? row("Token", `输入 ${k(u.uncachedInputTokens)} · 输出 ${k(u.outputTokens)} · 缓存 ${k(u.cacheReadTokens)}`) : "",
    cp?.contextWindow ? row("上下文", `${k(cp.pressureTokens)} / ${k(cp.contextWindow)}`) : "",
  ]);
  const where = group("位置", [
    row("会话 ID", state.current, { mono: true, wrap: true, copy: true }),
    row("工作目录", s.cwd, { mono: true, wrap: true, copy: true }),
  ]);

  const html = run + usage + where;
  return html || '<div class="drawer-empty">暂无信息</div>';
}

function openInfo() {
  el.infoBody.innerHTML = infoRowsHtml();
  el.info.hidden = false;
  syncSurface();
}

function updateHeader() {
  const s = state.sessions.find((x) => x.sessionId === state.current);
  let title = state.titles.get(state.current) || t.title || (s ? sessionTitle(s) : "");
  if (!title) title = state.current ? "会话" : "DSH Link";
  el.title.textContent = title;

  // 副标题只留两样：项目名 + 执行状态点（其它信息都在右上角「…」的会话信息里）
  const ws = state.current ? workspaceOf(state.current) : null;
  const projName = ws?.title || (ws?.path ? shortPath(ws.path) : "");
  const busy = Boolean(s?.running) || isRunning();
  el.sub.innerHTML = (projName ? `<span class="sub-name">${escapeHtml(projName)}</span>` : "")
    + (busy ? '<span class="sub-dot" title="正在执行" aria-label="正在执行"></span>' : "");
  state.infoSession = s || null;

  document.title = state.current ? `${title} · DSH Link` : "DSH Link";
}

// ───────────────────────── 渲染：消息 ─────────────────────────
const TOOL_ICONS = {
  terminal: '<path d="M5 8l4 4-4 4M13 16h6"/>',
  file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2"/>',
  web: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.6 2.4 2.6 13.6 0 16M12 4c-2.6 2.4-2.6 13.6 0 16"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5L14 17"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.8M17 20a5 5 0 0 0-2-4"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
};

function toolFamily(name) {
  const n = String(name || "").toLowerCase();
  if (/bash|shell|pwsh|terminal|exec/.test(n)) return "terminal";
  if (/image/.test(n)) return "image";
  if (/read|write|edit|patch|fs_|file/.test(n)) return "file";
  if (/grep|glob|search|find/.test(n)) return "search";
  if (/web|fetch|http|url/.test(n)) return "web";
  if (/todo|plan|task|job/.test(n)) return "list";
  if (/subagent|team|workflow|agent|goal/.test(n)) return "users";
  return "box";
}

function parseArgs(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

function argSummary(name, raw) {
  const a = parseArgs(raw) || {};
  const n = String(name || "").toLowerCase();
  let out = "";
  if (/bash|shell|pwsh|terminal/.test(n)) out = a.description || a.command || "";
  else if (/grep|glob|search|find/.test(n)) out = [a.pattern, a.path].filter(Boolean).join(" · ") || a.query || "";
  else if (/read|write|edit|patch|fs_|file/.test(n)) out = a.file_path || a.path || "";
  else if (n.includes("web_fetch") || n.includes("fetch")) out = a.url || "";
  else if (n.includes("web_search") || n.includes("search_web")) out = [].concat(a.queries || a.query || []).join(" | ");
  else if (/subagent|team|workflow/.test(n)) out = a.description || a.name || a.task || "";
  else if (/todo|plan/.test(n)) out = "更新任务清单";
  else if (/skill/.test(n)) out = a.name || "";
  if (!out) {
    const first = Object.values(a).find((v) => typeof v === "string" && v.trim());
    out = typeof first === "string" ? first : String(raw || "");
  }
  return truncate(out, 140);
}

function prettyArgs(raw) {
  const parsed = parseArgs(raw);
  if (!parsed) return String(raw || "").trim();
  return JSON.stringify(parsed, null, 2);
}

/** ask_user_question 的专用卡片：把"选项"直接摊开，而不是塞在 JSON 里。 */
function askCardHtml(call) {
  const answers = call.answers || null;
  const pending = !answers;
  const blocks = call.ask.map((q) => {
    const chosen = answers?.[q.id] || [];
    // 只做展示：不再是可点按钮（交互统一在弹层里），避免"看着能点、点了没反应"
    const opts = (q.options || []).map((o) => {
      const picked = chosen.includes(o.label);
      const cls = `ask-opt readonly${picked ? " picked" : ""}`;
      return `<div class="${cls}">`
        + `<span class="ask-mark">${picked ? "✓" : ""}</span>`
        + `<span class="ask-text"><span class="ask-label">${escapeHtml(o.label)}</span>`
        + (o.description ? `<span class="ask-desc">${escapeHtml(o.description)}</span>` : "")
        + "</span></div>";
    }).join("");
    return '<div class="ask-q">'
      + (q.header ? `<div class="ask-head">${escapeHtml(q.header)}</div>` : "")
      + `<div class="ask-title prose">${renderMarkdown(q.question || "")}</div>`
      + (opts ? `<div class="ask-opts">${opts}</div>` : "")
      + "</div>";
  }).join("");
  const foot = pending
    ? '<div class="ask-foot"><span>还没回答</span>'
      + `<button type="button" class="ask-open" data-ask-open="${escapeHtml(call.id)}">回答</button></div>`
    : '<div class="ask-foot"><span>已完成选择</span></div>';
  return `<div class="ask${pending ? " pending" : " done"}" data-call="${escapeHtml(call.id)}">`
    + `<div class="ask-badge"><span class="ask-dot"></span>${pending ? "需要你选择" : "已完成选择"}</div>`
    + blocks + foot + "</div>";
}

function toolCardHtml(callId) {
  const call = t.calls.get(callId);
  if (!call) return "";
  if (call.ask) return askCardHtml(call);
  const status = call.result ? (call.result.isError ? "err" : "ok") : "run";
  const dur = call.result?.time && call.startedAt ? ` · ${fmtDur(call.result.time - call.startedAt)}` : "";
  const icon = TOOL_ICONS[toolFamily(call.name)] || TOOL_ICONS.box;
  const mark = status === "run"
    ? '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 1-8 8"/></svg>'
    : status === "ok"
      ? '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';

  const body = [`<div class="tool-sec"><div class="tool-sec-t">参数</div><pre>${escapeHtml(prettyArgs(call.args))}</pre></div>`];
  if (call.result) {
    const text = call.result.text || "";
    const mediaList = call.result.media || [];
    const media = mediaList.map((m) => `[附件] ${m.name || m.attachmentId || ""}`).join("\n");
    const thumbs = mediaList.length ? mediaGridHtml(mediaList) : "";
    body.push(
      `<div class="tool-sec"><div class="tool-sec-t">结果${call.result.isError ? "（失败）" : ""}</div>` +
      thumbs +
      `<pre>${escapeHtml([text, media].filter(Boolean).join("\n") || (thumbs ? "（图片）" : "（无输出）"))}</pre>` +
      (text.length > 1200 || text.split("\n").length > 24
        ? '<button type="button" class="tool-more" data-act="expand">展开全部</button>'
        : "") +
      "</div>",
    );
  }
  return (
    `<details class="tool" data-call="${escapeHtml(call.id)}" data-status="${status}">` +
    `<summary><span class="tool-ico"><svg viewBox="0 0 24 24">${icon}</svg></span>` +
    `<span class="tool-name">${escapeHtml(call.name)}</span>` +
    `<span class="tool-arg">${escapeHtml(argSummary(call.name, call.args))}</span>` +
    `<span class="tool-state">${mark}</span></summary>` +
    `<div class="tool-body">${body.join("")}</div>` +
    "</details>"
  );
}

function reasoningHtml(part, live) {
  const preview = truncate(part.text, 90);
  const label = live ? "思考中…" : "思考";
  return (
    `<details class="reasoning${live ? " live" : ""}">` +
    `<summary><span>${label}</span><span class="reasoning-preview">${escapeHtml(preview)}</span></summary>` +
    `<div class="reasoning-body prose">${renderMarkdown(part.text)}</div>` +
    "</details>"
  );
}

/* ─────────────────────── 图片附件 ─────────────────────── */

// 历史消息里的图片：`<img>` 带不了鉴权头，所以拿 JS 取字节再转 objectURL 缓存起来。
const attachmentUrls = new Map(); // "sessionId|attachmentId" -> objectURL（空串=失败）
// host 还是旧版（没挂 /m/api/attachment）时只撞一次 404 就收手，别每张图都去试
let attachmentApiState = "unknown"; // unknown | ok | unsupported

// 无 src 的 <img> 会被浏览器渲染成"破图"（还带 alt 文字）——历史图片在拿到字节前
// 就闪一下破图。用 1×1 透明 GIF 占位，视觉上就是骨架底色 + 呼吸动画。
const BLANK_PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function mediaGridHtml(media) {
  const cells = [];
  for (const m of media) {
    const label = escapeHtml(m.name || "图片");
    if (m.preview) {
      cells.push(`<img class="attach-img" src="${escapeHtml(m.preview)}" alt="${label}">`);
    } else if (m.attachmentId) {
      cells.push(`<img class="attach-img pending" src="${BLANK_PX}" alt="${label}" data-attachment="${escapeHtml(m.attachmentId)}" data-session="${escapeHtml(state.current || "")}">`);
    } else {
      cells.push(`<span class="attach-chip">${label}</span>`);
    }
  }
  return `<div class="attach-grid">${cells.join("")}</div>`;
}

function base64ToBlob(base64, type) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || "image/jpeg" });
}

// 失败不要永久缓存：刚发出的图，附件可能还没落盘，抓早了会 404。
// 这里给失败加一个短冷却（避免每个事件都重试），冷却过后允许再试。
const attachmentRetryAt = new Map();     // cacheKey -> 下次可重试的时间戳
const ATTACHMENT_RETRY_MS = 1500;

async function attachmentUrl(sessionId, attachmentId) {
  if (attachmentApiState === "unsupported") return "";
  const cacheKey = `${sessionId}|${attachmentId}`;
  if (attachmentUrls.has(cacheKey)) return attachmentUrls.get(cacheKey);
  if (Date.now() < (attachmentRetryAt.get(cacheKey) || 0)) return "";
  let url = "";
  try {
    const res = await fetch(`${API.attachment}?sessionId=${encodeURIComponent(sessionId)}&attachmentId=${encodeURIComponent(attachmentId)}`,
      { headers: key ? { "X-Dsh-Link-Key": key } : {}, cache: "force-cache" });
    if (res.status === 404 || res.status === 503) {
      attachmentApiState = "unsupported";   // 桌面版还没重载插件：这个版本就是没有回看接口
    } else if (res.ok) {
      attachmentApiState = "ok";
      const data = await res.json().catch(() => null);
      if (data?.data) url = URL.createObjectURL(base64ToBlob(data.data, data.attachment?.mediaType));
    }
  } catch { /* 网络异常按失败处理 */ }
  if (url) attachmentUrls.set(cacheKey, url);
  else attachmentRetryAt.set(cacheKey, Date.now() + ATTACHMENT_RETRY_MS);
  return url;
}

let hydrateScheduled = false;
function scheduleHydrate() {
  if (hydrateScheduled) return;
  hydrateScheduled = true;
  requestAnimationFrame(() => { hydrateScheduled = false; hydrateAttachments(); });
}

async function hydrateAttachments(root = el.messages) {
  const nodes = [...root.querySelectorAll("img[data-attachment]:not([data-ready])")];
  for (const img of nodes) {
    const attachmentId = img.getAttribute("data-attachment");
    const sessionId = img.getAttribute("data-session") || state.current;
    if (!attachmentId || !sessionId || img.dataset.loading === "1") continue;
    img.dataset.loading = "1";
    const url = await attachmentUrl(sessionId, attachmentId);
    if (url) {
      img.dataset.ready = "1";
      img.src = url;
      img.classList.remove("pending");
      return;
    }
    img.dataset.loading = "";
    const tries = Number(img.dataset.tries || 0) + 1;
    img.dataset.tries = String(tries);
    // 接口确实不存在（旧版 host）→ 立刻降级；否则先重试几次（附件可能还没落盘）
    const giveUp = attachmentApiState === "unsupported" || tries >= 3;
    if (!giveUp) {
      setTimeout(() => { hydrateAttachments(root).catch(() => {}); }, ATTACHMENT_RETRY_MS + 200);
      continue;
    }
    img.classList.remove("pending");
    const label = img.getAttribute("alt") || "图片";
    const text = attachmentApiState === "unsupported"
      ? `🖼 ${label}`                     // 旧版 host：不谎报失败，标出来源即可
      : `图片读取失败：${label}`;
    img.replaceWith(Object.assign(document.createElement("span"), { className: "attach-chip", textContent: text }));
  }
}

// 拿到 blob 也可能解码失败（损坏/非图片）：降级成文字标签，别留破图
el.messages.addEventListener("error", (e) => {
  const img = e.target;
  if (!img || img.tagName !== "IMG" || !img.dataset?.attachment) return;
  const label = img.getAttribute("alt") || "图片";
  img.replaceWith(Object.assign(document.createElement("span"), {
    className: "attach-chip",
    textContent: attachmentApiState === "unsupported" ? `🖼 ${label}` : `图片读取失败：${label}`,
  }));
}, true);

/* ─────────────────────── 选图 / 压缩 / 上传 ─────────────────────── */

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}

/** 长边超过 IMAGE_MAX_EDGE 就先在手机本地缩一遍，再上传。 */
async function prepareImage(file) {
  const raw = await readAsDataUrl(file);
  let dataUrl = raw;
  let width = 0;
  let height = 0;
  try {
    const img = await loadImage(raw);
    width = img.naturalWidth || img.width;
    height = img.naturalHeight || img.height;
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height));
    if (scale < 1 || raw.length > IMAGE_KEEP_UNDER) {
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
      width = w;
      height = h;
    }
  } catch { /* HEIC 等解不开的格式：原样上传，交给 host 判断 */ }
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name || "image.jpg",
    dataUrl,
    base64,
    bytes: Math.round(base64.length * 0.75),
    width,
    height,
    status: "ready",
  };
}

async function addAttachments(files) {
  const list = [...files];
  if (!list.length) return;
  for (const file of list) {
    const looksImage = /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(file.name || "");
    if (!looksImage) { toast("只支持图片"); continue; }
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name || "图片"} 超过 20MB`); continue; }
    try {
      state.attach.push(await prepareImage(file));
    } catch (err) {
      toast("读取图片失败：" + (err?.message || err));
    }
  }
  renderAttachTray();
  updateStreamUI();
}

function renderAttachTray() {
  const list = state.attach;
  el.attachTray.hidden = !list.length;
  if (!list.length) { el.attachTray.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  for (const a of list) {
    const chip = document.createElement("div");
    chip.className = "attach-item";
    const img = document.createElement("img");
    img.src = a.dataUrl;
    img.alt = a.name || "图片";
    const kill = document.createElement("button");
    kill.type = "button";
    kill.className = "attach-x";
    kill.setAttribute("aria-label", "移除图片");
    kill.textContent = "×";
    kill.addEventListener("click", () => {
      state.attach = state.attach.filter((x) => x.id !== a.id);
      renderAttachTray();
      updateStreamUI();
      saveDraft();
    });
    chip.append(img, kill);
    frag.appendChild(chip);
  }
  el.attachTray.replaceChildren(frag);
}

function itemInner(item) {
  if (item.kind === "user") {
    const cls = item.pending ? " pending" : item.failed ? " error" : "";
    const bits = [];
    if (item.media?.length) {
      bits.push(escapeHtml(item.media.map((m) => m.name || "[图片]").join("、")));
    }
    bits.push(item.pending ? "发送中…" : item.failed ? "发送失败" : fmtClock(item.time));
    const media = item.media?.length ? mediaGridHtml(item.media) : "";
    return `<div class="bubble${cls}">${media}${renderMarkdown(item.text)}</div>` +
      `<div class="msg-meta">${bits.map((m) => `<span>${m}</span>`).join("")}</div>`;
  }

  if (item.kind === "notice") {
    return escapeHtml(item.text);
  }

  // assistant
  const out = [];
  const parts = item.parts || [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.type === "reasoning") {
      const isLive = Boolean(item.live) && i === parts.length - 1;
      out.push(reasoningHtml(p, isLive));
    } else if (p.type === "text") {
      const isLive = Boolean(item.live) && i === parts.length - 1;
      out.push(`<div class="prose">${renderMarkdown(p.text)}${isLive ? '<span class="cursor"></span>' : ""}</div>`);
    } else if (p.type === "call") {
      out.push(toolCardHtml(p.id));
    }
  }
  if (!out.length && item.live) out.push('<div class="prose"><span class="cursor"></span></div>');

  const meta = [];
  if (item.live) {
    meta.push("正在生成…");
  } else {
    const textParts = item.parts?.filter((p) => p.type === "text") ?? [];
    if (item.model) meta.push(escapeHtml(item.model));
    // token 统计只挂在「有正文的回答」上，避免每个中间步骤都刷一行
    if (item.usage?.totalTokens && textParts.length) meta.push(fmtTokens(item.usage.totalTokens));
    if (item.time) meta.push(fmtClock(item.time));
    if (textParts.length) {
      const raw = textParts.map((p) => p.text).join("\n\n");
      meta.push(`<button type="button" data-copy-msg="${escapeHtml(raw)}">复制</button>`);
    }
  }
  return out.join("") + `<div class="msg-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>`;
}

function itemElFor(item) {
  const node = document.createElement("div");
  node.className = `turn ${item.kind}`;
  node.dataset.key = item.key;
  node.innerHTML = itemInner(item);
  return node;
}

function renderAll({ keepScroll = false } = {}) {
  const prevHeight = el.messages.scrollHeight;
  const prevTop = el.messages.scrollTop;
  itemEls.clear();
  const frag = document.createDocumentFragment();
  if (t.hasMore && t.items.length) frag.appendChild(olderRow());
  for (const item of t.items) {
    const node = itemElFor(item);
    itemEls.set(item.key, node);
    frag.appendChild(node);
  }
  el.messages.replaceChildren(frag);
  if (!t.items.length) addEmpty(emptyText());
  if (keepScroll) el.messages.scrollTop = el.messages.scrollHeight - prevHeight + prevTop;
  else scrollToBottom(true);
  updateUnreadBadge();
  scheduleHydrate();
}

/** 列表顶部的「加载更早的消息」行（跟着列表一起滚动，而不是钉在屏幕上）。 */
function olderRow() {
  const row = document.createElement("div");
  row.className = "older-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "btn-older";
  btn.className = "btn-ghost";
  btn.textContent = "加载更早的消息";
  btn.addEventListener("click", loadOlder);
  row.appendChild(btn);
  return row;
}

function syncOlderRow() {
  const existing = el.messages.querySelector(".older-row");
  if (t.hasMore && t.items.length) {
    if (!existing) el.messages.prepend(olderRow());
  } else if (existing) {
    existing.remove();
  }
}

function refreshItem(item) {
  if (!item) return;
  let node = itemEls.get(item.key);
  if (!node || !node.isConnected) {
    node = itemElFor(item);
    itemEls.set(item.key, node);
    el.messages.appendChild(node);
  } else {
    node.innerHTML = itemInner(item);
  }
  scheduleHydrate();
}

function removeItems(keys) {
  for (const k of keys || []) {
    const node = itemEls.get(k);
    if (node) { node.remove(); itemEls.delete(k); }
  }
}

function refreshCalls(callId) {
  const call = t.calls.get(callId);
  if (!call) return;
  for (const itemKey of call.items) refreshItem(t.byKey.get(itemKey));
}

function emptyText() {
  if (!state.current) {
    return state.workspaces.length
      ? "选择左侧边栏里的会话，<br>或者点右上角 <b>+</b> 新建一个。"
      : "桌面版里还没有工作区。";
  }
  return "还没有消息。<br>在下面输入框里发第一条吧。";
}

function addEmpty(html) {
  const box = document.createElement("div");
  box.className = "empty";
  box.innerHTML = html;
  el.messages.appendChild(box);
  return box;
}

function removeEmpty() {
  el.messages.querySelector(".empty")?.remove();
}

function showSkeleton() {
  el.messages.replaceChildren();
  itemEls.clear();
  const box = document.createElement("div");
  box.className = "skeleton";
  box.innerHTML = '<div class="sk-line w40"></div><div class="sk-line w90"></div><div class="sk-line w70"></div><div class="sk-line w90"></div>';
  el.messages.appendChild(box);
}

// ───────────────────────── 滚动 ─────────────────────────
function nearBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120;
}

function scrollToBottom(force) {
  if (force || state.pinned) {
    el.messages.scrollTop = el.messages.scrollHeight;
    state.pinned = true;
    state.unread = 0;
    updateUnreadBadge();
  }
}

/** 把输入区的实际高度写给 CSS，「回到底部」按钮据此贴着它上沿浮动。 */
function syncComposerHeight() {
  const h = Math.round(el.composer.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty("--composer-h", `${h}px`);
}

function updateUnreadBadge() {
  const show = !state.pinned && state.unread > 0;
  el.badge.hidden = !show;
  el.badge.textContent = state.unread > 99 ? "99+" : String(state.unread);
  el.toBottom.hidden = state.pinned && !show;
}

el.messages.addEventListener("scroll", () => {
  const near = nearBottom();
  if (near !== state.pinned) {
    state.pinned = near;
    if (near) state.unread = 0;
  }
  updateUnreadBadge();
}, { passive: true });

// 问题卡片的选项：不代答（回答要由桌面端写回待决的 tool call），只把选项填进输入框
// 会话卡片上的「回答」按钮：打开弹层（历史里不自动弹的提问，靠这里手动进入）
el.messages.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-ask-open]");
  if (!btn) return;
  const call = t.calls.get(btn.dataset.askOpen);
  if (!call?.ask) return;
  state.askShown = call.id;
  renderAskSheet(call);
  el.ask.hidden = false;
  syncSurface();
}, true);

el.messages.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-ask-opt]");
  if (!btn) return;
  const text = btn.dataset.askOpt || "";
  if (!text) return;
  el.input.value = text;
  autoGrow();
  el.input.focus();
  updateStreamUI();
  toast("已填进输入框 · 发送后 agent 下一轮收到");
});

el.toBottom.addEventListener("click", () => {
  state.unread = 0;
  state.pinned = true;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  updateUnreadBadge();
});

// ───────────────────────── 会话 ─────────────────────────
function resetForSession(sessionId) {
  resetTranscript(t);
  itemEls.clear();
  state.pinned = true;
  state.unread = 0;
  showSkeleton();
  updateStreamUI();
  updateUnreadBadge();
}

async function openSession(sessionId) {
  if (!sessionId) return;
  const prev = state.current;
  if (prev === sessionId && t.historyReady) { scrollToBottom(true); return; }
  if (prev && prev !== sessionId) unfollow(prev);
  state.current = sessionId;
  // 记住位置：自动升级 / 刷新 / 切后台回来都回到同一个会话，不跳走
  try { localStorage.setItem(SESSION_STORAGE, sessionId); } catch { /* ignore */ }
  resetForSession(sessionId);
  restoreDraft(sessionId);
  updateHeader();
  renderDrawer();
  dbg("openSession " + sessionId);

  ensureStream();
  follow(sessionId);

  clearTimeout(state.historyTimer);
  state.historyTimer = setTimeout(() => { if (!t.historyReady) loadHistoryHttp(sessionId); }, 3500);
}

async function loadHistoryHttp(sessionId) {
  try {
    const { data } = await request(`${API.messages}?sessionId=${encodeURIComponent(sessionId)}&maxMessages=${PAGE_SIZE}`);
    if (state.current !== sessionId || t.historyReady) return;
    applySnapshot(t, data?.records || [], { cursor: data?.cursor, hasMore: data?.hasMore });
    renderAll();
    updateStreamUI();
  } catch (err) {
    if (String(err?.message) !== "unauthorized") {
      el.messages.replaceChildren();
      addEmpty("加载失败：" + escapeHtml(String(err?.message || err)));
    }
  }
}

async function loadOlder() {
  const btn = () => el.messages.querySelector("#btn-older");
  if (!state.current || t.loadingOlder || !t.hasMore) return;
  t.loadingOlder = true;
  if (btn()) { btn().disabled = true; btn().textContent = "载入中…"; }
  const sessionId = state.current;
  const beforeSeq = Number.isFinite(t.firstSeq) ? t.firstSeq : null;
  try {
    const qs = new URLSearchParams({ sessionId, maxMessages: String(PAGE_SIZE) });
    // host 语义：beforeSeq = 想要「早于它」的消息（内部再 -1 取 throughSeq）
    if (beforeSeq !== null) qs.set("beforeSeq", String(beforeSeq));
    const { data } = await request(`${API.messages}?${qs}`);
    if (state.current !== sessionId) return;
    const { added } = prependPage(t, data?.records || []);
    t.hasMore = Boolean(data?.hasMore);
    if (added) renderAll({ keepScroll: true });
    else toast("没有更早的消息了");
  } catch (err) {
    if (String(err?.message) !== "unauthorized") toast("加载失败：" + String(err?.message || err));
  } finally {
    t.loadingOlder = false;
    if (btn()) { btn().disabled = false; btn().textContent = "加载更早的消息"; }
    syncOlderRow();
  }
}

// ───────────────────────── WebSocket ─────────────────────────
function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${API.stream}`;
}

function disconnectStream() {
  state.gen += 1;
  clearTimeout(state.reconnectTimer);
  clearInterval(state.heartbeat);
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch { /* ignore */ }
  }
  state.ws = null;
  state.wsReady = false;
  state.following = null;
  state.followedOnSocket = null;
  setConn("off", "未连接");
}

function ensureStream() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    if (state.current) follow(state.current);
    return;
  }
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING) return; // 等 onopen，别在这里递归 follow
  const gen = state.gen;
  setConn("busy", "连接中");
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  state.followedOnSocket = null;

  ws.onopen = () => {
    if (gen !== state.gen) { try { ws.close(); } catch { /* ignore */ } return; }
    state.wsReady = true;
    state.reconnectDelay = 800;
    state.followedOnSocket = null;
    setConn("on", "已连接");
    try { ws.send(JSON.stringify({ type: "auth", key })); } catch { /* ignore */ }
    for (const m of state.wsQueue.splice(0)) {
      try { ws.send(m); } catch { /* ignore */ }
      try { const p = JSON.parse(m); if (p.type === "follow") state.followedOnSocket = p.sessionId; } catch { /* ignore */ }
    }
    if (state.current) follow(state.current);
    clearInterval(state.heartbeat);
    state.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ } }
    }, HEARTBEAT_MS);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  };

  ws.onerror = () => { if (gen === state.gen) setConn("off", "连接异常"); };

  ws.onclose = (ev) => {
    if (gen !== state.gen) return;
    clearInterval(state.heartbeat);
    state.wsReady = false;
    state.ws = null;
    state.followedOnSocket = null;
    if (ev?.code === 4401) { showGate("密钥无效或已失效，请重新输入"); return; }
    setConn("off", "已断开");
    settleLive();
    if (state.current && !el.main.hidden) {
      const delay = Math.min(state.reconnectDelay, 8000);
      state.reconnectDelay = delay * 1.7;
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => { if (state.current && !state.ws) ensureStream(); }, delay);
    }
  };
}

function follow(sessionId) {
  if (!sessionId) return;
  state.following = sessionId;
  if (DEBUG) debugStats.follows = (debugStats.follows || 0) + 1;
  const payload = JSON.stringify({ type: "follow", sessionId });
  const ws = state.ws;

  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    queuePayload(payload);
    ensureStream();
    return;
  }
  if (ws.readyState === WebSocket.CONNECTING) { queuePayload(payload); return; }

  // 已经 follow 过同一会话就别再发：重复 follow 会让 host 反复重放快照基线，
  // 既浪费带宽，又会让正在流式的 live 条目被新基线打断。
  if (state.followedOnSocket === sessionId) return;
  state.followedOnSocket = sessionId;
  try { ws.send(payload); } catch { state.followedOnSocket = null; }
}

/** 待发队列按 payload 去重，防止重复 follow 堆积（旧实现会自我递归刷爆队列）。 */
function queuePayload(payload) {
  if (state.wsQueue.length > 16) state.wsQueue.length = 16;
  if (!state.wsQueue.includes(payload)) state.wsQueue.push(payload);
}

function unfollow(sessionId) {
  if (state.followedOnSocket === sessionId) state.followedOnSocket = null;
  if (!sessionId || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try { state.ws.send(JSON.stringify({ type: "unfollow", sessionId })); } catch { /* ignore */ }
}

function handleServerMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "opened") { setConn("on", "已连接"); return; }
  if (msg.type === "error") { dbg("server error: " + msg.message); return; }
  if (msg.type !== "frame") return;

  const frame = msg.frame;
  if (!frame) return;
  if (DEBUG) countFrame(frame);
  if (msg.sessionId && state.current && msg.sessionId !== state.current) {
    if (DEBUG) debugStats.dropped = (debugStats.dropped || 0) + 1;
    return;
  }

  if (frame.type === "snapshot") return onSnapshot(frame);
  if (frame.type === "assistant-stream") return onChunk(frame);
  if (frame.type === "event") return onEvent(frame.event ?? frame);
  if (frame.type === "end") {
    t.running = false;
    settleLive();
    updateHeader();
    return;
  }
  if (frame.type === "error") { toast(frame.message || "出错了"); return; }
}

function onSnapshot(frame) {
  const records = frame.records || [];
  let maxSeq = -1;
  for (const r of records) {
    const ev = r?.event ?? r;
    if (typeof ev?.seq === "number" && ev.seq > maxSeq) maxSeq = ev.seq;
  }
  clearTimeout(state.historyTimer);
  // ⚠️ host 的 snapshot 里**恒有** `assistantStream: { revision }` —— 空闲会话也带
  // （实测：空闲会话 lastEvent=turn/end 时依然是 `{revision: 47879}`）。
  // 因此**不能**拿它判断"是否在跑"：每次重连都会把状态点亮，而此后如果没有新的
  // turn/end，红色停止按钮就再也回不去。运行状态只由事件流推导
  // （turn/start → 跑，turn/end → 停），applyEvent/applySnapshot 已经处理好了。
  if (t.historyReady && t.items.length && maxSeq <= t.lastSeq) {
    t.hasMore = Boolean(frame.hasMore) || t.hasMore;
    syncOlderRow();
    return;
  }
  const { firstLoad, added } = applySnapshot(t, records, { cursor: frame.cursor, hasMore: frame.hasMore });
  if (firstLoad || added > 0) renderAll();
  else syncOlderRow();
  updateHeader();
  updateStreamUI();
  // 历史里的旧提问**不弹**：先把这一批标记为"看过了"，之后**新到**的提问才弹。
  if (!state.askArmed) {
    state.askArmed = true;
    const stale = pendingAsk();
    if (stale) state.askDismissed = stale.id;   // 历史里的旧提问不自动弹
  }
}

let liveDirty = false;
function scheduleLiveFlush() {
  if (liveDirty) return;
  liveDirty = true;
  requestAnimationFrame(() => {
    liveDirty = false;
    refreshLive();
    updateStreamUI();
  });
}

/** turn 结束/连接断开：把流式条目冻结成静态条目，并重绘它（去掉"正在生成…"与光标）。 */
function settleLive() {
  if (!t.live) { updateStreamUI(); return; }
  const key = freezeLive(t);
  if (key) refreshItem(t.byKey.get(key));
  updateStreamUI();
}

function refreshLive() {
  if (t.live) refreshItem(t.live.item);
}

function onChunk(frame) {
  const res = applyChunk(t, frame);
  if (DEBUG) debugStats.chunkApplied = (debugStats.chunkApplied || 0) + (res ? 1 : 0);
  if (!res) return;
  if (res.removed?.length) removeItems(res.removed);
  // 注意：流式分片**不**计数。一条回答能推上百个 chunk，按它加会让角标瞬间 99+，
  // 完全不是"有多少条新内容"的意思。未读只在成条的助手消息落地时 +1（见 onEvent）。
  scheduleLiveFlush();
}

function onEvent(ev) {
  if (!ev || typeof ev.type !== "string") return;
  const before = t.items.length;
  const res = applyEvent(t, ev);
  if (!res) return;
  if (res.removed?.length) removeItems(res.removed);

  // 顺序很重要：turn/end 时 `isRunning()` 是 t.running || t.live，
  // 必须先把流式条目冻结掉，否则会在 t.live 仍在的情况下算出 running=true，
  // 于是输入框一直是红色停止按钮，直到下一个事件才恢复。
  if (ev.type === "turn/end") settleLive();

  if (res.title) {
    if (state.current) state.titles.set(state.current, t.title);
    updateHeader();
    renderDrawer();
  }
  if (res.running) { updateStreamUI(); updateHeader(); }
  if (res.call) refreshCalls(res.call);

  for (const k of res.keys || []) {
    const item = t.byKey.get(k);
    if (!item) continue;
    if (!itemEls.has(k)) {
      removeEmpty();
      const node = itemElFor(item);
      itemEls.set(k, node);
      el.messages.appendChild(node);
      scrollToBottom(false);
    } else {
      refreshItem(item);
    }
  }
  // 未读 = 你离开底部期间新落地的助手消息条数（工具卡/思考块/流式分片都不算）。
  // 注意不能拿"条目数变没变"当条件：流式条目被成条消息接管时是一换一，数量不变。
  // 提问弹层：扫描"仍未作答"的提问；两个闸门见 maybeOpenAskSheet
  if (state.askArmed) maybeOpenAskSheet();
  if (ev.type === "assistant/message" && !state.pinned) {
    state.unread += 1;
    updateUnreadBadge();
  }
  if (t.items.length !== before) updateUnreadBadge();
}

// ───────────────────────── 输入区 ─────────────────────────
// 输入框随内容长高，但封顶在 ~160px / 28vh：再多就内部滚动，别把对话挤出屏幕
function composerMaxHeight() {
  return Math.min(160, Math.round(window.innerHeight * 0.28));
}

function autoGrow() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, composerMaxHeight())}px`;
}

function updateStreamUI() {
  const running = isRunning();
  const uploading = state.uploading;
  // 运行中默认显示"停止"；但**只要用户在输入**（聚焦/键盘弹起/已输入内容）就换成发送，
  // 这样"边跑边插话"可以一步发出，不用先停止。
  const composing = document.activeElement === el.input
    || el.main.classList.contains("kb")
    || el.input.value.trim().length > 0;
  const showSend = !running || composing;
  el.stop.hidden = showSend;
  el.send.hidden = !showSend;
  el.send.disabled = uploading;
  el.attachBtn.classList.toggle("disabled", uploading || !state.current);
  el.input.disabled = !state.current || uploading;
  el.input.placeholder = state.current ? (uploading ? "正在上传图片…" : running ? "可继续输入，回车插话…" : "发消息…") : "先选择一个会话";
  // 这行只在"有具体状态要说"时出现：上传中 / 已选图片。
  // 运行中不再挂一行「Agent 正在运行」——发送方式固定为插话，那行是噪音。
  el.hint.textContent = uploading
    ? "正在上传图片…"
    : state.attach.length ? `已选 ${state.attach.length} 张图片` : "";
  // 这行没有内容时就别占高度（去掉模式选择器后它经常是空的）
  const bar = el.hint.parentElement;
  if (bar) bar.hidden = !el.hint.textContent;
}

// 点「+」要打开系统选图，但**不能把输入框的键盘弄没**：
// pointerdown 拦一下默认行为，按钮就不会抢走输入框的焦点（否则一按键盘就收）；
// 系统选择器本身是模态的，回来后（change 或窗口重新获得焦点）再把焦点还给输入框。
let keepKeyboardForPicker = false;

/** 从系统选择器返回后：把焦点还给输入框，让键盘自己回来。 */
function restoreKeyboardAfterPicker() {
  if (!keepKeyboardForPicker) return;
  keepKeyboardForPicker = false;
  if (el.input.disabled) return;
  setTimeout(() => { try { el.input.focus(); } catch { /* ignore */ } }, 60);
}
// label 打开 file input 时，iOS 仍会把焦点转到那个（隐藏的）input 上，于是键盘掉。
// pointerdown 和 mousedown 都拦一下：焦点不动，输入框保持第一响应者，键盘就不会收。
function holdInputFocus(e) {
  keepKeyboardForPicker = document.activeElement === el.input;
  e.preventDefault();
}
el.attachBtn.addEventListener("pointerdown", holdInputFocus);
el.attachBtn.addEventListener("mousedown", holdInputFocus);
el.attachBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); }
});
window.addEventListener("focus", restoreKeyboardAfterPicker);
el.fileInput.addEventListener("change", () => {
  const files = [...(el.fileInput.files || [])];
  el.fileInput.value = "";   // 同一个文件连选两次也要能触发
  addAttachments(files);
  saveDraft();
  restoreKeyboardAfterPicker();
});

el.input.addEventListener("input", () => {
  autoGrow();
  saveDraft();
  updateStreamUI();      // 有内容时把"停止"换成"发送"
  // 之前因为正在写草稿而推迟的自动升级，草稿清空后立刻补上
  if (updatePending && !el.input.value.trim()) checkForUpdate(true);
});

// 粘贴直接进托盘：iOS 长按「粘贴」、桌面 Ctrl+V 都能发图，**完全绕开**系统那个
// 「照片图库 / 拍照 / 选取文件」菜单（那个菜单是 iOS 给的，页面跳不过去）。
el.input.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const files = items
    .filter((it) => it.kind === "file" && /^image\//.test(it.type))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;          // 纯文本粘贴走默认行为
  e.preventDefault();
  addAttachments(files);
});

// 聚焦/失焦也要换按钮：正在输入就能直接发（插话），收起键盘则回到"停止"。
// 真机上 focus 事件有时早于 activeElement 落定，所以再补两次延迟复算；
// 点击/按键也各算一次，不把行为绑死在 focus 这一个事件上。
function refreshComposerButton() { updateStreamUI(); }
el.input.addEventListener("focus", () => {
  refreshComposerButton();
  setTimeout(refreshComposerButton, 60);
  setTimeout(refreshComposerButton, 280);
});
el.input.addEventListener("blur", refreshComposerButton);
el.input.addEventListener("keydown", refreshComposerButton);
el.composer.addEventListener("click", refreshComposerButton);
el.composer.addEventListener("pointerup", refreshComposerButton);

el.input.addEventListener("keydown", (e) => {
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el.composer.requestSubmit(); return; }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); el.composer.requestSubmit(); }
});

el.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  submitPrompt();
});

/* ── 草稿暂存：弱网下发送失败、切会话、切后台回来，输入与待发图片都还在 ──
   只存"当前会话"的一份，且总量有上限（localStorage 配额有限，超了就当没存过）。 */
const DRAFT_STORAGE = "dsh-link-draft";
const DRAFT_MAX_BYTES = 1500 * 1000;

function saveDraftNow() {
  if (!state.current) return;
  const text = el.input.value;
  const attach = state.attach.map((a) => ({
    name: a.name, base64: a.base64, mediaType: a.mediaType,
    dataUrl: a.dataUrl, bytes: a.bytes, width: a.width, height: a.height,
  }));
  try {
    if (!text.trim() && !attach.length) { localStorage.removeItem(DRAFT_STORAGE); return; }
    const payload = JSON.stringify({ sessionId: state.current, text, attach, at: Date.now() });
    if (payload.length > DRAFT_MAX_BYTES) return;      // 太大就不存，别把配额撑爆
    localStorage.setItem(DRAFT_STORAGE, payload);
  } catch { /* 配额满/隐私模式：忽略 */ }
}

let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 300);          // 打字时别每键一次写盘
}

function clearDraft() {
  clearTimeout(draftTimer);
  try { localStorage.removeItem(DRAFT_STORAGE); } catch { /* ignore */ }
}

/** 切到某会话时把草稿放回输入区与托盘。 */
function restoreDraft(sessionId) {
  if (!sessionId) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DRAFT_STORAGE) || "null"); } catch { saved = null; }
  if (!saved || saved.sessionId !== sessionId) return;
  if (saved.text) { el.input.value = saved.text; autoGrow(); }
  if (Array.isArray(saved.attach) && saved.attach.length) {
    state.attach = saved.attach.map((a, i) => ({ id: `draft-${i}-${Date.now()}`, ...a, status: "ready" }));
    renderAttachTray();
  }
  updateStreamUI();
}

/* ── ask_user_question：待答时弹层一点即发 ──
   手机端没法把答案写回那个待决的 tool call，所以点选项 = 作为消息立刻发出（插话），
   而不是"只填进输入框让你再按一次发送"。 */
function pendingAsk() {
  // 直接扫 calls：ask 卡片可能是助手消息里的嵌套 part，不一定有独立的顶层 item
  let found = null;
  for (const call of t.calls.values()) {
    if (call.ask && !call.answers) found = call;
  }
  return found;
}

function renderAskSheet(call) {
  state.askPicks = {};
  const blocks = call.ask.map((q, qi) => {
    const opts = (q.options || []).map((o) => (
      '<button class="ask-opt big" type="button" data-ask-q="' + escapeHtml(q.id || String(qi))
      + '" data-ask-pick="' + escapeHtml(o.label) + '"'
      + (q.multiSelect ? ' data-ask-multi="1"' : "") + '>'
      + '<span class="ask-mark' + (q.multiSelect ? " box" : "") + '"></span>'
      + '<span class="ask-text"><span class="ask-label">' + escapeHtml(o.label) + "</span>"
      + (o.description ? '<span class="ask-desc">' + escapeHtml(o.description) + "</span>" : "")
      + "</span></button>"
    )).join("");
    // 选项必须在 .ask-q 里面：分组、样式、多选都按"每个问题"来
    return (q.header ? '<div class="set-label">' + escapeHtml(q.header) + "</div>" : "")
      + '<div class="ask-q">'
      + '<div class="ask-title prose">' + renderMarkdown(q.question || "") + "</div>"
      + '<div class="ask-opts">' + opts + "</div></div>";
  }).join("");
  el.askBody.innerHTML = blocks;
  // 发送区固定在弹层底部（不跟着内容滚、也不盖住最后一个选项）
  el.askFoot.innerHTML = '<div class="ask-foot">手机端不能直接写回提问，确认后会作为一条消息发出</div>'
    + '<button id="ask-send" class="ask-send" type="button" disabled>发送</button>';
  el.askFoot.querySelector("#ask-send").addEventListener("click", submitAskPicks);
  updateAskSendState(call);
}

/** 每个问题都要选一个，才允许发送。 */
function updateAskSendState(call) {
  const btn = el.askFoot.querySelector("#ask-send");
  if (!btn) return;
  const list = (call || pendingAsk())?.ask || [];
  const picks = state.askPicks || {};
  const answered = list.filter((q, qi) => (picks[q.id || String(qi)] || []).length > 0).length;
  btn.disabled = answered < list.length;
}

/** 选中的答案拼成一条消息，**走独立请求**——不碰输入框，避免把字留在草稿里。 */
async function submitAskPicks() {
  const call = pendingAsk();
  if (!call || !state.current) return;
  const lines = call.ask.map((q, qi) => {
    const picked = state.askPicks[q.id || String(qi)];
    if (!picked) return null;
    return call.ask.length > 1 && q.header ? `${q.header}：${picked}` : picked;
  }).filter(Boolean);
  if (lines.length !== call.ask.length) return;

  const btn = el.askFoot.querySelector("#ask-send");
  if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }

  // 正路：回答那个待决的 tool call（官方 userQuestions.answer）
  const answers = call.ask.map((q, qi) => ({ id: q.id || String(qi), selected: state.askPicks[q.id || String(qi)] || [] }))
    .filter((a) => a.selected.length);
  const viaTool = await request(API.answer, {
    method: "POST",
    body: { sessionId: state.current, callId: call.id, answers },
    allow401: true,
  });
  if (viaTool.status === 200 && viaTool.data?.ok !== false) {
    el.ask.hidden = true;
    syncSurface();
    toast("已提交");
    return;
  }
  const unsupported = viaTool.status === 404 || viaTool.status === 503;

  // 兜底：老 host / 接口缺失 / 提问已超时 → 退化成发一条消息（原来的行为）
  try {
    await request(API.prompt, {
      method: "POST",
      body: {
        sessionId: state.current,
        text: lines.join("\n"),
        mode: "steer",
        requestId: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    el.ask.hidden = true;
    syncSurface();
    toast(unsupported ? "桌面版未提供接口，已作为消息发出" : "已提交（追问模式）");
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "发送"; }
    toast("提交失败：" + String(err?.message || err));
  }
}

/** 点选项只做"选中"，不发送——避免误触把手滑的内容发出去。 */
el.askBody.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-ask-pick]");
  if (!btn) return;
  const qid = btn.dataset.askQ;
  const label = btn.dataset.askPick;
  const multi = btn.dataset.askMulti === "1";
  state.askPicks = state.askPicks || {};
  const cur = state.askPicks[qid] || [];
  state.askPicks[qid] = multi
    ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label])
    : [label];
  // 不用 CSS.escape 拼选择器（jsdom 里没有），直接遍历比对 data 属性
  for (const other of el.askBody.querySelectorAll("[data-ask-q]")) {
    if (other.dataset.askQ !== qid) continue;
    const on = state.askPicks[qid].includes(other.dataset.askPick);
    other.classList.toggle("picked", on);
    const mark = other.querySelector(".ask-mark");
    mark.textContent = on ? "✓" : "";
    mark.classList.toggle("box", multi);       // 多选显示成方框
  }
  updateAskSendState();
});

// 仅调试：用真实渲染函数核对"多问题"在浏览器里的实际排版
if (DEBUG) window.__dshAsk = (call) => { renderAskSheet(call); el.ask.hidden = false; syncSurface(); };

/**
 * 只有"新到的提问"才弹：
 * - `callId` 由事件路径传入（收到 ask_user_question 的 tool/call 时），历史快照不会触发；
 * - 同一个 callId 只弹一次，用户关掉后不再骚扰；
 * - 该提问的结果回来后由 onEvent 收起。
 */
function maybeOpenAskSheet() {
  const call = pendingAsk();
  // ① 没有待答 → 收起（但别重置 askShown，否则下一次扫描又会弹）
  if (!call) {
    if (!el.ask.hidden) { el.ask.hidden = true; syncSurface(); }
    return;
  }
  // ② 同一个提问只弹一次；用户主动关掉的也不再弹
  if (state.askShown === call.id || state.askDismissed === call.id) return;
  state.askShown = call.id;
  renderAskSheet(call);
  el.ask.hidden = false;
  syncSurface();
}

function addOptimisticUser(text, rpcId, attaches = []) {
  const item = {
    key: `u:rpc:${rpcId}`,
    kind: "user",
    seq: null,
    time: Date.now(),
    text,
    // 本地预览：durable 消息到达后会换成 host 的附件引用（同一张图）
    media: attaches.map((a) => ({
      kind: "image", attachmentId: "", name: a.name, mediaType: "image/jpeg",
      bytes: a.bytes, width: a.width, height: a.height, preview: a.dataUrl,
    })),
    rpcId,
    pending: true,
  };
  t.items.push(item);
  t.byKey.set(item.key, item);
  t.pending.set(rpcId, item.key);
  removeEmpty();
  const node = itemElFor(item);
  itemEls.set(item.key, node);
  el.messages.appendChild(node);
  scrollToBottom(true);
  return item;
}

async function submitPrompt() {
  const text = el.input.value.trim();
  const attaches = state.attach.slice();
  if ((!text && !attaches.length) || !state.current || state.uploading) return;
  const sessionId = state.current;
  el.input.value = "";
  autoGrow();
  state.attach = [];
  renderAttachTray();
  clearDraft();

  const rpcId = `h5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item = addOptimisticUser(text, rpcId, attaches);
  t.running = true;
  updateStreamUI();
  ensureStream();
  try {
    // 图片**内联**进 prompt（PromptContentPart 支持 {type:"image", mediaType, data}）：
    // 走这条落库的内容块就是 type:"image"，官方附件接口才认、历史回看才读得回来。
    // 早先用"先上传换收据（type:"file"）"那条路，DSH 的授权只看 type:"image"，
    // 于是自己发的图永远读不回来（400 not referenced）。
    const images = attaches.map((a) => ({
      data: a.base64,
      mediaType: a.mediaType || "image/jpeg",
      name: a.name,
    }));
    await request(API.prompt, {
      method: "POST",
      body: {
        sessionId,
        text,
        mode: "steer",
        requestId: rpcId,
        images,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    t.running = true;
    state.lastSentAt = Date.now();
    updateStreamUI();
  } catch (err) {
    item.pending = false;
    item.failed = true;
    t.pending.delete(rpcId);
    refreshItem(item);
    t.running = false;
    // 图片放回输入区，用户不用重挑
    if (attaches.length) { state.attach = [...attaches, ...state.attach]; renderAttachTray(); }
    if (String(err?.message) !== "unauthorized") toast("发送失败：" + String(err?.message || err));
  } finally {
    state.uploading = false;
    updateStreamUI();
  }
}

el.stop.addEventListener("click", async () => {
  if (!state.current) return;
  el.stop.disabled = true;
  try {
    await request(API.cancel, { method: "POST", body: { sessionId: state.current } });
    t.running = false;
    if (t.live) { freezeLive(t); refreshLive(); }
    updateStreamUI();
  } catch { /* ignore */ } finally {
    el.stop.disabled = false;
  }
});

// ───────────────────────── 新建会话 ─────────────────────────
function openPicker() {
  const frag = document.createDocumentFragment();
  for (const ws of state.workspaces) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "picker-item";
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = ws.title || ws.path;
    const path = document.createElement("div");
    path.className = "p";
    path.textContent = ws.path || "";
    b.append(title, path);
    b.addEventListener("click", () => { el.picker.hidden = true; syncSurface(); newSession(ws); });
    frag.appendChild(b);
  }
  if (!state.workspaces.length) {
    const d = document.createElement("div");
    d.className = "drawer-empty";
    d.textContent = "没有可用工作区";
    frag.appendChild(d);
  }
  el.pickerList.replaceChildren(frag);
  el.picker.hidden = false;
  syncSurface();
}

async function newSession(ws) {
  try {
    const { data } = await request(API.sessions, { method: "POST", body: { cwd: ws.path } });
    if (data?.sessionId) {
      await loadIndex();
      openSession(data.sessionId);
    } else {
      toast("新建会话失败");
    }
  } catch (e) {
    if (String(e?.message) !== "unauthorized") toast("新建会话失败：" + String(e?.message || e));
  }
}

// ───────────────────────── 事件绑定 ─────────────────────────
$("btn-menu").addEventListener("click", () => openDrawer(el.drawer.hidden));
el.scrim.addEventListener("click", () => openDrawer(false));
$("btn-refresh").addEventListener("click", () => { loadIndex().catch(() => {}); toast("已刷新"); });
$("btn-new").addEventListener("click", openPicker);
$("picker-cancel").addEventListener("click", () => { el.picker.hidden = true; syncSurface(); });
el.picker.addEventListener("click", (e) => { if (e.target === el.picker) { el.picker.hidden = true; syncSurface(); } });

function updateFilterClear() {
  el.filterClear.hidden = !el.drawerFilter.value;
}

el.drawerFilter.addEventListener("input", () => {
  state.filter = el.drawerFilter.value;
  updateFilterClear();
  renderDrawer();
});

el.filterClear.addEventListener("click", () => {
  el.drawerFilter.value = "";
  state.filter = "";
  updateFilterClear();
  renderDrawer();
  el.drawerFilter.focus();
});

// 连接状态改在抽屉头部显示；点它也保留"手动重连"这个动作
el.drawerStatus.addEventListener("click", () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) { toast("连接正常"); return; }
  state.reconnectDelay = 800;
  clearTimeout(state.reconnectTimer);
  ensureStream();
  toast("正在重连…");
});

// 设置面板（原右上角「…」里的内容 + 连接信息）
function openSettings() {
  const origin = document.getElementById("settings-origin");
  if (origin) origin.textContent = location.origin + "/m/";
  const status = document.getElementById("settings-status");
  if (status) status.textContent = el.drawerStatus.textContent || "已连接";
  const idBtn = el.settings.querySelector('[data-act="copy-id"]');
  if (idBtn) idBtn.disabled = !state.current;
  el.settings.hidden = false;
  syncSurface();
}

$("btn-settings").addEventListener("click", () => { openDrawer(false); openSettings(); });
$("btn-info").addEventListener("click", openInfo);
el.info.addEventListener("click", (e) => { if (e.target === el.info) { el.info.hidden = true; syncSurface(); } });
$("info-close").addEventListener("click", () => { el.info.hidden = true; syncSurface(); });
$("ask-close").addEventListener("click", () => { el.ask.hidden = true; state.askDismissed = state.askShown; syncSurface(); });

el.ask.addEventListener("click", (e) => { if (e.target === el.ask) { el.ask.hidden = true; syncSurface(); } });
installSheetDrag(el.ask);
// 会话 ID / 工作目录：点一下复制
el.infoBody.addEventListener("click", (e) => {
  const target = e.target.closest?.("[data-copy]");
  if (!target) return;
  copyText(target.dataset.copy || "").then((ok) => toast(ok ? "已复制" : "复制失败，请长按选择"));
});
installSheetDrag(el.info);
$("settings-close").addEventListener("click", () => { el.settings.hidden = true; syncSurface(); });
el.settings.addEventListener("click", (e) => { if (e.target === el.settings) { el.settings.hidden = true; syncSurface(); } });
document.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (!act) return;
  const action = act.dataset.act;
  if (action === "expand") {
    const body = act.closest(".tool-body");
    if (body) {
      const expanded = body.classList.toggle("expanded");
      act.textContent = expanded ? "收起" : "展开全部";
    }
    return;
  }
  if (action === "reload") { el.settings.hidden = true; state.current && openSession(state.current); return; }
  if (action === "copy-id") {
    el.settings.hidden = true;
    copyText(state.current || "").then((ok) => toast(ok ? "会话 ID 已复制" : "复制失败"));
    return;
  }
  if (action === "top") { el.settings.hidden = true; el.messages.scrollTop = 0; return; }
});

/* ───────── 底部浮层：下滑关闭（跟手 + 距离/速度判定）─────────
   只在下滑方向、且内容没有滚动（scrollTop=0）时接管；否则让给滚动。 */
function installSheetDrag(sheet) {
  const card = sheet.querySelector(".sheet-card");
  if (!card) return;
  let drag = null;

  const reset = () => { card.style.transition = ""; card.style.transform = ""; };

  card.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (card.scrollTop > 0) return;                       // 内容还能往上滚，先让给滚动
    drag = { y0: e.clientY, dy: 0, decided: false, samples: [{ y: e.clientY, t: e.timeStamp }] };
    card.style.transition = "none";
  });

  card.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    if (!drag.decided) {
      if (Math.abs(dy) < 10) return;                       // 阈值大一点：想把列表点一下时别被当成拖拽
      if (dy < 0) { drag = null; reset(); return; }        // 只支持下滑
      drag.decided = true;
    }
    if (e.cancelable) e.preventDefault();
    drag.dy = Math.max(0, dy);
    drag.samples.push({ y: e.clientY, t: e.timeStamp });
    if (drag.samples.length > 6) drag.samples.shift();
    card.style.transform = `translateY(${drag.dy}px)`;
  });

  const finish = () => {
    const d = drag;
    drag = null;
    if (!d || !d.decided) { if (d) reset(); return; }
    const list = d.samples;
    const last = list[list.length - 1];
    let first = list[0];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (last.t - list[i].t > 100) break;
      first = list[i];
    }
    const dt = last.t - first.t;
    const v = dt > 0 ? (last.y - first.y) / dt : 0;         // px/ms，正数向下
    // 量不到高度时（无布局环境/元素刚显示）用视口高度兜底，否则阈值会退化成 0
    const h = card.getBoundingClientRect().height || Math.round((window.innerHeight || 640) * 0.5);
    const dismiss = d.dy > h * 0.25 || v > 0.5;
    swallowClick = d.decided;                               // 拖完那一下别当成点击
    setTimeout(() => { swallowClick = false; }, 150);
    if (dismiss) {
      card.style.transition = "transform .2s cubic-bezier(.32,0,.24,1)";
      card.style.transform = `translateY(${h}px)`;
      setTimeout(() => {
        reset();
        sheet.hidden = true;
        syncSurface();
      }, 200);
    } else {
      card.style.transition = "transform .18s cubic-bezier(.16,1,.3,1)";
      card.style.transform = "";
      setTimeout(reset, 200);
    }
  };

  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
}

// iOS 上真正能拦住滚动的是 touchmove 的 preventDefault
document.addEventListener("touchmove", (e) => {
  const card = e.target?.closest?.(".sheet-card");
  if (!card || !card.style.transform) return;
  if (e.cancelable) e.preventDefault();
}, { passive: false });

installSheetDrag(el.settings);
installSheetDrag(el.picker);

// 消息区委托：复制代码 / 复制整条
el.messages.addEventListener("click", (e) => {
  const copyBtn = e.target.closest("[data-copy]");
  if (copyBtn) {
    copyText(copyBtn.getAttribute("data-copy") || "").then((ok) => {
      if (ok) {
        const old = copyBtn.textContent;
        copyBtn.textContent = "已复制";
        setTimeout(() => { copyBtn.textContent = old; }, 1200);
      } else toast("复制失败，请长按选择");
    });
    return;
  }
  const msgBtn = e.target.closest("[data-copy-msg]");
  if (msgBtn) {
    copyText(msgBtn.getAttribute("data-copy-msg") || "").then((ok) => toast(ok ? "已复制" : "复制失败"));
  }
});

// 主题：点「外观」行循环切换 跟随系统 → 浅色 → 深色（照着 iOS 设置页的行式布局）
const THEME_CYCLE = ["auto", "light", "dark"];
document.getElementById("row-theme").addEventListener("click", () => {
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(state.theme) + 1) % THEME_CYCLE.length];
  state.theme = next;
  try { localStorage.setItem(THEME_STORAGE, next); } catch { /* ignore */ }
  applyTheme();
});

// 关于：显示当前构建指纹，点一下立刻检查更新
document.getElementById("row-version").addEventListener("click", async () => {
  const value = document.getElementById("version-value");
  const before = value?.textContent;
  if (value) value.textContent = "检查中…";
  await checkForUpdate(true);
  if (value && value.textContent === "检查中…") value.textContent = before || "";
  toast("已检查更新");
});

async function showBuildVersion() {
  const value = document.getElementById("version-value");
  if (!value) return;
  try {
    const build = await currentBuild();
    if (build) value.textContent = String(build).slice(0, 7);
  } catch { /* ignore */ }
}

// 页面重新可见：补一次索引与连接，并顺手看看有没有新版本
document.addEventListener("visibilitychange", () => {
  if (document.hidden || el.main.hidden) return;
  loadIndex().catch(() => {});
  if (!state.ws) ensureStream();
  checkForUpdate();
  hydrateAttachments();   // 后台时 rAF 会被暂停，回到前台补一次附件加载
});

// ───────────────────────── 无感升级 ─────────────────────────
/* 不新增任何接口：直接复用浏览器对**静态资源本身**的缓存校验。
   `fetch(file, { cache: "no-cache" })` 会带上 If-None-Match 问一遍——
   host 新版本会给静态资源发内容 ETag，没变就是 304、body 直接来自缓存
   （只有请求头，几十字节），变了就把新内容交回来。因此：
     · 没有自定义端点要维护，也不用手写 ?v=N；
     · 老 host（还没有 ETag）下同样成立，只是每次真的重下这几个文件；
     · 页面自己比较指纹，变了就 reload，用户无感。
   一次检查 = 5 个条件请求，节流窗口 60s。 */
const ASSETS = ["./index.html", "./app.js", "./style.css", "./md.js", "./transcript.js"];
let buildId = "";
let updatePending = false;
let lastCheckAt = 0;

/** 稳定且够短的本地指纹（不做密码学用途）。 */
function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function currentBuild() {
  const parts = [];
  let ok = 0;
  for (const file of ASSETS) {
    try {
      const res = await fetch(file, { cache: "no-cache" });
      parts.push(`${file}#${res.ok ? await res.text() : `err${res.status}`}`);
      if (res.ok) ok += 1;
    } catch {
      parts.push(`${file}#offline`);
    }
  }
  // 只要有一个没拿到，就不下「有没有新版本」的判断：断网/半通时误判会导致无限自刷
  if (ok !== ASSETS.length) return "";
  return hashText(parts.join("\u0000"));
}

async function checkForUpdate(force = false) {
  const now = Date.now();
  // 手机频繁切前后台时不至于每次都去问一遍；草稿清空那种情况用 force 立刻补。
  const minGap = 60000;
  if (!force && now - lastCheckAt < minGap) return;
  lastCheckAt = now;
  const build = await currentBuild();
  if (!build) return;
  if (!buildId) { buildId = build; return; }   // 本次加载只记录基线
  if (build === buildId) return;
  // 有新版本：正在写草稿就先不打断，等输入框清空后再刷
  if (el.input.value.trim()) { updatePending = true; return; }
  buildId = build;
  location.reload();
}

// ───────────────────────── 启动 ─────────────────────────
function storedSession() {
  try { return localStorage.getItem(SESSION_STORAGE) || ""; } catch { return ""; }
}

async function boot() {
  setConn("busy", "载入中");
  try {
    await loadIndex();
  } catch (e) {
    if (String(e?.message) === "unauthorized") return;
    el.messages.replaceChildren();
    addEmpty("无法连接桌面版：" + escapeHtml(String(e?.message || e)));
    setConn("off", "无法连接");
    return;
  }
  ensureStream();
  // 上次看的是哪条会话就回到哪条（自动升级后的 reload 才不会跳走）
  const saved = storedSession();
  const first =
    (saved && state.sessions.find((s) => s.sessionId === saved))
    || state.sessions.find((s) => state.workspaces.some((w) => (w.sessionIds || []).includes(s.sessionId) && s.running))
    || state.sessions.find((s) => state.workspaces.some((w) => (w.sessionIds || []).includes(s.sessionId)))
    || state.sessions[0];
  if (first) {
    openSession(first.sessionId);
  } else {
    state.current = null;
    updateStreamUI();
    updateHeader();
    el.messages.replaceChildren();
    addEmpty(emptyText());
    setConn("on", "已连接");
  }
  checkForUpdate();
  setInterval(checkForUpdate, VERSION_POLL_MS);
}

(async function start() {
  applyTheme();
  showBuildVersion();
  installDebugGesture();
  if (DEBUG) probeSoon();
  syncViewport();
  renderAttachTray();
  updateStreamUI();
  const stored = Boolean(key);
  try {
    const { ok } = await request(API.ping, { allow401: true });
    if (ok) { hideGate(); await boot(); return; }
    // 401 说明本机存着的密钥已经失效（桌面版重新生成过），别谎报成网络问题
    showGate(stored ? "本机保存的密钥已失效，请到桌面版「设置 → Link」重新生成后输入" : "");
  } catch {
    showGate(stored ? "连接失败：无法访问桌面版，请确认在同一网络后重试" : "");
  }
})();

let viewportSettleTimer = 0;
const ignoreIfUnloaded = (fn) => () => { try { fn(); } catch { /* 页面正在卸载 */ } };

function probeSoon() {
  if (!DEBUG) return;
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    try {
      const line = probeLine();
      if (line === lastProbe) return;    // 指标没变就不重复刷屏
      lastProbe = line;
      dbg(line);
    } catch { /* ignore */ }
  }, 350);
}

function syncViewportSoon() {
  syncViewport();
  probeSoon();
  clearTimeout(viewportSettleTimer);
  // 等地址栏收放动画结束再量一次；页面可能已经卸载，吞掉即可
  viewportSettleTimer = setTimeout(ignoreIfUnloaded(syncViewport), 260);
}
window.visualViewport?.addEventListener("resize", syncViewportSoon);
window.visualViewport?.addEventListener("scroll", syncViewport);
window.addEventListener("resize", syncViewportSoon);
window.addEventListener("orientationchange", syncViewportSoon);
document.addEventListener("visibilitychange", syncViewportSoon);

// iOS 上视口指标可能比真实布局晚一拍（首次进 PWA、地址栏收放之后都可能），
// 只靠 resize 事件有时根本不来，所以再挂一个观察者 + 启动后补测几次。
if (typeof ResizeObserver === "function") {
  try {
    new ResizeObserver(syncViewportSoon).observe(document.documentElement);
    // 「回到最近」按钮按输入区实际高度定位（输入框换行、安全区变化都会改它的高度）
    new ResizeObserver(syncComposerHeight).observe(el.composer);
  } catch { /* ignore */ }
}
syncComposerHeight();
for (const delay of [250, 700, 1500, 3000]) setTimeout(ignoreIfUnloaded(syncViewportSoon), delay);
window.addEventListener("orientationchange", () => setTimeout(syncViewport, 220));

// ── ?debug=1 时的现场检查口（手机上排查用；正常访问不注册）──
const debugStats = (window.__dshLinkStats ||= { frames: 0, byType: {}, chunks: 0, snapshots: 0 });
function countFrame(frame) {
  debugStats.frames += 1;
  const key = frame.type === "event" ? `event:${frame.event?.type ?? "?"}` : frame.type;
  debugStats.byType[key] = (debugStats.byType[key] || 0) + 1;
  if (frame.type === "assistant-stream") debugStats.chunks += 1;
  if (frame.type === "snapshot") debugStats.snapshots += 1;
}
if (DEBUG) window.__dshLink = { state, t, md, stats: debugStats, renderAll, hydrateAttachments, version: "h5-4" };
