/**
 * dsh-link · 客户端段（桌面版设置页「Link」栏）
 *
 * 产物格式对齐 DSH 客户端插件加载器：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 内以 `require("react")` 取 React。因此本文件是**手写的最终产物**（无需构建工具）。
 *
 * 与 host 段通信：同源 `fetch('/m/link/*')`（桌面版 127.0.0.1:19387，cookie 已认证）。
 */
window.__ModuleLoader__.load({
  id: "dsh-link/client",
  factory: (require) => {
    "use strict";
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const LOCALE_NS = "settings.link";

    const zh = {
      nav: "Link · 手机连接",
      title: "Link · 手机连接",
      intro: "让手机浏览器打开一个极简 H5，与桌面版当前会话聊天。仅需内网或 Tailscale 可达 + 一枚连接密钥。",
      lanServer: "手机接入服务",
      lanOn: "运行中",
      lanOff: "已关闭",
      lanPort: "端口",
      lanDisabled: "手机接入服务未开启（在插件配置中设置 lanEnabled: true）。",
      lanPortBusy: "端口被占用，手机暂时无法接入。换个端口或释放占用后重启桌面版。",
      lanAddr: "内网地址",
      noLan: "未检测到内网地址（未连 Wi-Fi？）",
      tailscale: "Tailscale",
      tsRunning: "运行中",
      tsOffline: "未在线",
      tsNotInstalled: "未安装或未登录",
      tsInstallHint: "手机与 Mac 登录同一 Tailscale 账号后，用下面的地址访问最安全。",
      key: "连接密钥",
      keySet: "已启用",
      keyUnset: "未启用",
      keyIntro: "生成密钥后，手机首次连接需输入一次（自动保存）。清除密钥后局域网侧将拒绝一切访问。",
      generate: "生成密钥",
      regenerate: "重新生成",
      clear: "清除密钥",
      copy: "复制",
      copied: "已复制",
      keyOnce: "请立即复制，此密钥只完整显示这一次：",
      openUrl: "手机浏览器打开：",
      steps: "手机连接步骤",
      step1: "手机与 Mac 连同一 Wi-Fi，或登录同一 Tailscale 账号。",
      step2: "生成连接密钥并复制。",
      step3: "手机浏览器打开上面任一地址（Tailscale 更安全）。",
      step4: "输入密钥，进入会话边栏，开始聊天。",
      refresh: "刷新状态",
      loading: "读取中…",
      error: "读取状态失败：",
      secWarn: "内网 HTTP 为明文传输，仅建议在可信网络使用；对安全有要求请走 Tailscale。",
      copyFail: "复制失败，请手动长按选择。",
    };

    const en = {
      nav: "Link · Mobile",
      title: "Link · Connect from phone",
      intro: "Open a minimal H5 page on your phone to chat with the desktop app's live sessions. Needs LAN/Tailscale reachability plus a connection key.",
      lanServer: "Phone access service",
      lanOn: "running",
      lanOff: "off",
      lanPort: "port",
      lanDisabled: "Phone access service is off (set lanEnabled: true in the plugin config).",
      lanPortBusy: "The port is in use; phones cannot connect until it is freed or reconfigured, then restart the desktop app.",
      lanAddr: "LAN address",
      noLan: "No LAN address detected (not on Wi-Fi?)",
      tailscale: "Tailscale",
      tsRunning: "running",
      tsOffline: "offline",
      tsNotInstalled: "not installed or signed out",
      tsInstallHint: "Sign your phone into the same Tailscale account, then use the address below for the safest link.",
      key: "Connection key",
      keySet: "enabled",
      keyUnset: "disabled",
      keyIntro: "After generating a key, the phone enters it once (auto-saved). Clearing it makes the LAN side reject everything.",
      generate: "Generate key",
      regenerate: "Regenerate",
      clear: "Clear key",
      copy: "Copy",
      copied: "Copied",
      keyOnce: "Copy it now — the full key is shown only this once:",
      openUrl: "Open on your phone:",
      steps: "Steps",
      step1: "Put the phone on the same Wi-Fi, or sign into the same Tailscale account.",
      step2: "Generate and copy the connection key.",
      step3: "Open one of the addresses above on the phone (Tailscale is safer).",
      step4: "Enter the key, open the session sidebar, start chatting.",
      refresh: "Refresh",
      loading: "Loading…",
      error: "Failed to read status: ",
      secWarn: "LAN HTTP is plaintext; use it only on trusted networks. Prefer Tailscale when security matters.",
      copyFail: "Copy failed — long-press to select manually.",
    };

    // ── 与 host 段通信 ──
    async function getJson(url, opts) {
      const res = await fetch(url, { credentials: "same-origin", cache: "no-store", ...opts });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }
    const ops = {
      status: () => getJson("/m/link/status"),
      generateKey: () => getJson("/m/link/generate-key", { method: "POST" }),
      clearKey: () => getJson("/m/link/clear-key", { method: "POST" }),
    };

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch { /* fall through */ }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch { return false; }
    }

    // ── 小组件 ──
    function Dot({ color }) {
      return h("span", {
        style: {
          display: "inline-block", width: 8, height: 8, borderRadius: "50%",
          background: color, marginRight: 8, flex: "0 0 auto",
        },
      });
    }

    function Row({ children, style }) {
      return h("div", { style: { display: "flex", alignItems: "center", gap: 8, margin: "6px 0", flexWrap: "wrap", ...style } }, children);
    }

    function Card({ title, children }) {
      return h("section", {
        style: {
          border: "1px solid var(--dsh-border, rgba(128,128,128,.25))",
          borderRadius: 12, padding: "14px 16px", margin: "12px 0",
          background: "var(--dsh-surface, rgba(128,128,128,.04))",
        },
      }, [
        title ? h("div", { key: "t", style: { fontWeight: 600, marginBottom: 8 } }, title) : null,
        children,
      ]);
    }

    function Button({ onClick, children, kind, disabled }) {
      const bg = kind === "danger" ? "#c0392b" : kind === "ghost" ? "transparent" : "var(--dsh-accent, #4f8cff)";
      const fg = kind === "ghost" ? "var(--dsh-text, inherit)" : "#fff";
      return h("button", {
        onClick, disabled,
        style: {
          padding: "7px 14px", borderRadius: 8, border: kind === "ghost" ? "1px solid rgba(128,128,128,.35)" : "none",
          background: bg, color: fg, cursor: disabled ? "default" : "pointer",
          fontSize: 13, opacity: disabled ? 0.5 : 1,
        },
      }, children);
    }

    function UrlList({ urls }) {
      if (!urls || !urls.length) return null;
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 } },
        urls.map((u, i) => h("code", {
          key: i,
          style: {
            fontSize: 12.5, padding: "4px 8px", borderRadius: 6,
            background: "rgba(128,128,128,.12)", wordBreak: "break-all", userSelect: "all",
          },
        }, typeof u === "string" ? u : u.url)));
    }

    // ── 主面板 ──
    function LinkSection() {
      const t = (k) => (window.__dshLinkT ? window.__dshLinkT(k) : k);
      const [status, setStatus] = useState(null);
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const [freshKey, setFreshKey] = useState(null);
      const [copied, setCopied] = useState(false);
      const mounted = useRef(true);

      const load = useCallback(async () => {
        setErr(null);
        try {
          const s = await ops.status();
          if (mounted.current) setStatus(s);
        } catch (e) {
          if (mounted.current) setErr(String(e && e.message ? e.message : e));
        }
      }, []);

      useEffect(() => {
        mounted.current = true;
        load();
        return () => { mounted.current = false; };
      }, [load]);

      const onGenerate = useCallback(async () => {
        setBusy(true);
        try {
          const r = await ops.generateKey();
          if (r && r.key) { setFreshKey(r.key); setCopied(false); }
          await load();
        } catch (e) { setErr(String(e && e.message ? e.message : e)); }
        finally { setBusy(false); }
      }, [load]);

      const onClear = useCallback(async () => {
        setBusy(true);
        try { await ops.clearKey(); setFreshKey(null); await load(); }
        catch (e) { setErr(String(e && e.message ? e.message : e)); }
        finally { setBusy(false); }
      }, [load]);

      const onCopy = useCallback(async () => {
        if (!freshKey) return;
        const ok = await copyText(freshKey);
        setCopied(ok);
        if (!ok) setErr(t("copyFail"));
      }, [freshKey]);

      const lanUrls = status && status.lan ? status.lan.urls : [];
      const tsUrls = status && status.tailscale ? status.tailscale.urls : [];
      const ts = status ? status.tailscale : null;
      const lanServerOn = status && status.lanServer && status.lanServer.enabled && status.lanServer.port;

      return h("div", { style: { maxWidth: 640, fontSize: 14, lineHeight: 1.6 } }, [
        h("h2", { key: "h", style: { fontSize: 18, margin: "4px 0 2px" } }, t("title")),
        h("p", { key: "intro", style: { color: "var(--dsh-text-dim, #888)", margin: "0 0 8px" } }, t("intro")),

        err ? h("p", { key: "err", style: { color: "#e05353" } }, t("error") + err) : null,
        !status && !err ? h("p", { key: "load", style: { color: "#888" } }, t("loading")) : null,

        status ? h(React.Fragment, { key: "body" }, [

          // 手机接入服务
          h(Card, { key: "lan", title: t("lanServer") }, [
            h(Row, { key: "st" }, [
              h(Dot, { color: lanServerOn ? "#35d07f" : "#e0a800" }),
              h("span", null, lanServerOn
                ? `${t("lanOn")} · ${t("lanPort")} ${status.lanServer.port}`
                : (status.lanServer && status.lanServer.enabled ? t("lanPortBusy") : t("lanDisabled"))),
            ]),
            lanServerOn ? h("div", { key: "lan-addr", style: { marginTop: 8 } }, [
              h("div", { key: "l", style: { fontSize: 12.5, color: "#888" } }, t("lanAddr")),
              lanUrls.length ? h(UrlList, { key: "u", urls: lanUrls }) : h("div", { style: { color: "#888", fontSize: 12.5 } }, t("noLan")),
            ]) : null,
          ]),

          // Tailscale
          h(Card, { key: "ts", title: t("tailscale") }, [
            h(Row, { key: "st" }, [
              h(Dot, { color: ts && ts.running && ts.online ? "#35d07f" : ts && ts.available ? "#e0a800" : "#999" }),
              h("span", null, !ts || !ts.available
                ? t("tsNotInstalled")
                : ts.running && ts.online ? `${t("tsRunning")}${ts.dnsName ? " · " + ts.dnsName : ""}` : t("tsOffline")),
            ]),
            lanServerOn && tsUrls.length ? h(UrlList, { key: "u", urls: tsUrls }) : null,
            (!ts || !ts.available)
              ? h("p", { key: "hint", style: { fontSize: 12.5, color: "#888", margin: "6px 0 0" } }, t("tsInstallHint"))
              : null,
          ]),

          // 连接密钥
          h(Card, { key: "key", title: t("key") }, [
            h(Row, { key: "st" }, [
              h(Dot, { color: status.keySet ? "#35d07f" : "#999" }),
              h("span", null, status.keySet ? t("keySet") : t("keyUnset")),
            ]),
            h("p", { key: "intro", style: { fontSize: 12.5, color: "#888", margin: "4px 0 10px" } }, t("keyIntro")),
            freshKey ? h("div", { key: "fresh", style: {
              padding: "10px 12px", borderRadius: 8, background: "rgba(79,140,255,.12)",
              border: "1px solid rgba(79,140,255,.4)", marginBottom: 10,
            } }, [
              h("div", { key: "l", style: { fontSize: 12.5, color: "#888", marginBottom: 6 } }, t("keyOnce")),
              h(Row, { key: "r" }, [
                h("code", { style: { fontSize: 13, userSelect: "all", wordBreak: "break-all", flex: 1 } }, freshKey),
                h(Button, { kind: "ghost", onClick: onCopy }, copied ? t("copied") : t("copy")),
              ]),
            ]) : null,
            h(Row, { key: "actions" }, [
              h(Button, { onClick: onGenerate, disabled: busy }, status.keySet ? t("regenerate") : t("generate")),
              status.keySet ? h(Button, { kind: "danger", onClick: onClear, disabled: busy }, t("clear")) : null,
              h(Button, { kind: "ghost", onClick: load, disabled: busy }, t("refresh")),
            ]),
          ]),

          // 步骤
          h(Card, { key: "steps", title: t("steps") }, [
            h("ol", { style: { margin: 0, paddingLeft: 20, color: "var(--dsh-text, inherit)" } }, [
              h("li", { key: 1 }, t("step1")),
              h("li", { key: 2 }, t("step2")),
              h("li", { key: 3 }, t("step3")),
              h("li", { key: 4 }, t("step4")),
            ]),
            h("p", { key: "warn", style: { fontSize: 12, color: "#e0a800", margin: "8px 0 0" } }, t("secWarn")),
          ]),
        ]) : null,
      ]);
    }

    // ── 插件契约 ──
    const name = "dsh-link-client";
    const inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-link: dictionaries");
      const t = ctx.locale.bind(LOCALE_NS);
      window.__dshLinkT = t; // 供函数组件读取（避免逐层透传）

      ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-link",
        order: 45,
        label: () => t("nav"),
        locale: LOCALE_NS,
      }, LinkSection)), "dsh-link: settings section");
    }

    const module = { exports: {} };
    module.exports = { name, inject, apply };
    return module.exports;
  },
});
