/**
 * 网络探测：内网 IPv4 与 Tailscale 状态。
 *
 * 内网地址只取「真实」物理/无线接口；utun/awdl/llw/bridge 等虚拟接口一律跳过，
 * 因为 Tailscale 的 100.x 地址由 `tailscale status --json` 单独提供，混进来只会
 * 让面板里出现连不上的地址。
 */
import { networkInterfaces } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** macOS 上 Tailscale CLI 的几个已知落点（App Store 版路径与 brew 版不同）。 */
const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/tailscale",
];

/** 虚拟接口前缀黑名单。 */
const VIRTUAL_PREFIXES = ["utun", "awdl", "llw", "bridge", "ap", "gif", "stf", "anpi", "vmenet", "vnic"];

export type TailscaleStatus = {
  available: boolean;
  running: boolean;
  online: boolean;
  dnsName: string | null;
  ips: string[];
  health: string[];
  version?: string;
  error?: string;
};

function isVirtualInterface(name: string) {
  const lower = name.toLowerCase();
  return VIRTUAL_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * 列出可用的内网 IPv4 地址。
 * @returns {{name: string, address: string}[]}
 */
export function lanInterfaces(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  let tables: NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>;
  try {
    tables = networkInterfaces();
  } catch {
    return out;
  }
  for (const [name, addrs] of Object.entries(tables)) {
    if (isVirtualInterface(name)) continue;
    for (const addr of addrs ?? []) {
      // Node 18 起 family 恒为字符串 "IPv4"；旧版本可能是数字 4。
      const family = String(addr.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (addr.internal) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

/**
 * 探一次 Tailscale 状态。未安装 / 未登录 / 命令超时一律走「未运行」分支，
 * 绝不抛出。
 *
 * @param {number} timeoutMs
 * @returns {Promise<{available: boolean, running: boolean, online: boolean,
 *   dnsName: string|null, ips: string[], health: string[], version?: string, error?: string}>}
 */
export async function tailscaleStatus(timeoutMs = 2500): Promise<TailscaleStatus> {
  const empty: TailscaleStatus = {
    available: false,
    running: false,
    online: false,
    dnsName: null,
    ips: [],
    health: [],
  };

  let lastError = "tailscale CLI 未找到";
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(bin, ["status", "--json"], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        lastError = "tailscale status 返回了非 JSON 输出";
        continue;
      }
      const self = json.Self ?? {};
      return {
        available: true,
        running: json.BackendState === "Running",
        online: self.Online === true,
        dnsName: typeof self.DNSName === "string" && self.DNSName ? self.DNSName.replace(/\.$/, "") : null,
        ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((x) => typeof x === "string") : [],
        health: Array.isArray(json.Health) ? json.Health.filter((x) => typeof x === "string") : [],
        version: typeof json.Version === "string" ? json.Version : undefined,
      };
    } catch (err) {
      lastError = err && err.code === "ENOENT" ? "tailscale CLI 未找到" : String(err && err.message ? err.message : err);
    }
  }
  return { ...empty, error: lastError };
}
