"""
HTTP API for the transcriber. Runs on this machine only (127.0.0.1).

POST /api/jobs                {url, language?, model?, forceWhisper?, screenshots?}  -> {id}
GET  /api/jobs                -> every job in memory, newest first, without the transcripts
GET  /api/jobs/{id}           -> status, progress and, when done, the transcript (and `frames`, how the
                                 screenshots are going)
POST /api/jobs/{id}/cancel    -> stops a waiting or running transcription
POST /api/jobs/{id}/retry     -> tries a failed or cancelled one again (same link and options, same row)
POST /api/jobs/retry-failed   -> tries every failed one again
DELETE /api/jobs/{id}         -> forgets a finished one (its screenshots stay on disk)
GET  /api/jobs/{id}/download  ?format=txt|srt|vtt&timestamps=true|false
GET  /api/jobs/{id}/frames    -> {state, percent, message, items: [{t, url, file, text}]}
GET  /api/jobs/{id}/frames/{file}  -> one screenshot (JPEG)
GET  /api/jobs/{id}/frames.zip     -> every screenshot, REFERENCES.md and references.json
GET  /api/health              -> tools found
GET  /api/busy                -> work a restart would cut short (dev.py waits for it)
     /api/motion/...           -> Motion: short animated videos made by Claude (see motion/api.py)

Several videos are transcribed at the same time, each on its own worker thread, and live in memory until
the server stops. The heavy steps have their own limits, so a long video doesn't hold up the rest:
  - the audio download (a video without captions): DOWNLOAD_SLOTS at once
  - Whisper on this computer: transcriber.SPEECH_SLOTS at once, sharing one model
  - the screenshots, after the transcript (on by default, see screenshots.py): SHOT_SLOTS at once, in
    their own pool, so the next video's transcript never waits for them
A video with captions needs none of these and is done in seconds even while others run. The transcript
is shown at once while the screenshots are taken. Those are kept on disk, so they outlive the job in
memory and a restart.
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
from contextlib import contextmanager
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

DOWNLOAD_SLOTS = tr._env_int("TRANSCRIBE_DOWNLOADS", 3, 1, 8)
SHOT_SLOTS = tr._env_int("TRANSCRIBE_SCREENSHOTS", 2, 1, 4)
# a job waiting for a slot still holds its thread, so there are threads for every slot and a few more:
# those read the next videos' details and captions meanwhile (quick network calls, no slot needed)
ACTIVE_JOBS = DOWNLOAD_SLOTS + tr.SPEECH_SLOTS + 3

_executor = ThreadPoolExecutor(max_workers=ACTIVE_JOBS, thread_name_prefix="transcribe")
_shots_executor = ThreadPoolExecutor(max_workers=SHOT_SLOTS, thread_name_prefix="screenshots")
_slots = {"download": threading.BoundedSemaphore(DOWNLOAD_SLOTS), "speech": threading.BoundedSemaphore(tr.SPEECH_SLOTS)}
_jobs: dict[str, dict] = {}
_cancels: dict[str, threading.Event] = {}
_lock = threading.Lock()
MAX_JOBS = 50


class _Cancelled(Exception):
    """Raised inside a job (from its progress callback or while it waits for a slot) once it is cancelled."""


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


_WAITING = {
    "download": "Waiting to download the audio ({n} downloads at once)",
    "speech": "Waiting for speech-to-text ({n} videos at once)",
}


def _gate(job_id: str, cancel: threading.Event):
    """transcribe_url's gate: a slot of the step's own limit, taken when one is free. While the job waits, its
    status says what for; a cancel ends the wait."""

    @contextmanager
    def hold(stage: str):
        sem = _slots[stage]
        if not sem.acquire(blocking=False):
            n = DOWNLOAD_SLOTS if stage == "download" else tr.SPEECH_SLOTS
            _update(job_id, state="running", stage="waiting", percent=None, message=_WAITING[stage].format(n=n))
            while not sem.acquire(timeout=0.5):
                if cancel.is_set():
                    raise _Cancelled()
        try:
            yield
        finally:
            sem.release()

    return hold


def _run(job_id: str, req: JobRequest, run: int = 1) -> None:
    with _lock:
        job = _jobs.get(job_id)
        # a newer try of this job was queued (Retry on a job cancelled before its worker started): this one stands down
        if not job or int(job.get("run") or 1) != run:
            return
        cancel = _cancels.get(job_id) or threading.Event()
    if cancel.is_set():
        _update(job_id, state="cancelled", stage="cancelled", percent=None, message="Cancelled", frames={"state": "none", "message": "Cancelled."})
        return

    def progress(stage: str, pct: float | None, message: str) -> None:
        # the cancel lands here: the download's hook and Whisper's loop both call this as they go
        if cancel.is_set():
            raise _Cancelled()
        _update(job_id, state="running", stage=stage, percent=None if pct is None else round(pct, 1), message=message)

    def on_info(title: str, duration: float | None) -> None:
        _update(job_id, title=title, duration=duration)

    no_shots = {"state": "none", "message": "No transcript, so no screenshots."}
    try:
        t = tr.transcribe_url(
            req.url,
            language=(req.language or None),
            model=req.model,
            force_whisper=req.forceWhisper,
            progress=progress,
            gate=_gate(job_id, cancel),
            on_info=on_info,
        )
    except Exception as err:  # noqa: BLE001 - report anything else without crashing the worker
        if cancel.is_set():  # yt-dlp wraps an error raised in its hook, so the flag decides
            _update(job_id, state="cancelled", stage="cancelled", percent=None, message="Cancelled", frames={"state": "none", "message": "Cancelled."})
        elif isinstance(err, tr.TranscriptError):
            _update(job_id, state="error", message=str(err), frames=no_shots)
        else:
            _update(job_id, state="error", message=f"Something went wrong: {type(err).__name__}: {err}"[:400], frames=no_shots)
        return

    # The transcript is done and shown at once. The screenshots follow in their own pool (the next video
    # doesn't wait for them), with their own progress; whatever goes wrong there, the transcript stays done.
    if not req.screenshots:
        _update(job_id, state="done", stage="done", percent=100, message="Done", transcript=t, title=t.title)
        return
    _update(job_id, state="done", stage="done", percent=100, message="Done", transcript=t, title=t.title,
            frames={"state": "waiting", "percent": None, "message": "Waiting for the screenshots of other videos to finish"})
    _shots_executor.submit(_screenshots, job_id, t)


def _screenshots(job_id: str, t: tr.Transcript) -> None:
    def shot_progress(pct: float | None, message: str) -> None:
        _update(job_id, frames={"state": "running", "percent": None if pct is None else round(pct, 1), "message": message})

    shot_progress(0, "Taking screenshots")
    result = shots.run_for_job(job_id, t, shot_progress)
    _update(job_id, frames={**result, "percent": 100 if result["state"] == "done" else None})


def _public(job: dict, transcript: bool = True) -> dict:
    """A job as the page gets it. Without the transcript (the list): its title, source and length only."""
    out = {k: v for k, v in job.items() if k != "transcript"}
    t: tr.Transcript | None = job.get("transcript")
    if t and transcript:
        out["transcript"] = asdict(t)
    elif t:
        out["summary"] = {"source": t.source, "language": t.language, "duration": t.duration, "lines": len(t.segments)}
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
        # how much runs side by side (the page says so next to the queue)
        "parallel": {"speech": tr.SPEECH_SLOTS, "downloads": DOWNLOAD_SLOTS, "screenshots": SHOT_SLOTS, "whisperThreads": tr.WHISPER_THREADS},
    }


@app.post("/api/jobs")
def create_job(req: JobRequest) -> dict:
    job_id = uuid.uuid4().hex[:12]
    now = time.time()
    with _lock:
        # Keep memory bounded: drop the oldest finished jobs (never one whose screenshots are still coming).
        finished = sorted((j for j in _jobs.values() if _settled(j)), key=lambda j: j["createdAt"])
        while len(_jobs) >= MAX_JOBS and finished:
            gone = finished.pop(0)["id"]
            _jobs.pop(gone, None)
            _cancels.pop(gone, None)
        _jobs[job_id] = {
            "id": job_id,
            "url": req.url.strip(),
            "title": None,  # the video's title, once it has been read
            "duration": None,
            "model": req.model,
            "state": "queued",
            "stage": "queued",
            "percent": None,
            "message": "Waiting for a free worker",
            "createdAt": now,
            "updatedAt": now,
            # the screenshots' own state: off, waiting (for the transcript), running, done or none (with why)
            "frames": _frames_start(req),
            # what was asked (language, model, captions or not, screenshots), so Retry asks the same again
            "request": req.model_dump(),
            "attempts": 1,
            "run": 1,  # which try's worker may run it (see _retry)
        }
        _cancels[job_id] = threading.Event()
    _executor.submit(_run, job_id, req, 1)
    return {"id": job_id}


def _frames_start(req: JobRequest) -> dict:
    return {"state": "waiting", "message": "After the transcript"} if req.screenshots else {"state": "off", "message": "Screenshots were turned off for this video."}


def _retry(job_id: str) -> None:
    """Puts a failed or cancelled job back in the queue as it was asked (same link and options), in its own row,
    counting the tries. The caller holds _lock and has checked it may be retried."""
    job = _jobs[job_id]
    asked = job.get("request") or {"url": job["url"], "model": job.get("model") or tr.DEFAULT_MODEL}
    req = JobRequest(**asked)
    tries = int(job.get("attempts") or 1) + 1
    job.pop("transcript", None)
    job.pop("summary", None)
    run = int(job.get("run") or 1) + 1
    job.update(state="queued", stage="queued", percent=None, message=f"Waiting for a free worker (try {tries})", updatedAt=time.time(),
               attempts=tries, run=run, frames=_frames_start(req))
    _cancels[job_id] = threading.Event()
    _executor.submit(_run, job_id, req, run)


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str) -> dict:
    """Tries a failed or cancelled transcription again: the same link with the same options, in the same row."""
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(404, "No such job (the server may have restarted).")
        if job["state"] not in ("error", "cancelled"):
            raise HTTPException(409, "Only a video that failed or was cancelled can be tried again.")
        _retry(job_id)
        return {"ok": True, "attempts": job["attempts"]}


@app.post("/api/jobs/retry-failed")
def retry_failed() -> dict:
    """Tries every failed transcription again (cancelled ones stay cancelled). They queue like new ones, so the
    download limit still spreads them out."""
    with _lock:
        failed = [j["id"] for j in sorted(_jobs.values(), key=lambda j: j["createdAt"]) if j["state"] == "error"]
        for job_id in failed:
            _retry(job_id)
    return {"ok": True, "retried": len(failed)}


def _settled(job: dict) -> bool:
    """Nothing more will happen to this job: the transcript is done, failed or cancelled, and the screenshots
    aren't waiting or being taken."""
    return job["state"] in ("done", "error", "cancelled") and (job.get("frames") or {}).get("state") not in ("waiting", "running")


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    """Every job in memory, newest first, without the transcripts (the page fetches the one it shows)."""
    with _lock:
        jobs = [dict(j) for j in _jobs.values()]
    return [_public(j, transcript=False) for j in sorted(jobs, key=lambda j: j["createdAt"], reverse=True)]


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    """Stops a transcription that is waiting or running. Whisper and a download stop at their next step
    (a second or two); a job still waiting for a worker never starts. The screenshots of a finished
    transcript are not stopped."""
    with _lock:
        job = _jobs.get(job_id)
        ev = _cancels.get(job_id)
        if not job:
            raise HTTPException(404, "No such job (the server may have restarted).")
        if job["state"] not in ("queued", "running"):
            return {"ok": True, "state": job["state"]}
        if ev:
            ev.set()
        if job["state"] == "queued":  # it never started: settled at once (the worker will see the flag and skip it)
            job.update(state="cancelled", stage="cancelled", percent=None, message="Cancelled", updatedAt=time.time(),
                       frames={"state": "none", "message": "Cancelled."})
    return {"ok": True, "state": "cancelling"}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    """Forgets a finished job (the list on the page gets shorter). Its screenshots stay on disk for 14 days."""
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return {"ok": True}
        if not _settled(job):
            raise HTTPException(409, "This video is still being transcribed: cancel it first.")
        _jobs.pop(job_id, None)
        _cancels.pop(job_id, None)
    return {"ok": True}


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
