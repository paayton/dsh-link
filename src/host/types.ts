/**
 * host 段实际依赖的 DSH 上下文面（`ctx`）。
 *
 * 这是本次迁移的核心产物：**把摸出来的契约固化成类型**。
 * 之前踩的两个坑都能被它拦在编译期：
 *   · `sessionController.prompt(request, signal)` —— signal 是**必填**，漏传 → TypeError；
 *   · `fileUploads.upload(agent, request, signal)` —— 第三个参数是取消信号。
 *
 * 权威来源（版本与本机桌面版一致，均为 0.2.0-rc.2）：
 *   - `@deepseek-ai/dsh-api-session-controller`：`SessionController` 直接引用官方类型，
 *     见 node_modules/.../lib/types/index.d.ts:163 `prompt(request, signal: AbortSignal)`；
 *   - `fileUploads` / `connection` / `webServer` / `credentials` / `workspaceRegistry`
 *     官方类型未单独发布可引用的包，这里按其远程描述符与调用点写成**结构化类型**，
 *     只覆盖我们用到的成员，避免把 rc 版本的类型树整个拖进来。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type {
  SessionController,
  SessionFollowFrame,
} from "@deepseek-ai/dsh-api-session-controller";

export type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

/** `ctx.effect(fn, label)`：fn 的返回值若是函数，则在卸载时作为 disposer 执行。 */
export type EffectFn = () => void | (() => void);

/** 静态资源路由注册（@deepseek-ai/dsh-host-webserver）。 */
export type WebServerFace = {
  register(route: {
    kind: "prefix";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
  registerUpgrade(route: {
    path: string;
    handler: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
  }): () => void;
};

/**
 * `ctx.fileUploads`（@deepseek-ai/dsh-client-file-upload 的 host 半边）。
 * 签名来自其 typert 远程描述符：`parameters: [agent(lookup), request(json)]`，
 * `cancellation: { parameter: "signal" }` —— 取消参数按约定是**最后一个位置参数**。
 */
export type FileUploadsFace = {
  upload(
    agent: unknown,
    request: { data: string; name?: string },
    signal: AbortSignal,
  ): Promise<{
    receiptId: string;
    file: { attachmentId: string; name: string; bytes: number };
  }>;
};

/** `ctx.credentials`（@deepseek-ai/dsh-credentials）。 */
export type CredentialsFace = {
  readRecord(key: string): Promise<{ kind?: string; payload?: Record<string, unknown> } | undefined>;
  modifyRecord(
    key: string,
    mutate: (record: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>;
  deleteRecord(key: string): Promise<void>;
};

export type WorkspaceInfo = {
  id: string;
  path: string;
  title?: string;
  sessionIds?: string[];
};

/** `ctx.connection.admit(req)`：返回准入结果或 `{ rejection: number }`。 */
export type ConnectionFace = {
  admit(req: IncomingMessage): unknown;
};

/**
 * 我们用到的那部分 host 上下文。
 * 用 `sessionController: SessionController` 直接吃官方类型，其余为结构化类型。
 */
export type HostCtx = {
  logger?: Logger;
  on(event: string, handler: (...args: unknown[]) => void): () => void;
  effect(fn: EffectFn, label?: string): () => void;
  inject(deps: string[], callback: (ctx: HostCtx) => void): void;

  connection: ConnectionFace;
  credentials: CredentialsFace;
  sessionController: SessionController;
  workspaceRegistry: { list(): WorkspaceInfo[] };
  webServer: WebServerFace;
  fileUploads?: FileUploadsFace;
};

/** 门面方法的请求体类型：直接用官方签名反推，避免手抄出错。 */
export type SessionPromptRequest = Parameters<SessionController["prompt"]>[0];
export type SessionPageRequest = Parameters<SessionController["page"]>[0];
export type SessionFollowRequest = Parameters<SessionController["follow"]>[0];
export type SessionCreateRequest = Parameters<SessionController["create"]>[0];
export type SessionAttachmentRequest = Parameters<SessionController["attachment"]>[0];
export type SessionId = SessionPromptRequest["sessionId"];

/** 供 stream.ts 复用的转发帧字段。 */
export type FollowFrame = SessionFollowFrame;
export type FollowRequest = SessionFollowRequest;
