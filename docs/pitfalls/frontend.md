# 前端坑点（React / Vite / Tailwind）

## 列表页对每个处理中文档单独轮询 progress，批量通过后触发 429

- **现象**：批量审核通过多个文档后，文档列表页大量 `GET /documents/:id/progress` 并发，触发全局限流（120 次/分/IP）返回 429
- **根因**：`setInterval` 里 `for` 循环对每个处理中文档逐个 `await api.get(.../progress)`，N 个文档 = 每 2s N 个请求
- **修复**：后端加批量接口 `POST /documents/progress`（body `{ids[]}`，按 workspace 分组校验 ACL + Redis pipeline 批量取进度，一次往返）；前端改为单次批量请求，有文档离开处理中状态时刷新列表
- **相关**：`apps/api/src/modules/documents/documents.controller.ts`、`documents.service.ts#batchProgress`、`apps/web/src/pages/DocumentsPage.tsx`
- **教训**：列表页的轮询/刷新类请求，凡是「每行一次」的都要警惕 N 倍放大，优先改批量接口

## crypto.subtle 在 http 局域网 IP 下不可用（安全上下文限制）

- **现象**：系统改为局域网共享（`http://192.168.x.x:5173`）后，上传在 sha256 预检处抛 `Cannot read properties of undefined (reading 'digest')`
- **根因**：`crypto.subtle` 仅在安全上下文（localhost / HTTPS）可用，`http://<IP>` 不算安全上下文，`crypto.subtle` 为 undefined
- **修复**：检测 `crypto.subtle` 存在性，不可用时降级为 js-sha256（`sha256(arrayBuffer)`）；凡用到 Web Crypto / 剪贴板 / getUserMedia 等 API 都要考虑局域网 http 场景
- **相关**：`apps/web/src/pages/DocumentsPage.tsx` doUpload

## socket.io 的 namespace 不在 URL 路径里

- **现象**：vite proxy 配 `'/tts': { ws: true }` 后 WS 仍连不上，`/tts/socket.io/?EIO=4` 返回 404
- **根因**：socket.io 的 HTTP 握手端点固定是 `/socket.io/`，`io('/tts')` 中的 `/tts` 是协议层 namespace，不出现在请求 URL 中
- **修复**：proxy 改配 `'/socket.io': { target, ws: true }`
- **相关**：`apps/web/vite.config.ts`、`apps/api/src/modules/tts/tts.gateway.ts`

## React 闭包内对象不随 setState 更新

- **现象**：SSE 流式累积的回答文本，在 `done` 事件里读 `assistantMsg.content` 永远是空串
- **根因**：`setMessages(prev => prev.map(...))` 更新的是 state 副本，闭包里的 `assistantMsg` 对象本身从未被修改
- **修复**：用局部变量 `let fullContent` 在 token 事件中同步累积，done 时读局部变量
- **相关**：`apps/web/src/pages/ChatPage.tsx` send()

## tailwind.config.js 变更后 dev server 不生效

- **现象**：新增自定义颜色（如 `bg-surface`）后 vite dev server 报 `The 'bg-surface' class does not exist`，但 `pnpm build` 正常
- **根因**：运行中的 vite dev server 不会可靠地热重载 tailwind 配置（tailwindcss 3.x 的 config 在 postcss 插件初始化时加载）
- **修复**：改 `tailwind.config.js` 后重启 dev server
- **相关**：`apps/web/tailwind.config.js`、`apps/web/src/index.css`

## multiline 正则中 \s 吞掉换行符

- **现象**：stripMarkdown 处理表格后多行内容合并成一行
- **根因**：`/^\s*\|(.+)\|\s*$/gm` 中 `\s` 包含 `\n`，行首/行尾的 `\s*` 会跨行吞掉换行符
- **修复**：multiline 模式下描述"行内空白"一律用 `[ \t]` 而非 `\s`
- **相关**：`apps/web/src/lib/tts.ts` stripMarkdown

## TTS 停止播放失效（stopped 标志被 setTimeout 复位）

- **现象**：点停止后当前句停了，后续句子照样播放
- **根因**：`stopPlayback()` 用 `setTimeout(() => stopped = false, 0)` 复位标志，服务端仍在逐句推音频，标志复位后新音频继续入队；且 `audio.pause()` 不触发 `onended`，pump 的 await 悬挂导致后续播放卡死
- **修复**：代次（gen）机制——speak/stop 递增 gen 并随帧回传，过期帧一律丢弃；服务端 stop 消息中断合成循环；stopPlayback 手动调 `currentResolve()` 放行悬挂的 pump
- **相关**：`apps/web/src/lib/tts.ts`、`apps/api/src/modules/tts/tts.gateway.ts`

## 祖先 transform 导致 fixed 弹窗被"关进"卡片

- **现象**：`fixed inset-0` 的 Modal 没有全屏覆盖，而是被限制在某个卡片内部
- **根因**：祖先元素的 CSS 动画以 `fill-mode: both` 结束，保留了 `transform: translateY(0)`——transform 非 none 的元素会成为 fixed 后代的包含块
- **修复**：弹窗用 `createPortal(..., document.body)` 渲染到 body；动画 fill-mode 去掉 `both`（结束即移除 transform）
- **相关**：`apps/web/src/components/chat/MessageItem.tsx`、`apps/web/tailwind.config.js`（fadeUp）

## @ag-ui/client 的 threadId 语义与服务端会话冲突

- **现象**：`HttpAgent` 构造时未传 `threadId` 会自动生成随机 UUID，POST 给服务端后被当作 conversation_id 查询，命中 404
- **根因**：AG-UI 协议中 threadId 是客户端主导的线程标识，而原服务端接口要求 conversation_id 必须已存在
- **修复**：服务端新增 `getOrCreateByThreadId`——threadId 对应的会话不存在时直接以该 id 创建，保证 threadId == conversation_id
- **相关**：`apps/api/src/modules/chat/chat.service.ts`、`apps/api/src/modules/chat/agui.controller.ts`

## typography 插件样式缺失导致 ol 编号不显示（dev server 缓存旧配置）

- **现象**：react-markdown 正确输出 `<ol>`，但页面列表只显示圆点/无编号；TTS 却能读出原文的 "1."
- **根因**：`@tailwindcss/typography` 是后来才加进 `plugins` 的，Vite dev server 一直用着加插件之前编译的 Tailwind 缓存，`.prose ol` 的 `list-style-type: decimal` 从未生成；表格等"看似正常"的样式其实来自自定义 components，与 prose 无关
- **修复**：重启 web dev server；验证方式 `curl -s localhost:5173/src/index.css | grep -c 'list-style-type: decimal'` 应 ≥1
- **相关**：`apps/web/tailwind.config.js`、tailwind 配置改动必须重启的既有坑
