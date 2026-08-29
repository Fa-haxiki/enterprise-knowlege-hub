# 开发坑点记录

> 按 `.cursor/rules/pitfall-logging.mdc` 规则维护：遇到排查耗时、易复发的问题，修复后立即追加到对应模块的文件。

## 记录规范

每条记录四要素，标题带关键词便于搜索：

```markdown
## <简短标题>

- **现象**：报错信息或异常行为（保留关键原文）
- **根因**：一句话说明本质原因
- **修复**：具体做法（含文件路径）
- **相关**：涉及的文件/模块
```

## 模块索引

| 文件 | 范围 |
|------|------|
| [toolchain.md](toolchain.md) | pnpm、webpack、nest-cli、TypeScript 等构建与工具链 |
| [database.md](database.md) | PostgreSQL、TypeORM、pgvector、migration |
| [backend.md](backend.md) | NestJS 后端：配置、模块依赖、守卫、SSE |
| [agent.md](agent.md) | LangGraph、RAG 链路、LLM/Embedding 接入 |
| [middleware.md](middleware.md) | Elasticsearch、Redis、MinIO、Ollama 等中间件 |
| [frontend.md](frontend.md) | React、Vite、Tailwind、SSE 解析 |

新增模块时在此表登记。
