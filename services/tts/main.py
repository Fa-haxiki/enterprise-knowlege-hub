"""TTS 语音合成服务：edge-tts 流式合成，输出 MP3 音频流。

POST /synthesize {"text": "...", "voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%"}
→ audio/mpeg 流式响应
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="TTS Service", version="0.1.0")

MAX_TEXT_LEN = 2000


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str = "zh-CN-XiaoxiaoNeural"
    rate: str = "+0%"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest):
    import edge_tts

    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    if len(text) > MAX_TEXT_LEN:
        raise HTTPException(status_code=400, detail="text too long")

    async def audio_stream():
        communicate = edge_tts.Communicate(text, req.voice, rate=req.rate)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]

    return StreamingResponse(audio_stream(), media_type="audio/mpeg")
