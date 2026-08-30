# 中间件坑点（ES / Redis / MinIO / Ollama / MinerU）

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
