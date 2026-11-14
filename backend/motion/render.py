"""
Frames and MP4s from the same player the page uses, driven in headless Edge (or Chrome) by Playwright.

- preview_frame: one frame of one scene, small, plus layout checks (text off the stage, overlapping
  labels, tiny text, script errors). Claude calls it to look at its own work.
- export: the whole video. Each scene is captured frame by frame (seeked, never played, so every render
  is identical) and encoded on its own: H.264, CRF 18, preset veryfast. A finished scene file is kept
  under its content hash, so after an edit only the changed scene (and the one after it, when that one
  fades in from it) is captured again. The scene files are joined without re-encoding (concat demuxer,
  -c copy), and a soundtrack is added last without touching the video stream (-c:v copy).

All browser work runs on one background thread with its own asyncio loop; other threads submit jobs with
`RenderService.call`.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
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

RUNTIME_VERSION = "4"  # bump when the player changes how a frame looks, so cached scene files are redone
# 4: arrow tips, the slate web address, CSS tilts kept (stamps, stickies, tags), the logo/url settings
DEFAULT_PAGES = max(1, min(4, int(os.environ.get("MOTION_RENDER_PAGES", "3"))))
RESOLUTIONS = (720, 1080, 2160)
# how loud each paper sound sits under the voice
SFX_GAIN = {"rip": 0.55, "page": 0.5, "stamp": 0.6, "crumple": 0.5, "pop": 0.35, "pencil": 0.22, "whoosh": 0.35, "ding": 0.4, "thump": 0.45, "type": 0.25, "sting": 0.45, "slap": 0.45, "popper": 0.4}


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
        """The layout report for each written scene just after every cue and just before its end."""
        h = await self._preview_handle(bundle)
        out = []
        for s in bundle["scenes"]:
            if (ids and s["id"] not in ids) or not s.get("source") or s.get("kind") == "endscreen":
                continue
            end = max(0.0, s["duration"] - 0.35)
            times = sorted({round(min(c + 0.7, end), 2) for c in (s.get("cues") or [])} | {round(end, 2)})
            for t in times:
                d = await h["page"].evaluate("([id, t]) => window.MotionPlayer.diagnose(id, t)", [s["id"], t])
                out.append({"id": s["id"], "t": t, **d})
        if h["errors"]:
            out.append({"id": "*", "t": 0, "errors": list(h["errors"])})
        return out

    async def preview_frame(self, bundle: dict, scene_id: str, local_t: float, width: int = 540) -> tuple[bytes, dict]:
        h = await self._preview_handle(bundle)
        diag = await h["page"].evaluate("([id, t]) => window.MotionPlayer.diagnose(id, t)", [scene_id, local_t])
        scale = min(1.0, width / bundle["width"])
        img = await self._shot(h, scene_id, local_t, "jpeg", scale, quality=82)
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
    ) -> dict:
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
            if narration_path or audio_path or events:
                progress(0.97, "Mixing the narration, music and sound effects")
                mixed = out_path.with_suffix(".audio.mp4")
                await self._mix_audio(ffmpeg, work, mixed, total, narration_path, audio_path, events)
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

    async def _mix_audio(self, ffmpeg: str, video: Path, out: Path, total: float, narration: Path | None, music: Path | None, events: list[dict]) -> None:
        """Narration at full level, music low under it (faded out at the end), and each sound effect at its moment.
        The video stream is copied untouched (-c:v copy)."""
        sfx_dir = self.dist_dir / "assets" / "motion" / "sfx"
        by_name: dict[str, list[dict]] = {}
        for e in events:
            f = sfx_dir / f"{e['name']}.mp3"
            if f.exists():
                by_name.setdefault(e["name"], []).append(e)
        inputs: list[str] = ["-i", str(video)]
        parts: list[str] = []
        labels: list[str] = []
        k = 1
        if narration:
            inputs += ["-i", str(narration)]
            parts.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo[nar]")
            labels.append("[nar]")
            k += 1
        if music:
            inputs += ["-i", str(music)]
            parts.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={0.12 if narration else 0.6},apad,atrim=0:{total:.3f},afade=t=out:st={max(0.0, total - 1.5):.3f}:d=1.5[mus]")
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
        mix = f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,apad=whole_dur={total:.3f},atrim=0:{total:.3f},alimiter=limit=0.95[aout]" if len(labels) > 1 else f"{labels[0]}apad=whole_dur={total:.3f},atrim=0:{total:.3f}[aout]"
        script = out.with_suffix(".filter.txt")
        script.write_text(";\n".join(parts + [mix]), encoding="utf-8")
        try:
            await _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *inputs, *vc.filter_file_args(ffmpeg, script),
                        "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                        "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)])
        finally:
            script.unlink(missing_ok=True)

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
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RenderError("FFmpeg failed: " + err.decode(errors="replace")[-400:])


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
