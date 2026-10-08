/**
 * transcript.js 的自测：会话事件归约（历史 / 实时流 / 工具调用 / 分页）。
 * 运行：node test/transcript.test.mjs
 */
import { strict as assert } from "node:assert";
import { test, afterAll } from "vitest";
import {
  createTranscript, resetTranscript, applyEvent, applyChunk, applySnapshot, prependPage,
  freezeLive, textOf, mediaOf, ensureCall,
} from "../src/public/transcript.js";


const rec = (event) => ({ type: "event", event });

const userEv = (seq, text, rpcId) => ({
  type: "user/message",
  seq,
  time: 1000 + seq,
  surfaceOp: "append",
  data: { content: [{ type: "text", text }], source: { kind: "user", ...(rpcId ? { rpcId } : {}) } },
});

const assistantEv = (seq, content, step = 1) => ({
  type: "assistant/message",
  seq,
  time: 2000 + seq,
  data: {
    turn: 1,
    step,
    message: { role: "assistant", content, source: { kind: "model", model: "deepseek-flash" } },
    usage: { totalTokens: 1234 },
  },
});

// 真实载荷：toolCallId / isError / content 都在 data.message 里
const toolResultEv = (seq, callId, text, isError = false) => ({
  type: "tool/result",
  seq,
  time: 3000 + seq,
  data: { turn: 1, step: 1, message: { role: "tool", toolCallId: callId, content: [{ type: "text", text }], isError } },
});


test("textOf 只取 text 片段", () => {
  assert.equal(textOf([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "ab");
  assert.equal(textOf(null), "");
});

test("快照：用户 + 助手消息按序成条目", () => {
  const t = createTranscript();
  applySnapshot(t, [
    rec(userEv(1, "你好")),
    rec({ type: "turn/start", seq: 2, data: { turn: 1 } }),
    rec({ type: "step/start", seq: 3, data: { turn: 1, step: 1 } }),
    rec(assistantEv(4, [{ type: "reasoning", text: "想" }, { type: "text", text: "在的" }])),
    rec({ type: "turn/end", seq: 5, data: { turn: 1 } }),
  ], { cursor: 5, hasMore: true });

  assert.equal(t.items.length, 2);
  assert.equal(t.items[0].kind, "user");
  assert.equal(t.items[0].text, "你好");
  assert.equal(t.items[1].kind, "assistant");
  assert.deepEqual(t.items[1].parts.map((p) => p.type), ["reasoning", "text"]);
  assert.equal(t.items[1].model, "deepseek-flash");
  assert.equal(t.hasMore, true);
  assert.equal(t.cursor, 5);
  assert.equal(t.historyReady, true);
  assert.equal(t.running, false, "turn/end 后不应仍在运行");
});

test("mediaOf 提取附件引用（图片/文件）", () => {
  const media = mediaOf([
    { type: "text", text: "看图" },
    { type: "image", attachment: { attachmentId: "sha256:aa", mediaType: "image/png", name: "a.png", bytes: 12, width: 4, height: 4 } },
    { type: "file", attachment: { attachmentId: "sha256:bb", name: "b.pdf", bytes: 99 } },
  ]);
  assert.equal(media.length, 2);
  assert.deepEqual(media[0], { kind: "image", attachmentId: "sha256:aa", name: "a.png", mediaType: "image/png", bytes: 12, width: 4, height: 4 });
  assert.equal(media[1].kind, "file");
  assert.equal(media[1].mediaType, "");
  assert.deepEqual(mediaOf(null), []);
  assert.deepEqual(mediaOf([{ type: "image" }]), [{ kind: "image", attachmentId: "", name: "", mediaType: "", bytes: 0, width: undefined, height: undefined }]);
});

test("compaction 的 replace 副本不进入人类 transcript", () => {
  const t = createTranscript();
  const ev = userEv(1, "被压缩的旧消息");
  ev.surfaceOp = { kind: "replace", sourceSeqs: [1] };
  assert.equal(applyEvent(t, ev), null);
  assert.equal(t.items.length, 0);
});

test("工具调用：卡片挂在发起它的助手消息里，结果原地更新", () => {
  const t = createTranscript();
  applySnapshot(t, [
    rec(assistantEv(10, [
      { type: "reasoning", text: "看看目录" },
      { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls","description":"列目录"}' },
    ])),
    rec({ type: "tool/call", seq: 11, time: 2100, data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: '{"command":"ls"}' } }),
    rec(toolResultEv(12, "c1", "a.txt\nb.txt")),
  ]);

  assert.equal(t.items.length, 1, "tool/call 不应另起一条消息");
  assert.deepEqual(t.items[0].parts.map((p) => p.type), ["reasoning", "call"]);
  const call = t.calls.get("c1");
  assert.equal(call.name, "bash");
  assert.equal(call.result.text, "a.txt\nb.txt");
  assert.equal(call.result.isError, false);
  assert.ok(Number.isFinite(call.startedAt), "记录了开始时间（用于展示耗时）");
  assert.ok(call.result.time > call.startedAt);
});

test("工具失败标记 isError", () => {
  const t = createTranscript();
  applySnapshot(t, [
    rec(assistantEv(1, [{ type: "tool-call", id: "c9", name: "bash", arguments: "{}" }])),
    rec(toolResultEv(2, "c9", "boom", true)),
  ]);
  assert.equal(t.calls.get("c9").result.isError, true);
});

test("未知工具结果被安全忽略", () => {
  const t = createTranscript();
  assert.equal(applyEvent(t, toolResultEv(1, "nope", "x")), null);
});

test("兼容 toolCallId 直接挂在 data 上的旧载荷", () => {
  const t = createTranscript();
  applySnapshot(t, [rec(assistantEv(1, [{ type: "tool-call", id: "cx", name: "bash", arguments: "{}" }]))]);
  const res = applyEvent(t, {
    type: "tool/result", seq: 2, time: 200,
    data: { toolCallId: "cx", message: { role: "tool", content: [{ type: "text", text: "旧格式" }], isError: false } },
  });
  assert.deepEqual(res.keys, ["a:1"]);
  assert.equal(t.calls.get("cx").result.text, "旧格式");
});

test("实时流：block-start / delta / block-end", () => {
  const t = createTranscript();
  applyEvent(t, { type: "turn/start", seq: 1, data: { turn: 1 } });
  applyEvent(t, { type: "step/start", seq: 2, data: { turn: 1, step: 1 } });

  applyChunk(t, { attemptId: "a1", chunk: { type: "block-start", index: 0, blockType: "reasoning" } });
  applyChunk(t, { attemptId: "a1", chunk: { type: "reasoning-delta", index: 0, text: "想" } });
  applyChunk(t, { attemptId: "a1", chunk: { type: "reasoning-delta", index: 0, text: "一下" } });
  applyChunk(t, { attemptId: "a1", chunk: { type: "block-end", index: 0, block: { type: "reasoning", text: "想一下" } } });

  assert.equal(t.items.length, 1);
  assert.equal(t.live.item.parts[0].text, "想一下");
  assert.equal(t.running, true);

  applyChunk(t, { attemptId: "a1", chunk: { type: "block-start", index: 1, blockType: "text" } });
  applyChunk(t, { attemptId: "a1", chunk: { type: "text-delta", index: 1, text: "答案" } });
  assert.equal(t.live.item.parts[1].text, "答案");
});

test("实时流：接受 host 原样转发的双层包装帧", () => {
  const t = createTranscript();
  applyEvent(t, { type: "step/start", seq: 1, data: { turn: 1, step: 1 } });
  // host → H5 的形状：{ type:"assistant-stream", frame:{ type:"chunk", attemptId, chunk } }
  applyChunk(t, {
    type: "assistant-stream",
    frame: { type: "chunk", attemptId: "a9", index: 0, time: 500, chunk: { type: "block-start", index: 0, blockType: "text" } },
  });
  applyChunk(t, {
    type: "assistant-stream",
    frame: { type: "chunk", attemptId: "a9", index: 1, time: 520, chunk: { type: "text-delta", index: 0, text: "包了两层" } },
  });
  assert.equal(t.live.item.parts[0].text, "包了两层");
  assert.equal(t.live.item.parts[0].startedAt, 500);
});

test("实时工具调用：delta 累积参数，block-end 校正", () => {
  const t = createTranscript();
  applyEvent(t, { type: "step/start", seq: 1, data: { turn: 1, step: 1 } });
  applyChunk(t, { attemptId: "a2", chunk: { type: "block-start", index: 0, blockType: "tool-call" } });
  applyChunk(t, { attemptId: "a2", chunk: { type: "tool-call-delta", index: 0, id: "c1", name: "bash", argumentsDelta: '{"command":' } });
  applyChunk(t, { attemptId: "a2", chunk: { type: "tool-call-delta", index: 0, id: "c1", name: "bash", argumentsDelta: '"ls"}' } });
  assert.equal(t.calls.get("c1").args, '{"command":"ls"}');
  applyChunk(t, { attemptId: "a2", chunk: { type: "block-end", index: 0, block: { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls -la"}' } } });
  assert.equal(t.calls.get("c1").args, '{"command":"ls -la"}');
  assert.equal(t.live.item.parts[0].type, "call");
});

test("durable 的 assistant/message 接管实时条目（不留两份）", () => {
  const t = createTranscript();
  applyEvent(t, { type: "step/start", seq: 1, data: { turn: 1, step: 1 } });
  applyChunk(t, { attemptId: "a3", chunk: { type: "block-start", index: 0, blockType: "text" } });
  applyChunk(t, { attemptId: "a3", chunk: { type: "text-delta", index: 0, text: "流式" } });
  const liveKey = t.live.item.key;

  const res = applyEvent(t, assistantEv(20, [{ type: "text", text: "流式（正式）" }], 1));
  assert.deepEqual(res.removed, [liveKey]);
  assert.equal(t.live, null);
  assert.equal(t.items.length, 1);
  assert.equal(t.items[0].key, "a:20");
  assert.equal(t.items[0].parts[0].text, "流式（正式）");
});

test("turn/end 冻结实时条目；随后到达的 durable 接管它（不重复）", () => {
  const t = createTranscript();
  applyEvent(t, { type: "step/start", seq: 1, data: { turn: 1, step: 1 } });
  applyChunk(t, { attemptId: "a4", chunk: { type: "block-start", index: 0, blockType: "text" } });
  applyChunk(t, { attemptId: "a4", chunk: { type: "text-delta", index: 0, text: "半截" } });
  const frozenKey = freezeLive(t);
  assert.equal(t.live, null);
  assert.equal(t.items.length, 1, "冻结后内容仍在");
  assert.equal(t.items[0].live, false);

  const res = applyEvent(t, assistantEv(30, [{ type: "text", text: "半截完成" }], 1));
  assert.deepEqual(res.removed, [frozenKey]);
  assert.equal(t.items.length, 1);
  assert.equal(t.items[0].key, "a:30");
});

test("冻结后同 step 的迟到 chunk 被忽略", () => {
  const t = createTranscript();
  applyEvent(t, { type: "step/start", seq: 1, data: { turn: 1, step: 1 } });
  applyChunk(t, { attemptId: "a5", chunk: { type: "block-start", index: 0, blockType: "text" } });
  freezeLive(t);
  assert.equal(applyChunk(t, { attemptId: "a5", chunk: { type: "text-delta", index: 0, text: "迟到" } }), null);
  assert.equal(t.items.length, 1);
});

test("本机乐观气泡按 requestId 合并", () => {
  const t = createTranscript();
  const item = { key: "u:rpc:r1", kind: "user", seq: null, text: "在吗", media: [], rpcId: "r1", pending: true };
  t.items.push(item);
  t.byKey.set(item.key, item);
  t.pending.set("r1", item.key);

  const res = applyEvent(t, userEv(7, "在吗", "r1"));
  assert.deepEqual(res.keys, ["u:rpc:r1"]);
  assert.equal(t.items.length, 1, "不应出现重复气泡");
  assert.equal(item.pending, false);
  assert.equal(item.seq, 7);
  assert.equal(t.pending.size, 0);
});

test("更早的一页：插到最前且去重", () => {
  const t = createTranscript();
  applySnapshot(t, [rec(userEv(50, "最近的")), rec(assistantEv(51, [{ type: "text", text: "回复" }]))], { cursor: 51, hasMore: true });

  const { added } = prependPage(t, [rec(userEv(10, "很早")), rec(assistantEv(11, [{ type: "text", text: "早回复" }]))]);
  assert.equal(added, 2);
  assert.deepEqual(t.items.map((i) => i.seq), [10, 11, 50, 51]);
  assert.equal(t.firstSeq, 10);

  const again = prependPage(t, [rec(userEv(10, "很早"))]);
  assert.equal(again.added, 0, "重复页不应重复插入");
  assert.equal(t.items.length, 4);
});

test("重复下发的快照是合并不是清空（保住更早的历史与 live）", () => {
  const t = createTranscript();
  applySnapshot(t, [rec(userEv(50, "最近的"))]);
  prependPage(t, [rec(userEv(10, "很早"))]);
  assert.deepEqual(t.items.map((i) => i.seq), [10, 50]);

  // host 在重连/重新 follow 时会再发一次同窗口基线
  const { added, firstLoad } = applySnapshot(
    t,
    [rec(userEv(50, "最近的")), rec(assistantEv(51, [{ type: "text", text: "回复" }]))],
    { hasMore: true },
  );
  assert.equal(firstLoad, false);
  assert.equal(added, 1, "只有新事件被追加");
  assert.deepEqual(t.items.map((i) => i.seq), [10, 50, 51], "更早翻出来的一页仍在");
});

test("快照回放不会把当前 step 倒退", () => {
  const t = createTranscript();
  applySnapshot(t, [
    rec({ type: "turn/start", seq: 1, data: { turn: 1 } }),
    rec({ type: "step/start", seq: 2, data: { turn: 1, step: 5 } }),
  ]);
  assert.deepEqual(t.step, { turn: 1, step: 5 });
  // 旧基线回放：seq 更小的 turn/start 不应把 step 拉回去
  applyEvent(t, { type: "turn/start", seq: 1, data: { turn: 1 } });
  assert.deepEqual(t.step, { turn: 1, step: 5 });
});

test("resetTranscript 才真正清空", () => {
  const t = createTranscript();
  applySnapshot(t, [rec(userEv(1, "a"))]);
  resetTranscript(t);
  assert.equal(t.items.length, 0);
  assert.equal(t.historyReady, false);
});

test("ensureCall 不覆盖已有结果", () => {
  const t = createTranscript();
  const c = ensureCall(t, "c1", "bash", "{}", 1);
  c.result = { text: "done", isError: false, time: 2 };
  ensureCall(t, "c1", "bash", '{"command":"ls"}', 1);
  assert.equal(t.calls.get("c1").result.text, "done");
  assert.equal(t.calls.get("c1").args, '{"command":"ls"}');
});

