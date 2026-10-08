/**
 * 连接密钥的持久化与常数时间校验。
 *
 * 存储走 `ctx.credentials`：与浏览器 cookie 签名密钥同一层级（跨进程独占写、
 * 落盘持久化），因此密钥在桌面版重启后依然有效。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { HostCtx } from "./types.js";

const SCOPE = "dsh-link";
const ID = "link-key";

/**
 * `credentialKey(scope, id)` 在运行时就是 `` `${scope}/${id}` ``（品牌只存在于
 * TS 类型层）。优先用官方实现；官方包在当前插件路径下可能不可解析（裸模块
 * 解析不到 profile 的 node_modules），此时退回等价字符串。
 */
let credentialKey = (scope, id) => `${scope}/${id}`;
try {
  const mod = await import("@deepseek-ai/dsh-credentials");
  if (typeof mod?.credentialKey === "function") credentialKey = mod.credentialKey;
} catch {
  // 保持等价实现
}

export const LINK_KEY_RECORD = credentialKey(SCOPE, ID);

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

/** 生成一枚人可手输的连接密钥。 */
export function generateLinkKey() {
  return `link-${randomBytes(18).toString("base64url")}`;
}

export class KeyStore {
  ctx: HostCtx;
  /** 当前密钥的 sha256 */
  digest: Buffer | undefined;
  /** 是否已配置密钥 */
  enabled: boolean;

  /** @param {any} ctx host 上下文 */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Buffer|undefined} 当前密钥的 sha256 */
    this.digest = undefined;
    /** @type {boolean} 是否已配置密钥 */
    this.enabled = false;
  }

  /** 从 credentials 重新载入密钥（启动时、以及每次生成/清除后调用）。 */
  async load() {
    let secret;
    try {
      const record = await this.ctx.credentials.readRecord(LINK_KEY_RECORD);
      const payload = record && record.payload;
      if (payload && typeof payload.secret === "string" && payload.secret.length > 0) {
        secret = payload.secret;
      }
    } catch (err) {
      this.ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)));
      secret = undefined;
    }
    this.digest = secret === undefined ? undefined : sha256(secret);
    this.enabled = this.digest !== undefined;
    return this.enabled;
  }

  /** 常数时间比较候选密钥。未配置密钥时恒为 false。 */
  matches(candidate) {
    if (this.digest === undefined) return false;
    if (typeof candidate !== "string" || candidate.length === 0) return false;
    const actual = sha256(candidate);
    if (actual.length !== this.digest.length) return false;
    return timingSafeEqual(actual, this.digest);
  }

  /** 写入一枚新密钥并立即生效。返回明文（仅在生成时展示一次）。 */
  async set(secret) {
    await this.ctx.credentials.modifyRecord(LINK_KEY_RECORD, () =>
      Promise.resolve({ kind: "grant", payload: { secret, createdAt: new Date().toISOString() } }));
    await this.load();
    return secret;
  }

  /** 生成并保存一枚新密钥。 */
  async generate() {
    return this.set(generateLinkKey());
  }

  /** 清除密钥。此后本机回环免密钥，局域网侧将拒绝一切 API 调用。 */
  async clear() {
    await this.ctx.credentials.deleteRecord(LINK_KEY_RECORD);
    await this.load();
  }
}
