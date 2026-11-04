"""
HTTP API for the transcriber. Runs on this machine only (127.0.0.1).

POST /api/jobs                {url, language?, model?, forceWhisper?}  -> {id}
GET  /api/jobs/{id}           -> status, progress and, when done, the transcript
GET  /api/jobs/{id}/download  ?format=txt|srt|vtt&timestamps=true|false
GET  /api/health              -> tools found

Jobs run one at a time in a background thread (Whisper uses every CPU core) and live in memory
until the server stops.
"""

from __future__ import annotations

import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import transcriber as tr

app = FastAPI(title="Video Transcriber")

_executor = ThreadPoolExecutor(max_workers=1)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
MAX_JOBS = 50


class JobRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    language: str | None = Field(default=None, max_length=12)
    model: str = tr.DEFAULT_MODEL
    forceWhisper: bool = False


def _update(job_id: str, **fields) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job.update(fields, updatedAt=time.time())


def _run(job_id: str, req: JobRequest) -> None:
    def progress(stage: str, pct: float | None, message: str) -> None:
        _update(job_id, state="running", stage=stage, percent=None if pct is None else round(pct, 1), message=message)

    try:
        t = tr.transcribe_url(
            req.url,
            language=(req.language or None),
            model=req.model,
            force_whisper=req.forceWhisper,
            progress=progress,
        )
        _update(job_id, state="done", stage="done", percent=100, message="Done", transcript=t)
    except tr.TranscriptError as err:
        _update(job_id, state="error", message=str(err))
    except Exception as err:  # noqa: BLE001 - report anything else without crashing the worker
        _update(job_id, state="error", message=f"Something went wrong: {type(err).__name__}: {err}"[:400])


def _public(job: dict) -> dict:
    out = {k: v for k, v in job.items() if k != "transcript"}
    t: tr.Transcript | None = job.get("transcript")
    if t:
        out["transcript"] = asdict(t)
    return out


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "ffmpeg": tr.find_ffmpeg() is not None,
        "models": tr.WHISPER_MODELS,
        "defaultModel": tr.DEFAULT_MODEL,
    }


@app.post("/api/jobs")
def create_job(req: JobRequest) -> dict:
    job_id = uuid.uuid4().hex[:12]
    now = time.time()
    with _lock:
        # Keep memory bounded: drop the oldest finished jobs.
        finished = sorted((j for j in _jobs.values() if j["state"] in ("done", "error")), key=lambda j: j["createdAt"])
        while len(_jobs) >= MAX_JOBS and finished:
            _jobs.pop(finished.pop(0)["id"], None)
        _jobs[job_id] = {
            "id": job_id,
            "url": req.url.strip(),
            "state": "queued",
            "stage": "queued",
            "percent": None,
            "message": "Waiting for the previous video to finish",
            "createdAt": now,
            "updatedAt": now,
        }
    _executor.submit(_run, job_id, req)
    return {"id": job_id}


def _get(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(404, "No such job (the server may have restarted).")
        return dict(job)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    return _public(_get(job_id))


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str, format: str = "txt", timestamps: bool = True) -> PlainTextResponse:
    job = _get(job_id)
    t: tr.Transcript | None = job.get("transcript")
    if not t:
        raise HTTPException(409, "The transcript is not ready yet.")
    if format == "srt":
        body, mime = tr.to_srt(t), "application/x-subrip"
    elif format == "vtt":
        body, mime = tr.to_vtt(t), "text/vtt"
    elif format == "txt":
        body, mime = tr.to_txt(t, timestamps), "text/plain"
    else:
        raise HTTPException(400, "format must be txt, srt or vtt")
    name = re.sub(r"[^\w\- ]+", "", t.title).strip()[:80] or "transcript"
    return PlainTextResponse(
        body,
        media_type=f"{mime}; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}.{format}"'},
    )


# The built page (frontend/dist), when present, is served from the same address.
_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_dist / "index.html")


if __name__ == "__main__":
    import uvicorn

    if not shutil.which("ffmpeg") and not tr.find_ffmpeg():
        print("Warning: FFmpeg not found; some sites (HLS streams) will fail.")
    uvicorn.run(app, host="127.0.0.1", port=8765)
