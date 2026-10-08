/**
 * ws-mini 的自测：用 Node 内置的 WebSocket 客户端（undici）对抗自研服务端。
 * 覆盖：握手、小文本、大文本（16/64 位长度）、客户端分片、服务端连续推送、
 * 多连接隔离、关闭握手、服务端主动 4401 关闭、未掩码帧拒绝。
 *
 * 运行：node test/ws-mini.test.mjs
 */
import { createServer } from "node:http";
import net from "node:net";
import { strict as assert } from "node:assert";
import { test, afterAll } from "vitest";
import { upgrade } from "../dist/host/ws-mini.js";


/** 起一个 echo/推送两用的测试服务端，并暴露其连接集合。 */
function startServer() {
  return new Promise((resolve) => {
    const conns = new Set();
    const server = createServer((req, res) => { res.writeHead(404); res.end(); });
    server.on("upgrade", (req, socket, head) => {
      upgrade(req, socket, head, (conn) => {
        conns.add(conn);
        conn.on("close", () => conns.delete(conn));
        conn.on("message", (data) => {
          if (typeof data === "string" && data.startsWith("!push ")) {
            conn.send(`push:1:${data.slice(6)}`);
            conn.send(`push:2:${data.slice(6)}`);
            return;
          }
          conn.send(`echo:${typeof data === "string" ? data : "<binary>"}`);
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        conns,
        close: () => new Promise((r) => {
          for (const c of conns) c.close(1001, "server shutting down");
          server.close(() => r());
        }),
      });
    });
  });
}

const srv = await startServer();
const URL_BASE = `ws://127.0.0.1:${srv.port}/m/api/stream`;

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
    setTimeout(() => reject(new Error("open timeout")), 3000);
  });
}

// 每条连接挂一个**常驻**监听并排队：服务端可能连续推送两条，
// 「挂一次监听等一条」的写法会在第二条先派发时丢消息（老 flake 的根因）。
const inboxes = new WeakMap();

function inboxOf(ws) {
  let box = inboxes.get(ws);
  if (!box) {
    box = { queue: [], waiters: [] };
    inboxes.set(ws, box);
    ws.addEventListener("message", (ev) => {
      const value = String(ev.data);
      const waiter = box.waiters.shift();
      if (waiter) waiter(value);
      else box.queue.push(value);
    });
  }
  return box;
}

function nextMessage(ws, timeout = 5000) {
  const box = inboxOf(ws);
  if (box.queue.length) return Promise.resolve(box.queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = box.waiters.indexOf(waiter);
      if (i >= 0) box.waiters.splice(i, 1);
      reject(new Error("message timeout"));
    }, timeout);
    const waiter = (value) => { clearTimeout(timer); resolve(value); };
    box.waiters.push(waiter);
  });
}

function closed(ws, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 1006 });
    const t = setTimeout(() => reject(new Error("close timeout")), timeout);
    ws.addEventListener("close", (ev) => { clearTimeout(t); resolve(ev); }, { once: true });
  });
}


test("握手并回显小文本（含中文）", async () => {
  const ws = await open(URL_BASE);
  ws.send("hello 世界");
  assert.equal(await nextMessage(ws), "echo:hello 世界");
  ws.close();
  await closed(ws);
});

test("中等消息走 16 位长度（1000 字节）", async () => {
  const ws = await open(URL_BASE);
  const payload = "a".repeat(1000);
  ws.send(payload);
  assert.equal(await nextMessage(ws), "echo:" + payload);
  ws.close();
  await closed(ws);
});

test("超大消息走 64 位长度 + 客户端分片（512 KiB）", async () => {
  const ws = await open(URL_BASE);
  const payload = "x".repeat(512 * 1024);
  ws.send(payload);
  const got = await nextMessage(ws);
  assert.equal(got, "echo:" + payload);
  ws.close();
  await closed(ws);
});

test("服务端连续推送两条（follow 帧模式）", async () => {
  const ws = await open(URL_BASE);
  ws.send("!push abc");
  assert.equal(await nextMessage(ws), "push:1:abc");
  assert.equal(await nextMessage(ws), "push:2:abc");
  ws.close();
  await closed(ws);
});

test("多连接并发互不串扰", async () => {
  const [a, b] = await Promise.all([open(URL_BASE), open(URL_BASE)]);
  a.send("AAA");
  b.send("BBB");
  assert.equal(await nextMessage(a), "echo:AAA");
  assert.equal(await nextMessage(b), "echo:BBB");
  a.close(); b.close();
  await Promise.all([closed(a), closed(b)]);
});

test("客户端主动关闭握手", async () => {
  const ws = await open(URL_BASE);
  ws.close(1000, "bye");
  const ev = await closed(ws);
  assert.ok(ev.code === 1000 || ev.code === 1005, `unexpected close code ${ev.code}`);
});

test("服务端主动 4401 关闭（密钥失效语义）", async () => {
  const ws = await open(URL_BASE);
  ws.send("!push x");
  await nextMessage(ws);
  assert.ok(srv.conns.size >= 1, "服务端应记录到连接");
  for (const c of srv.conns) c.close(4401, "invalid link key");
  const ev = await closed(ws);
  assert.equal(ev.code, 4401);
});

test("握手算法符合 RFC 6455 样例向量", async () => {
  const socket = net.connect(srv.port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  socket.write(
    "GET /m/api/stream HTTP/1.1\r\n" +
    "Host: 127.0.0.1\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    "Sec-WebSocket-Version: 13\r\n\r\n",
  );
  const handshake = await new Promise((resolve) => {
    let acc = "";
    socket.on("data", (c) => { acc += c.toString("latin1"); if (acc.includes("\r\n\r\n")) resolve(acc); });
  });
  assert.match(handshake, /HTTP\/1\.1 101 Switching Protocols/);
  assert.match(handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  socket.destroy();
});

test("未掩码客户端帧被以 1002 关闭", async () => {
  const socket = net.connect(srv.port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  socket.write(
    "GET /m/api/stream HTTP/1.1\r\n" +
    "Host: 127.0.0.1\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    "Sec-WebSocket-Version: 13\r\n\r\n",
  );
  await new Promise((resolve) => {
    let acc = "";
    socket.on("data", (c) => { acc += c.toString("latin1"); if (acc.includes("\r\n\r\n")) resolve(); });
  });
  const frames = [];
  const got = new Promise((resolve) => {
    socket.on("data", (c) => {
      frames.push(c);
      const buf = Buffer.concat(frames);
      if (buf.length >= 4 && (buf[0] & 0x0f) === 0x8) resolve(buf);
    });
    setTimeout(() => resolve(null), 3000);
  });
  socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // 未加掩码的 "hi"
  const closeFrame = await got;
  assert.ok(closeFrame, "服务端应回关闭帧");
  assert.equal(closeFrame.readUInt16BE(2), 1002);
  socket.destroy();
});

test("错误握手（缺少 Sec-WebSocket-Key）被 400 拒绝", async () => {
  const socket = net.connect(srv.port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  socket.write(
    "GET /m/api/stream HTTP/1.1\r\n" +
    "Host: 127.0.0.1\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n\r\n",
  );
  const status = await new Promise((resolve) => {
    socket.on("data", (c) => resolve(c.toString("latin1").split("\r\n")[0]));
    setTimeout(() => resolve(""), 3000);
  });
  assert.match(status, /400 Bad Request/);
  socket.destroy();
});

afterAll(() => srv.close());

