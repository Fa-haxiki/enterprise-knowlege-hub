# 性能压测报告（M3）

> 日期：2026-08-30　环境：MacBook 单机（CPU）、Docker 中间件、远程 LLM（qwen3.8-flash 经阿里云网关）、本地 Ollama（bge-m3 / bge-reranker-v2-m3）

## 1. 问答链路压测

工具：`scripts/benchmark/chat-bench.mjs`（SSE 全链路：检索 → 重排 → 图谱 → LLM 流式）

### 结果

| 场景 | 请求数 | 成功率 | 吞吐 | 首 Token P50 / P95 | 总延迟 P50 / P95 |
|---|---|---|---|---|---|
| 5 并发 × 2 | 10 | 100% | 0.67 req/s | 4.5s / 7.3s | 5.6s / 8.7s |
| 50 并发 × 2 | 100 | 100% | 2.04 req/s | 10.0s / 15.5s | 12.0s / 19.9s |

### 对照指标（01-PRD §5）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 单实例 50 并发问答 | 支持 | 100/100 成功，无 5xx | ✅ 达标 |
| 首 Token ≤ 2.5s（P95，简单问题） | ≤ 2.5s | 5 并发 P95 7.3s；单请求约 3.6s | ⚠️ 未达标 |
| Worker 解析吞吐 ≥ 5 页/秒（CPU） | ≥ 5 页/s | 约 0.15 页/s（2 页 PDF 约 13s） | ❌ 未达标 |

### 首 Token 延迟归因

单请求首 Token 约 3.6s 的构成：

1. **远程 LLM 首 Token 延迟 ~2-4s**：qwen3.8-flash 经 token-plan 网关，网络 + 排队占大头，本地无法优化
2. **检索+重排 ~0.8-1.2s**：ES + pgvector + bge-reranker（CPU）基本达标
3. **记忆/图谱查询 ~0.2s**：Redis + Neo4j 本地查询

50 并发下延迟放大主要来自远程 LLM 网关的并发排队（本地 CPU 占用并不饱和）。

**改进路径**（后续里程碑）：更换低延迟 LLM 端点或本地部署模型；检索结果缓存（相同问题命中 Redis）；reranker 批量化/GPU 化。

## 2. 入库吞吐压测

工具：`scripts/benchmark/ingest-bench.mjs`（upload-init → 分片上传 → upload-complete → 轮询 READY）

### 结果（4KB / 2 页 PDF，2 并发 × 3 份）

| 指标 | 实测 |
|---|---|
| 成功率 | 3/3（100%） |
| 单份端到端 | 82s ~ 139s |
| 吞吐 | 1.0 份/分 |

### 归因

- MinerU（magic-pdf CPU 模式）解析约 13s/份，是固定大头
- 每 chunk 一次 LLM 实体抽取（图谱构建），chunks 越多越慢
- embedding（bge-m3 CPU）每 chunk 约 0.3s

CPU 模式下 5 页/秒的指标不现实（magic-pdf 版面分析本身就是重计算）。GPU 模式可提升 10 倍以上；或接受异步入库的产品形态（上传后后台处理，进度可见）。

## 3. 结论

- **并发能力达标**：50 并发零失败，系统稳定性可靠
- **延迟指标受远程 LLM 制约**：本地链路（检索/重排/图谱）健康，首 Token 瓶颈在上游模型网关
- **入库吞吐受 CPU 解析制约**：功能正确，性能需 GPU 或接受异步体验

## 4. 复现方式

```bash
# 问答压测（压测前临时调大限流：THROTTLE_LIMIT / CHAT_RATE_LIMIT_PER_MIN）
TOKEN=<jwt> node scripts/benchmark/chat-bench.mjs 50 2

# 入库压测
TOKEN=<jwt> TEST_FILE=test-docs/差旅费用管理制度.pdf node scripts/benchmark/ingest-bench.mjs 3 2
```
