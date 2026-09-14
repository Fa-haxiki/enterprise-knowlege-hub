#!/usr/bin/env python3
"""生成「仅含图片、无文字层」的入库拒收测试文档，输出到 test-docs/image-only/。

覆盖两条解析路径：
  - PDF：整页位图，无 text 操作符（模拟扫描件，走 MinerU）
  - md / html：只有图片标记（走 TextParser）
"""

from __future__ import annotations

import os
from io import BytesIO

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "test-docs", "image-only")

FONT = "/System/Library/Fonts/STHeiti Light.ttc"
FONT_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"
W, H = 1240, 1754  # ~A4 @150dpi


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size, index=0)


def page_bg() -> Image.Image:
    img = Image.new("RGB", (W, H), (236, 232, 224))
    return img


def draw_scan_noise(img: Image.Image) -> Image.Image:
    return img.filter(ImageFilter.GaussianBlur(radius=0.4))


def invoice_page(page: int) -> Image.Image:
    img = page_bg()
    d = ImageDraw.Draw(img)
    d.rectangle((60, 60, W - 60, H - 60), outline=(80, 80, 80), width=2)
    d.text((120, 120), "增值税电子普通发票（扫描件）", font=font(42, True), fill=(30, 30, 30))
    d.text((120, 200), f"发票号码  253120000000{page:04d}", font=font(28), fill=(50, 50, 50))
    d.text((120, 260), "购方    华辰智造科技股份有限公司", font=font(28), fill=(50, 50, 50))
    d.text((120, 320), "销方    上海云途商旅服务有限公司", font=font(28), fill=(50, 50, 50))
    y = 420
    for line in (
        "项目                  金额",
        "机票（上海-北京往返）   2,860.00",
        "酒店住宿 2 晚          1,280.00",
        "合计（含税）           4,140.00",
        "",
        "本页为打印机扫描图像，PDF 内无文字层。",
    ):
        d.text((120, y), line, font=font(26), fill=(40, 40, 40))
        y += 56
    d.text((120, H - 180), f"第 {page} 页 / 共 2 页", font=font(22), fill=(90, 90, 90))
    return draw_scan_noise(img)


def minutes_page() -> Image.Image:
    img = page_bg()
    d = ImageDraw.Draw(img)
    d.rectangle((60, 60, W - 60, H - 60), outline=(80, 80, 80), width=2)
    d.text((120, 140), "项目周例会签到表（扫描件）", font=font(40, True), fill=(30, 30, 30))
    d.text((120, 230), "会议主题  星河 MES 二期排期对齐", font=font(28), fill=(50, 50, 50))
    d.text((120, 300), "时间地点  2026-03-12  研发楼 3F", font=font(28), fill=(50, 50, 50))
    y = 400
    for i, name in enumerate(("陈思远", "林婉清", "赵启明", "周可欣", "外来访客"), start=1):
        d.text((120, y), f"{i}.  {name}    签字：____________", font=font(28), fill=(40, 40, 40))
        y += 70
    d.text((120, H - 180), "本页为手机拍照入档，无 OCR 文字层。", font=font(22), fill=(90, 90, 90))
    return draw_scan_noise(img)


def pdf_from_images(path: str, images: list[Image.Image]) -> None:
    c = canvas.Canvas(path, pagesize=A4)
    pw, ph = A4
    for im in images:
        buf = BytesIO()
        im.save(buf, format="PNG")
        buf.seek(0)
        c.drawImage(ImageReader(buf), 0, 0, width=pw, height=ph)
        c.showPage()
    c.save()


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    pdf_from_images(
        os.path.join(OUT_DIR, "扫描件-差旅发票.pdf"),
        [invoice_page(1), invoice_page(2)],
    )
    pdf_from_images(
        os.path.join(OUT_DIR, "扫描件-会议签到表.pdf"),
        [minutes_page()],
    )

    md = os.path.join(OUT_DIR, "纯图片.md")
    with open(md, "w", encoding="utf-8") as f:
        f.write("![](https://example.com/scan-invoice-p1.png)\n\n")
        f.write("![签到表](./scan-signin.jpg)\n")

    html = os.path.join(OUT_DIR, "纯图片.html")
    with open(html, "w", encoding="utf-8") as f:
        f.write(
            "<!doctype html><html><body>"
            '<img src="https://example.com/scan-invoice-p1.png" alt="">'
            '<img src="./scan-signin.jpg" alt="签到">'
            "</body></html>\n"
        )

    print(f"written to {OUT_DIR}")
    for name in sorted(os.listdir(OUT_DIR)):
        p = os.path.join(OUT_DIR, name)
        print(f"  {name}  {os.path.getsize(p)} bytes")


if __name__ == "__main__":
    main()
