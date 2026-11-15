"""
Frames and MP4s from the same player the page uses, driven in headless Edge (or Chrome) by Playwright.

- preview_frame: one frame of one scene, small, plus layout checks (text off the stage, overlapping
  labels, tiny text, script errors). Claude calls it to look at its own work. The YouTube thumbnail is
  one of these too: a one-scene bundle photographed at 1280 x 720.
- audit: the layout report of every scene at every cue, plus the player's timing checks (stretches where
  nothing moves while the voice talks, and entrances that land in the next phrase).
- export: the whole video. Each scene is captured frame by frame (seeked, never played, so every render
  is identical) and encoded on its own: H.264, CRF 18, preset veryfast. A finished scene file is kept
  under its content hash, so after an edit only the changed scene (and the one after it, when that one
  fades in from it) is captured again. The scene files are joined without re-encoding (concat demuxer,
  -c copy), and a soundtrack is added last without touching the video stream (-c:v copy): the music
  ducked under the narration (a sidechain compressor keyed by the voice), and the whole mix brought to
  YouTube's loudness in two passes (loudnorm measures, then applies the gain linearly: -14 LUFS, -1.5 dBTP).

All browser work runs on one background thread with its own asyncio loop; other threads submit jobs with
`RenderService.call`.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import re
import shutil
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Callable

from . import voice as vc

RUNTIME_VERSION = "7"  # bump when the player changes how a frame looks, so cached scene files are redone
# 7: the camera keeps the page's top content below the header (a zoom pushed rows over the logo, label
#    and title); the layout report's overflow check (words running into their box's padding)
# 4: arrow tips, the slate web address, CSS tilts kept (stamps, stickies, tags), the logo/url settings
# 5: pen notes keep their letters' tails (the write-on mask no longer trims below the box)
# 6: the camera (fx.focus), the flow kit, code panels, carried elements, part stings and the thumbnail kind;
#    fonts no longer race each other while loading (a family could go missing and fall back silently)
DEFAULT_PAGES = max(1, min(4, int(os.environ.get("MOTION_RENDER_PAGES", "3"))))
RESOLUTIONS = (720, 1080, 2160)
# how loud each paper sound sits under the voice
SFX_GAIN = {"rip": 0.55, "page": 0.5, "stamp": 0.6, "crumple": 0.5, "pop": 0.35, "pencil": 0.22, "whoosh": 0.35, "ding": 0.4, "thump": 0.45, "type": 0.25, "sting": 0.45, "slap": 0.45, "popper": 0.4}
# The audio finish. YouTube plays everything at about -14 LUFS, so the mix is brought there itself (a mix
# far under it plays quiet next to other videos; one over it is turned down and loses its peaks). The true
# peak stays 1.5 dB under full scale, room for the AAC encoder's small overshoots. LRA is left wide: the
# point is the level, not squeezing the voice's natural range.
LOUDNESS = {"I": -14.0, "TP": -1.5, "LRA": 20.0}
# The music bed: its level in the pauses (0.25 is about -12 dB), and the sidechain compressor that pulls it
# about 10 dB further down while the voice talks. The slow release lets it swell back only in real pauses
# (between sentences, across a page change), not between words.
MUSIC_BED = 0.25
MUSIC_ALONE = 0.6  # music in a video without narration
DUCK = "threshold=0.02:ratio=6:attack=20:release=600:knee=4"
THUMBNAIL_AT = 2.95  # the moment of the 3 second thumbnail scene that is photographed
THUMBNAIL_WIDTH = 1280  # YouTube's thumbnail size: 1280 x 720


class RenderError(Exception):
    pass


class Cancelled(Exception):
    pass


def ffmpeg_exe(folder: str | None) -> str | None:
    if not folder:
        return None
    exe = Path(folder) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    return str(exe) if exe.exists() else None


def output_size(width: int, height: int, resolution: int) -> tuple[int, int, float]:
    """Output size for '1080p' / '720p': the short side gets `resolution` pixels, both sides even."""
    scale = resolution / min(width, height)
    ow, oh = round(width * scale / 2) * 2, round(height * scale / 2) * 2
    return ow, oh, scale


def scene_frames(duration: float, fps: int) -> int:
    return max(1, round(duration * fps))


def scene_hashes(bundle: dict, assets_dir: Path | None, ow: int, oh: int) -> list[str]:
    """One hash per scene from everything that changes its pixels. A scene that fades or slides in also
    depends on the scene before it, whose last frame shows underneath."""
    asset_sig = []
    if assets_dir and assets_dir.exists():
        for f in sorted(assets_dir.iterdir()):
            if f.is_file():
                st = f.stat()
                asset_sig.append([f.name, st.st_size, st.st_mtime_ns])
    common = {
        "runtime": RUNTIME_VERSION,
        "stage": [bundle["width"], bundle["height"]],
        "out": [ow, oh],
        "fps": bundle["fps"],
        "brand": bundle["brand"],
        "assets": asset_sig,
        "theme": bundle.get("theme"),
        "title": bundle.get("title") if bundle.get("theme") == "paper" else None,  # the paper frame shows the title
    }
    out, prev = [], ""
    for s in bundle["scenes"]:
        payload = {
            **common,
            "source": s.get("source") or "",
            "status": s.get("status"),
            "name": s.get("name"),
            "idea": s.get("idea"),
            "props": s.get("props", {}),
            "duration": s["duration"],
            "transition": s["transition"],
            "kind": s.get("kind"),
            "label": s.get("label"),
            "part": s.get("part"),
            "cues": s.get("cues"),
            "prev": prev if s["transition"] != "cut" else "",
        }
        h = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:24]
        out.append(h)
        prev = h
    return out


def thumbnail_hash(bundle: dict) -> str:
    """The rendered thumbnail's cache key (renders/thumbnail-<hash>.jpg): everything that changes its pixels,
    its source, props, the brand and the player's version (and the stage it is laid out on)."""
    s = bundle["scenes"][0]
    payload = {
        "runtime": RUNTIME_VERSION,
        "source": s.get("source") or "",
        "props": s.get("props") or {},
        "brand": bundle["brand"],
        "stage": [bundle["width"], bundle["height"]],
        "theme": bundle.get("theme"),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:24]


class RenderService:
    def __init__(self, base_url: str, dist_dir: Path):
        self.base_url = base_url.rstrip("/")
        self.netloc = urllib.parse.urlsplit(self.base_url).netloc
        self.dist_dir = dist_dir
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self._pw = None
        self._browser = None
        self.browser_name: str | None = None
        self._preview_pages: dict[str, dict] = {}  # project id -> {ctx, page, cdp, size, used}

    # ── the render thread ──

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._start_lock:
            if self._loop is None:
                # Playwright and asyncio subprocesses need the Proactor loop on Windows
                loop = asyncio.ProactorEventLoop() if sys.platform == "win32" else asyncio.new_event_loop()
                self._thread = threading.Thread(target=loop.run_forever, name="motion-render", daemon=True)
                self._thread.start()
                self._loop = loop
            return self._loop

    def call(self, coro_fn, *args, timeout: float = 900):
        """Runs `await coro_fn(*args)` on the render thread and waits for the result."""
        loop = self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(coro_fn(*args), loop)
        return future.result(timeout)

    def player_built(self) -> bool:
        return (self.dist_dir / "motion-player.html").exists()

    async def _get_browser(self):
        if self._browser is not None and self._browser.is_connected():
            return self._browser
        try:
            from playwright.async_api import async_playwright
        except ImportError as err:
            raise RenderError("Playwright is not installed: run backend\\setup.ps1 again.") from err
        if self._pw is None:
            self._pw = await async_playwright().start()
        args = ["--force-color-profile=srgb", "--hide-scrollbars", "--disable-lcd-text", "--mute-audio"]
        tried = []
        wanted = os.environ.get("MOTION_BROWSER_CHANNEL")
        for channel in ([wanted] if wanted else []) + ["msedge", "chrome", None]:
            try:
                self._browser = await self._pw.chromium.launch(channel=channel, headless=True, args=args)
                self.browser_name = channel or "chromium"
                return self._browser
            except Exception as err:  # noqa: BLE001 - try the next browser
                tried.append(f"{channel or 'chromium'}: {str(err).splitlines()[0][:120]}")
        raise RenderError("No browser for rendering. Install Microsoft Edge or Chrome, or run: .venv\\Scripts\\python.exe -m playwright install chromium. Tried " + "; ".join(tried))

    async def _route(self, route):
        """Rendering pages may load the player, fonts and the project's own files, nothing else."""
        req = route.request
        u = urllib.parse.urlsplit(req.url)
        if u.scheme in ("data", "blob"):
            return await route.continue_()
        if u.netloc == self.netloc:
            p = u.path
            ok = req.method == "GET" and (
                p.startswith("/assets/")
                or p == "/motion-player.html"
                or p.startswith("/api/motion/fonts")
                or re.match(r"^/api/motion/projects/[a-z0-9]+/assets/[^/]+$", p)
                or re.match(r"^/api/motion/brand-kits/[\w-]+/(logo|icon)$", p)
            )
            return await (route.continue_() if ok else route.abort())
        if u.hostname in ("fonts.googleapis.com", "fonts.gstatic.com"):
            return await route.continue_()
        if req.method == "GET" and u.scheme == "https" and req.resource_type in ("image", "font", "stylesheet", "media"):
            return await route.continue_()
        return await route.abort()

    async def _open(self, bundle: dict) -> dict:
        if not self.player_built():
            raise RenderError("The page is not built yet: run `npm run build` in the frontend folder, then try again.")
        browser = await self._get_browser()
        ctx = await browser.new_context(viewport={"width": bundle["width"], "height": bundle["height"]}, device_scale_factor=1)
        page = await ctx.new_page()
        await page.route("**/*", self._route)
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:300]))
        await page.goto(self.base_url + "/motion-player.html?mode=render", wait_until="load")
        await page.wait_for_function("() => window.MotionPlayer && window.MotionPlayer.ready === true", timeout=20000)
        info = await page.evaluate("b => window.MotionPlayer.load(b)", bundle)
        cdp = await ctx.new_cdp_session(page)
        return {"ctx": ctx, "page": page, "cdp": cdp, "info": info, "errors": errors, "size": (bundle["width"], bundle["height"]), "used": time.time(), "bundle": bundle}

    @staticmethod
    async def _shot(h: dict, scene_id: str, local_t: float, fmt: str, scale: float, quality: int | None = None) -> bytes:
        await h["page"].evaluate("([id, t]) => window.MotionPlayer.seekScene(id, t)", [scene_id, local_t])
        w, hgt = h["size"]
        params: dict = {"format": fmt, "optimizeForSpeed": True, "captureBeyondViewport": False}
        if abs(scale - 1) > 1e-6:
            params["clip"] = {"x": 0, "y": 0, "width": w, "height": hgt, "scale": scale}
        if quality is not None:
            params["quality"] = quality
        r = await h["cdp"].send("Page.captureScreenshot", params)
        return base64.b64decode(r["data"])

    # ── one frame, for Claude's checks and the library posters ──

    async def _preview_handle(self, bundle: dict) -> dict:
        """A warm page per video for checks (reloaded with the latest bundle), closed after 10 idle minutes."""
        pid = bundle["projectId"]
        for key, old in list(self._preview_pages.items()):
            if time.time() - old["used"] > 600:
                self._preview_pages.pop(key, None)
                await old["ctx"].close()
        h = self._preview_pages.get(pid)
        if h is None or h["size"] != (bundle["width"], bundle["height"]) or h["page"].is_closed():
            if h is not None:
                await h["ctx"].close()
            h = await self._open(bundle)
            self._preview_pages[pid] = h
        else:
            h["errors"].clear()
            h["info"] = await h["page"].evaluate("b => window.MotionPlayer.load(b)", bundle)
        h["used"] = time.time()
        return h

    async def audit(self, bundle: dict, ids: list[str] | None = None) -> list[dict]:
        """The layout report for each written scene just after every cue and just before its end, then the
        player's timing check for that scene: one row per still stretch ({gaps: [[from, to]]}) and one per
        late entrance ({late: [item]}), at its own time, so Claude reads each as its own fix."""
        h = await self._preview_handle(bundle)
        # MotionPlayer.timing(sceneId) came with the camera and flow kit; an older player page has none
        has_timing = await h["page"].evaluate("() => !!(window.MotionPlayer && typeof window.MotionPlayer.timing === 'function')")
        out = []
        for s in bundle["scenes"]:
            if (ids and s["id"] not in ids) or not s.get("source") or s.get("kind") == "endscreen":
                continue
            end = max(0.0, s["duration"] - 0.35)
            times = sorted({round(min(c + 0.7, end), 2) for c in (s.get("cues") or [])} | {round(end, 2)})
            for t in times:
                d = await h["page"].evaluate("([id, t]) => window.MotionPlayer.diagnose(id, t)", [s["id"], t])
                out.append({"id": s["id"], "t": t, **d})
            if has_timing:
                out += await self._timing_rows(h, s)
        if h["errors"]:
            out.append({"id": "*", "t": 0, "errors": list(h["errors"])})
        return out

    @staticmethod
    async def _timing_rows(h: dict, s: dict) -> list[dict]:
        """The timing check of one scene as audit rows. The player gives each late item's nextCue as a time
        (the next cue's, or the voice's end after the last cue); the row adds which cue that is (nextIndex,
        None for the voice's end) and how far past it the element lands (into), so the report can say both."""
        try:
            tm = await h["page"].evaluate("id => window.MotionPlayer.timing(id)", s["id"]) or {}
        except Exception:  # noqa: BLE001 - a failing timing check must not lose the layout report
            return []
        rows: list[dict] = []
        cues = s.get("cues") or []
        for gap in tm.get("gaps") or []:
            if isinstance(gap, (list, tuple)) and len(gap) == 2:
                a, b = float(gap[0]), float(gap[1])
                rows.append({"id": s["id"], "t": round(a, 2), "gaps": [[round(a, 2), round(b, 2)]]})
        for item in tm.get("late") or []:
            if not isinstance(item, dict) or item.get("at") is None:
                continue
            x = dict(item)
            nxt = x.get("nextCue")
            if isinstance(nxt, (int, float)):
                # cue(n) is cues[n] (cues[0] is the voice's start); no cue at that time means the voice's end
                x["nextIndex"] = next((i for i, c in enumerate(cues) if abs(float(c) - float(nxt)) < 0.02), None)
                x["into"] = round(float(x["at"]) - float(nxt), 2)
            rows.append({"id": s["id"], "t": round(float(x["at"]), 2), "late": [x]})
        return rows

    async def preview_frame(self, bundle: dict, scene_id: str, local_t: float, width: int = 540, quality: int = 82) -> tuple[bytes, dict]:
        h = await self._preview_handle(bundle)
        diag = await h["page"].evaluate("([id, t]) => window.MotionPlayer.diagnose(id, t)", [scene_id, local_t])
        scale = min(1.0, width / bundle["width"])
        img = await self._shot(h, scene_id, local_t, "jpeg", scale, quality=quality)
        if h["errors"]:
            diag.setdefault("errors", []).extend(h["errors"])
        return img, diag

    async def poster(self, bundle: dict, width: int = 360) -> bytes | None:
        scene = next((s for s in bundle["scenes"] if s.get("source") and s.get("kind") != "endscreen"), None)
        if not scene:
            return None
        img, _ = await self.preview_frame(bundle, scene["id"], min(2.0, scene["duration"] * 0.6), width)
        return img

    async def screenshot_url(self, url: str, width: int = 1280, height: int = 800) -> bytes:
        """A screenshot of a public web page (for the brand extraction)."""
        browser = await self._get_browser()
        ctx = await browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
        try:
            page = await ctx.new_page()

            async def guard(route):
                u = urllib.parse.urlsplit(route.request.url)
                if u.netloc == self.netloc or (u.hostname or "") in ("localhost", "127.0.0.1", "::1"):
                    return await route.abort()
                return await route.continue_()

            await page.route("**/*", guard)
            await page.goto(url, wait_until="domcontentloaded", timeout=20000)
            try:
                await page.wait_for_load_state("networkidle", timeout=6000)
            except Exception:  # noqa: BLE001 - a busy page still gets its screenshot
                pass
            return await page.screenshot(type="jpeg", quality=75)
        finally:
            await ctx.close()

    # ── the MP4 export ──

    async def export(
        self,
        bundle: dict,
        assets_dir: Path,
        cache_dir: Path,
        out_path: Path,
        ffmpeg: str,
        resolution: int,
        audio_path: Path | None,
        progress: Callable[[float, str], None],
        cancel: threading.Event,
        narration_path: Path | None = None,
        with_sfx: bool = True,
        loudness: bool = True,
    ) -> dict:
        """The MP4. loudness False skips the loudness normalisation (the music is still ducked)."""
        started = time.time()
        scenes = bundle["scenes"]
        if not scenes:
            raise RenderError("This video has no scenes yet.")
        if any(not s.get("source") and s.get("kind") != "endscreen" for s in scenes):
            missing = ", ".join(s["id"] for s in scenes if not s.get("source") and s.get("kind") != "endscreen")
            raise RenderError(f"These scenes have no code yet: {missing}. Ask Claude to finish them first.")
        fps = bundle["fps"]
        ow, oh, scale = output_size(bundle["width"], bundle["height"], resolution)
        hashes = scene_hashes(bundle, assets_dir, ow, oh)
        cache_dir.mkdir(parents=True, exist_ok=True)
        files = [cache_dir / f"{h}.mp4" for h in hashes]
        todo = [i for i, f in enumerate(files) if not f.exists()]
        total_frames = sum(scene_frames(scenes[i]["duration"], fps) for i in todo) or 1
        done = {"frames": 0}
        progress(0.0, f"{len(scenes) - len(todo)} of {len(scenes)} scenes unchanged, rendering {len(todo)}")

        async def encode_scene(h: dict, i: int) -> None:
            s = scenes[i]
            n = scene_frames(s["duration"], fps)
            tmp = files[i].with_suffix(".part.mp4")
            # frames arrive as JPEG (quality 92); the paper's film grain is laid over here, not captured: noise in
            # every captured frame made capture about twice as slow
            if grain:
                video = ["-loop", "1", "-framerate", str(fps), "-i", str(grain),
                         "-filter_complex", f"[0:v]scale={ow}:{oh}:flags=lanczos,format=rgb24[v];[1:v]format=rgba[g];[v][g]overlay=shortest=1:format=rgb,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[o]",
                         "-map", "[o]"]
            else:
                video = ["-vf", f"scale={ow}:{oh}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p"]
            cmd = [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
                *video,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high",
                "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
                "-r", str(fps), "-video_track_timescale", str(fps * 512), "-movflags", "+faststart", str(tmp),
            ]
            proc = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            try:
                for k in range(n):
                    if cancel.is_set():
                        raise Cancelled()
                    data = await self._shot(h, s["id"], k / fps, "jpeg", scale, quality=92)
                    proc.stdin.write(data)
                    await proc.stdin.drain()
                    done["frames"] += 1
                    if done["frames"] % 10 == 0 or k == n - 1:
                        progress(done["frames"] / total_frames * 0.95, f"Rendering scene {i + 1} of {len(scenes)} ({s['name']})")
                proc.stdin.close()
                err = await proc.stderr.read()
                rc = await proc.wait()
                if rc != 0:
                    raise RenderError(f"FFmpeg failed on scene {s['id']}: {err.decode(errors='replace')[-400:]}")
                os.replace(tmp, files[i])  # only a cleanly finished file enters the cache
            except BaseException:
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
                tmp.unlink(missing_ok=True)
                raise

        handles: list[dict] = []
        sfx: list[dict] = []
        grain: Path | None = None
        try:
            pages = min(DEFAULT_PAGES, len(todo)) if todo else 1
            handles = [await self._open(bundle) for _ in range(pages)]
            if bundle.get("theme") == "paper":
                grain = cache_dir / f"grain-{ow}x{oh}.png"
                if not grain.exists():
                    await self._grain_frame(handles[0], grain, scale)
                for h in handles:
                    await h["page"].evaluate("() => document.querySelectorAll('#chrome .c-grain').forEach((g) => (g.style.display = 'none'))")
            bad = handles[0]["info"].get("errors") if handles else None
            if bad:
                raise RenderError("A scene has errors, so the export stopped: " + "; ".join(str(e) for e in bad[:3]))
            # the sound effects the scenes' entrances asked for, scene by scene (local seconds)
            sfx = await handles[0]["page"].evaluate("() => window.MotionPlayer.sfx ? window.MotionPlayer.sfx() : []")
            if todo:
                queue = list(todo)

                async def worker(h: dict) -> None:
                    while queue:
                        await encode_scene(h, queue.pop(0))

                await asyncio.gather(*(worker(h) for h in handles))
        finally:
            for h in handles:
                await h["ctx"].close()

        if cancel.is_set():
            raise Cancelled()
        progress(0.96, "Joining the scenes")
        work = out_path.with_suffix(".part.mp4")
        listing = out_path.with_suffix(".txt")
        listing.write_text("".join(f"file '{f.as_posix()}'\n" for f in files), encoding="utf-8")
        try:
            await _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", "-movflags", "+faststart", str(work)])
            # where each scene starts in the finished video (whole frames, as encoded)
            starts, acc = {}, 0
            for s in scenes:
                starts[s["id"]] = acc / fps
                acc += scene_frames(s["duration"], fps)
            total = acc / fps
            events = [
                {"t": starts[e["sceneId"]] + float(e["t"]), "name": e["name"], "gain": float(e.get("gain") or 1)}
                for e in sfx
                if with_sfx and e.get("sceneId") in starts and 0 <= float(e["t"]) < 600
            ]
            level = None
            if narration_path or audio_path or events:
                progress(0.97, "Mixing the narration, music and sound effects" + (" and setting the loudness" if loudness and (narration_path or audio_path) else ""))
                mixed = out_path.with_suffix(".audio.mp4")
                level = await self._mix_audio(ffmpeg, work, mixed, total, narration_path, audio_path, events, loudness)
                os.replace(mixed, work)
            os.replace(work, out_path)
        finally:
            listing.unlink(missing_ok=True)
            work.unlink(missing_ok=True)
        progress(1.0, "Done")
        return {
            "file": out_path.name,
            "bytes": out_path.stat().st_size,
            "width": ow,
            "height": oh,
            "seconds": round(sum(scene_frames(s["duration"], fps) for s in scenes) / fps, 2),
            "renderedScenes": len(todo),
            "cachedScenes": len(scenes) - len(todo),
            "took": round(time.time() - started, 1),
            "loudness": level,  # what the mix was measured at and set to, or None
        }

    async def _grain_frame(self, h: dict, out: Path, scale: float) -> None:
        """The paper's film grain alone, as a see-through PNG at the output size (laid over every frame)."""
        page, cdp = h["page"], h["cdp"]
        await page.evaluate("""() => {
            document.documentElement.style.background = 'transparent';
            document.body.style.background = 'transparent';
            const stage = document.getElementById('stage');
            stage.style.background = 'transparent';
            for (const el of Array.from(stage.children)) if (el.id !== 'chrome') el.style.visibility = 'hidden';
            for (const el of Array.from(document.querySelectorAll('#chrome > *'))) if (!el.classList.contains('c-grain')) el.style.visibility = 'hidden';
        }""")
        await cdp.send("Emulation.setDefaultBackgroundColorOverride", {"color": {"r": 0, "g": 0, "b": 0, "a": 0}})
        w, hgt = h["size"]
        r = await cdp.send("Page.captureScreenshot", {"format": "png", "clip": {"x": 0, "y": 0, "width": w, "height": hgt, "scale": scale}})
        out.write_bytes(base64.b64decode(r["data"]))
        await cdp.send("Emulation.setDefaultBackgroundColorOverride", {})
        h["info"] = await page.evaluate("b => window.MotionPlayer.load(b)", h["bundle"])
        await page.evaluate("""() => {
            document.documentElement.style.background = '';
            document.body.style.background = '';
            document.getElementById('stage').style.background = '';
        }""")

    def _mix_parts(self, total: float, narration: Path | None, music: Path | None, events: list[dict], base: int) -> tuple[list[str], list[str]]:
        """The mix's inputs and filter graph, ending in the label [mix]: the narration at full level, the
        music ducked under it (a sidechain compressor keyed by the voice) and faded out at the end, and each
        sound effect at its moment. Inputs are numbered from `base`: the final pass has the video as input 0,
        the measuring pass has no video at all. No parts means there is nothing to mix."""
        sfx_dir = self.dist_dir / "assets" / "motion" / "sfx"
        by_name: dict[str, list[dict]] = {}
        for e in events:
            f = sfx_dir / f"{e['name']}.mp3"
            if f.exists():
                by_name.setdefault(e["name"], []).append(e)
        inputs: list[str] = []
        parts: list[str] = []
        labels: list[str] = []
        k = base
        if narration:
            inputs += ["-i", str(narration)]
            if music:
                # a copy of the voice keys the music's compressor, padded so the key never ends before the music
                parts.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[nar][key0]")
                parts.append("[key0]apad[key]")
            else:
                parts.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo[nar]")
            labels.append("[nar]")
            k += 1
        if music:
            inputs += ["-i", str(music)]
            bed = f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={MUSIC_BED if narration else MUSIC_ALONE},apad,atrim=0:{total:.3f},afade=t=out:st={max(0.0, total - 1.5):.3f}:d=1.5"
            if narration:
                parts.append(bed + "[bed]")
                parts.append(f"[bed][key]sidechaincompress={DUCK}[mus]")
            else:
                parts.append(bed + "[mus]")
            labels.append("[mus]")
            k += 1
        for name, evs in sorted(by_name.items()):
            inputs += ["-i", str(sfx_dir / f"{name}.mp3")]
            outs = "".join(f"[{name}_{i}]" for i in range(len(evs)))
            parts.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={SFX_GAIN.get(name, 0.4):.2f},asplit={len(evs)}{outs}" if len(evs) > 1 else f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={SFX_GAIN.get(name, 0.4):.2f}[{name}_0]")
            for i, e in enumerate(evs):
                ms = max(0, round(e["t"] * 1000))
                parts.append(f"[{name}_{i}]volume={e['gain']:.2f},adelay={ms}|{ms}[e_{name}_{i}]")
                labels.append(f"[e_{name}_{i}]")
            k += 1
        if not labels:
            return [], []
        if len(labels) > 1:
            parts.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,apad=whole_dur={total:.3f},atrim=0:{total:.3f}[mix]")
        else:
            parts.append(f"{labels[0]}apad=whole_dur={total:.3f},atrim=0:{total:.3f}[mix]")
        return inputs, parts

    async def _mix_audio(
        self, ffmpeg: str, video: Path, out: Path, total: float, narration: Path | None, music: Path | None, events: list[dict], loudness: bool = True,
    ) -> dict | None:
        """Narration at full level, the music ducked under it (faded out at the end), each sound effect at its
        moment; with `loudness`, the whole mix brought to YouTube's -14 LUFS in two passes. The video stream is
        copied untouched (-c:v copy).

        Returns the loudness report ({target, integrated, truePeak, mode, measured, limited}), or None when the
        mix wasn't normalised: loudness off, or a video with only paper sounds (raising a few pops to a
        talking video's loudness would make them blare), or a silent mix."""
        inputs, parts = self._mix_parts(total, narration, music, events, base=1)
        if not parts:  # the sounds asked for aren't installed: the video stays as it is
            shutil.copyfile(video, out)
            return None
        script = out.with_suffix(".filter.txt")
        report = None
        # without normalising, the mix only gets a safety limiter against clipping (level=false: the limiter's
        # default auto level would push every peak back up to full scale)
        final = "[mix]alimiter=limit=0.95:level=false[aout]"
        try:
            if loudness and (narration or music):
                stats = await self._measure_mix(ffmpeg, script, total, narration, music, events)
                if stats:
                    final, report = _loudnorm_apply(stats)
            script.write_text(";\n".join(parts + [final]), encoding="utf-8")
            err = await _run_capture([ffmpeg, "-hide_banner", "-nostats", "-loglevel", "info" if report else "error", "-y", "-i", str(video), *inputs,
                                      *vc.filter_file_args(ffmpeg, script), "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                                      "-ar", "48000", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
            if report:
                done = _loudnorm_json(err) or {}
                report.update(
                    integrated=_num(done.get("output_i")),
                    truePeak=_num(done.get("output_tp")),
                    mode=done.get("normalization_type") or "unknown",
                )
        finally:
            script.unlink(missing_ok=True)
        return report

    async def _measure_mix(self, ffmpeg: str, script: Path, total: float, narration: Path | None, music: Path | None, events: list[dict]) -> dict | None:
        """The first loudness pass: the same mix (without the video) through loudnorm, only to measure it.
        None when there is nothing to measure (silence) or the measurement can't be read."""
        inputs, parts = self._mix_parts(total, narration, music, events, base=0)
        t = LOUDNESS
        script.write_text(";\n".join(parts + [f"[mix]loudnorm=I={t['I']}:TP={t['TP']}:LRA={t['LRA']}:print_format=json[aout]"]), encoding="utf-8")
        err = await _run_capture([ffmpeg, "-hide_banner", "-nostats", "-loglevel", "info", "-y", *inputs, *vc.filter_file_args(ffmpeg, script),
                                  "-map", "[aout]", "-f", "null", "-"])
        stats = _loudnorm_json(err)
        if not stats or not all(math.isfinite(stats.get(k, math.nan)) for k in ("input_i", "input_tp", "input_lra", "input_thresh")):
            return None
        if stats["input_i"] < -70:  # silence: nothing to bring up
            return None
        return stats

    def shutdown(self) -> None:
        if self._loop is None:
            return

        async def close():
            for h in self._preview_pages.values():
                try:
                    await h["ctx"].close()
                except Exception:  # noqa: BLE001
                    pass
            if self._browser is not None:
                await self._browser.close()
            if self._pw is not None:
                await self._pw.stop()

        try:
            self.call(close, timeout=10)
        except Exception:  # noqa: BLE001 - shutting down anyway
            pass


async def _run(cmd: list[str]) -> None:
    await _run_capture(cmd)


async def _run_capture(cmd: list[str]) -> str:
    """Runs FFmpeg and returns what it wrote to stderr (the loudness passes print their measurements there)."""
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    text = err.decode(errors="replace")
    if proc.returncode != 0:
        raise RenderError("FFmpeg failed: " + text[-400:])
    return text


# ── loudness ──


def _num(value) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return round(x, 2) if math.isfinite(x) else None


def _loudnorm_json(stderr: str) -> dict | None:
    """The measurements loudnorm prints as JSON at the end of a pass (input_i, input_tp, ..., as numbers;
    normalization_type as text). None when there are none."""
    blocks = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr)
    if not blocks:
        return None
    try:
        raw = json.loads(blocks[-1])
    except ValueError:
        return None
    out: dict = {"normalization_type": raw.get("normalization_type")}
    for k, v in raw.items():
        if k != "normalization_type":
            try:
                out[k] = float(v)  # "-inf" for silence parses too
            except (TypeError, ValueError):
                out[k] = math.nan
    return out


def _loudnorm_apply(stats: dict) -> tuple[str, dict]:
    """The second pass: (the filter chain from [mix] to [aout], the report so far) from the first pass's
    measurements. loudnorm scales linearly only when the gain keeps the true peak under the ceiling; a
    narrated mix's peaks (plosives, a stamp's thump) usually stand too high for that, and loudnorm would ride
    the level up and down instead. So a look-ahead limiter first holds those few peaks 1 dB under where the
    gain needs them, and the gain stays one clean, linear change for the whole video."""
    t = LOUDNESS
    i, tp, lra, thresh = stats["input_i"], stats["input_tp"], stats["input_lra"], stats["input_thresh"]
    gain = t["I"] - i
    limiter, measured_tp = "", tp
    if tp + gain > t["TP"]:
        ceiling = max(0.0625, min(1.0, 10 ** ((t["TP"] - gain - 1.0) / 20)))
        limiter = f"alimiter=limit={ceiling:.4f}:attack=5:release=50:level=false:latency=true,"
        # what the second pass sees: the limited peaks plus half a dB for the peaks between samples
        measured_tp = min(tp, 20 * math.log10(ceiling) + 0.5)

    def clamp(x: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, x))

    norm = (
        f"loudnorm=I={t['I']}:TP={t['TP']}:LRA={t['LRA']}"
        f":measured_I={clamp(i, -99, 0):.2f}:measured_TP={clamp(measured_tp, -99, 99):.2f}"
        f":measured_LRA={clamp(lra, 0, 99):.2f}:measured_thresh={clamp(thresh, -99, 0):.2f}"
        f":offset={clamp(stats.get('target_offset', 0.0) if math.isfinite(stats.get('target_offset', 0.0)) else 0.0, -99, 99):.2f}"
        ":linear=true:print_format=json"
    )
    # loudnorm works at 192 kHz inside; the file goes out at 48 kHz
    chain = f"[mix]{limiter}{norm},aresample=48000[aout]"
    report = {
        "target": t["I"],
        "integrated": None,
        "truePeak": None,
        "mode": None,
        "measured": {"integrated": _num(i), "truePeak": _num(tp), "lra": _num(lra)},
        "limited": bool(limiter),
    }
    return chain, report


def loudness_of(ffmpeg: str, path: Path) -> dict:
    """A file's integrated loudness (LUFS) and true peak (dBTP), measured with FFmpeg's EBU R128 meter: a
    check independent of loudnorm, for the tests and by hand."""
    import subprocess

    res = subprocess.run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=600)
    summary = res.stderr[res.stderr.rfind("Summary:"):]
    i = re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", summary)
    p = re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", summary)
    return {"integrated": _num(i.group(1)) if i else None, "truePeak": _num(p.group(1)) if p else None}


def prune_cache(cache_dir: Path, keep_bytes: int = 2_000_000_000) -> None:
    """Keeps the scene cache under `keep_bytes`, dropping the least recently used files."""
    if not cache_dir.exists():
        return
    files = sorted((f for f in cache_dir.glob("*.mp4") if ".part" not in f.name), key=lambda f: f.stat().st_atime, reverse=True)
    total = 0
    for f in files:
        total += f.stat().st_size
        if total > keep_bytes:
            f.unlink(missing_ok=True)


def copy_file(src: Path, dst: Path) -> None:
    shutil.copyfile(src, dst)
