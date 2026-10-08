# 贡献指南

## 目录结构

```
src/host/*.ts       host 段（进程内全权限）—— 构建到 dist/ 后由 DSH 加载
src/client/client.js  桌面版设置页「Link」栏（手写产物格式，React，无需构建）
src/public/*.js     手机端 H5（**不参与构建**，运行时直读 + 内容指纹自升级）
test/*.mjs          测试（针对 dist/ 产物）
docs/               设计与实现说明
```

## 开发环路（重要）

| 改了什么 | 怎么生效 | 代价 |
|---|---|---|
| `src/public/*` | 保存即生效（服务端每次请求读盘；页面靠构建号自检自动 reload） | 无 |
| `src/host/*.ts` | `pnpm build` → **重启桌面版进程** | 会中断当前会话 |
| `cordis.patch.yml` 配置 | profile 重组时生效 | 无需重启 |

**为什么 host 改动必须重启**：DSH 在进程启动时加载插件模块，之后重组 profile 只会重新执行
`apply()`，不会重新读盘（Node 的 ESM 按 URL 缓存）。实测 touch 插件的 `package.json` /
`src/host/*.ts` 都会触发 profile 重组，但接口行为不变——只有新进程才真正读新代码。

所以：**host 改动请攒批**，一次重启验证完，不要每修一处就重启一次。

## 常用命令

```bash
pnpm install          # 只装 dev 依赖（运行时不依赖任何第三方包）
pnpm typecheck        # tsc --noEmit，对着 DSH 官方类型检查 host 段
pnpm build            # 编译到 dist/
pnpm test             # 先 build，再跑全部测试
```

## 类型约定

`src/host/types.ts` 是本项目最重要的类型文件：它把**我们对 DSH 内部 API 的依赖**固化成类型。
之前踩过的两个坑都被它拦在编译期：

```ts
// 官方签名（@deepseek-ai/dsh-api-session-controller）
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
// 我们的调用必须带 signal，否则 tsc 报错——运行时漏传会得到
// "Cannot read properties of undefined (reading 'throwIfAborted')"
```

给 host 上下文加新依赖时，请：

1. 优先引用官方类型（`pnpm add -D @deepseek-ai/<pkg>@<桌面版同版本>`，注意 `latest` tag 可能落后，要写死版本）；
2. 官方没有可引用类型的（`fileUploads` 等），在 `types.ts` 里写**结构化类型**，并在注释里注明依据（远程描述符 / 调用点 / 源码行号）；
3. `noImplicitAny` 与 `useUnknownInCatchVariables` 目前是关的（迁移期折中），欢迎逐文件收紧。

## 测试

```bash
pnpm test          # tsc + vitest run
pnpm test:watch
pnpm run coverage
```

测试针对 `dist/` 产物跑（`pnpm test` 内置了 `tsc`）。断言用 `node:assert`，由 vitest 负责发现与报告。

- `ws-mini` / `host-integration` / `client-smoke` / `md` / `transcript` — 见 README 的测试表
- **`app-ui.test.mjs`** — H5 的 UI 层：jsdom 加载真实 `index.html` 结构与真实 `app.js`，
  只桩 `fetch` / `WebSocket` / `localStorage` / `Image`。通过 `?debug=1` 暴露的
  `window.__dshLink`（`state` / `t`）断言内部状态，再回到 DOM 上断言渲染结果。

写 UI 测试时注意几个环境事实（都已在 `app-ui.test.mjs` 里处理好）：

- vitest 的 jsdom 里 `window.localStorage` 的 getter 返回 `undefined`，测试自带内存 Storage 实现；
- jsdom 不解码图片，`Image` 被替换成会触发 `onload` 的假实现；canvas 不可用，
  正好覆盖 `prepareImage` 的"压缩失败回退原图"分支；
- 每个用例 `vi.resetModules()` 后重新 `import` app.js，拿到全新的应用实例。

mock 上下文请按**真实签名**写断言（例如 `prompt(req, signal)` 里就调用 `signal.throwIfAborted()`），
这样漏传参数的退化会被测试直接拦住。

## 发布前检查

```bash
pnpm typecheck && pnpm test
```
