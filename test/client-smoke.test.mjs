/**
 * 客户端段冒烟测试：在 Node 里用最小 React 桩执行客户端产物，
 * 验证 __ModuleLoader__ 契约、apply() 注册、locale 字典、以及组件可无异常渲染。
 *
 * 运行：node test/client-smoke.test.mjs
 */
import { strict as assert } from "node:assert";
import { test, afterAll } from "vitest";


// ── 最小 React 桩 ──
const effects = [];
const React = {
  Fragment: Symbol("Fragment"),
  createElement: (type, props, ...children) => ({ $$: "el", type, props: props || {}, children: children.flat() }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: (fn) => { effects.push(fn); },
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
};

// ── 浏览器全局桩 ──
let loaded = null;
globalThis.window = {
  __ModuleLoader__: { load: (arg) => { loaded = arg; } },
};
try { Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true }); } catch { /* navigator 只读则忽略 */ }
globalThis.document = { createElement: () => ({ style: {}, select() {} }), body: { appendChild() {}, removeChild() {} }, execCommand: () => true };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

await import("../src/client/client.js");


test("__ModuleLoader__.load 被调用，携带 id 与 factory", () => {
  assert.ok(loaded, "load 未被调用");
  assert.equal(loaded.id, "dsh-link/client");
  assert.equal(typeof loaded.factory, "function");
});

let exportsObj;
test("factory(require) 返回 { name, inject, apply }", () => {
  const requireStub = (id) => {
    if (id === "react") return React;
    throw new Error("unexpected require: " + id);
  };
  exportsObj = loaded.factory(requireStub);
  assert.equal(exportsObj.name, "dsh-link-client");
  assert.deepEqual(exportsObj.inject, ["slots", "locale"]);
  assert.equal(typeof exportsObj.apply, "function");
});

let registered = null;
let dict = null;
const t = (k) => `T:${k}`;
test("apply(ctx) 注册 locale 与 settings.section", () => {
  const ctx = {
    effect: (fn) => { const d = fn(); return () => { if (typeof d === "function") d(); }; },
    locale: {
      register: (ns, dictionaries) => { dict = { ns, dictionaries }; return () => {}; },
      bind: () => t,
    },
    slots: {
      inject: (slotName, factory) => { assert.equal(slotName, "settings.section"); return factory(); },
      register: (opts, Component) => { registered = { opts, Component }; return () => {}; },
    },
  };
  exportsObj.apply(ctx);
  assert.ok(dict, "未注册 locale");
  assert.equal(dict.ns, "settings.link");
  assert.ok(dict.dictionaries.zh && dict.dictionaries.en, "缺少 zh/en 字典");
  assert.ok(registered, "未注册 settings.section");
  assert.equal(registered.opts.id, "dsh-link");
  assert.equal(registered.opts.name, "settings.section");
  assert.equal(typeof registered.opts.label, "function");
  assert.equal(registered.opts.label(), "T:nav");
});

test("zh / en 字典键集合一致（无遗漏翻译）", () => {
  const zk = Object.keys(dict.dictionaries.zh).sort();
  const ek = Object.keys(dict.dictionaries.en).sort();
  assert.deepEqual(zk, ek, "zh/en 键不一致");
  assert.ok(zk.length >= 20, "字典条目过少");
});

test("组件在 status=null 下可渲染（不抛异常）", () => {
  const tree = registered.Component({});
  assert.ok(tree, "组件应返回元素树");
  // 递归确保结构可遍历
  let count = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    count += 1;
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(tree);
  assert.ok(count > 0);
});

test("useEffect 回调（load 状态）执行不抛异常", async () => {
  // 触发已收集的 effect（会调用 fetch 桩）
  for (const fn of effects) {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanup();
  }
  await new Promise((r) => setTimeout(r, 10));
});

