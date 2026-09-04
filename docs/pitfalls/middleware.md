# 中间件坑点（ES / Redis / MinIO / Ollama / MinerU）

## 切换网络（家/公司 IP 不同）后上传卡死：MINIO_PUBLIC_ENDPOINT 是旧 IP

- **现象**：文档上传卡在 `upload-init`，API 报 `connect ETIMEDOUT 192.168.70.15:9000`（旧 IP），75s 后 500
- **根因**：`MINIO_PUBLIC_ENDPOINT` 用于生成预签名上传 URL，写死为某次网络环境的本机 IP；换网络后本机 IP 变了，客户端拿旧 IP 连 MinIO 超时。且该值在 API 启动时经 `configuration.ts` 一次性读取，改 .env 必须重启 API
- **修复**：`scripts/dev-up.sh` 在启动 API **之前**自动 `ipconfig getifaddr en0/en1` 检测当前 LAN IP，与 .env 不一致则 `sed` 原地更新 `MINIO_PUBLIC_ENDPOINT`，实现换网络后重启即自动适配
- **相关**：`scripts/dev-up.sh`、`.env`、`apps/api/src/modules/documents/storage.service.ts`（presignClient）

## ES 换 IK 分词必须删索引重建，旧 mapping 改不了 analyzer

- **现象**：代码改成 `ik_max_word` 后 `_analyze` 仍按字切开，或创建索引报 `analyzer [ik_max_word] not found`
- **根因**：已有字段的 analyzer 不能改；IK 是插件，官方镜像默认没有
- **修复**：`deploy/elasticsearch/Dockerfile` 预装 `analysis-ik` 8.15.0；非生产 `ensureIndex` 发现分析器不匹配会删索引重建。重建后需从 PG 回填分片（或 `reindex?from_stage=index`）
- **相关**：`docker-compose.yml`、`apps/api/src/modules/retrieval/es.service.ts`

## ES fs 快照必须配置 path.repo 白名单

- **现象**：注册快照仓库报 `location [/tmp/es-backup] doesn't match any of the locations specified by path.repo because this setting is empty`，且 `wait_for_completion` 不报错时快照静默为空
- **根因**：ES 安全设计，fs 仓库路径必须在 `path.repo` 白名单内；docker 镜像通过环境变量 `path.repo` 传入（entrypoint 自动转 elasticsearch.yml）
- **修复**：compose 加 `path.repo: "/tmp/es-backup"`；备份脚本对 snapshot 响应断言 `"state":"SUCCESS"`，失败即中断
- **教训**：备份脚本必须校验每步结果，"命令没报错" ≠ "备份成功"；恢复演练是唯一能证明备份有效的方式
- **相关**：`docker-compose.yml`、`scripts/backup.sh`

## Neo4j 社区版不支持 STOP DATABASE（企业版功能）

- **现象**：`cypher-shell -d system "STOP DATABASE neo4j"` 报 `Unsupported administration command`
- **根因**：多库管理操作（CREATE/STOP/START DATABASE）全是企业版功能，社区版只能停实例
- **修复**：冷备方案——`docker stop` 后用临时容器挂载数据卷执行 `neo4j-admin database dump/load`
- **相关**：`scripts/backup.sh`、`scripts/restore.sh`

## magic-pdf 运行时还要下载 layoutreader 模型（huggingface 直连失败）

- **现象**：MinerU 解析报 500 `Max retries exceeded with url: /hantian/layoutreader/resolve/main/config.json (SSLError)`
- **根因**：magic-pdf 的阅读顺序排序依赖 layoutreader 模型，未包含在 PDF-Extract-Kit-1.0 仓内，运行时从 huggingface.co 下载；容器内直连 huggingface 被墙
- **修复**：宿主机用 modelscope 下载 `ppaanngggg/layoutreader` 到 `data/models/`，`magic-pdf.json` 配置 `layoutreader-model-dir` 指向容器内挂载路径；compose 加 `HF_ENDPOINT=https://hf-mirror.com` 兜底其他 HF 下载
- **注意**：modelscope 新版缓存结构是 `<cache_dir>/models/<org>--<repo>/snapshots/master`，配置路径要指到 snapshots/master 这一层
- **相关**：`services/mineru/magic-pdf.json`、`docker-compose.yml`

## Ollama 是宿主机进程，docker compose 管不到

- **现象**：入库在 MinerU 解析成功后报 `fetch failed`，文档 FAILED
- **根因**：Ollama 跑在宿主机（非容器），机器重启或手动关闭后，worker 的 embedding 请求失败；报错点远离根因（日志先看到 chunks 成功，再看到 fetch failed）
- **修复**：`scripts/dev-up.sh` 增加 Ollama 检测与自动拉起；排查 `fetch failed` 时按调用链逐个 curl 健康端点（MinerU /health → Ollama /api/tags → ES /_cluster/health）
- **相关**：`scripts/dev-up.sh`、`.env` EMBEDDING_BASE_URL

## magic-pdf 1.3.x 移除 magic_pdf.pipe 模块

- **现象**：MinerU 解析报 500 `No module named 'magic_pdf.pipe'`
- **根因**：magic-pdf 1.3.x 重构 API，旧版 `UNIPipe.pipe_classify/pipe_analyze/pipe_parse` 流程被移除
- **修复**：改用 1.3.x 管线：`PymuDocDataset` + `doc_analyze` + `infer_result.pipe_txt_mode/pipe_ocr_mode`；middle_json 的块列表字段从 `preproc_blocks` 变为 `para_blocks`，表格 HTML 在 `blocks[].table_body` 的 span `html` 字段
- **相关**：`services/mineru/main.py`

## magic-pdf 1.3.x 必须提供配置文件与预下载模型

- **现象**：解析报 500 `/root/magic-pdf.json not found`
- **根因**：1.3.x 启动时读 `~/magic-pdf.json` 定位模型目录，且不再自动下载模型；CLI 也无 model download 子命令
- **修复**：`services/mineru/magic-pdf.json` 固化进镜像（`COPY` 到 `/root/magic-pdf.json`）；模型用 `modelscope.snapshot_download('opendatalab/PDF-Extract-Kit-1.0')`（约 14GB）下载到宿主机 `data/models/`，compose 挂载到容器 `/root/models`；hf-mirror 对该仓不可用，modelscope 稳定
- **注意**：`models-dir` 需指向仓内 `models/` 子目录（如 `/root/models/models`），不是下载根目录
- **相关**：`services/mineru/Dockerfile`、`services/mineru/magic-pdf.json`、`docker-compose.yml`

## magic-pdf 1.3.0 依赖与模型仓的版本错配（连环坑）

- **现象**：依次报 `No module named 'pycocotools'` → `No module named 'detectron2'` → `ch_PP-OCRv3_det_infer.pth 不存在` → `ch_PP-OCRv5_det_infer is not in arch_config.yaml` → state_dict key 不匹配 → `UnimerMBartForCausalLM.forward() got an unexpected keyword argument 'cache_position'`
- **根因与修复**：
  1. `pycocotools` 未在 magic-pdf[full] 依赖中声明 → Dockerfile 显式补装
  2. `layout-config` 缺省值是 layoutlmv3（依赖需编译的 detectron2）→ 配置显式指定 `doclayout_yolo`
  3. PDF-Extract-Kit-1.0 仓不再提供 ch/en PP-OCRv3 det 权重，而内置 models_config.yml 仍指向 v3 → sed 改为仓内自带的 `Multilingual_PP-OCRv3_det_infer.pth`（det 只做区域检测，多语言版覆盖中英文）
  4. PP-OCRv5 det 权重与内置 pytorch 架构不兼容（state_dict key 不匹配），不可用
  5. unimernet 公式识别代码与新版 transformers 不兼容（cache_position）→ `formula-config.enable=false` 关闭（制度类文档无公式）
- **相关**：`services/mineru/Dockerfile`、`services/mineru/magic-pdf.json`

## Elasticsearch 8 mapping 不支持 boost 参数

- **现象**：建索引报 mapping 解析错误
- **根因**：ES 8 移除了 mapping 级 `boost`，改为查询时 boosting
- **修复**：mapping 去掉 `boost`，在 query 的 `match` 子句上加权重
- **相关**：`apps/api/src/modules/retrieval/es.service.ts`

## MinIO 预签名 URL 设了 inline 仍触发下载

- **现象**：`presignedGetObject` 传了 `response-content-disposition: inline`，浏览器打开仍下载而非预览
- **根因**：分片上传时对象 Content-Type 落为 `binary/octet-stream`，浏览器对未知类型无视 inline 一律下载
- **修复**：respHeaders 同时覆盖 `response-content-type` 为文档真实 MIME（如 `application/pdf`）
- **相关**：`apps/api/src/modules/documents/storage.service.ts` presignDownload

## macOS 系统代理（Clash）下 Node fetch 直连被重置 / 走代理复用死连接挂起

- **现象**：worker 调 MinerU 线上 API，apply/PUT 成功但 10s 后第一次轮询必现 `fetch failed cause=ECONNRESET`（TLS 握手被重置）；改用 `NODE_USE_ENV_PROXY=1` 走代理后，又出现请求挂起（LLM 调用 60s 超时）
- **根因**：①系统代理启用时 mineru.net 直连被中间设备干扰（curl 读系统代理所以正常，Node fetch 默认直连）；②走代理后 undici keep-alive 复用的空闲隧道连接已被代理回收，复用即 ECONNRESET 或静默挂起
- **修复**：最终方案是关掉系统代理走纯直连（用户网络环境 mineru.net/阿里云直连可达）；若必须走代理，需 `NODE_USE_ENV_PROXY=1` + 禁 keep-alive 的 dispatcher（`new Agent({keepAliveTimeout:1})`，且 undici 包版本须与 Node 内置 fetch 协议匹配，Node 24 用 undici@7，@8 会报 `UND_ERR_INVALID_ARG invalid onRequestStart`）
- **相关**：`apps/worker/src/pipelines/mineru.client.ts` fetchWithCause（保留 cause 日志便于定位）
