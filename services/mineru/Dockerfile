# MinerU 解析服务：FastAPI 包装 magic-pdf，输出结构化块
# 基础镜像含 CPU 版模型；GPU 部署请改用官方 CUDA 镜像
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    magic-pdf[full]==1.3.0 \
    pycocotools==2.0.8 \
    fastapi==0.115.0 \
    uvicorn==0.30.6 \
    python-multipart==0.0.9

# PDF-Extract-Kit-1.0 模型仓不再提供 ch/en PP-OCRv3 det 权重（v5 det 与内置架构不兼容），
# 改用仓内自带的 Multilingual_PP-OCRv3 det（det 只做文本区域检测，多语言版覆盖中英文）
RUN sed -i 's/ch_PP-OCRv3_det_infer.pth/Multilingual_PP-OCRv3_det_infer.pth/; s/en_PP-OCRv3_det_infer.pth/Multilingual_PP-OCRv3_det_infer.pth/' \
    /usr/local/lib/python3.10/site-packages/magic_pdf/model/sub_modules/ocr/paddleocr2pytorch/pytorchocr/utils/resources/models_config.yml

WORKDIR /app
COPY main.py /app/main.py
# magic-pdf 1.3.x 必需：配置文件指向模型目录（模型经 volume 挂载到 /root/models）
COPY magic-pdf.json /root/magic-pdf.json

EXPOSE 8700
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8700"]
