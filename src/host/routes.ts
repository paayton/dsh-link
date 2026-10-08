/**
 * HTTP 路由分发（两个服务端共用一套 handler）。
 *
 * 受众隔离：
 *  - `/m`（静态 H5）        —— 公开
 *  - `/m/api/*`（H5 数据）  —— 连接密钥（局域网侧强制要求已配置密钥）
 *  - `/m/link/*`（控制面）  —— 仅回环 + cookie；**绝不**在局域网服务端挂载
 */
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { lanInterfaces, tailscaleStatus } from "./net.js";
import type {
  HostCtx,
  FileUploadsFace,
  SessionPromptRequest,
  SessionPageRequest,
  SessionFollowRequest,
  SessionCreateRequest,
  SessionAttachmentRequest,
} from "./types.js";
import type { KeyStore } from "./key-store.js";

// 静态 H5 始终从 `src/public/` 提供，**不随构建搬到 dist**：
// 这些文件是"实时读盘 + 内容指纹自升级"的那部分，搬走就没法改完即生效。
// src/host/ 与 dist/host/ 距包根都是两层，所以这里向上两级再拼路径即可兼容两种布局。
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const STATIC_ROOT = resolve(PACKAGE_ROOT, "src/public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const MAX_BODY_BYTES = 1 * 1024 * 1024;
// 图片上传：base64 之后体积会膨胀约 1/3，因此请求体上限给到 18MB，解码后上限 12MB。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_BODY = 18 * 1024 * 1024;

export class LinkRoutes {
  ctx: HostCtx;
  keyStore: KeyStore;
  lanPort: () => number | undefined;
  lanEnabled: () => boolean;
  uploads?: () => FileUploadsFace | undefined;

  /**
   * @param {object} opts
   * @param {any} opts.ctx                 host 上下文
   * @param {import("./key-store.js").KeyStore} opts.keyStore
   * @param {() => number|undefined} opts.lanPort  局域网服务端端口（用于生成手机 URL）
   * @param {() => boolean} opts.lanEnabled
   */
  constructor({ ctx, keyStore, lanPort, lanEnabled, uploads }) {
    this.ctx = ctx;
    this.keyStore = keyStore;
    this.lanPort = lanPort;
    this.lanEnabled = lanEnabled;
    /** @type {() => any} 懒取 fileUploads 服务（桌面端没提供时为 undefined） */
    this.uploads = uploads;
  }

  // ────────────────────── 分发入口 ──────────────────────
  /**
   * @param req node 请求
   * @param res node 响应
   * @param {{ exposure: "loopback" | "lan" }} scope
   */
  async dispatch(req, res, scope) {
    const pathname = safePathname(req.url);
    try {
      if (pathname === "/m/api/ping") return await this.ping(req, res, scope);
      if (pathname === "/m/api/verify") return await this.verify(req, res);
      if (pathname === "/m/api/workspaces") return await this.workspaces(req, res, scope);
      if (pathname === "/m/api/messages") return await this.messages(req, res, scope);
      if (pathname === "/m/api/sessions") return await this.createSession(req, res, scope);
      if (pathname === "/m/api/prompt") return await this.prompt(req, res, scope);
      if (pathname === "/m/api/cancel") return await this.cancel(req, res, scope);
      if (pathname === "/m/api/upload") return await this.upload(req, res, scope);
      if (pathname === "/m/api/attachment") return await this.attachment(req, res, scope);
      if (pathname === "/m/api/answer") return await this.answer(req, res, scope);

      if (pathname.startsWith("/m/link/")) {
        // 控制面只在回环服务端提供，且需要桌面 cookie。
        if (scope.exposure !== "loopback") { res.writeHead(404); res.end(); return; }
        return await this.control(req, res, pathname);
      }

      // 其余 /m/* → 静态资源
      return await this.serveStatic(req, pathname, res);
    } catch (err) {
      this.ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)));
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
      else try { res.end(); } catch { /* ignore */ }
    }
  }

  // ────────────────────── 鉴权门 ──────────────────────
  keyFromRequest(req) {
    const header = req.headers["x-dsh-link-key"];
    if (typeof header === "string" && header) return header;
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
    return "";
  }

  /**
   * API 门控。返回 true 表示放行。
   * - 局域网侧未配置密钥 → 403（拒绝，避免把会话裸奔到网络）
   * - 已配置密钥 → 必须匹配，否则 401
   * - 回环侧且未配置密钥 → 放行（本机自测便利）
   */
  guardApi(req, res, scope) {
    if (!this.keyStore.enabled) {
      if (scope.exposure === "lan") {
        sendJson(res, 403, { ok: false, error: "link key required", code: "key-required" });
        return false;
      }
      return true; // 回环免密钥
    }
    if (!this.keyStore.matches(this.keyFromRequest(req))) {
      sendJson(res, 401, { ok: false, error: "invalid link key" });
      return false;
    }
    return true;
  }

  cookieGuard(req, res) {
    const admission = this.ctx.connection.admit(req) as
      | { rejection?: number }
      | undefined;
    if (admission && admission.rejection !== undefined) {
      res.writeHead(admission.rejection);
      res.end(admission.rejection === 401 ? "unauthorized" : "forbidden");
      return false;
    }
    return true;
  }

  // ────────────────────── /m/api/* ──────────────────────
  async ping(req, res, scope) {
    if (!this.keyStore.enabled) {
      // 未配置密钥：回环放行、局域网明确告知需要密钥。
      if (scope.exposure === "lan") return sendJson(res, 403, { ok: false, code: "key-required" });
      return sendJson(res, 200, { ok: true, keyRequired: false });
    }
    const ok = this.keyStore.matches(this.keyFromRequest(req));
    return sendJson(res, ok ? 200 : 401, { ok, keyRequired: true });
  }

  async verify(req, res) {
    const body = await readJson(req);
    const ok = this.keyStore.matches(String(body?.key ?? ""));
    return sendJson(res, ok ? 200 : 401, { ok });
  }

  async workspaces(req, res, scope) {
    if (!this.guardApi(req, res, scope)) return;
    const workspaces = this.ctx.workspaceRegistry.list().map((w) => ({
      id: w.id,
      path: w.path,
      title: w.title,
      sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
    }));
    let sessions = [];
    try {
      const result = await withSignal((signal) => this.ctx.sessionController.list({}, signal));
      sessions = Array.isArray(result?.items) ? result.items : [];
    } catch (err) {
      this.ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)));
    }
    return sendJson(res, 200, { workspaces, sessions });
  }

  async messages(req, res, scope) {
    if (!this.guardApi(req, res, scope)) return;
    const url = new URL(req.url, "http://x");
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
    const maxMessages = clampInt(url.searchParams.get("maxMessages"), 50, 1, 200);
    const beforeSeqRaw = url.searchParams.get("beforeSeq");

    try {
      if (beforeSeqRaw !== null) {
        const beforeSeq = Number(beforeSeqRaw);
        if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0) {
          return sendJson(res, 400, { ok: false, error: "beforeSeq invalid" });
        }
        const page = await withSignal((signal) => this.ctx.sessionController.page({
          // @ts-expect-error 官方把 address 收窄成 branded SessionId，这里跨边界收敛
          address: { kind: "session", sessionId },
          throughSeq: beforeSeq - 1,
          beforeSeq,
          maxMessages,
        }, signal));
        return sendJson(res, 200, { records: page?.records ?? [], hasMore: page?.hasMore ?? false });
      }
      // 初始历史：取 follow 的首帧 snapshot（用真实 cursor，且不激活 agent）。
      const snap = await this.readSnapshot(sessionId, maxMessages);
      return sendJson(res, 200, {
        records: snap.records,
        hasMore: snap.hasMore,
        cursor: snap.cursor,
      });
    } catch (err) {
      return sendJson(res, 200, { records: [], hasMore: false, error: remoteMessage(err) });
    }
  }

  /** 打开 follow，取到首帧 snapshot 后立即收束（不触发 promote，冷安全）。 */
  async readSnapshot(sessionId, maxMessages) {
    const ac = new AbortController();
    try {
      const iterator = this.ctx.sessionController.follow(
        { address: { kind: "session", sessionId }, maxMessages } as SessionFollowRequest,
        ac.signal,
      );
      for await (const frame of iterator) {
        if (frame && frame.type === "snapshot") {
          return { records: frame.records ?? [], hasMore: frame.hasMore ?? false, cursor: frame.cursor };
        }
        break; // 理论上首帧必为 snapshot
      }
      return { records: [], hasMore: false, cursor: -1 };
    } finally {
      ac.abort();
    }
  }

  async createSession(req, res, scope) {
    if (!this.guardApi(req, res, scope)) return;
    const body = await readJson(req);
    const request: Record<string, unknown> = {};
    if (typeof body?.sessionId === "string") request.sessionId = body.sessionId;
    if (typeof body?.workspaceId === "string") request.workspaceId = body.workspaceId;
    else if (typeof body?.cwd === "string") request.cwd = body.cwd;
    if (typeof body?.agentPreset === "string") request.agentPreset = body.agentPreset;
    try {
      const result = await this.ctx.sessionController.create(request as SessionCreateRequest);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: remoteMessage(err) });
    }
  }

  async prompt(req, res, scope) {
    if (!this.guardApi(req, res, scope)) return;
    const body = await readJson(req, MAX_UPLOAD_BODY);   // 图片内联在 body 里，可能几 MB
    const text = String(body?.text ?? "");
    const sessionId = body?.sessionId;
    const receiptIds = Array.isArray(body?.receiptIds)
      ? body.receiptIds.filter((id) => typeof id === "string" && id)
      : [];
    // 内联图片：{data: base64, mediaType, name}。落库后是 type:"image"，
    // 官方附件接口才认（type:"file" 收据那条路会被判 not-referenced，读不回来）。
    const images = (Array.isArray(body?.images) ? body.images : [])
      .map((img: any) => ({
        type: "image" as const,
        mediaType: String(img?.mediaType || "image/jpeg"),
        data: String(img?.data || "").replace(/^data:[^;]+;base64,/, ""),
        ...(img?.name ? { name: String(img.name) } : {}),
      }))
      .filter((img: any) => img.data && /^image\//.test(img.mediaType) && Buffer.byteLength(img.data, "base64") <= MAX_IMAGE_BYTES);
    if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
    if (!text.trim() && !receiptIds.length && !images.length) return sendJson(res, 400, { ok: false, error: "empty prompt" });
    try {
      const content: any[] = [];
      if (text.trim()) content.push({ type: "text", text });
      content.push(...images);
      for (const receiptId of receiptIds) content.push({ type: "file", receiptId });
      // 注意：sessionController 的 Remote 门面签名是 prompt(request, signal)，
      // 方法体第一行就是 signal.throwIfAborted()。走 RPC 时网关会自动补 signal，
      // 进程内直调必须自己传，否则直接 TypeError（这条以前踩过）。
      const result = await this.ctx.sessionController.prompt({
        requestId: typeof body?.requestId === "string" ? body.requestId : randomUUID(),
        sessionId,
        mode: body?.mode === "steer" ? "steer" : "queue",
        content: content as SessionPromptRequest["content"],
        ...(typeof body?.clientTimeZone === "string" ? { clientTimeZone: body.clientTimeZone } : {}),
      }, new AbortController().signal);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: remoteMessage(err) });
    }
  }

  /**
   * 图片上传 → fileUploads 收据。
   * body: { sessionId, data(base64，可带 data: 前缀), name? }
   */
  async upload(req, res, scope) {
    if (!this.guardApi(req, res, scope)) return;
    let body;
    try {
      body = await readJson(req, MAX_UPLOAD_BODY);
    } catch (err) {
      return sendJson(res, 413, { ok: false, error: remoteMessage(err) });
    }
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const name = typeof body?.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 200)
      : "image.jpg";
    let data = typeof body?.data === "string" ? body.data.trim() : "";
    if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
    if (!data) return sendJson(res, 400, { ok: false, error: "data required" });

    const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/.exec(data);
    if (dataUrl) data = dataUrl[2];
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) {
      return sendJson(res, 400, { ok: false, error: "data must be base64" });
    }
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) return sendJson(res, 400, { ok: false, error: "empty image" });
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return sendJson(res, 413, { ok: false, error: `image too large (${bytes.length} bytes, max ${MAX_UPLOAD_BYTES})` });
    }

    const uploads = this.uploads?.();
    if (!uploads || typeof uploads.upload !== "function") {
      return sendJson(res, 503, { ok: false, error: "图片上传服务不可用（桌面版未提供 fileUploads）" });
    }
    let resolvedSource = "resolving";
    try {
      // fileUploads.upload 的签名来自 typert 描述符：
      //   upload(agent, { data, name }, signal)
      // —— 第一个参数是**解析后的 agent 对象**（远端调用时由 agentId 查表得到，这里要自己解析），
      //    第三个是取消信号（实现第一件事就是 signal.throwIfAborted()，不传就直接 TypeError）。
      const resolved = await this.resolveAgent(sessionId);
      resolvedSource = resolved.source;
      const signal = new AbortController().signal;
      const value = await uploads.upload(resolved.agent, { data, name }, signal);
      return sendJson(res, 200, {
        ok: true,
        receiptId: value?.receiptId ?? null,
        file: value?.file ?? null,
        bytes: bytes.length,
      });
    } catch (err) {
      // 带上 agent 解析方式，下一次出错能直接看出卡在哪一步
      return sendJson(res, 400, { ok: false, error: `${remoteMessage(err)} [agent=${resolvedSource}]` });
    }
  }

  /**
   * sessionId → agent 对象。
   * 走的就是 session-controller 注册给 fileUploads 的那条解析路径
   * （`this.agents.resolveAgent(sessionId)`），拿不到时退回原始 id。
   */
  async resolveAgent(sessionId) {
    // `agents` 在官方类型里是 private；这里是刻意的内部访问，
    // 用的正是 session-controller 注册给 fileUploads 的那条解析路径。
    const controller = this.ctx.sessionController as unknown as {
      agents?: { resolveAgent(id: string): Promise<{ agent?: unknown; error?: unknown }> };
    };
    const resolve = controller?.agents?.resolveAgent;
    if (typeof resolve !== "function") return { agent: sessionId, source: "raw" };
    try {
      const result = await resolve.call(controller.agents, sessionId);
      if (result && typeof result === "object" && "error" in result) throw result.error;
      if (result?.agent) return { agent: result.agent, source: "resolved" };
    } catch (err) {
      throw new Error(`无法解析会话 ${sessionId}：${remoteMessage(err)}`);
    }
    return { agent: sessionId, source: "raw" };
  }

  /** 读取会话里的附件（历史消息里的图片要能显示）。 */
  async attachment(req, res, scope) {
    if (!this.guardApi(req, res, scope)) return;
    const url = new URL(req.url, "http://x");
    const sessionId = url.searchParams.get("sessionId");
    const attachmentId = url.searchParams.get("attachmentId");
    if (!sessionId || !attachmentId) {
      return sendJson(res, 400, { ok: false, error: "sessionId & attachmentId required" });
    }
    const controller = this.ctx.sessionController;
    if (typeof controller?.attachment !== "function") {
      return sendJson(res, 503, { ok: false, error: "当前 host 不支持读取附件" });
    }
    try {
      const value = await controller.attachment({ sessionId, attachmentId } as SessionAttachmentRequest);
      const raw: unknown = value?.data;
      const data = typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array || Buffer.isBuffer(raw)
          ? Buffer.from(raw).toString("base64")
          : "";
      return sendJson(res, 200, { ok: true, attachment: value?.attachment ?? null, data });
    } catch (err) {
      // 只走官方路径：图片现在内联发送，落库就是 type:"image"，
      // 官方授权认它（type:"file" 收据那条老路已废弃，历史图不再兼容）。
      return sendJson(res, 400, { ok: false, error: remoteMessage(err) });
    }
  }

  /**
   * 回答 ask_user_question：转给官方 `ctx.remote.userQuestions.answer(agent, callId, answer)`，
   * 直接让待决的那个 tool call 收到答案（而不是往会话里插一条消息）。
   * 契约来自 @deepseek-ai/dsh-user-questions：
   *   AskUserQuestionAnswer = { answers: [{ id, selected: string[], custom?: string }] }
   */
  async answer(req, res, scope) {
    if (!this.guardApi(req, res, scope)) return;
    const body = await readJson(req);
    const sessionId = String(body?.sessionId ?? "");
    const callId = String(body?.callId ?? "");
    if (!sessionId || !callId) return sendJson(res, 400, { ok: false, error: "sessionId & callId required" });

    const answers = (Array.isArray(body?.answers) ? body.answers : [])
      .map((a: any) => ({
        id: String(a?.id ?? ""),
        selected: (Array.isArray(a?.selected) ? a.selected : []).map((v: unknown) => String(v)).filter(Boolean),
        ...(a?.custom ? { custom: String(a.custom) } : {}),
      }))
      .filter((a: any) => a.id && (a.selected.length || a.custom));
    if (!answers.length) return sendJson(res, 400, { ok: false, error: "answers required" });

    // 注意：**连 `ctx.remote` 的属性访问都要放进 try**——这类网关代理在未授权/未就绪时
    // 取值本身就会抛错（实测：访问在 try 外时异常逃逸，被外层兜成 "internal error"，
    // 我们自己的诊断信息根本没机会返回）。
    try {
      const remote = (this.ctx as unknown as { remote?: { userQuestions?: { answer?: (...args: unknown[]) => unknown } } })
        .remote?.userQuestions;
      if (typeof remote?.answer !== "function") {
        return sendJson(res, 503, { ok: false, code: "unsupported", error: "桌面版未提供 userQuestions.answer" });
      }
      // 契约以桌面端源码为准：
      //   ctx.remote.userQuestions.answer(sessionId, callId, answer) -> { ok, value } | { ok:false, error }
      // 类型声明写的 `agent` 与实际不符（实测传 agent 会 internal error）。
      const raw = (await remote.answer(sessionId, callId, { answers })) as
        | { ok?: boolean; value?: unknown; error?: { message?: string } | string }
        | boolean;
      if (raw && typeof raw === "object" && "ok" in raw) {
        if (raw.ok === false) {
          const detail = typeof raw.error === "string" ? raw.error : raw.error?.message;
          return sendJson(res, 409, { ok: false, error: detail || "该提问已超时或被其它端回答" });
        }
        return sendJson(res, 200, { ok: true, accepted: true });
      }
      if (raw === false) return sendJson(res, 409, { ok: false, error: "该提问已超时或被其它端回答" });
      return sendJson(res, 200, { ok: true, accepted: true });
    } catch (err) {
      // 网关会把插件内部错误包成 "internal error"，排查期把原始信息一起带出来
      const e = err as { code?: unknown; message?: unknown; cause?: unknown; stack?: unknown };
      const detail = {
        error: remoteMessage(err),
        code: typeof e?.code === "string" ? e.code : undefined,
        message: typeof e?.message === "string" ? e.message : undefined,
        cause: e?.cause === undefined ? undefined : String(e.cause).slice(0, 300),
        stack: typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 4).join(" | ") : undefined,
      };
      this.ctx.logger?.warn?.("dsh-link answer failed", JSON.stringify(detail));
      return sendJson(res, 400, { ok: false, ...detail });
    }
  }

  async cancel(req, res, scope) {
    if (!this.guardApi(req, res, scope)) return;
    const body = await readJson(req);
    if (!body?.sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
    try {
      const result = this.ctx.sessionController.cancel({ sessionId: body.sessionId });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: remoteMessage(err) });
    }
  }

  // ────────────────────── /m/link/* （控制面）──────────────────────
  async control(req, res, pathname) {
    if (!this.cookieGuard(req, res)) return;
    if (pathname === "/m/link/status") return sendJson(res, 200, await this.status());
    if (pathname === "/m/link/generate-key") {
      const key = await this.keyStore.generate();
      return sendJson(res, 200, { ok: true, key });
    }
    if (pathname === "/m/link/clear-key") {
      await this.keyStore.clear();
      return sendJson(res, 200, { ok: true });
    }
    res.writeHead(404);
    res.end();
  }

  async status() {
    const port = this.lanPort();
    const enabled = this.lanEnabled();
    const lan = lanInterfaces();
    const ts = await tailscaleStatus();
    const mkUrl = (host) => (port ? `http://${host}:${port}/m/` : null);
    return {
      keySet: this.keyStore.enabled,
      lanServer: { enabled, port: port ?? null },
      lan: {
        interfaces: lan,
        urls: enabled && port ? lan.map((i) => ({ name: i.name, address: i.address, url: mkUrl(i.address) })) : [],
      },
      tailscale: {
        available: ts.available,
        running: ts.running,
        online: ts.online,
        dnsName: ts.dnsName,
        ips: ts.ips,
        health: ts.health,
        version: ts.version ?? null,
        urls: enabled && port && ts.dnsName ? [mkUrl(ts.dnsName)] : [],
        error: ts.error ?? null,
      },
    };
  }

  // ────────────────────── 静态 H5 ──────────────────────
  /**
   * 静态资源：内容哈希 ETag + `no-cache`。
   *
   * 浏览器每次都会带 `If-None-Match` 来问一句，没变就 304（约 100 字节），
   * 变了就自动拿到新文件——所以既不会读到旧 H5，也不需要 `?v=N` 这种手写版本号。
   * 图片/字体另加长缓存（它们基本不会变，且不参与构建号）。
   */
  async serveStatic(req, pathname, res) {
    let rel = pathname === "/m" || pathname === "/m/" ? "/index.html" : pathname.slice("/m".length);
    if (!rel.startsWith("/")) rel = "/" + rel;
    const abs = resolve(STATIC_ROOT, "." + rel);
    if (abs !== STATIC_ROOT && !abs.startsWith(STATIC_ROOT + sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const info = await stat(abs);
      if (info.isDirectory()) return await this.serveStatic(req, "/m/index.html", res);
      const body = await readFile(abs);
      const ext = extname(abs).toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
      const immutable = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff2"].includes(ext);
      const cache = immutable ? "public, max-age=86400" : "no-cache";

      if (freshEnough(req.headers["if-none-match"], etag)) {
        res.writeHead(304, { etag, "cache-control": cache });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": type,
        "cache-control": cache,
        etag,
        "content-length": String(body.length),
      });
      res.end(body);
    } catch {
      // SPA 无路由，缺失即 404（但根路径已在上面兜底为 index.html）
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  }
}

/** 客户端 `If-None-Match` 是否覆盖当前 ETag（支持弱校验前缀与逗号列表）。 */
function freshEnough(header, etag) {
  if (typeof header !== "string" || !header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => {
    const t = tag.trim();
    return t === etag || t === `W/${etag}`;
  });
}



// ────────────────────── 工具函数 ──────────────────────
function safePathname(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://x").pathname;
  } catch {
    return "/";
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: import("node:http").IncomingMessage, limit = MAX_BODY_BYTES): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}

/** 用一次性 AbortController 包裹一个必须传 signal 的调用；结束后中止清理。 */
async function withSignal(fn) {
  const ac = new AbortController();
  try {
    return await fn(ac.signal);
  } finally {
    ac.abort();
  }
}

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function remoteMessage(err) {
  if (!err) return "unknown error";
  if (typeof err.message === "string") return err.message;
  return String(err);
}
