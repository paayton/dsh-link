/**
 * dsh-link · host 段
 *
 * 形态：Cordis 纯函数插件（`apply` + `inject` + `name`，对齐官方
 * `@deepseek-ai/dsh-client-connection` 的写法），进程内全权限，零第三方依赖。
 *
 * 挂两处监听：
 *  1. 回环 `ctx.webServer`（桌面版 127.0.0.1:19387）：挂 `/m` 全量路由。
 *     `/m/link/*` 控制面仅在此暴露，天然与设置页同源、走 cookie 鉴权；
 *     本机也可用 `http://127.0.0.1:19387/m/` 自测。
 *  2. 自建 LAN 监听（默认 0.0.0.0:19388）：给手机用，只挂 `/m`（静态 + `/m/api/*`），
 *     **不挂** `/m/link/*`。DSH 官方禁止把主 webServer 绑到 0.0.0.0（会把 RCE 暴露到
 *     网络），因此桥自建这道受密钥保护的、只读/聊天用途的窄口。
 */
import { createServer } from "node:http";
import { KeyStore } from "./key-store.js";
import { LinkRoutes } from "./routes.js";
import { StreamHub } from "./stream.js";
import { upgrade as wsUpgrade } from "./ws-mini.js";

export const name = "dsh-link";

export const inject = [
  "webServer",
  "connection",
  "sessionController",
  "workspaceRegistry",
  "credentials",
];

const DEFAULTS = {
  lanEnabled: true,
  lanPort: 19388,
  bindHost: "127.0.0.1", // 安全默认：仅回环。手机接入需显式改为 "0.0.0.0"（见 cordis.patch.yml）。
};

function normalizeConfig(config) {
  const c = config ?? {};
  const lanPort = Number.isInteger(c.lanPort) && c.lanPort > 0 && c.lanPort < 65536 ? c.lanPort : DEFAULTS.lanPort;
  return {
    lanEnabled: c.lanEnabled === undefined ? DEFAULTS.lanEnabled : Boolean(c.lanEnabled),
    lanPort,
    bindHost: typeof c.bindHost === "string" && c.bindHost ? c.bindHost : DEFAULTS.bindHost,
  };
}

export async function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const log = ctx.logger ?? console;

  const keyStore = new KeyStore(ctx);
  await keyStore.load();

  // 外部编辑密钥记录时热重载（README: credentials/record-updated）。
  if (typeof ctx.on === "function") {
    ctx.effect(() => ctx.on("credentials/record-updated", () => {
      keyStore.load().catch((err) => log.warn?.(err instanceof Error ? err : new Error(String(err))));
    }), "dsh-link: watch credential record");
  }

  const runtime = { lanPort: undefined, uploads: undefined };
  const routes = new LinkRoutes({
    ctx,
    keyStore,
    lanPort: () => runtime.lanPort,
    lanEnabled: () => cfg.lanEnabled,
    uploads: () => runtime.uploads,
  });
  const hub = new StreamHub({ ctx, keyStore });

  // ── 0) 图片上传：fileUploads 是 web-app bundle 提供的服务。
  //     这里用「可选注入」而不是写进 inject 列表——即使某个 profile 没有它，
  //     dsh-link 也照常工作，只是 /m/api/upload 返回 503。 ──
  ctx.inject(["fileUploads"], (uploadCtx) => {
    runtime.uploads = uploadCtx.fileUploads;
    uploadCtx.effect(() => () => { runtime.uploads = undefined; }, "dsh-link: fileUploads");
  });

  // ── 1) 回环：挂到桌面版主 webServer ──
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: "prefix",
        path: "/m",
        handler: (req, res) => routes.dispatch(req, res, { exposure: "loopback" }),
      }),
      "dsh-link: /m loopback routes",
    );
    webCtx.effect(
      () => webCtx.webServer.registerUpgrade({
        path: "/m/api/stream",
        handler: (req, socket, head) => {
          wsUpgrade(req, socket, head, (ws) => hub.attach(ws, { exposure: "loopback" }));
        },
      }),
      "dsh-link: /m/api/stream loopback ws",
    );
  });

  // ── 2) 自建 LAN 监听 ──
  if (cfg.lanEnabled) {
    ctx.effect(() => startLanServer({ cfg, routes, hub, runtime, log }), "dsh-link: LAN server");
  } else {
    log.info?.("dsh-link: LAN server disabled by config; phone access via loopback only");
  }

  // ── 关停时断开所有流 ──
  ctx.effect(() => () => hub.dispose(), "dsh-link: stream hub teardown");

  log.info?.(`dsh-link ready (LAN ${cfg.lanEnabled ? `${cfg.bindHost}:${cfg.lanPort}` : "off"}, key ${keyStore.enabled ? "set" : "unset"})`);
}

/**
 * 起 LAN HTTP + WS 监听，返回 disposer。
 * 端口占用/权限错误只记日志，不让插件加载失败。
 */
function startLanServer({ cfg, routes, hub, runtime, log }) {
  const server = createServer((req, res) => {
    const pathname = pathnameOf(req.url);
    if (pathname === "/m" || pathname.startsWith("/m/")) {
      routes.dispatch(req, res, { exposure: "lan" }).catch((err) => {
        log.warn?.(err instanceof Error ? err : new Error(String(err)));
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    } else {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("dsh-link: not found");
    }
  });

  server.on("upgrade", (req, socket, head) => {
    if (pathnameOf(req.url) !== "/m/api/stream") { socket.destroy(); return; }
    wsUpgrade(req, socket, head, (ws) => hub.attach(ws, { exposure: "lan" }));
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    runtime.lanPort = undefined;
    if (err && err.code === "EADDRINUSE") {
      log.error?.(`dsh-link: LAN port ${cfg.lanPort} in use; phone access unavailable until freed or reconfigured`);
    } else {
      log.error?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  server.listen(cfg.lanPort, cfg.bindHost, () => {
    const address = server.address();
    runtime.lanPort = address && typeof address === "object" ? address.port : cfg.lanPort;
    log.info?.(`dsh-link: LAN server listening on ${cfg.bindHost}:${runtime.lanPort}`);
  });

  return () => {
    runtime.lanPort = undefined;
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    server.close();
  };
}

function pathnameOf(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://x").pathname;
  } catch {
    return "/";
  }
}

export default { name, inject, apply };
