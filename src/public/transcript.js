/* DSH Link · 会话事件归约器（纯函数，无 DOM）
 *
 * 输入是 host `follow` 送给 H5 的两类东西：
 *   1) 历史记录 `{ type:"event", event: SessionWireEvent }`（snapshot / page）
 *   2) 实时帧 `assistant-stream` 里的增量 chunk
 *
 * 输出是给 UI 用的线性条目表：
 *   { kind: "user"|"assistant"|"notice", parts: [...], usage, model, time, seq, key }
 * 其中 assistant 的 parts 依次是 reasoning / text / call（工具调用卡片）。
 *
 * 设计要点（与桌面版一致的取舍）：
 *  - 工具调用渲染在**发起它的那条助手消息内部**，结果回来后原地更新卡片；
 *  - 流式内容先落在一条 `live:` 条目里，等到 durable 的 `assistant/message`
 *    到达就整条替换（同一个 step），避免流式与历史两份内容并存；
 *  - 只认 append 来源的人类消息，compaction 的 replace 副本不显示。
 */

/** 取 content 数组里的纯文本。 */
export function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

/** content 数组里的附件（图片/文件）→ 可渲染的引用。 */
export function mediaOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c || (c.type !== "image" && c.type !== "file")) continue;
    const a = c.attachment ?? {};
    out.push({
      kind: c.type,
      attachmentId: a.attachmentId ? String(a.attachmentId) : "",
      name: typeof a.name === "string" ? a.name : "",
      mediaType: typeof a.mediaType === "string" ? a.mediaType : "",
      bytes: typeof a.bytes === "number" ? a.bytes : 0,
      width: a.width,
      height: a.height,
    });
  }
  return out;
}

export function createTranscript() {
  return {
    items: [],
    byKey: new Map(),
    calls: new Map(), // callId -> 工具调用（含结果）
    step: { turn: 0, step: 0 },
    stepSeq: -1,
    running: false,
    live: null,
    frozen: null,
    sealedSteps: new Set(),
    pending: new Map(), // rpcId -> item key（本机乐观气泡）
    title: null,
    firstSeq: Infinity,
    lastSeq: -1,
    cursor: -1,
    hasMore: false,
    loadingOlder: false,
    historyReady: false,
  };
}

export function resetTranscript(t) {
  const fresh = createTranscript();
  Object.assign(t, fresh, { byKey: fresh.byKey, calls: fresh.calls });
  return t;
}

function push(t, item) {
  t.items.push(item);
  t.byKey.set(item.key, item);
  return item;
}

function stepKey(step) {
  return `${step?.turn ?? 0}:${step?.step ?? 0}`;
}

/** 回放旧快照时，不要把「当前在第几回合/第几步」和运行中状态倒退回去。 */
function staleStep(t, ev) {
  return typeof ev.seq === "number" && ev.seq < t.stepSeq;
}

/** 建/复用一条工具调用记录，返回它。 */
/* ── ask_user_question：它是一条普通 tool call，但语义是"向用户提问" ──
   入参：{questions:[{id,header,question,options:[{label,description}]}]}
   回执：{"answers":[{"id","selected":["选项 label"]}]}
   手机端只负责展示（回答要由桌面端的问询卡写回那个待决的 tool call）。 */
function parseAskQuestions(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const list = Array.isArray(parsed?.questions) ? parsed.questions : null;
    return list && list.length ? list : null;
  } catch {
    return null;
  }
}

function parseAskAnswers(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    const list = Array.isArray(parsed?.answers) ? parsed.answers : [];
    const map = {};
    for (const a of list) if (a && a.id) map[a.id] = Array.isArray(a.selected) ? a.selected : [];
    return Object.keys(map).length ? map : null;
  } catch {
    return null;
  }
}

export function ensureCall(t, id, name, args, time) {
  if (!id) return null;
  let call = t.calls.get(id);
  if (!call) {
    call = { id, name: name || "tool", args: args ?? "", startedAt: time ?? null, result: null, items: new Set() };
    t.calls.set(id, call);
  } else {
    if (name) call.name = name;
    if (args !== undefined && args !== null && args !== "") call.args = args;
  }
  if (call.name === "ask_user_question" && !call.ask) {
    call.ask = parseAskQuestions(call.args);
    if (!call.ask) call.ask = null;
  }
  return call;
}

/* ─────────────────────── 历史 / durable 事件 ─────────────────────── */

/**
 * 归约一条 durable 事件。
 * @returns {null | {keys?: string[], call?: string, title?: boolean, running?: boolean, removed?: string[]}}
 */
export function applyEvent(t, ev) {
  if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return null;

  if (typeof ev.seq === "number") {
    if (ev.seq > t.lastSeq) t.lastSeq = ev.seq;
    if (ev.seq < t.firstSeq) t.firstSeq = ev.seq;
  }

  switch (ev.type) {
    case "user/message":
      return upsertUser(t, ev);
    case "assistant/message":
      return upsertAssistant(t, ev);
    case "tool/call": {
      const d = ev.data ?? {};
      const call = ensureCall(t, d.callId, d.name, d.arguments, ev.time);
      // 正常情况下卡片已经挂在某条助手消息里；顺序异常时补一条独立卡片
      const item = standaloneCallItem(t, call);
      return { keys: item ? [item.key] : [], call: d.callId };
    }
    case "tool/result": {
      const d = ev.data ?? {};
      // 真实载荷把 toolCallId / isError / content 放在 data.message 里
      const msg = d.message ?? {};
      const callId = msg.toolCallId ?? d.toolCallId;
      const call = t.calls.get(callId);
      if (!call) return null;
      if (call.ask) {
        const answers = parseAskAnswers(textOf(msg.content));
        if (answers) call.answers = answers;
      }
      call.result = {
        text: textOf(msg.content),
        media: mediaOf(msg.content),
        isError: Boolean(msg.isError),
        time: ev.time ?? null,
      };
      return { call: call.id, keys: [...call.items] };
    }
    case "session/title":
      if (typeof ev.data?.title === "string" && ev.data.title.trim()) {
        t.title = ev.data.title.trim();
        return { title: true };
      }
      return null;
    case "turn/start":
      if (staleStep(t, ev)) return null;
      t.stepSeq = ev.seq ?? t.stepSeq;
      t.running = true;
      t.step = { turn: ev.data?.turn ?? 0, step: 0 };
      return { running: true };
    case "step/start":
      if (staleStep(t, ev)) return null;
      t.stepSeq = ev.seq ?? t.stepSeq;
      t.running = true;
      t.step = { turn: ev.data?.turn ?? t.step.turn, step: ev.data?.step ?? 0 };
      return { running: true };
    case "turn/end":
      if (staleStep(t, ev)) return null;
      t.stepSeq = ev.seq ?? t.stepSeq;
      t.running = false;
      return { running: true };
    default:
      return null;
  }
}

function upsertUser(t, ev) {
  if (ev.surfaceOp && typeof ev.surfaceOp === "object") return null; // compaction 副本
  const d = ev.data ?? {};
  const text = textOf(d.content);
  const media = mediaOf(d.content);
  const rpcId = d.source?.rpcId;

  // 承认本机乐观气泡：同一 requestId 合并成一条
  if (rpcId && t.pending.has(rpcId)) {
    const key = t.pending.get(rpcId);
    t.pending.delete(rpcId);
    const item = t.byKey.get(key);
    if (item) {
      item.pending = false;
      item.failed = false;
      item.seq = ev.seq;
      item.time = ev.time;
      item.text = text || item.text;
      item.media = media;
      return { keys: [key] };
    }
  }
  if (!text && !media.length) return null;
  const key = `u:${ev.seq}`;
  if (t.byKey.has(key)) return null;
  const item = push(t, { key, kind: "user", seq: ev.seq, time: ev.time, text, media, rpcId });
  return { keys: [item.key] };
}

function upsertAssistant(t, ev) {
  const d = ev.data ?? {};
  const msg = d.message ?? {};
  const parts = [];
  for (const c of Array.isArray(msg.content) ? msg.content : []) {
    if (!c) continue;
    if (c.type === "reasoning" && typeof c.text === "string" && c.text) parts.push({ type: "reasoning", text: c.text });
    else if (c.type === "text" && typeof c.text === "string" && c.text) parts.push({ type: "text", text: c.text });
    else if (c.type === "tool-call") {
      const call = ensureCall(t, c.id, c.name, c.arguments, ev.time);
      if (call) parts.push({ type: "call", id: call.id });
    }
  }
  if (!parts.length) return null;

  const key = `a:${ev.seq}`;
  if (t.byKey.has(key)) return null;

  const removed = sealLive(t);
  // turn/end 先到、durable 后到的竞态：冻结条目由这条正式消息接管
  if (t.frozen && t.frozen.stepKey === stepKey(d)) {
    removeItem(t, t.frozen.key);
    removed.push(t.frozen.key);
    t.frozen = null;
  }
  const item = push(t, {
    key,
    kind: "assistant",
    seq: ev.seq,
    time: ev.time,
    step: stepKey(d),
    parts,
    usage: d.usage ?? null,
    model: msg.source?.model ?? null,
  });
  for (const p of parts) {
    if (p.type === "call") t.calls.get(p.id)?.items.add(item.key);
  }
  return { keys: [item.key], removed };
}

function standaloneCallItem(t, call) {
  if (!call || call.items.size) return null;
  const prev = t.items[t.items.length - 1];
  // 上一条助手消息属于当前 step 时，卡片就挂在它下面（历史顺序异常的兜底）
  if (prev && prev.kind === "assistant" && prev.step && prev.step === stepKey(t.step)) {
    prev.parts.push({ type: "call", id: call.id });
    call.items.add(prev.key);
    return prev;
  }
  const item = push(t, {
    key: `c:${call.id}`,
    kind: "assistant",
    seq: null,
    time: call.startedAt,
    parts: [{ type: "call", id: call.id }],
    usage: null,
    model: null,
  });
  call.items.add(item.key);
  return item;
}

/* ─────────────────────── 实时流 ─────────────────────── */

function removeItem(t, key) {
  const idx = t.items.findIndex((i) => i.key === key);
  if (idx >= 0) t.items.splice(idx, 1);
  t.byKey.delete(key);
}

/** durable 的 assistant/message 到达：实时条目让位（整条替换）。 */
function sealLive(t) {
  if (!t.live) return [];
  const key = t.live.item.key;
  t.sealedSteps.add(t.live.stepKey);
  t.live = null;
  removeItem(t, key);
  t.frozen = null;
  return [key];
}

/** turn/end：把实时条目冻结成静态条目（保留内容，只去掉“正在生成”外观）。 */
export function freezeLive(t) {
  if (!t.live) return null;
  const key = t.live.item.key;
  t.sealedSteps.add(t.live.stepKey);
  const item = t.byKey.get(key);
  if (item) {
    item.live = false;
    item.done = true;
  }
  t.frozen = { stepKey: t.live.stepKey, key };
  t.live = null;
  return key;
}

function ensureLive(t, attemptId) {
  if (t.live && t.live.attemptId === attemptId) return t.live;
  let removed = [];
  if (t.live) removed = sealLive(t); // 上一次尝试没等到 durable：直接让位给新尝试
  const item = {
    key: `live:${attemptId}`,
    kind: "assistant",
    seq: null,
    time: Date.now(),
    parts: [],
    usage: null,
    model: null,
    live: true,
    sealed: false,
  };
  push(t, item);
  t.live = { attemptId, stepKey: stepKey(t.step), item, removed };
  return t.live;
}

const BLOCK_TYPE = { reasoning: "reasoning", text: "text", "tool-call": "call" };

/**
 * 归约一个 `assistant-stream` 帧里的 chunk。
 * 兼容两种入参：host 原样转发的 `{type:"assistant-stream", frame:{...}}`，
 * 以及已经剥掉外层的 `{type:"chunk", chunk:{...}}`。
 * @returns {null | {key: string, removed?: string[]}}
 */
export function applyChunk(t, frame) {
  const inner = frame?.frame ?? frame;
  const chunk = inner?.chunk;
  if (!chunk || typeof chunk.type !== "string") return null;
  const attemptId = inner.attemptId ?? "live";

  // 本 step 已被冻结（turn/end 先到）：迟到的 chunk 直接丢弃，避免重复条目
  if (!t.live && t.frozen && t.frozen.stepKey === stepKey(t.step)) return null;

  if (chunk.type === "finish" || chunk.type === "usage") {
    if (t.live && t.live.attemptId === attemptId) {
      if (chunk.type === "usage" && chunk.usage) t.live.item.usage = chunk.usage;
      t.live.item.done = true;
      return { key: t.live.item.key };
    }
    return null;
  }

  const live = ensureLive(t, attemptId);
  const parts = live.item.parts;
  const idx = typeof chunk.index === "number" ? chunk.index : 0;

  if (chunk.type === "block-start") {
    parts[idx] = { type: BLOCK_TYPE[chunk.blockType] ?? "text", text: "", startedAt: inner.time ?? Date.now() };
    return { key: live.item.key, removed: live.removed };
  }

  const part = parts[idx];

  if (chunk.type === "reasoning-delta" || chunk.type === "text-delta") {
    const target = part ?? (parts[idx] = { type: chunk.type === "text-delta" ? "text" : "reasoning", text: "" });
    target.text = (target.text ?? "") + (chunk.text ?? chunk.delta ?? "");
    return { key: live.item.key, removed: live.removed };
  }

  if (chunk.type === "tool-call-delta") {
    const target = part ?? (parts[idx] = { type: "call", id: chunk.id, name: chunk.name, args: "" });
    if (chunk.id) target.id = chunk.id;
    if (chunk.name) target.name = chunk.name;
    target.args = (target.args ?? "") + (chunk.argumentsDelta ?? "");
    ensureCall(t, target.id, target.name, target.args, inner.time);
    return { key: live.item.key, removed: live.removed };
  }

  if (chunk.type === "block-end" && chunk.block) {
    const block = chunk.block;
    if (block.type === "tool-call") {
      const call = ensureCall(t, block.id, block.name, block.arguments, inner.time);
      parts[idx] = { type: "call", id: call?.id ?? block.id };
    } else {
      parts[idx] = { type: BLOCK_TYPE[block.type] ?? "text", text: block.text ?? "" };
    }
    return { key: live.item.key, removed: live.removed };
  }

  return null;
}

/**
 * 快照：首次打开时重建条目表；之后到达的快照（重连、重新 follow）**合并**处理。
 *
 * host 会在一次连接里多次下发 snapshot 基线，如果每次都 reset，正在流式的
 * live 条目和已经翻出来的更早历史都会被抹掉——手机端表现为「一直在重新加载」。
 * 事件本身按 key 幂等，重复应用没有副作用。
 */
export function applySnapshot(t, records, meta = {}) {
  const firstLoad = !t.historyReady || !t.items.length;
  if (firstLoad) resetTranscript(t);
  const before = t.items.length;
  for (const rec of Array.isArray(records) ? records : []) {
    if (rec && rec.event) applyEvent(t, rec.event);
    else applyEvent(t, rec);
  }
  if (typeof meta.cursor === "number") t.cursor = meta.cursor;
  if (meta.hasMore !== undefined) t.hasMore = Boolean(meta.hasMore);
  t.historyReady = true;
  return { firstLoad, added: t.items.length - before };
}

/** 更早的一页：插到最前面（保持 seq 顺序，按 key 去重）。 */
export function prependPage(t, records) {
  const older = createTranscript();
  for (const rec of Array.isArray(records) ? records : []) {
    if (rec && rec.event) applyEvent(older, rec.event);
    else applyEvent(older, rec);
  }
  if (!older.items.length) return { added: 0 };
  const fresh = older.items.filter((i) => !t.byKey.has(i.key));
  if (!fresh.length) return { added: 0 };
  t.items = [...fresh, ...t.items];
  for (const i of fresh) t.byKey.set(i.key, i);
  for (const [id, c] of older.calls) {
    const mine = t.calls.get(id);
    if (!mine) t.calls.set(id, c);
    else if (!mine.result && c.result) mine.result = c.result;
  }
  if (older.firstSeq < t.firstSeq) t.firstSeq = older.firstSeq;
  return { added: fresh.length };
}
