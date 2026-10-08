/**
 * WebSocket 流式桥：把 `sessionController.follow(...)` 的帧转发给手机 H5。
 *
 * 协议（客户端 → 服务端，均为 JSON 文本帧）：
 *   { type: "auth", key }                首帧鉴权（配置了密钥时必需）
 *   { type: "follow", sessionId }        开始跟随一个会话
 *   { type: "unfollow", sessionId }      停止跟随
 *   { type: "ping" }                     应用层保活（回 { type:"pong" }）
 *
 * 服务端 → 客户端：
 *   { type: "ready", keyRequired }       连接建立
 *   { type: "opened", sessionId }        跟随已建立
 *   { type: "frame", sessionId, frame }  follow 帧（snapshot / event / assistant-stream）
 *   { type: "error", sessionId?, message }
 */

import type { HostCtx } from "./types.js";
import type { KeyStore } from "./key-store.js";

/** 一条已建立的应用层连接（ws-mini 的 WsConnection）。 */
export interface LinkConnection {
  authed: boolean;
  scope: { exposure: "loopback" | "lan" };
  follows: Map<string, AbortController>;
  ws: import("./ws-mini.js").WsConnection;
}

export class StreamHub {
  ctx: HostCtx;
  keyStore: KeyStore;
  connections: Set<LinkConnection>;

  /**
   * @param {object} opts
   * @param {any} opts.ctx
   * @param {import("./key-store.js").KeyStore} opts.keyStore
   */
  constructor({ ctx, keyStore }) {
    this.ctx = ctx;
    this.keyStore = keyStore;
    /** @type {Set<object>} 活跃连接 */
    this.connections = new Set();
  }

  /**
   * 处理一条新升级的 WebSocket 连接。
   * @param {import("./ws-mini.js").WsConnection} ws
   * @param {{ exposure: "loopback" | "lan" }} scope
   */
  attach(ws, scope) {
    const conn = {
      ws,
      scope,
      authed: !this.keyStore.enabled && scope.exposure === "loopback",
      follows: new Map(), // sessionId -> AbortController
    };
    this.connections.add(conn);

    send(ws, { type: "ready", keyRequired: this.keyStore.enabled });

    ws.on("message", (data) => {
      if (typeof data !== "string") return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this._onMessage(conn, msg).catch((err) => {
        this.ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)));
      });
    });

    ws.on("close", () => {
      for (const ac of conn.follows.values()) { try { ac.abort(); } catch { /* ignore */ } }
      conn.follows.clear();
      this.connections.delete(conn);
    });
  }

  async _onMessage(conn, msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "auth") {
      if (!this.keyStore.enabled) {
        // 未配置密钥：回环放行；局域网侧不应发生（服务端不会在无密钥时开放局域网 API），保守拒绝。
        conn.authed = conn.scope.exposure === "loopback";
      } else {
        conn.authed = this.keyStore.matches(String(msg.key ?? ""));
      }
      if (!conn.authed) { conn.ws.close(4401, "invalid link key"); return; }
      send(conn.ws, { type: "authed" });
      return;
    }

    if (msg.type === "ping") { send(conn.ws, { type: "pong" }); return; }

    if (!conn.authed) {
      conn.ws.close(4401, "authentication required");
      return;
    }

    if (msg.type === "follow" && typeof msg.sessionId === "string") {
      this._startFollow(conn, msg.sessionId);
      return;
    }
    if (msg.type === "unfollow" && typeof msg.sessionId === "string") {
      this._stopFollow(conn, msg.sessionId);
      return;
    }
  }

  _stopFollow(conn, sessionId) {
    const ac = conn.follows.get(sessionId);
    if (ac) { try { ac.abort(); } catch { /* ignore */ } conn.follows.delete(sessionId); }
  }

  _startFollow(conn, sessionId) {
    this._stopFollow(conn, sessionId); // 幂等重连
    const ac = new AbortController();
    conn.follows.set(sessionId, ac);
    send(conn.ws, { type: "opened", sessionId });

    (async () => {
      try {
        const iterator = this.ctx.sessionController.follow(
          { address: { kind: "session", sessionId }, assistantStream: true },
          ac.signal,
        );
        for await (const frame of iterator) {
          if (ac.signal.aborted) break;
          if (conn.ws.readyState !== 1 /* OPEN */) break;
          send(conn.ws, { type: "frame", sessionId, frame });
        }
      } catch (err) {
        if (!ac.signal.aborted && conn.ws.readyState === 1) {
          send(conn.ws, { type: "error", sessionId, message: errText(err) });
        }
      } finally {
        if (conn.follows.get(sessionId) === ac) conn.follows.delete(sessionId);
      }
    })();
  }

  /** 关停：断开所有连接。 */
  dispose() {
    for (const conn of this.connections) {
      for (const ac of conn.follows.values()) { try { ac.abort(); } catch { /* ignore */ } }
      try { conn.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

function errText(err) {
  if (!err) return "unknown error";
  if (typeof err.message === "string") return err.message;
  return String(err);
}
