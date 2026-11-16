"""
HTTP routes under /api/motion, and `install(app, ...)`, which wires Motion into the transcriber's app.

Projects     GET/POST /projects, GET/PATCH/DELETE /projects/{id}, GET /projects/{id}/bundle
             (POST takes sourceText for a transcript, and framesJob to bring that transcription's
             screenshots along as layout references)
Scenes       PUT /projects/{id}/scenes/{sceneId}   (direct edits from the page; refused if stale)
Undo         POST /projects/{id}/undo
Assets       GET/POST /projects/{id}/assets, GET/DELETE /projects/{id}/assets/{name}
Chat         GET/POST /projects/{id}/chat, POST .../chat/stop, POST .../chat/new
Live updates GET /projects/{id}/events?after=<seq>&boot=<id>   (long poll)
Export       POST /projects/{id}/export {resolution, narration, sfx, loudness}, POST .../export/cancel,
             GET /projects/{id}/renders/{file} (the MP4s and their .srt and .vtt captions)
Captions     GET /projects/{id}/captions.srt, GET /projects/{id}/captions.vtt
Thumbnail    GET /projects/{id}/thumbnail.jpg (?download=1), GET/PUT /projects/{id}/thumbnail
Brand kits   GET/POST /brand-kits, PUT/DELETE /brand-kits/{id}, GET/POST/DELETE /brand-kits/{id}/logo,
             POST /brand-kits/extract
Health       GET /health
"""

from __future__ import annotations

import atexit
import hashlib
import io
import os
import re
import threading
import time
import urllib.parse
import zipfile
from pathlib import Path

from fastapi import APIRouter, Body, FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from . import agent as ag
from . import claude_code
from . import voice as vc
from . import brand as br
from . import render as rd
from .hub import Hub
from .jobs import Exports, VoiceJobs, narration_track, thumbnail_image
from .store import ASPECTS, TRANSITIONS, Store, StoreError, fmt_clock, slugify

BACKEND_DIR = Path(__file__).resolve().parent.parent


def load_env_file(path: Path) -> None:
    """backend/.env: KEY=value lines for ANTHROPIC_*, ELEVENLABS_* and MOTION_* settings (never overrides the real environment)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key.startswith(("ANTHROPIC_", "ELEVENLABS_", "MOTION_")) and key not in os.environ:
            os.environ[key] = value


def install(app: FastAPI, dist_dir: Path, find_ffmpeg, references=None) -> None:
    """`references(jobId)` finds a transcription's screenshots on disk ({folder, title, url, items: [{t,
    file, text}]} or None); the transcriber passes screenshots.load."""
    load_env_file(BACKEND_DIR / ".env")
    store = Store()
    hub = Hub(store)
    renderer = rd.RenderService(os.environ.get("MOTION_SELF_URL", "http://127.0.0.1:8765"), dist_dir)
    exports = Exports(store, renderer, hub, find_ffmpeg)
    voices = VoiceJobs(store, hub, find_ffmpeg)
    agent = ag.Agent(store, renderer, hub, exports)
    atexit.register(renderer.shutdown)
    last_snap: dict[str, tuple[str, float]] = {}  # project -> (what was edited, when), to group quick edits

    def busy() -> dict:
        """What a restart would cut short: exports, voice jobs and Claude turns in flight. The dev runner
        (backend/dev.py, run.ps1 -Dev) waits for these before it restarts the server on a code change."""
        def live(jobs) -> int:
            with jobs._lock:
                return sum(1 for j in jobs._jobs.values() if j.get("state") in ("queued", "running"))

        with agent._lock:
            turns = len(agent._turns)
        return {"exports": live(exports), "voice": live(voices), "claude": turns}

    app.state.motion_busy = busy

    @app.exception_handler(StoreError)
    async def store_error(_: Request, err: StoreError):
        return JSONResponse({"detail": str(err)}, status_code=err.status)

    @app.exception_handler(br.FetchError)
    async def fetch_error(_: Request, err: br.FetchError):
        return JSONResponse({"detail": str(err)}, status_code=400)

    @app.middleware("http")
    async def cors_for_player(request: Request, call_next):
        # the preview runs in a sandboxed iframe (an opaque origin), so the files it loads need CORS
        response = await call_next(request)
        p = request.url.path
        if request.method in ("GET", "HEAD") and (
            p.startswith("/assets/")
            or p == "/motion-player.html"
            or (p.startswith("/api/motion/projects/") and "/assets/" in p)
            or p.startswith("/api/motion/fonts")
            or (p.startswith("/api/motion/brand-kits/") and (p.endswith("/logo") or p.endswith("/icon")))
        ):
            response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    @app.get("/motion-player.html", include_in_schema=False)
    def player_page() -> FileResponse:
        f = dist_dir / "motion-player.html"
        if not f.exists():
            raise StoreError("The page is not built yet: run `npm run build` in the frontend folder.", 404)
        return FileResponse(f, media_type="text/html")

    r = APIRouter(prefix="/api/motion")

    def not_running(pid: str) -> None:
        if agent.running(pid):
            raise StoreError("Claude is editing this video right now. Wait for it to finish, or press Stop.", 409)

    def snapshot_for_edit(pid: str, key: str) -> None:
        """One undo step per burst of direct edits to the same thing."""
        prev = last_snap.get(pid)
        if not prev or prev[0] != key or time.time() - prev[1] > 10:
            store.snapshot(pid, "Before: your edit of " + key)
        last_snap[pid] = (key, time.time())

    def project_view(pid: str) -> dict:
        chat = store.load_chat(pid)
        return {
            "project": store.get_project(pid),
            "bundle": store.bundle(pid),
            "undo": store.undo_info(pid),
            "running": agent.running(pid),
            "exportJob": exports.status(pid),
            "voiceJob": voices.status(pid),
            "renders": exports.renders(pid),
            "totals": chat.get("totals") or {},
        }

    # ── health ──

    @r.get("/health")
    def health() -> dict:
        return {
            "claude": ag.credentials_hint(),
            "claudeCode": claude_code.available(),
            "engines": list(ag.ENGINES),
            "defaultEngine": ag.default_engine(),
            "elevenlabs": vc.api_key() is not None,
            "voice": {k: vc.VOICE[k] for k in ("id", "name", "model")},
            "playerBuilt": renderer.player_built(),
            "ffmpeg": rd.ffmpeg_exe(find_ffmpeg()) is not None,
            "browser": renderer.browser_name,
            "models": [{"id": k, "label": v["label"]} for k, v in ag.MODELS.items()],
            "defaultModel": ag.DEFAULT_MODEL,
            "efforts": list(ag.EFFORTS),
            "defaultEffort": ag.DEFAULT_EFFORT,
            "aspects": list(ASPECTS),
            "transitions": list(TRANSITIONS),
        }

    # ── projects ──

    @r.get("/projects")
    def list_projects() -> list[dict]:
        return store.list_projects()

    @r.post("/projects")
    def create_project(body: dict = Body(default={})) -> dict:
        target = body.get("targetSeconds")
        p = store.create_project(
            body.get("title") or "",
            body.get("aspect") or "9:16",
            body.get("brandKitId"),
            body.get("settings") if isinstance(body.get("settings"), dict) else None,
            float(target) if isinstance(target, (int, float)) and target > 0 else None,
        )
        attachments = []
        source = body.get("sourceText")
        if isinstance(source, str) and source.strip():
            name = "transcript-" + slugify(str(body.get("sourceTitle") or "source"))[:40] + ".txt"
            text = (f"Title: {body.get('sourceTitle')}\n" if body.get("sourceTitle") else "") + (f"Link: {body.get('sourceUrl')}\n\n" if body.get("sourceUrl") else "\n") + source
            attachments.append(store.save_asset(p["id"], name, text.encode("utf-8"))["name"])
        # The transcription's screenshots, when it has them: copied in as ref-<mm>m<ss>s.jpg assets with
        # docs/REFERENCES.md and project.references, for Claude to look at (view_references), never to show.
        refs = []
        job = body.get("framesJob")
        if isinstance(job, str) and job.strip() and references:
            found = references(job.strip())
            if found and found.get("items"):
                frames = [{"t": it["t"], "path": Path(found["folder"]) / it["file"], "text": it.get("text") or ""} for it in found["items"]]
                refs = store.add_references(p["id"], frames, found.get("title") or body.get("sourceTitle"), found.get("url") or body.get("sourceUrl"))
                p = store.get_project(p["id"])
        return {"project": p, "attachments": attachments, "references": len(refs)}

    @r.get("/projects/{pid}")
    def get_project(pid: str) -> dict:
        return project_view(pid)

    @r.get("/projects/{pid}/bundle")
    def get_bundle(pid: str) -> dict:
        return store.bundle(pid)

    @r.patch("/projects/{pid}")
    def patch_project(pid: str, body: dict = Body(...)) -> dict:
        fields = {k: body[k] for k in ("title", "aspect", "brandKitId", "audio", "settings", "targetSeconds", "destination", "closing") if k in body}
        if any(k in fields for k in ("aspect", "brandKitId", "audio")):
            not_running(pid)
            snapshot_for_edit(pid, "the video settings")
        p = store.update_project(pid, fields, body.get("baseVersion"))
        hub.project_changed(pid, p["version"])
        return project_view(pid)

    @r.delete("/projects/{pid}")
    def delete_project(pid: str) -> dict:
        not_running(pid)
        exports.cancel(pid)
        store.delete_project(pid)
        hub.forget(pid)
        return {"ok": True}

    @r.put("/projects/{pid}/scenes/{sid}")
    def edit_scene(pid: str, sid: str, body: dict = Body(...)) -> dict:
        not_running(pid)
        fields = {k: body[k] for k in ("props", "duration", "transition", "source", "name", "narration", "label", "part", "hold") if k in body}
        if not fields:
            raise StoreError("Nothing to change.")
        snapshot_for_edit(pid, f"scene {sid}")
        p = store.edit_scene(pid, sid, fields, body.get("baseRev"))
        hub.project_changed(pid, p["version"])
        return project_view(pid)

    @r.post("/projects/{pid}/undo")
    def undo(pid: str) -> dict:
        not_running(pid)
        info = store.undo_info(pid)
        p = store.undo(pid)
        last_snap.pop(pid, None)
        hub.project_changed(pid, p["version"])
        hub.add(pid, {"kind": "note", "text": "Undone: " + (info["label"] if info else "the last change").replace("Before: ", "")})
        hub.flush(pid)
        return project_view(pid)

    # ── assets ──

    @r.get("/projects/{pid}/assets")
    def list_assets(pid: str) -> list[dict]:
        return store.list_assets(pid)

    @r.post("/projects/{pid}/assets")
    async def upload_assets(pid: str, files: list[UploadFile] = File(...)) -> list[dict]:
        store.get_project(pid)
        out = []
        for f in files[:20]:
            data = await f.read()
            out.append(store.save_asset(pid, f.filename or "file", data))
        return out

    @r.get("/projects/{pid}/assets/{name}")
    def get_asset(pid: str, name: str) -> FileResponse:
        return FileResponse(store.asset_path(pid, name), headers={"Cache-Control": "no-cache"})

    @r.delete("/projects/{pid}/assets/{name}")
    def delete_asset(pid: str, name: str) -> list[dict]:
        p = store.get_project(pid)
        if p.get("audio") == name:
            store.update_project(pid, {"audio": None})
        store.delete_asset(pid, name)
        return store.list_assets(pid)

    @r.get("/projects/{pid}/frames/{name}")
    def get_frame(pid: str, name: str) -> FileResponse:
        f = store.renders_dir(pid) / "frames" / Path(name).name
        if not f.exists():
            raise StoreError("No such frame.", 404)
        return FileResponse(f, media_type="image/jpeg")

    @r.get("/projects/{pid}/poster.jpg")
    def poster(pid: str) -> Response:
        p = store.get_project(pid)
        folder = store.renders_dir(pid)
        f = folder / f"poster-v{p['version']}.jpg"
        if not f.exists():
            if not renderer.player_built():
                raise StoreError("No poster yet.", 404)
            img = renderer.call(renderer.poster, store.bundle(pid), timeout=90)
            if not img:
                raise StoreError("No scenes yet.", 404)
            for old in folder.glob("poster-v*.jpg"):
                old.unlink(missing_ok=True)
            f.write_bytes(img)
        return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})

    # ── chat ──

    @r.get("/projects/{pid}/chat")
    def get_chat(pid: str) -> dict:
        store.get_project(pid)
        chat = store.load_chat(pid)
        return {
            "boot": hub.boot,
            "seq": hub.seq(pid),
            "log": hub.log(pid),
            "running": agent.running(pid),
            "pending": bool(chat.get("pending")),
            "totals": chat.get("totals") or {},
        }

    @r.post("/projects/{pid}/chat")
    def post_chat(pid: str, body: dict = Body(...)) -> dict:
        current = store.get_project(pid).get("settings") or {}
        settings = {k: body[k] for k in ("model", "effort", "engine") if body.get(k) and body[k] != current.get(k)}
        if settings:  # remember a changed model or effort for this video
            store.update_project(pid, {"settings": settings})
        agent.start(pid, body)
        return {"ok": True}

    @r.post("/projects/{pid}/chat/stop")
    def stop_chat(pid: str) -> dict:
        agent.stop(pid)
        return {"ok": True}

    @r.post("/projects/{pid}/chat/new")
    def new_chat(pid: str) -> dict:
        agent.new_chat(pid)
        return {"ok": True}

    @r.get("/projects/{pid}/events")
    def events(pid: str, after: int = 0, boot: str = "", timeout: float = 25.0) -> dict:
        if boot and boot != hub.boot:
            return {"boot": hub.boot, "events": [{"op": "reload", "seq": hub.seq(pid)}]}
        return {"boot": hub.boot, "events": hub.wait(pid, after, max(0.0, min(timeout, 30.0)))}

    # ── fonts: Google Fonts kept on this computer (fast, the same in every frame, works offline after once) ──

    font_dir = store.root / "fonts"
    font_lock = threading.Lock()

    @r.get("/fonts.css")
    def font_css(family: str) -> Response:
        fam = re.sub(r"[^A-Za-z0-9 ]+", "", family).strip()[:60]
        if not fam:
            raise StoreError("No font family.", 400)
        css_file = font_dir / f"{slugify(fam, 'font')}.css"
        with font_lock:
            if not css_file.exists():
                font_dir.mkdir(parents=True, exist_ok=True)
                name = urllib.parse.quote_plus(fam)
                css = None
                for q in (f"{name}:wght@400;500;600;700;800", f"{name}:wght@400;700", name):
                    try:
                        body, _, _ = br.fetch(f"https://fonts.googleapis.com/css2?family={q}&display=block", max_bytes=500_000)
                        css = body.decode("utf-8")
                        break
                    except br.FetchError:
                        continue
                if css is None:
                    raise StoreError(f"Could not get the font {fam} from Google Fonts.", 502)

                def local(m: re.Match) -> str:
                    url = m.group(1)
                    fname = hashlib.sha1(url.encode()).hexdigest()[:16] + Path(urllib.parse.urlsplit(url).path).suffix
                    target = font_dir / fname
                    if not target.exists():
                        data, _, _ = br.fetch(url, max_bytes=3_000_000)
                        target.write_bytes(data)
                    return f"url(/api/motion/fonts/{fname})"

                css = re.sub(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", local, css)
                css_file.write_text(css, encoding="utf-8")
        return Response(css_file.read_text(encoding="utf-8"), media_type="text/css", headers={"Cache-Control": "max-age=86400"})

    @r.get("/fonts/{name}")
    def font_file(name: str) -> FileResponse:
        f = font_dir / Path(name).name
        if not f.exists():
            raise StoreError("No such font file.", 404)
        return FileResponse(f, headers={"Cache-Control": "max-age=31536000"})

    # ── narration and voice ──

    @r.get("/projects/{pid}/voice")
    def voice_status(pid: str) -> dict:
        return {**store.voice_status(pid), "job": voices.status(pid), "pronunciations": store.get_project(pid).get("pronunciations") or []}

    @r.post("/projects/{pid}/voice")
    def voice_generate(pid: str, body: dict = Body(default={})) -> dict:
        not_running(pid)
        ids = body.get("scenes") if isinstance(body.get("scenes"), list) else None
        return voices.start(pid, ids)

    @r.post("/projects/{pid}/voice/cancel")
    def voice_cancel(pid: str) -> dict:
        voices.cancel(pid)
        return {"ok": True}

    @r.put("/projects/{pid}/pronunciations")
    def put_pronunciations(pid: str, body: dict = Body(...)) -> dict:
        not_running(pid)
        p = store.set_pronunciations(pid, body.get("entries") or [], replace=True)
        hub.project_changed(pid, p["version"])
        return {**store.voice_status(pid), "job": voices.status(pid), "pronunciations": p.get("pronunciations") or []}

    @r.get("/projects/{pid}/narration.m4a")
    def narration_audio(pid: str) -> FileResponse:
        f = narration_track(store, pid, find_ffmpeg())
        if not f:
            raise StoreError("No scene has its voice yet.", 404)
        return FileResponse(f, media_type="audio/mp4", headers={"Cache-Control": "max-age=86400"})

    @r.get("/projects/{pid}/script.md")
    def script_md(pid: str) -> Response:
        p = store.get_project(pid)
        return Response(store.script_markdown(pid), media_type="text/markdown; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{slugify(p["title"])}-script.md"'})

    @r.get("/projects/{pid}/script")
    def script_view(pid: str) -> dict:
        return {"markdown": store.script_markdown(pid), "chapters": store.chapters(pid), "docs": store.list_docs(pid)}

    @r.get("/projects/{pid}/docs/{name}")
    def get_doc(pid: str, name: str) -> Response:
        return Response(store.read_doc(pid, name), media_type="text/markdown; charset=utf-8")

    # ── captions: the written narration, timed by the voice ──

    @r.get("/projects/{pid}/captions.srt")
    def captions_srt(pid: str) -> Response:
        p = store.get_project(pid)
        return Response(store.captions(pid, "srt"), media_type="application/x-subrip; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{slugify(p["title"])}.srt"'})

    @r.get("/projects/{pid}/captions.vtt")
    def captions_vtt(pid: str) -> Response:
        p = store.get_project(pid)
        return Response(store.captions(pid, "vtt"), media_type="text/vtt; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{slugify(p["title"])}.vtt"'})

    # ── the YouTube thumbnail ──

    @r.get("/projects/{pid}/thumbnail.jpg")
    def thumbnail_jpg(pid: str, download: int = 0, v: str = "") -> FileResponse:
        # rendered on first request after each change, then served from renders/ (404 before there is one).
        # A versioned link (the url GET /thumbnail gives, ?v=...) never changes its picture, so the browser
        # keeps it; a bare link is checked every time.
        f, _ = thumbnail_image(store, renderer, pid)
        cache = "private, max-age=31536000, immutable" if v else "no-cache"
        if download:
            return FileResponse(f, media_type="image/jpeg", filename=f'{slugify(store.get_project(pid)["title"])}-thumbnail.jpg', headers={"Cache-Control": cache})
        return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": cache})

    @r.get("/projects/{pid}/thumbnail")
    def thumbnail_get(pid: str) -> dict:
        return store.thumbnail_view(pid, rd.RUNTIME_VERSION)

    @r.put("/projects/{pid}/thumbnail")
    def thumbnail_put(pid: str, body: dict = Body(...)) -> dict:
        not_running(pid)
        snapshot_for_edit(pid, "the thumbnail")
        p, warnings = store.write_thumbnail(pid, body.get("html"), body.get("props") if isinstance(body.get("props"), dict) else None, body.get("baseRev"))
        hub.project_changed(pid, p["version"])
        return {**store.thumbnail_view(pid, rd.RUNTIME_VERSION), "warnings": warnings, "version": p["version"]}

    # ── the publishing kit: everything an upload needs besides the MP4, in one zip ──

    @r.get("/projects/{pid}/publish-kit.zip")
    def publish_kit(pid: str) -> Response:
        """The thumbnail, the captions (SRT and VTT), the chapters (for the description) and YOUTUBE.md, in one
        zip named after the video. What doesn't exist yet (no thumbnail, no narration) is left out."""
        p = store.get_project(pid)
        slug = slugify(p["title"])
        files: list[tuple[str, bytes]] = []
        if p.get("thumbnail"):
            f, _ = thumbnail_image(store, renderer, pid)
            files.append((f"{slug}-thumbnail.jpg", f.read_bytes()))
        if any((s.get("narration") or "").strip() for s in p["scenes"]):
            files.append((f"{slug}.srt", store.captions(pid, "srt").encode("utf-8")))
            files.append((f"{slug}.vtt", store.captions(pid, "vtt").encode("utf-8")))
        chapters = store.chapters(pid)
        if chapters:
            lines = [f"{fmt_clock(c['start'])} {c['title']}" for c in chapters]
            files.append((f"{slug}-chapters.txt", ("\n".join(lines) + "\n").encode("utf-8")))
        for d in store.list_docs(pid):
            if d["name"].upper() == "YOUTUBE.MD":
                files.append((d["name"], store.read_doc(pid, d["name"]).encode("utf-8")))
        if not files:
            raise StoreError("Nothing to download yet: this video has no thumbnail, narration or YouTube details.", 404)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in files:
                z.writestr(name, data)
        return Response(buf.getvalue(), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{slug}-publish-kit.zip"'})

    # ── export ──

    @r.post("/projects/{pid}/export")
    def start_export(pid: str, body: dict = Body(default={})) -> dict:
        # narration, sfx (the paper sounds) and loudness (the mix at -14 LUFS) default to on; the music bed is
        # the project's audio setting
        return exports.start(
            pid, int(body.get("resolution") or 1080), body.get("narration") is not False, body.get("sfx") is not False, body.get("loudness") is not False,
        )

    @r.post("/projects/{pid}/export/cancel")
    def cancel_export(pid: str) -> dict:
        exports.cancel(pid)
        return {"ok": True}

    @r.get("/projects/{pid}/renders/{name}")
    def get_render(pid: str, name: str) -> FileResponse:
        # an exported MP4, or the captions written next to it
        types = {".mp4": "video/mp4", ".srt": "application/x-subrip; charset=utf-8", ".vtt": "text/vtt; charset=utf-8"}
        f = store.renders_dir(pid) / Path(name).name
        if f.suffix not in types or ".part" in f.name or ".audio" in f.name or not f.exists():
            raise StoreError("No such file.", 404)
        return FileResponse(f, media_type=types[f.suffix], filename=f.name)

    # ── brand kits ──

    @r.get("/brand-kits")
    def list_kits() -> list[dict]:
        return store.list_kits()

    @r.post("/brand-kits")
    def create_kit(body: dict = Body(...)) -> dict:
        kit = store.create_kit(body.get("kit") or {}, body.get("baseKitId"))
        if body.get("logoUrl"):
            try:
                data, ctype, final = br.fetch(body["logoUrl"], max_bytes=5_000_000)
                name = Path(final.split("?")[0]).name or "logo"
                if "." not in name:
                    name += {"image/svg+xml": ".svg", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(ctype.split(";")[0].strip(), ".png")
                kit = store.set_kit_logo(kit["id"], name, data)
            except (br.FetchError, StoreError):
                pass  # the kit is still useful without its logo
        return kit

    @r.put("/brand-kits/{kid}")
    def update_kit(kid: str, body: dict = Body(...)) -> dict:
        return store.update_kit(kid, body)

    @r.delete("/brand-kits/{kid}")
    def delete_kit(kid: str) -> dict:
        used = [p["title"] for p in store.list_projects() if p.get("brandKitId") == kid]
        if used:
            raise StoreError("Videos still use this kit: " + ", ".join(used[:5]) + ". Switch them to another kit first.", 409)
        store.delete_kit(kid)
        return {"ok": True}

    @r.get("/brand-kits/{kid}/logo")
    def kit_logo(kid: str) -> FileResponse:
        f = store.kit_logo_path(kid)
        if not f:
            raise StoreError("This kit has no logo.", 404)
        return FileResponse(f, headers={"Cache-Control": "no-cache"})

    @r.get("/brand-kits/{kid}/icon")
    def kit_icon(kid: str) -> FileResponse:
        f = store.kit_logo_path(kid, "icon")
        if not f:
            raise StoreError("This kit has no icon.", 404)
        return FileResponse(f, headers={"Cache-Control": "no-cache"})

    @r.post("/brand-kits/{kid}/logo")
    async def upload_logo(kid: str, file: UploadFile = File(...)) -> dict:
        return store.set_kit_logo(kid, file.filename, await file.read())

    @r.delete("/brand-kits/{kid}/logo")
    def remove_logo(kid: str) -> dict:
        return store.set_kit_logo(kid, None, None)

    @r.post("/brand-kits/extract")
    def extract_kit(body: dict = Body(...)) -> dict:
        url = str(body.get("url") or "").strip()
        if not url:
            raise StoreError("Paste a website address first.")
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        info = br.extract(url)
        info.pop("inlineSvgLogo", None)
        return info

    app.include_router(r)
