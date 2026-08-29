# MinerU 解析服务：FastAPI 包装 magic-pdf，输出结构化块
# 基础镜像含 CPU 版模型；GPU 部署请改用官方 CUDA 镜像
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    magic-pdf[full]==1.3.0 \
    fastapi==0.115.0 \
    uvicorn==0.30.6 \
    python-multipart==0.0.9

WORKDIR /app
COPY main.py /app/main.py

EXPOSE 8700
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8700"]
