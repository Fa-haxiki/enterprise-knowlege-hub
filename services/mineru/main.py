"""MinerU 解析服务：接收文件上传，返回结构化块 JSON。

响应结构：
{
  "blocks": [
    {"type": "heading|paragraph|table|figure|formula",
     "level": 1,            # heading 层级
     "text": "...",         # 段落文本 / 表格 Markdown / 公式 LaTeX
     "page": 1,
     "bbox": [x0, y0, x1, y1]}
  ],
  "meta": {"pages": 12, "language": "zh", "parser_version": "magic-pdf-1.3"}
}
"""

import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile

app = FastAPI(title="MinerU Parse Service", version="0.1.0")

SUPPORTED = {".pdf", ".docx", ".pptx", ".xlsx", ".md", ".txt", ".html"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/parse")
async def parse(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED:
        raise HTTPException(status_code=400, detail=f"unsupported file type: {suffix}")

    content = await file.read()
    if len(content) > 200 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="file too large")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)

    try:
        blocks, pages = _parse_with_magic_pdf(tmp_path)
        return {
            "blocks": blocks,
            "meta": {"pages": pages, "parser_version": "magic-pdf"},
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)


def _parse_with_magic_pdf(path: Path):
    """调用 magic-pdf 解析，统一转换为结构化块。

    说明：magic-pdf 的 API 随版本变化，此处以其 middle_json 中间格式为准做适配；
    纯文本类文件（md/txt/html）直接按段落切分。
    """
    suffix = path.suffix.lower()
    if suffix in {".md", ".txt", ".html"}:
        text = path.read_text(encoding="utf-8", errors="ignore")
        blocks = []
        for para in text.split("\n\n"):
            para = para.strip()
            if not para:
                continue
            if para.startswith("#"):
                level = len(para) - len(para.lstrip("#"))
                blocks.append({"type": "heading", "level": min(level, 6),
                               "text": para.lstrip("#").strip(), "page": 1})
            else:
                blocks.append({"type": "paragraph", "text": para, "page": 1})
        return blocks, 1

    # PDF / Office：magic-pdf 1.3.x 管线（PymuDocDataset + doc_analyze）
    import json

    from magic_pdf.config.enums import SupportedPdfParseMethod
    from magic_pdf.data.data_reader_writer import FileBasedDataReader, FileBasedDataWriter
    from magic_pdf.data.dataset import PymuDocDataset
    from magic_pdf.model.doc_analyze_by_custom_model import doc_analyze

    reader = FileBasedDataReader("")
    pdf_bytes = reader.read(str(path))
    ds = PymuDocDataset(pdf_bytes)

    with tempfile.TemporaryDirectory() as img_dir:
        image_writer = FileBasedDataWriter(img_dir)
        if ds.classify() == SupportedPdfParseMethod.OCR:
            infer_result = ds.apply(doc_analyze, ocr=True)
            pipe_result = infer_result.pipe_ocr_mode(image_writer)
        else:
            infer_result = ds.apply(doc_analyze, ocr=False)
            pipe_result = infer_result.pipe_txt_mode(image_writer)
        middle_data = json.loads(pipe_result.get_middle_json())

    blocks = []
    pages = 0
    for page_info in middle_data.get("pdf_info", []):
        pages += 1
        page_no = page_info.get("page_no", pages - 1) + 1
        for block in page_info.get("para_blocks", []):
            btype = block.get("type", "text")
            bbox = block.get("bbox")
            if btype == "title":
                text = _block_text(block)
                if text:
                    blocks.append({"type": "heading", "level": block.get("level", 1) or 1,
                                   "text": text, "page": page_no, "bbox": bbox})
            elif btype in ("text", "plain_text"):
                text = _block_text(block)
                if text:
                    blocks.append({"type": "paragraph", "text": text,
                                   "page": page_no, "bbox": bbox})
            elif btype == "table":
                text = _table_html(block) or _block_text(block)
                if text:
                    blocks.append({"type": "table", "text": text,
                                   "page": page_no, "bbox": bbox})
            elif btype == "interline_equation":
                text = _block_text(block)
                if text:
                    blocks.append({"type": "formula", "text": text,
                                   "page": page_no, "bbox": bbox})
    return blocks, pages


def _table_html(block) -> str:
    """magic-pdf 1.3.x 表格块：table_body 内的 span 携带 html 字段。"""
    for sub in block.get("blocks", []):
        if sub.get("type") == "table_body":
            for line in sub.get("lines", []):
                for span in line.get("spans", []):
                    html = span.get("html")
                    if html:
                        return html
    return ""


def _block_text(block) -> str:
    parts = []
    for line in block.get("lines", []):
        for span in line.get("spans", []):
            content = span.get("content") or span.get("text") or ""
            parts.append(content)
    return "".join(parts).strip()
