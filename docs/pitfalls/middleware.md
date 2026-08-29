# 中间件坑点（ES / Redis / MinIO / Ollama）

## Elasticsearch 8 mapping 不支持 boost 参数

- **现象**：建索引报 mapping 解析错误
- **根因**：ES 8 移除了 mapping 级 `boost`，改为查询时 boosting
- **修复**：mapping 去掉 `boost`，在 query 的 `match` 子句上加权重
- **相关**：`apps/api/src/modules/retrieval/es.service.ts`
