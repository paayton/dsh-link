# DSH Link · H5 客户端实现说明

手机端 H5 的职责：**把 host `follow` 出来的会话事件流，渲染成接近桌面版 DSH 的对话视图**。
零依赖、零构建，纯静态文件由 `/m/*` 提供。

```
src/public/
  index.html            结构（顶栏 / 抽屉 / 消息区 / 输入区 / 底部浮层）
  style.css             设计令牌 + 桌面级暗色/浅色主题 + 移动适配
  app.js                界面、连接（WS）、输入、分页、手势与滚动
  transcript.js         事件归约（纯函数，可在 Node 里单测）
  md.js                 Markdown 渲染（纯函数，可在 Node 里单测）
  manifest.webmanifest  加到主屏（standalone）
  icon.svg / icon-*.png 图标
```

`app.js` 不解析事件，只做「归约结果 → DOM」；`transcript.js` 不碰 DOM，只做「事件 → 条目」。
分层的收益：协议细节能写单测（`test/transcript.test.mjs`），Markdown 与转义安全也能单测（`test/md.test.mjs`）。

---

## 1. 数据模型

一条会话被归约成线性条目（`transcript.js`）：

| kind | 来源事件 | 渲染 |
|---|---|---|
| `user` | `user/message`（只取 append 来源，compaction 的 replace 副本忽略） | 右侧气泡 + 时间/失败态 |
| `assistant` | `assistant/message` | 扁平正文，内部按 `parts` 顺序渲染 |

`assistant` 的 `parts` 依次是：

- `reasoning` → 可折叠「思考」块（流式时标题为「思考中…」且有呼吸点，折叠态显示首行预览）
- `text` → Markdown 正文（流式时行尾带光标）
- `call` → 工具卡片，卡片内容从 `t.calls`（`callId → {name,args,result,startedAt}`）取

**工具卡片挂在发起它的那条助手消息里**，与桌面版一致；`tool/result` 到达时原地更新那张卡
（状态：运行中转圈 / 成功对勾 / 失败红叉 + 耗时），不另起一条消息。

## 2. 事件与帧的真实形状

踩过的坑都记在这里，改动前先看：

```jsonc
// durable：tool/result 的 toolCallId / isError / content 在 data.message 里
{ "type":"tool/result", "seq":21, "data": { "turn":1, "step":1,
  "message": { "role":"tool", "toolCallId":"call_xx", "content":[{"type":"text","text":"..."}], "isError":false } } }

// durable：tool/call 的字段直接在 data 上
{ "type":"tool/call", "seq":20, "data": { "callId":"call_xx", "name":"bash", "arguments":"{...}" } }

// durable：assistant/message 的正文/用量
{ "type":"assistant/message", "data": {
  "message": { "content":[ {"type":"reasoning","text":...}, {"type":"tool-call","id","name","arguments"}, {"type":"text","text":...} ],
               "source": { "model":"deepseek-flash" } },
  "usage": { "totalTokens": 1234 } } }

// 实时帧是**双层包装**：最外层是 host 的 frame 信封
{ "type":"frame", "sessionId":"session-…", "frame": {
    "type":"assistant-stream",
    "frame": { "type":"chunk", "attemptId":"session-…:48", "revision":123, "index":0, "time":…,
               "chunk": { "type":"reasoning-delta" | "text-delta" | "tool-call-delta" | "block-start" | "block-end" | "finish" | "usage",
                          … } } } }
```

`applyChunk` 同时接受双层包装和已剥壳的 `{attemptId, chunk}`；`block-end` 会用整块内容校正
delta 累积的结果。

## 3. 流式与历史的衔接

- 打开会话：WS `follow` → 首帧 `snapshot` 作为历史基线（不激活 agent）。
- 流式期间：`assistant-stream` 的增量落在一个临时条目 `live:<attemptId>` 上。
- 该 step 的 durable `assistant/message` 到达 → **整条替换** live 条目（不会出现两份内容）。
- `turn/end` 先到、durable 后到（竞态）→ 先把 live 冻结成静态条目，durable 到达时接管它。
- 同一个连接里 host 可能重复下发 `snapshot`：**合并**而不是 reset，否则正在流式的条目和
  已经翻出来的更早历史都会被抹掉。

## 4. 分页

- `hasMore` 来自快照帧；顶部「加载更早的消息」用 `/m/api/messages?beforeSeq=<当前最老 seq>`。
- host 语义：`beforeSeq` 表示「要早于这个 seq 的消息」（内部再 `-1` 当 `throughSeq`）。
- 插入时保持滚动位置（记录 `scrollHeight` 差值补偿），并按条目 key 去重。

## 5. 移动端交互要点

- **软键盘 / 视口**：`.main` 的高度始终由 JS 每次视口变化写入 `--app-h`（CSS 里 `100dvh`/`100%` 只作兜底）：
  - **键盘弹出**（`innerHeight - visualViewport.height > 80` 或 `offsetTop > 0`）→ 用 `visualViewport.height`
    精确贴合，并加 `.kb`（该状态下 `min-height` 归零，否则会被下面的地板撑住、输入框被键盘挡）；
  - **键盘收起** → 取 `max(布局视口, 可视区)`。某些浏览器/WebView 在地址栏收起后
    `100dvh`/`innerHeight` 仍比真正可见区域小，输入框下面会露出正好一条地址栏高度的空白；
    取较大值可以兜住。**加到主屏（standalone）**时再抬到 `screen.height`，并用
    `@media (display-mode: standalone)` 给 `.main` 加 `min-height: 100vh` 当地板。
  - `resize` 之后额外延迟 260ms 再量一次（地址栏收放有动画，事件到达时尺寸往往没定）。
  - `viewport` 另带 `interactive-widget=resizes-content`（Android 上布局视口自己会缩，无需 JS 介入）。
- **`ask_user_question` 卡片**：它是一条普通 `tool/call`（name=`ask_user_question`），
  入参 `{questions:[{id,header,question,options:[{label,description}]}]}`，回执是 tool/result 里的
  `{"answers":[{"id","selected":[label]}]}`。轨迹层把它解析成结构化数据（`call.ask` / `call.answers`），
  渲染成专门的卡片：徽标 + header + 问题正文 + 选项列表（label/description），
  回执到达后给选中项打勾、其余置灰。
  > **手机端不能直接回答**：回答要写回那个"待决的 tool call"，`SessionPromptRequest` 里没有任何
  > 回答字段（已核对官方类型），那是桌面端问询卡的内部通道，不在 dsh-link 的窄接口里。
  > 所以点选项只做一件事：**填进输入框**，发送后 agent 在下一轮收到（不是真回答）。
  卡片里的这个提示是刻意写清楚的，避免让人以为点了就答了。
- **`snapshot.assistantStream` 不能用来判断"是否在跑"**：host 的快照里**恒有**这个字段
  （空闲会话也一样，实测 `{revision: 47879}`，最后一条事件是 `turn/end`）。早期代码
  `if (frame.assistantStream) t.running = true` 导致**每次重连都把停止按钮点亮**，
  之后没有新的 `turn/end` 就再也回不去——手机切后台/换网重连时必现。
  运行状态只由事件流推导（`turn/start` → 跑，`turn/end` → 停），索引刷新时再做一次单向兜底校正。
- **覆盖层的高度 / iOS 独立模式的"底部带子"（真机实测结论）**：
  在 iPhone 16 Pro + 加到主屏（standalone）下，真机探针读数：
  ```
  screen=874  safeT=62  lay=812  vv=812  100vh=812  100dvh=812
  ```
  即 **物理屏幕 874，但布局视口只有 812，差的正好是状态栏 62**，而页面画不到下面那 62px
  （只能露出 canvas 底色）。由此得两条硬结论：
  1. **绝不能用 `screen.height` 给内容当地板**：`.main` 一旦铺到 874，输入框底边就落在
     812~874 这段"画不出来"的区域里 → 输入框被切、底部露一条带子。可绘制高度就是
     `max(layoutViewport, visualViewport)`。
  2. 那 62px 页面**根本画不到**，只能让它"隐形"：抽屉/底部浮层是白底时，给 `<html>` 加
     `.surface-elev`，把 `html/body` 的底色也切成 `--bg-elev`，带子就与浮层同色了
     （`syncSurface()` 在抽屉/浮层显隐处统一维护）。
  > 判断这类问题的最快办法：截图取像素色。抽屉是 `#FFFFFF`、页面底色是 `#F6F7F9`，
  > 出现 `#F6F7F9` 就说明容器没铺满或露到了 canvas。
  > 真机取数入口：**点抽屉顶部「DSH Link」5 下**开调试浮层（加到主屏后 URL 带不了
  > `?debug=1`，且独立 App 存储在 iOS 上与 Safari 分开，所以必须在 App 内给开关）。
  > 浮层顶部有「收起/展开」和「✕ 关闭」——收起后只留一条标题栏，不会挡住要排查的界面。
- **侧边栏手势**：左缘 26px 起手右滑打开、抽屉上左滑关闭，**跟手拖动**（不是阈值触发）：
  拖动时抽屉位移、遮罩透明度、主内容"被推开"的视差（最多 24px）都实时跟随。松手怎么收尾：
  - **看速度**：最近 100ms 的平均速度 ≥ 0.45px/ms 就算"甩"，只看方向（往右=开、往左=关）——
    短促一划即可，不用拖过半屏；`v>0` 开 / `v<0` 关这个判据两个模式通用。
    （早先写成"已打开时 v<0 判开"，方向反了，关闭时永远关不上。）
  - **慢拖看距离**：打开手势拖过 35%、关闭手势拖过 50% 才吸附到对应一端。
  - **时长自适应**：`clamp(剩余距离/速度, 150ms, 320ms)`，开用 `cubic-bezier(.16,1,.3,1)`（收得干净），
    关用 `cubic-bezier(.32,0,.24,1)`；拖得越远/甩得越快，动画越快。结束后清掉内联样式回到 CSS 状态。
  要点：
  - 方向判定前（8px 以内）不接管；判定为纵向就放弃（让给列表滚动），方向相反也放弃；
  - `.drawer/.scrim` 用 `touch-action: pan-y pinch-zoom`，横向留给手势；
    真正的滚动拦截靠 `touchmove` 的 `preventDefault`（iOS 上 `pointermove` 拦不住）；
  - 拖动结束会吞掉紧接的那一下 `click`（窗口 150ms），否则松手会顺带切走会话；
  - 拖动期间禁用入场动画/过渡与文字选择（`.dragging`）。**入场动画的压制用常驻的 `.no-enter`**：
    从拖动开始一直留到"抽屉真正关闭"才摘掉。早先只在收尾时压住，收尾一结束就摘掉，
    `slide-in` / `fade-in` 立刻被重新触发又播了一遍——表现就是"出来之后闪一下"。
  - 收尾用 `transitionend` 结束（定时器只做兜底）：单靠定时器时，若过渡没走完就清内联样式会跳变。
  > 已知限制：iOS Safari 的**左缘返回手势**优先级很高，从最边缘起手有时会被浏览器抢走。
  > 如果实测抢不过，把 `DRAWER_EDGE` 收窄到 ~16px 会好一些。
- **历史图片的占位**：图片要等 JS 抓到字节、转成 objectURL 才能显示，所以**不能先输出一个没有
  `src` 的 `<img>`** —— 浏览器会把它画成"破图"（还带 alt 文字），于是每张图都先闪一下报错。
  现在用 1×1 透明 GIF 占位（天然就是 `.pending` 的骨架底色 + 呼吸动画），取到字节后赋 blob、
  打 `data-ready="1"`（水合选择器也从 `:not([src])` 改成 `:not([data-ready])`，避免重复抓取）；
  解码失败再降级成文字 chip（`error` 事件用捕获阶段监听，img 的 error 不冒泡）。
- **设置 = iOS 设置页那种页面式面板**：顶部居中标题 + 右上角圆形 ✕，下面是「分组标题 +
  白色圆角卡片 + 行（图标 / 标题 / 右侧值或箭头）」，行间分隔线从图标右侧起（`left: 50px`）。
  分组：连接（服务地址、状态）/ 会话（重新载入、复制会话 ID、回到顶部）/ 外观（当前值，
  点一下循环 跟随系统→浅色→深色）/ 关于（检查更新，右侧显示构建指纹）/ ~~清除密钥并退出~~（已按需求移除；密钥失效时 401 会自动回到密钥门重新输入）。
  面板是 `margin-top: max(10px, safe-t)`、`height: calc(100% - 那个值)`、顶部 20px 圆角，
  并且**卡片自身就是滚动容器**（这样下滑关闭里的 `card.scrollTop > 0` 判断才有意义）。
- **底部浮层的关闭方式**：下滑关闭（跟手 + 判定：拖过卡片高 25% 或下甩速度 > 0.5px/ms）
  ＋ 点浮层外部关闭。**设置面板不再有「关闭」按钮**。要点：
  - 只接管下滑方向，且 `card.scrollTop === 0` 时才接管（否则让给内容滚动）；
  - 量不到高度时用视口高一半兜底，否则阈值会退化成 0.25px（这个边界是测试逼出来的）；
  - 拖完那一下的 click 要吞掉，避免顺手点到卡片里的按钮；
  - 同一套 `installSheetDrag()` 复用在设置面板与「新建会话」浮层上。
- **侧边栏 = 头像 + 会话 + 设置**：头部是头像与应用图标 + 「DSH Link」+ 状态行
  （`已连接 · N 个工作区`）；底部是「设置」入口。原右上角 `…` 菜单已删除，
  内容并入设置面板（连接信息与地址 / 本会话操作：重新载入、复制会话 ID、回到顶部 /
  外观主题 / 清除密钥并退出），设置面板同时打开时把抽屉收起，并按浮层规则参与 `syncSurface`。
- **工作区分组（下拉）**：整行是可点的折叠头（42px 高、圆角、`:active` 有按下反馈），
  左边 14px 的 caret、中间加粗的工作区名、右边带描边的计数徽标；折叠时 caret 旋转 -90°、
  计数变淡。**展开时该组内的会话左缩进 14px**，层次一眼能看出来。分组头 + 路径整块 `sticky`
  吸顶，滚动时不迷失。
- **侧边栏结构**：品牌头 + 搜索（不自动 focus，避免真机弹键盘）+「新建会话」动作行 +
  吸顶的工作区分组（`.ws-bar` 整块 sticky，滚动时不迷失）+ 分组计数 +「其它会话」分区。
  路径只在**有歧义**时显示（末段重名，或与工作区标题不符）。「其它会话」= 未被任何工作区
  认领的会话，**筛选时不能退化成"没命中的分组里的会话"**（这个洞被 UI 测试抓到过）。
- **回合结束的收尾**：`settleLive()` 统一处理「冻结流式条目 + 重绘 + 刷新输入区状态」，
  三处调用（`turn/end` 事件、WS 的 `end` 帧、连接断开）。踩过的坑：先算 `isRunning()` 再冻结 live，
  会在 live 还在的时候算出「运行中」，于是**回合结束后发送按钮一直卡在红色停止**；
  冻结后的条目也要重绘一次，否则会一直挂着「正在生成…」和光标。
- **底部安全区**：`padding-bottom: 8px + max(0px, safe-area-inset-bottom - 16px)`——
  Home Indicator 本体只占底部约 13px，整段留 34px 会显得输入框下面空一大片。
- **回车语义**：`pointer: coarse`（触屏）时回车换行，用发送键提交；桌面指针下回车发送、`⌘/Ctrl+Enter` 恒发送。
- **自动吸底**：滚到底部才跟随新内容；一旦上滑就看住位置，新内容计入「回到底部」角标。
  自动跟随用瞬时滚动，「回到底部」按钮才用平滑滚动（两者混用会互相打架）。
- **图片走内联，不走上传收据（正解）**：`PromptContentPart` 支持 `{type:"image", mediaType, data}`，
  发消息时直接把 base64 内联进去，落库就是 `type:"image"` —— 官方附件授权认这个形状，
  历史回看天然读得回来，也少一次上传往返。客户端发 `images:[{data,mediaType,name}]`，
  host 侧剥 data URL 前缀、校验 `image/*` 与单张 8MB 上限后转成 content part
  （该路由 body 上限放宽到 18MB）。
  > 实测：内联发送后 `GET /m/api/attachment` 返回 **200 + 129736 字节** ✓
  > 走过一段弯路：早先用"先上传换收据"发图，它落库成 `type:"file"`，而 DSH 的
  > `sessionController.attachment()` 授权只看 `type === "image"` → 自己发的图**永远读不回来**
  > （400 not referenced）。当时在 host 侧做过一版"按内容哈希读盘"的兜底，但既然改成内联、
  > 新的图都走官方路径，兜底已删除——**不做老数据兼容**（不会有老图）。
- **附件读取失败可重试**：`attachmentUrls` 只缓存成功；失败写进 `attachmentRetryAt`（1.5s 冷却，
  避免每个事件都重试）。单张图最多试 3 次，期间保持占位并自动重抓；只有接口确实不存在
  （404/503 → `unsupported`）才立刻降级成文字 chip。
  踩过的坑：**曾经把失败也永久缓存**（`url=""`），刚发出的图因为附件还没落盘抓了一次 404，
  之后永远是「图片读取失败」。
- **多行输入框**：`padding: 6px 6px 6px 10px`、圆角 21px、字号 16px/行高 1.5；
  高度随内容长高，封顶 `min(160px, 28vh)`（JS 的 `autoGrow()` 与 CSS 的 `max-height` 用同一个值），
  超出则内部滚动并显示 4px 细滚动条。发送/附件按钮始终贴底对齐。
- **键盘弹起时收掉底部安全区**：`.main.kb .composer { padding-bottom: 8px }`。
  收起键盘时那条 26px 的留白是给 Home Indicator 的；键盘弹起时它盖住了 Home Indicator，
  再留就是输入框和键盘之间白白多一条（实测少 18px）。注意**中文输入法那两行（候选栏 + 候选词）
  是 iOS 系统键盘的一部分**，不在页面里，页面无法消除。
- **未读角标 = 新落地的助手消息条数**：只在 `assistant/message`（成条消息）落地且用户不在底部时 +1。
  **流式分片不计数**——一条回答能推上百个 chunk，按分片加会让角标瞬间 99+，完全不是"有多少条新内容"。
  另一个坑：不能用"条目数变没变"当条件，流式条目被成条消息接管时是一换一、数量不变。
- **运行中的发送/停止按钮**：默认显示「停止」；**只要用户在输入**（聚焦、键盘弹起、或已有内容）
  就换成「发送」——边跑边插话可以一步发出，不用先停。收起键盘且输入框为空时回到「停止」。
  实现是 `updateStreamUI()` 里算一个 `composing`，并在 `focus/blur`、`input`、视口变化（`.kb`）时重算。
- **会话信息在右上角「…」**：顶栏副标题只留"运行中 / 更新于 X"，详细状态（dsh 模式、
  智能体成员、后台任务、模型 + reasoning effort、token 用量、上下文占用、会话 ID、工作目录）
  都放进 `#info` 弹框，数据全来自会话 projections（`/m/api/workspaces` 已返回，无需额外接口）。
  > 选图时"钉住几何"的尝试已回退：真机上仍会因键盘收起而让系统弹窗悬空，这块不再优化。
- **系统弹窗要锚在「+」上**：file input **不能用 `hidden`**（`display:none` 没有几何盒子，
  iOS 找不到锚点，弹窗会跑到屏幕别处、和「+」错开）。做法：透明（`opacity:0`）+
  `pointer-events:none` + 盒子与「+」完全重合（实测 left 21 / bottom 17 / 34×34，误差 0）。
- **ask_user_question 走官方接口回答**：`POST /m/api/answer`
  → `ctx.remote.userQuestions.answer(agent, callId, { answers:[{id, selected[], custom?}] })`
  （契约 `@deepseek-ai/dsh-user-questions`，签名 `answer(agent: Agent, callId: ToolCallId, answer) : boolean`）。
  好处：**直接让待决的 tool call 收到答案**，而不是往会话里插一条消息；还支持 `multiSelect`
  （多选渲染成方框）与 `custom`。老 host / 接口缺失(404,503) / 已超时(409) 都会**优雅降级**
  成"发一条消息"，行为与以前一致。
  > 曾经的做法是"点选项 → 塞进输入框 → 走发送"，弱网发送失败时那段文字会留在输入框并被
  > 草稿暂存记录下来，用户会看到"不是我打的字"一个个冒出来——已彻底改掉，不再碰输入框。
- **「+」不能把键盘弄掉**：附件入口用 **`<label for=file-input>`** 而不是 `<button>`
  （label 不可聚焦，点它不会把焦点从输入框顶掉），并且 `pointerdown` + `mousedown`
  都 `preventDefault()`（iOS 上真正决定焦点转移的是 mousedown，只拦 pointerdown 不够）。
  用键盘激活时（Enter/Space）手动 `fileInput.click()`。
  > 系统那个「照片图库 / 拍照 / 选取文件」菜单**页面跳不过去**（iOS 对 `<input type=file>`
  > 的固定行为，加 `capture` 只会直接进相机）。想少一步就用**粘贴**：长按输入框选「粘贴」、
  > 桌面 Ctrl+V，图片会直接进托盘（监听 `paste`，只认 `kind==="file"` 的图片项，纯文字粘贴不拦）。
  > 系统相册选择器本身是模态的，**弹出时键盘必然收起**——这是 iOS 行为，页面无法阻止；
  > 我们能做的是不让"点按钮"这一步额外抢走焦点（那样键盘会提前收、且返回后不回来）。
- **发送方式固定为插话**：`/m/api/prompt` 的 `mode: "steer"`（曾经做过排队/插话二选一，实测在手机上多一步操作、价值不大，已去掉选择器）。运行时发一条就立刻打断当前步骤；乐观气泡按 `requestId`
  与 durable 消息合并，失败就地标红。
- **主题**：跟随系统 / 浅色 / 深色，存 localStorage，显式覆盖排在 `prefers-color-scheme` 之后。

## 6. 图片上传

```
手机选图 → canvas 压到长边 1568px/JPEG 0.85 → POST /m/api/upload {sessionId,name,data(base64)}
        → host: ctx.fileUploads.upload(sessionId, {data,name}) → { receiptId }
        → POST /m/api/prompt { text, receiptIds:[…] }
        → host: content 追加 { type:"file", receiptId }，由 ctx.attachments 解析成真正的附件
```

- **host 侧**（`src/host/routes.js`）：`/m/api/upload` 剥掉可选 `data:` 前缀、校验 base64 与体积
  （解码后 12MB / 请求体 18MB），再调 `fileUploads`；`/m/api/attachment?sessionId&attachmentId`
  把历史里的附件读回来（host 返回字节时转 base64）。
- **门面方法都以 `signal` 结尾**：`sessionController.prompt(request, signal)` 第一行就是
  `signal.throwIfAborted()`；RPC 网关会按描述符自动补，进程内直调要自己传（`upload` 同理，是第三个参数）。
- **`fileUploads` 是可选依赖**：`ctx.inject(["fileUploads"], …)`，桌面版没提供时插件仍可用，
  只是 upload 返回 503 并带上原因。
- **H5 侧**（`app.js`）：选图后立刻在本地压缩（4MB 手机原图通常降到 200~400KB），托盘里可删；
  发送时**先传图拿收据再发 prompt**，失败会把图片放回托盘，不用重挑。
- **显示**：待发送用本地 dataURL 即时预览；durable 消息到达后换成 host 附件引用，
  由 `/m/api/attachment` 拉字节转 objectURL（`<img>` 带不了鉴权头，所以用 JS 取）。工具结果里的
  图片（如 `read_image`）同样渲染缩略图。objectURL 按 `sessionId|attachmentId` 缓存。
- 页面在后台时 rAF 会暂停，附件水合可能延后；`visibilitychange` 时会补一次。

## 7. 无感升级（不需要版本号）

静态文件从 `/m/*` 来，浏览器缓存策略是 **内容哈希 ETag + `no-cache`**：每次带 `If-None-Match`
问一句，没变 304，变了自动换新。因此**没有也不需要 `?v=N`**。

页面自己还会比对指纹并自行刷新——**复用同一套缓存校验，不新增任何接口**：

- `currentBuild()` 对 5 个静态文件各发一次 `fetch(file, { cache: "no-cache" })`：
  host 会带 `If-None-Match` 条件请求，没变就是 304、body 直接来自缓存（只有响应头几十字节），
  变了就拿到新内容；把结果拼起来算个短指纹即可判断「代码变了没有」。
- 任一文件没取到（断网、半通）直接跳过本轮判断——否则会把失败本身当成「有新版本」而无限自刷。
- `checkForUpdate()` 在 `boot()`、每次 `visibilitychange`、以及每 5 分钟各跑一次，最小间隔 60 秒；
- 构建号变了且输入框为空 → `location.reload()`；正在写草稿则推迟到草稿清空（避免打字打一半被刷掉）；
- 会话 id 存在 `localStorage['dsh-link-session']`，`boot()` 优先恢复它，所以自动刷新后
  仍然停在原来那条会话上。

改了任何 `src/public/*` 之后：手机**什么都不用做**，切回页面就会自动升级。

## 8. 排障开关

地址后加 `?debug=1`：

- 页面底部绿色浮层显示 `loadIndex` / `openSession` / WS / 异常的实时日志；
- `window.__dshLink` 暴露 `state`、`t`（归约器现场）、`stats`（收到的帧类型计数、chunk 数、
  `follow` 次数、因 sessionId 不匹配被丢弃的帧数）。

典型判读：`stats.follows` 远大于个位数 → 连接在反复重连；`stats.snapshots` 持续增长但
`chunkApplied` 不涨 → 基线在反复重放把流式冲掉；`stats.dropped` 增长 → 跟随的会话与当前会话不一致。
