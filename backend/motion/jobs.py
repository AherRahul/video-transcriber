"""
MP4 exports: one at a time for the whole app (frame capture and x264 use every core), with progress the
page shows in the editor's top bar. The video is exported as it was when Export was pressed, so edits
made during an export go into the next one. Each MP4 gets its captions next to it (<same name>.srt and
.vtt), made from the same moment's narration and voice.

Also here: the narration track and the rendered thumbnail, both built once per content and kept in
renders/.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from pathlib import Path

from . import render as rd
from . import voice as vc
from .hub import Hub
from .store import Store, StoreError, slugify


_track_lock = threading.Lock()


def narration_track(store: Store, pid: str, ffmpeg_dir: str | None) -> Path | None:
    """The whole narration as one file, each voiced scene's clip at its start (built once per layout)."""
    plan = store.narration_plan(pid)
    if not plan["clips"]:
        return None
    if not ffmpeg_dir:
        raise StoreError("FFmpeg was not found, so the narration track can't be built.", 503)
    out = store.renders_dir(pid) / f"narration-{plan['hash']}.m4a"
    with _track_lock:
        if not out.exists():
            vc.build_track(out, plan["clips"], plan["total"], ffmpeg_dir)
            for old in store.renders_dir(pid).glob("narration-*.m4a"):
                if old != out:
                    old.unlink(missing_ok=True)
    return out


_thumb_lock = threading.Lock()
# (project, cheap key) -> the rendered file. Building the bundle to get the content hash reads every scene
# and voice clip (seconds on a long video), so a thumbnail that hasn't changed is found by its cheap key
# (store.thumbnail_key: project.json and kit.json only) and the bundle is built only when that key is new.
_thumb_index: dict[tuple[str, str], Path] = {}


def thumbnail_image(store: Store, renderer: rd.RenderService, pid: str, fresh: bool = False) -> tuple[Path, dict | None]:
    """The YouTube thumbnail as a 1280 x 720 JPEG: renders/thumbnail-<hash>.jpg, rendered once per design (its
    source, props, the brand and the player's version) and older ones removed. Returns (the file, the layout
    report); the report is None when the file came from the cache. fresh renders it again anyway (Claude's
    write_thumbnail wants the report). A 404 StoreError when the video has no thumbnail yet."""
    key = store.thumbnail_key(pid, rd.RUNTIME_VERSION)
    if key is None:
        raise StoreError("This video has no thumbnail yet.", 404)
    hit = _thumb_index.get((pid, key))
    if hit is not None and not fresh and hit.exists():
        return hit, None  # the fast path: nothing that shows in the picture changed
    bundle = store.thumbnail_bundle(pid)
    folder = store.renders_dir(pid)
    out = folder / f"thumbnail-{rd.thumbnail_hash(bundle)}.jpg"
    diag = None
    with _thumb_lock:
        if fresh or not out.exists():
            if not renderer.player_built():
                raise StoreError("The page is not built yet: run `npm run build` in the frontend folder, then try again.", 503)
            img, diag = renderer.call(renderer.preview_frame, bundle, "thumbnail", rd.THUMBNAIL_AT, rd.THUMBNAIL_WIDTH, 92, timeout=120)
            tmp = out.with_suffix(".part.jpg")
            tmp.write_bytes(img)
            os.replace(tmp, out)
            for old in folder.glob("thumbnail-*.jpg"):
                if old != out:
                    old.unlink(missing_ok=True)
        _thumb_index[(pid, key)] = out
    return out, diag


class VoiceJobs:
    """Generate voice: each narrated scene whose words changed gets a clip from ElevenLabs (with the time of
    every character); clips already made for the same words are reused, never billed again. Only the user
    starts this (the Voice menu); Claude has no tool for it."""

    def __init__(self, store: Store, hub: Hub, find_ffmpeg):
        self.store = store
        self.hub = hub
        self.find_ffmpeg = find_ffmpeg
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="motion-voice")
        self._jobs: dict[str, dict] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def status(self, pid: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(pid)
            return dict(job) if job else None

    def _update(self, pid: str, **fields) -> None:
        with self._lock:
            job = self._jobs.get(pid)
            if not job:
                return
            job.update(fields, updatedAt=time.time())
            snapshot = dict(job)
        self.hub.emit(pid, {"op": "voice", "job": snapshot})

    def start(self, pid: str, scene_ids: list[str] | None = None) -> dict:
        with self._lock:
            current = self._jobs.get(pid)
            if current and current["state"] in ("queued", "running"):
                raise StoreError("The voice is already being generated for this video.", 409)
        status = self.store.voice_status(pid)
        todo = [r for r in status["scenes"] if r["state"] != "voiced" and (not scene_ids or r["id"] in scene_ids)]
        if not todo:
            raise StoreError("Every narrated scene already has its voice.")
        # a place left for the user's own words ([[you: ...]]) would be read out as it stands
        p = self.store.get_project(pid)
        waiting = [s["id"] for s in p["scenes"] if any(s["id"] == r["id"] for r in todo) and vc.slots(s.get("narration") or "")]
        if waiting:
            raise StoreError(
                f"{', '.join(waiting[:12])} still {'has a place' if len(waiting) == 1 else 'have places'} for your own words ([[you: ...]]). "
                "Write them in (Script > Your words), then generate the voice."
            )
        needs_api = any(r["state"] in ("none", "changed") for r in todo)
        if needs_api and not vc.api_key():
            raise StoreError("No ElevenLabs key: put ELEVENLABS_API_KEY=... in backend\\.env, then restart the app.", 503)
        job = {
            "id": uuid.uuid4().hex[:8],
            "state": "queued",
            "done": 0,
            "total": len(todo),
            "chars": 0,
            "message": "Starting",
            "startedAt": time.time(),
            "updatedAt": time.time(),
        }
        cancel = threading.Event()
        with self._lock:
            self._jobs[pid] = job
            self._cancel[pid] = cancel
        self.hub.emit(pid, {"op": "voice", "job": dict(job)})
        self._pool.submit(self._run, pid, [r["id"] for r in todo], cancel)
        return dict(job)

    def cancel(self, pid: str) -> None:
        with self._lock:
            ev = self._cancel.get(pid)
        if ev:
            ev.set()

    def _run(self, pid: str, ids: list[str], cancel: threading.Event) -> None:
        self._update(pid, state="running")
        chars = done = 0
        try:
            for sid in ids:
                if cancel.is_set():
                    self._update(pid, state="cancelled", message=f"Stopped after {done} scenes")
                    return
                p = self.store.get_project(pid)
                s = next((x for x in p["scenes"] if x["id"] == sid), None)
                if not s:
                    continue
                t = self.store.timing(pid, p, s)
                if not t["narrated"] or t["voiced"]:
                    done += 1
                    continue
                self._update(pid, message=f"Scene {done + 1} of {len(ids)}: {s['name']}")
                folder = self.store.voice_dir(pid)
                # this video's clip, or the same words already voiced for another video: free either way
                if self.store.find_clip(pid, t["hash"]) is None:
                    audio, times = vc.synthesize(t["spoken"], self.store.voice_of(p))
                    vc.save_clip(folder, t["hash"], t["spoken"], audio, times, self.find_ffmpeg())
                    self.store.share_clip(pid, t["hash"])
                    chars += len(t["spoken"])
                p = self.store.link_voice(pid, sid, t["hash"])
                self.hub.project_changed(pid, p["version"])
                done += 1
                self._update(pid, done=done, chars=chars)
            self._update(pid, state="done", done=done, chars=chars, message=f"Voiced {done} scenes ({chars:,} characters sent to ElevenLabs)")
        except vc.VoiceError as err:
            self._update(pid, state="error", message=str(err))
        except Exception as err:  # noqa: BLE001 - report it on the page
            self._update(pid, state="error", message=f"Voice failed: {type(err).__name__}: {err}"[:500])


class Exports:
    def __init__(self, store: Store, renderer: rd.RenderService, hub: Hub, find_ffmpeg):
        self.store = store
        self.render = renderer
        self.hub = hub
        self.find_ffmpeg = find_ffmpeg
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="motion-export")
        self._jobs: dict[str, dict] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def status(self, pid: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(pid)
            return dict(job) if job else None

    def renders(self, pid: str) -> list[dict]:
        out = []
        folder = self.store.renders_dir(pid)
        for f in sorted(folder.glob("*.mp4"), key=lambda x: x.stat().st_mtime, reverse=True):
            if ".part" in f.name or ".audio" in f.name:
                continue
            out.append({"file": f.name, "bytes": f.stat().st_size, "at": round(f.stat().st_mtime, 3), "url": f"/api/motion/projects/{pid}/renders/{f.name}"})
        return out[:20]

    def _update(self, pid: str, **fields) -> None:
        with self._lock:
            job = self._jobs.get(pid)
            if not job:
                return
            job.update(fields, updatedAt=time.time())
            snapshot = dict(job)
        self.hub.emit(pid, {"op": "export", "job": snapshot})

    def start(self, pid: str, resolution: int = rd.DEFAULT_RESOLUTION, narration: bool = True, sfx: bool = True, loudness: bool = True) -> dict:
        """narration False leaves the voice out; sfx False leaves out the paper sounds (rip, page, pop...);
        loudness False skips bringing the mix to -14 LUFS. The music bed is the video's soundtrack setting
        (project.audio)."""
        if resolution not in rd.RESOLUTIONS:
            raise StoreError("resolution must be 720, 1080 or 2160")
        with self._lock:
            current = self._jobs.get(pid)
            if current and current["state"] in ("queued", "running"):
                raise StoreError("This video is already exporting.", 409)
        ffmpeg = rd.ffmpeg_exe(self.find_ffmpeg())
        if not ffmpeg:
            raise StoreError("FFmpeg was not found, so the video can't be exported. Install it (winget install Gyan.FFmpeg.Essentials) and restart the app.", 503)
        if not self.render.player_built():
            raise StoreError("The page is not built yet: run `npm run build` in the frontend folder, then try again.", 503)
        bundle = self.store.bundle(pid)
        if not bundle["scenes"]:
            raise StoreError("This video has no scenes yet.")
        missing = [s["id"] for s in bundle["scenes"] if not s.get("source") and s.get("kind") not in ("endscreen", "promo")]
        if missing:
            raise StoreError("These scenes have no code yet: " + ", ".join(missing) + ". Ask Claude to finish them first.")
        project = self.store.get_project(pid)
        audio = self.store.asset_path(pid, project["audio"]) if project.get("audio") else None
        # the captions as the video is now (the same moment as the bundle), written next to the MP4 at the end
        cues = self.store.caption_cues(pid)
        captions = {"srt": vc.to_srt(cues), "vtt": vc.to_vtt(cues)} if cues else None
        job = {
            "id": uuid.uuid4().hex[:8],
            "state": "queued",
            "percent": 0.0,
            "message": "Waiting for the previous export to finish",
            "resolution": resolution,
            "narration": narration,
            "sfx": sfx,
            "loudness": loudness,
            "version": bundle["version"],
            "startedAt": time.time(),
            "updatedAt": time.time(),
        }
        cancel = threading.Event()
        with self._lock:
            self._jobs[pid] = job
            self._cancel[pid] = cancel
        self.hub.emit(pid, {"op": "export", "job": dict(job)})
        self._pool.submit(self._run, pid, bundle, audio, ffmpeg, resolution, cancel, narration, sfx, loudness, captions)
        return dict(job)

    def cancel(self, pid: str) -> None:
        with self._lock:
            ev = self._cancel.get(pid)
        if ev:
            ev.set()

    def _run(
        self, pid, bundle, audio, ffmpeg, resolution, cancel, with_narration: bool = True, with_sfx: bool = True,
        with_loudness: bool = True, captions: dict | None = None,
    ) -> None:
        if cancel.is_set():
            self._update(pid, state="cancelled", message="Cancelled")
            return
        self._update(pid, state="running", message="Starting the browser")
        try:
            folder = self.store.renders_dir(pid)
            ow, oh, _ = rd.output_size(bundle["width"], bundle["height"], resolution)
            out = folder / f"{slugify(bundle['title'])}-{ow}x{oh}-v{bundle['version']}.mp4"
            narration = None
            if bundle.get("narration") and with_narration:
                self._update(pid, message="Building the narration track")
                narration = narration_track(self.store, pid, self.find_ffmpeg())

            def progress(fraction: float, message: str) -> None:
                self._update(pid, percent=round(fraction * 100, 1), message=message)

            result = self.render.call(
                self.render.export,
                bundle,
                self.store.assets_dir(pid),
                folder / "cache",
                out,
                ffmpeg,
                resolution,
                audio,
                progress,
                cancel,
                narration,
                with_sfx,
                with_loudness,
                timeout=6 * 3600,
            )
            rd.prune_cache(folder / "cache")
            # the captions under the MP4's own name, so the two travel together (YouTube takes either file)
            links = None
            if captions:
                links = {}
                for fmt, text in captions.items():
                    f = out.with_suffix("." + fmt)
                    f.write_text(text, encoding="utf-8", newline="\n")
                    links[fmt] = f"/api/motion/projects/{pid}/renders/{f.name}"
            self._update(pid, state="done", percent=100.0, message="Done", result={**result, "url": f"/api/motion/projects/{pid}/renders/{result['file']}", "captions": links})
        except rd.Cancelled:
            self._update(pid, state="cancelled", message="Cancelled")
        except (rd.RenderError, StoreError) as err:
            self._update(pid, state="error", message=str(err))
        except Exception as err:  # noqa: BLE001 - report anything else on the page
            self._update(pid, state="error", message=f"Export failed: {type(err).__name__}: {err}"[:500])
