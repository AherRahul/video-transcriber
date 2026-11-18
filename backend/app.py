"""
HTTP API for the transcriber. Runs on this machine only (127.0.0.1).

POST /api/jobs                {url, language?, model?, forceWhisper?, screenshots?}  -> {id}
GET  /api/jobs/{id}           -> status, progress and, when done, the transcript (and `frames`, how the
                                 screenshots are going)
GET  /api/jobs/{id}/download  ?format=txt|srt|vtt&timestamps=true|false
GET  /api/jobs/{id}/frames    -> {state, percent, message, items: [{t, url, file, text}]}
GET  /api/jobs/{id}/frames/{file}  -> one screenshot (JPEG)
GET  /api/jobs/{id}/frames.zip     -> every screenshot, REFERENCES.md and references.json
GET  /api/health              -> tools found
GET  /api/busy                -> work a restart would cut short (dev.py waits for it)
     /api/motion/...           -> Motion: short animated videos made by Claude (see motion/api.py)

Jobs run one at a time in a background thread (Whisper uses every CPU core) and live in memory
until the server stops. After the transcript, a job takes screenshots of the video (on by default, see
screenshots.py): the transcript is shown at once while they are taken. They are kept on disk, so they
outlive the job in memory and a restart.
"""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import screenshots as shots
import transcriber as tr
from motion import api as motion_api

app = FastAPI(title="Video Transcriber")

# The built page (frontend/dist). Motion's player page is served from it too. Motion reads a job's
# screenshots from disk (shots.load) when Make a Motion video takes them along.
_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
motion_api.install(app, _dist, tr.find_ffmpeg, references=shots.load)

# Screenshots are kept 14 days: older job folders go when the app starts.
shots.cleanup()

_executor = ThreadPoolExecutor(max_workers=1)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
MAX_JOBS = 50


class JobRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    language: str | None = Field(default=None, max_length=12)
    model: str = tr.DEFAULT_MODEL
    forceWhisper: bool = False
    # screenshots of the video at each new scene and every 15 s, with what is said then (layout references
    # for Motion), taken after the transcript
    screenshots: bool = True


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
    except tr.TranscriptError as err:
        _update(job_id, state="error", message=str(err), frames={"state": "none", "message": "No transcript, so no screenshots."})
        return
    except Exception as err:  # noqa: BLE001 - report anything else without crashing the worker
        _update(job_id, state="error", message=f"Something went wrong: {type(err).__name__}: {err}"[:400], frames={"state": "none", "message": "No transcript, so no screenshots."})
        return

    # The transcript is done and shown at once. The screenshots follow in this same worker (so the next
    # video waits for them), with their own progress; whatever goes wrong there, the transcript stays done.
    if not req.screenshots:
        _update(job_id, state="done", stage="done", percent=100, message="Done", transcript=t)
        return
    _update(job_id, state="done", stage="done", percent=100, message="Done", transcript=t, frames={"state": "running", "percent": 0, "message": "Taking screenshots"})

    def shot_progress(pct: float | None, message: str) -> None:
        _update(job_id, frames={"state": "running", "percent": None if pct is None else round(pct, 1), "message": message})

    result = shots.run_for_job(job_id, t, shot_progress)
    _update(job_id, frames={**result, "percent": 100 if result["state"] == "done" else None})


def _public(job: dict) -> dict:
    out = {k: v for k, v in job.items() if k != "transcript"}
    t: tr.Transcript | None = job.get("transcript")
    if t:
        out["transcript"] = asdict(t)
    return out


@app.get("/api/busy")
def busy() -> dict:
    """Work a restart would cut short: transcriptions (and their screenshots) here, and Motion's exports,
    voice jobs and Claude turns. The dev runner (dev.py) waits for all of it before it restarts the server."""
    with _lock:
        jobs = list(_jobs.values())
    transcribing = sum(1 for j in jobs if j.get("state") in ("queued", "running") or (j.get("frames") or {}).get("state") in ("waiting", "running"))
    motion = app.state.motion_busy() if hasattr(app.state, "motion_busy") else {}
    counts = {"transcriptions": transcribing, **motion}
    return {"busy": any(counts.values()), **counts}


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
            # the screenshots' own state: off, waiting (for the transcript), running, done or none (with why)
            "frames": {"state": "waiting", "message": "After the transcript"} if req.screenshots else {"state": "off", "message": "Screenshots were turned off for this video."},
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
    # only what a file name can't hold is removed (\w alone dropped Hindi vowel signs: हिंदी became हद)
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "", t.title).strip()[:80] or "transcript"
    # A header can only carry plain ASCII, so a Hindi (or any non-Latin) title went in raw and the download
    # failed. The plain filename is an ASCII fallback; filename* carries the real title (RFC 6266), which
    # browsers prefer.
    plain = re.sub(r"[^A-Za-z0-9\- ]+", "", name).strip() or "transcript"
    disposition = f"attachment; filename=\"{plain}.{format}\"; filename*=UTF-8''{urllib.parse.quote(f'{name}.{format}')}"
    return PlainTextResponse(body, media_type=f"{mime}; charset=utf-8", headers={"Content-Disposition": disposition})


# ── screenshots: from the job in memory while they are taken, from disk once they are done ──


@app.get("/api/jobs/{job_id}/frames")
def frames(job_id: str) -> dict:
    """How the screenshots are going and, once done, each one's time, address and what is said then.
    A job gone from memory (after a restart) is answered from its folder on disk."""
    with _lock:
        job = _jobs.get(job_id)
        status = dict(job.get("frames") or {}) if job else None
    found = shots.load(job_id)
    if status is None:
        if found is None:
            raise HTTPException(404, "No such job (the server may have restarted).")
        status = {"state": found["state"], "message": found["message"]}
        if status["state"] not in ("done", "none"):  # the app stopped while they were being taken
            status = {"state": "none", "message": "The screenshots were cut short when the app stopped."}
    items = []
    if status.get("state") == "done":
        items = [
            {"t": it["t"], "url": f"/api/jobs/{job_id}/frames/{it['file']}", "file": it["file"], "text": it["text"]}
            for it in (found or {}).get("items", [])
        ]
        if not items:
            status = {"state": "none", "message": "The screenshots are no longer on disk (they are kept 14 days)."}
    return {"state": status.get("state"), "percent": status.get("percent"), "message": status.get("message") or "", "items": items}


@app.get("/api/jobs/{job_id}/frames.zip")
def frames_zip(job_id: str) -> Response:
    found = shots.load(job_id)
    if not found or not found["items"]:
        raise HTTPException(404, "This video has no screenshots.")
    # ASCII only: a header can't carry other characters
    name = re.sub(r"[^A-Za-z0-9\- ]+", "", found["title"]).strip()[:80] or "video"
    return Response(
        shots.zip_bytes(found),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name} - screenshots.zip"'},
    )


@app.get("/api/jobs/{job_id}/frames/{file}")
def frame_file(job_id: str, file: str) -> FileResponse:
    f = shots.frame_path(job_id, file)
    if not f:
        raise HTTPException(404, "No such screenshot.")
    # a job's frames never change (a new transcription is a new job), so the browser may keep them
    return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


# The built page (frontend/dist), when present, is served from the same address.
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        # no-cache: the browser asks again every time (a 304 when nothing changed). A rebuild deletes the old
        # hashed scripts, so a page kept from before it would point at files that are gone.
        return FileResponse(_dist / "index.html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn

    if not shutil.which("ffmpeg") and not tr.find_ffmpeg():
        print("Warning: FFmpeg not found; some sites (HLS streams) will fail.")
    # TRANSCRIBER_PORT runs a second copy beside the usual one (a test copy, or dev.py's)
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TRANSCRIBER_PORT", "8765")))
