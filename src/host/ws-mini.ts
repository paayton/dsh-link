/**
 * 极简 RFC 6455 WebSocket 服务端 —— 零依赖。
 *
 * 为什么不用 `ws`：dsh-link 以本地目录形式装入 profile，其真实路径在
 * 工作区里，Node 的裸模块解析找不到 profile 的 node_modules；而为了一个
 * WS 服务端引入安装依赖会显著抬高插件的安装门槛。此处只实现我们确实
 * 用到的子集：文本帧、分片续帧、ping/pong、close，外加长度上限。
 *
 * 服务端发出的帧不加掩码（协议要求），客户端来的帧必须带掩码。
 */
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 单条消息（含分片重组后）的字节上限，防止内存被单连接打爆。 */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** 合并缓冲区上限：超过即判定为畸形/攻击流量。 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function acceptValue(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

export class WsConnection {
  /** 分片消息是否为文本帧（非文本即二进制） */
  _fragText = false;
  socket: Socket;
  readyState: number;
  _buf: Buffer;
  _fragments: Buffer[];
  _fragBytes: number;
  _dead: boolean;
  _handlers: Map<string, ((...args: any[]) => void)[]>;

  constructor(socket: Socket) {
    this.socket = socket;
    this.readyState = OPEN;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragBytes = 0;
    this._dead = false;
    this._handlers = new Map();

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err) => {
      this._emit("error", err);
      this._finish(1006);
    });
    socket.on("close", () => this._finish(1006));
  }

  on(event: string, fn: (...args: any[]) => void) {
    const list = this._handlers.get(event);
    if (list) list.push(fn);
    else this._handlers.set(event, [fn]);
    return this;
  }

  _emit(event, ...args) {
    const list = this._handlers.get(event);
    if (!list) return;
    for (const fn of list) {
      try { fn(...args); } catch { /* 监听器异常不应拖垮连接 */ }
    }
  }

  /** 发送一条文本消息。返回是否真的写出去了。 */
  send(data) {
    if (this.readyState !== OPEN) return false;
    return this._writeFrame(OP_TEXT, Buffer.from(String(data), "utf8"));
  }

  /** 发送关闭帧并优雅收尾。 */
  close(code = 1000, reason = "") {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    const reasonBuf = Buffer.from(String(reason), "utf8");
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try { this._writeFrame(OP_CLOSE, payload); } catch { /* ignore */ }
    this.socket.end();
    const timer = setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, 500);
    if (typeof timer.unref === "function") timer.unref();
  }

  /** 立即断开 TCP，不发关闭帧。 */
  destroy() {
    this._finish(1006);
    try { this.socket.destroy(); } catch { /* ignore */ }
  }

  _finish(code) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this._emit("close", code);
  }

  _fail(code, reason) {
    this._dead = true;
    try { this.close(code, reason); } catch { /* ignore */ }
  }

  // ── 写出 ──────────────────────────────────────────────
  _writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN=1，服务端不加掩码
    try {
      this.socket.write(header);
      if (len > 0) this.socket.write(payload);
      return true;
    } catch {
      return false;
    }
  }

  // ── 读入 ──────────────────────────────────────────────
  _onData(chunk) {
    if (this._dead || this.readyState === CLOSED) return;
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    if (this._buf.length > MAX_BUFFER_BYTES) {
      this._fail(1009, "message too big");
      return;
    }
    while (!this._dead) {
      const frame = this._readFrame();
      if (frame === undefined) return;   // 数据不够，等下一批
      if (frame === null) return;        // 协议错误，已处理
      this._handleFrame(frame);
    }
  }

  /** @returns 帧对象 | undefined（需要更多数据）| null（协议错误） */
  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return undefined;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    if ((b0 & 0x70) !== 0) { this._fail(1002, "reserved bits set"); return null; }
    const opcode = b0 & 0x0f;

    const masked = (b1 & 0x80) !== 0;
    if (!masked) { this._fail(1002, "client frame must be masked"); return null; }

    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return undefined;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return undefined;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) { this._fail(1009, "frame too big"); return null; }
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_MESSAGE_BYTES) { this._fail(1009, "frame too big"); return null; }

    // 控制帧必须 ≤125 字节且不可分片
    if (opcode >= OP_CLOSE && (fin === false || len > 125)) {
      this._fail(1002, "invalid control frame");
      return null;
    }

    if (buf.length < offset + 4 + len) return undefined;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) payload[i] = buf[offset + i] ^ mask[i & 3];
    offset += len;

    this._buf = buf.subarray(offset);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === OP_PING) { this._writeFrame(OP_PONG, payload); return; }
    if (opcode === OP_PONG) return;

    if (opcode === OP_CLOSE) {
      let code = 1005;
      if (payload.length >= 2) code = payload.readUInt16BE(0);
      this.readyState = CLOSING;
      try { this._writeFrame(OP_CLOSE, payload.subarray(0, 2)); } catch { /* ignore */ }
      this.socket.end();
      this._finish(code);
      return;
    }

    if (opcode === OP_CONTINUATION) {
      if (this._fragments.length === 0) { this._fail(1002, "unexpected continuation"); return; }
      this._fragBytes += payload.length;
      if (this._fragBytes > MAX_MESSAGE_BYTES) { this._fail(1009, "message too big"); return; }
      this._fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this._fragments, this._fragBytes);
        const wasText = this._fragText;
        this._resetFragments();
        this._deliver(wasText, full);
      }
      return;
    }

    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this._fragments.length > 0) { this._fail(1002, "interleaved fragment"); return; }
      const isText = opcode === OP_TEXT;
      if (fin) { this._deliver(isText, payload); return; }
      this._fragments = [payload];
      this._fragBytes = payload.length;
      this._fragText = isText;
      return;
    }

    this._fail(1002, `unknown opcode ${opcode}`);
  }

  _resetFragments() {
    this._fragments = [];
    this._fragBytes = 0;
    this._fragText = false;
  }

  _deliver(isText, payload) {
    if (!isText) {
      this._emit("message", payload, true);
      return;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch {
      this._fail(1007, "invalid utf-8");
      return;
    }
    this._emit("message", text, false);
  }
}

/**
 * 完成握手并把 socket 升级为 {@link WsConnection}。
 * 失败时由本函数负责销毁 socket。
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:net").Socket} socket
 * @param {Buffer} head
 * @param {(conn: WsConnection, req: import("node:http").IncomingMessage) => void} onOpen
 * @returns {WsConnection | null}
 */
export function upgrade(req, socket, head, onOpen) {
  const header = (name) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const upgradeHeader = String(header("upgrade") ?? "").toLowerCase();
  const key = header("sec-websocket-key");
  const version = String(header("sec-websocket-version") ?? "");

  if (upgradeHeader !== "websocket" || !key || version !== "13") {
    try {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } catch { /* ignore */ }
    socket.destroy();
    return null;
  }

  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptValue(String(key))}`,
    "\r\n",
  ];
  try {
    socket.write(lines.join("\r\n"));
  } catch {
    socket.destroy();
    return null;
  }
  socket.setNoDelay(true);

  const conn = new WsConnection(socket);
  if (head && head.length > 0) conn._onData(head);
  try {
    onOpen(conn, req);
  } catch {
    conn.close(1011, "handler failed");
  }
  return conn;
}
