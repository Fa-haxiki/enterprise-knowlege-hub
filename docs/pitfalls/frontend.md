# 前端坑点（React / Vite / Tailwind）

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
