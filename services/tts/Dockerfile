FROM python:3.11-slim

RUN pip install --no-cache-dir \
    edge-tts==7.2.3 \
    fastapi==0.115.0 \
    uvicorn==0.30.6

WORKDIR /app
COPY main.py /app/main.py

EXPOSE 8750
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8750"]
