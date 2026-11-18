"""
B-roll: short clips and photos placed under the narration where an idea meets everyday life (a queue at a
shop, a server room, someone typing). They come from the user (an upload) or from free stock (Pexels and
Pixabay, searched and imported by Claude's find_broll and import_broll tools).

Every clip becomes an edit-friendly copy in the video's assets, made with FFmpeg: H.264 yuv420p in TV range
(what browsers show without a colour shift), no audio (b-roll is always silent: the narration is the sound),
a keyframe every 10 frames with no B-frames (so the export finds any frame quickly and exactly), at most
3840 x 2160, at the clip's own frame rate (30 when it can't be read, or is over 60). The original upload is
not kept: it stays on the user's computer where it came from, and the copy is near-lossless (CRF 17).

A clip's facts (length, size, frame rate, where it came from) live next to it in assets/.meta/<name>.json;
stock credits also go to docs/CREDITS.md. Neither licence asks for credit, but the record stays with the video.

Keys: MOTION_PEXELS_KEY and MOTION_PIXABAY_KEY in backend/.env (free accounts). They are only sent to their
own service and never printed.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .store import Store, StoreError, safe_asset_name

KEYINT = 10  # a keyframe every 10 frames: the export seeks a frame in a few decodes
MAX_W, MAX_H = 3840, 2160
MAX_STOCK_BYTES = 400 * 1024 * 1024
USER_AGENT = "Motion-video-tool/1.0"  # a generic client name: nothing about the user goes to the stock services
TIMEOUT = 20.0

LICENCES = {
    "pexels": "Pexels License: free to use, no credit needed (https://www.pexels.com/license/)",
    "pixabay": "Pixabay Content License: free to use, no credit needed (https://pixabay.com/service/license-summary/)",
}
KEY_ENV = {"pexels": "MOTION_PEXELS_KEY", "pixabay": "MOTION_PIXABAY_KEY"}
NO_KEY_HELP = (
    "No stock key is set, so the stock search can't run. Both are free: "
    "Pexels: sign up at https://www.pexels.com/api/ and copy your API key; "
    "Pixabay: sign up at https://pixabay.com/accounts/register/ and copy the key shown on https://pixabay.com/api/docs/. "
    "Put them in backend/.env as MOTION_PEXELS_KEY=... and MOTION_PIXABAY_KEY=..., then restart the app. "
    "The user's own clips work without any key: they attach them with the paperclip."
)

# the network, through names a test can swap (no test ever reaches a real service)
_urlopen = urllib.request.urlopen


def _check_url(url: str) -> str:
    from .brand import check_public_url  # refuses this computer and the local network

    return check_public_url(url)


class BrollError(Exception):
    pass


# ── FFmpeg: the clip's facts and the edit-friendly copy ──


def ffprobe_exe(ffmpeg: str) -> str | None:
    p = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    return str(p) if p.exists() else None


def _rate(text: str | None) -> float | None:
    """'30000/1001' or '25' as frames a second (None when it can't be read)."""
    if not text:
        return None
    try:
        if "/" in text:
            a, b = text.split("/", 1)
            return float(a) / float(b) if float(b) else None
        return float(text)
    except ValueError:
        return None


def probe(ffmpeg: str, path: Path) -> dict:
    """{seconds, width, height, fps} of a video, or of a picture (seconds 0)."""
    exe = ffprobe_exe(ffmpeg)
    if exe:
        r = subprocess.run(
            [exe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        try:
            data = json.loads(r.stdout or "{}")
        except json.JSONDecodeError:
            data = {}
        st = (data.get("streams") or [{}])[0]
        fps = _rate(st.get("avg_frame_rate")) or _rate(st.get("r_frame_rate"))
        seconds = float((data.get("format") or {}).get("duration") or 0)
        if st.get("width"):
            return {"seconds": round(seconds, 3), "width": int(st["width"]), "height": int(st["height"]), "fps": round(fps, 3) if fps else None}
    return probe_text(subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=60).stderr)


def probe_text(stderr: str) -> dict:
    """The same facts from `ffmpeg -i` (when ffprobe isn't there)."""
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", stderr)
    seconds = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    v = re.search(r"Video: .*?(\d{2,5})x(\d{2,5})", stderr)
    f = re.search(r"(\d+(?:\.\d+)?) fps", stderr)
    if not v:
        raise BrollError("This file has no picture FFmpeg can read.")
    return {"seconds": round(seconds, 3), "width": int(v.group(1)), "height": int(v.group(2)), "fps": float(f.group(1)) if f else None}


def clip_fps(fps: float | None) -> float:
    """The frame rate a copy keeps: the clip's own (up to 60), else 30."""
    return round(fps, 3) if fps and 1 <= fps <= 60 else 30.0


def _fit() -> str:
    # the largest size that fits 3840 x 2160 without growing the picture, both sides even
    f = f"min(1,min({MAX_W}/iw,{MAX_H}/ih))"
    return f"scale='trunc(iw*{f}/2)*2':'trunc(ih*{f}/2)*2':flags=lanczos:out_range=tv"


def convert_args(ffmpeg: str, src: Path, dst: Path, fps: float, start: float | None = None, seconds: float | None = None) -> list[str]:
    """The FFmpeg command for a clip's edit-friendly copy (see the module's notes)."""
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if start:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", str(src)]
    if seconds:
        args += ["-t", f"{seconds:.3f}"]
    return args + [
        "-an", "-sn", "-dn",
        "-vf", f"{_fit()},fps={fps:g},format=yuv420p",
        "-c:v", "libx264", "-preset", "fast", "-crf", "17",
        "-g", str(KEYINT), "-keyint_min", str(KEYINT), "-sc_threshold", "0", "-bf", "0",
        "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-movflags", "+faststart",
        str(dst),
    ]


def photo_args(ffmpeg: str, src: Path, dst: Path) -> list[str]:
    """A stock photo at most 3840 x 2160, as a good JPEG."""
    f = f"min(1,min({MAX_W}/iw,{MAX_H}/ih))"
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vf", f"scale='trunc(iw*{f}/2)*2':'trunc(ih*{f}/2)*2':flags=lanczos", "-q:v", "2", "-frames:v", "1", str(dst)]


def convert(ffmpeg: str, src: Path, dst: Path, start: float | None = None, seconds: float | None = None) -> dict:
    """Makes the edit-friendly copy at dst and returns its facts {seconds, width, height, fps}."""
    facts = probe(ffmpeg, src)
    tmp = dst.with_name(dst.name + ".part.mp4")
    r = subprocess.run(convert_args(ffmpeg, src, tmp, clip_fps(facts.get("fps")), start, seconds), capture_output=True, text=True, timeout=1800)
    if r.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise BrollError("FFmpeg couldn't convert the clip: " + (r.stderr or "").strip()[-300:])
    os.replace(tmp, dst)
    return probe(ffmpeg, dst)


def meta_dir(store: Store, pid: str) -> Path:
    d = store.assets_dir(pid) / ".meta"
    d.mkdir(exist_ok=True)
    return d


def incoming_dir(store: Store, pid: str) -> Path:
    d = store.assets_dir(pid) / ".incoming"
    d.mkdir(exist_ok=True)
    return d


def write_meta(store: Store, pid: str, name: str, meta: dict) -> None:
    from .store import write_json

    write_json(meta_dir(store, pid) / f"{name}.json", meta)


def free_name(store: Store, pid: str, wanted: str, ext: str) -> str:
    """A name in the assets folder that no file (nor a clip still converting) has yet."""
    folder = store.assets_dir(pid)
    stem = os.path.splitext(safe_asset_name(wanted))[0] or "clip"
    name, i = stem + ext, 2
    while (folder / name).exists() or (folder / ".meta" / f"{name}.json").exists():
        name = f"{stem}-{i}{ext}"
        i += 1
    return name


# ── the user's own clips: converted in the background after an upload ──


class Clips:
    """Converts uploaded clips one at a time, off the request (a long 4K clip takes minutes). While one
    converts, the asset list shows it as converting; when it is ready the page is told (hub op "assets") and
    the chat gets a note with its length and size."""

    def __init__(self, store: Store, hub, find_ffmpeg):
        self.store = store
        self.hub = hub
        self.find_ffmpeg = find_ffmpeg
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="motion-clips")
        self._lock = threading.Lock()
        self._busy: set[str] = set()

    def ffmpeg(self) -> str:
        from .render import ffmpeg_exe

        exe = ffmpeg_exe(self.find_ffmpeg())
        if not exe:
            raise StoreError("FFmpeg was not found, so videos can't be added. Install FFmpeg and restart the app.")
        return exe

    def busy(self) -> int:
        with self._lock:
            return len(self._busy)

    def start(self, pid: str, incoming: Path, filename: str) -> dict:
        """incoming is the upload on disk (in assets/.incoming). Returns the asset as it will be named."""
        ffmpeg = self.ffmpeg()
        name = free_name(self.store, pid, filename, ".mp4")
        write_meta(self.store, pid, name, {"kind": "video", "state": "converting", "source": "upload", "original": Path(filename).name, "at": time.time()})
        with self._lock:
            self._busy.add(f"{pid}:{name}")
        self._pool.submit(self._run, pid, incoming, name, ffmpeg)
        return {"name": name, "kind": "video", "bytes": incoming.stat().st_size, "state": "converting"}

    def _run(self, pid: str, incoming: Path, name: str, ffmpeg: str) -> None:
        try:
            facts = convert(ffmpeg, incoming, self.store.assets_dir(pid) / name)
            write_meta(self.store, pid, name, {"kind": "video", "state": "ready", "source": "upload", **facts, "at": time.time()})
            text = f"Clip ready: asset://{name}, {facts['seconds']:.1f} s, {facts['width']} x {facts['height']} at {facts['fps']:g} fps."
        except Exception as err:  # noqa: BLE001 - any failure is told to the user, never raised in a worker
            (meta_dir(self.store, pid) / f"{name}.json").unlink(missing_ok=True)
            text = f"The clip {name} couldn't be added: {err}"
        finally:
            incoming.unlink(missing_ok=True)
            with self._lock:
                self._busy.discard(f"{pid}:{name}")
        try:
            self.hub.add(pid, {"kind": "note", "text": text})
            self.hub.flush(pid)
            self.hub.emit(pid, {"op": "assets"})
        except Exception:  # noqa: BLE001 - the project may have been deleted meanwhile
            pass


async def save_upload(store: Store, pid: str, upload, max_bytes: int) -> Path:
    """Streams an uploaded video to assets/.incoming (never all of it in memory)."""
    dst = incoming_dir(store, pid) / f"{uuid.uuid4().hex}{os.path.splitext(upload.filename or '')[1].lower()}"
    total = 0
    with open(dst, "wb") as out:
        while True:
            chunk = await upload.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                out.close()
                dst.unlink(missing_ok=True)
                raise StoreError(f"The video is larger than {max_bytes // (1024 * 1024)} MB.")
            out.write(chunk)
    return dst


# ── free stock: Pexels and Pixabay ──


def keys() -> dict[str, str]:
    return {src: os.environ.get(env, "").strip() for src, env in KEY_ENV.items() if os.environ.get(env, "").strip()}


def _get_json(url: str, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})})
    try:
        with _urlopen(req, timeout=TIMEOUT) as res:  # noqa: S310 - fixed https hosts
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        host = urllib.parse.urlsplit(url).hostname or "the stock service"
        if err.code in (401, 403):
            raise BrollError(f"{host} refused the key (HTTP {err.code}): check it in backend/.env.") from None
        if err.code == 429:
            raise BrollError(f"{host} says too many searches for now (HTTP 429): try again in a while.") from None
        raise BrollError(f"{host} answered HTTP {err.code}.") from None
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        raise BrollError(f"The stock service couldn't be reached: {err}") from None


# what the last searches found, so import_broll knows a candidate's files without searching again
_seen: dict[str, dict] = {}
_seen_lock = threading.Lock()


def _remember(cands: list[dict]) -> None:
    with _seen_lock:
        for c in cands:
            _seen[c["id"]] = c
        while len(_seen) > 500:
            _seen.pop(next(iter(_seen)))


def _pexels_video(v: dict) -> dict:
    files = [
        {"url": f.get("link"), "width": f.get("width") or 0, "height": f.get("height") or 0, "fps": f.get("fps"), "type": f.get("file_type") or ""}
        for f in v.get("video_files") or []
        if f.get("link")
    ]
    user = v.get("user") or {}
    return {
        "id": f"pexels:{v['id']}", "source": "pexels", "kind": "video", "title": _title_from_url(v.get("url") or ""),
        "seconds": float(v.get("duration") or 0), "width": v.get("width") or 0, "height": v.get("height") or 0,
        "author": user.get("name") or "", "authorUrl": user.get("url") or "", "page": v.get("url") or "",
        "preview": v.get("image") or "", "files": files, "licence": LICENCES["pexels"],
    }


def _pexels_photo(p: dict) -> dict:
    src = p.get("src") or {}
    return {
        "id": f"pexels:{p['id']}", "source": "pexels", "kind": "photo", "title": p.get("alt") or _title_from_url(p.get("url") or ""),
        "seconds": 0.0, "width": p.get("width") or 0, "height": p.get("height") or 0,
        "author": p.get("photographer") or "", "authorUrl": p.get("photographer_url") or "", "page": p.get("url") or "",
        "preview": src.get("medium") or src.get("large") or "", "files": [{"url": src.get("original") or src.get("large2x"), "width": p.get("width") or 0, "height": p.get("height") or 0}],
        "licence": LICENCES["pexels"],
    }


def _pixabay_video(h: dict) -> dict:
    vids = h.get("videos") or {}
    files = [
        {"url": f.get("url"), "width": f.get("width") or 0, "height": f.get("height") or 0, "type": "video/mp4"}
        for f in (vids.get(k) or {} for k in ("large", "medium", "small", "tiny"))
        if f.get("url")
    ]
    biggest = max(files, key=lambda f: f["width"] * f["height"], default={"width": 0, "height": 0})
    thumb = next((f.get("thumbnail") for f in (vids.get(k) or {} for k in ("medium", "small", "large", "tiny")) if f.get("thumbnail")), "")
    if not thumb and h.get("picture_id"):
        thumb = f"https://i.vimeocdn.com/video/{h['picture_id']}_640x360.jpg"
    return {
        "id": f"pixabay:{h['id']}", "source": "pixabay", "kind": "video", "title": h.get("tags") or "",
        "seconds": float(h.get("duration") or 0), "width": biggest["width"], "height": biggest["height"],
        "author": h.get("user") or "", "authorUrl": f"https://pixabay.com/users/{h.get('user')}-{h.get('user_id')}/" if h.get("user") else "",
        "page": h.get("pageURL") or "", "preview": thumb, "files": files, "licence": LICENCES["pixabay"],
    }


def _pixabay_photo(h: dict) -> dict:
    return {
        "id": f"pixabay:{h['id']}", "source": "pixabay", "kind": "photo", "title": h.get("tags") or "",
        "seconds": 0.0, "width": h.get("imageWidth") or 0, "height": h.get("imageHeight") or 0,
        "author": h.get("user") or "", "authorUrl": f"https://pixabay.com/users/{h.get('user')}-{h.get('user_id')}/" if h.get("user") else "",
        "page": h.get("pageURL") or "", "preview": h.get("webformatURL") or "",
        "files": [{"url": h.get("largeImageURL") or h.get("webformatURL"), "width": h.get("imageWidth") or 0, "height": h.get("imageHeight") or 0}],
        "licence": LICENCES["pixabay"],
    }


def _title_from_url(url: str) -> str:
    # pexels pages end in /<words>-<id>/: the words are the clip's title
    m = re.search(r"/(?:video|photo)/([a-z0-9-]+?)-\d+/?$", url)
    return m.group(1).replace("-", " ") if m else ""


def _fits(c: dict, orientation: str) -> bool:
    w, h = c.get("width") or 0, c.get("height") or 0
    if not w or not h or orientation in ("", "any"):
        return True
    return {"landscape": w > h, "portrait": h > w, "square": abs(w - h) <= 0.1 * max(w, h)}.get(orientation, True)


def search(query: str, kind: str = "video", orientation: str = "landscape", min_seconds: float = 0, limit: int = 8) -> list[dict]:
    """Candidates from every service with a key, alternating between them. Raises BrollError without keys."""
    query = (query or "").strip()
    if not query:
        raise BrollError("Say what to search for, in a few plain words (like: queue at a shop counter).")
    kind = "photo" if kind == "photo" else "video"
    have = keys()
    if not have:
        raise BrollError(NO_KEY_HELP)
    per = max(4, min(30, limit * 2))
    found: list[list[dict]] = []
    errors = []
    q = urllib.parse.quote(query)
    if "pexels" in have:
        try:
            ori = f"&orientation={orientation}" if orientation in ("landscape", "portrait", "square") else ""
            if kind == "video":
                data = _get_json(f"https://api.pexels.com/videos/search?query={q}&per_page={per}{ori}", {"Authorization": have["pexels"]})
                found.append([_pexels_video(v) for v in data.get("videos") or []])
            else:
                data = _get_json(f"https://api.pexels.com/v1/search?query={q}&per_page={per}{ori}", {"Authorization": have["pexels"]})
                found.append([_pexels_photo(p) for p in data.get("photos") or []])
        except BrollError as err:
            errors.append(str(err))
    if "pixabay" in have:
        try:
            k = urllib.parse.quote(have["pixabay"])
            if kind == "video":
                data = _get_json(f"https://pixabay.com/api/videos/?key={k}&q={q}&per_page={per}&safesearch=true")
                found.append([_pixabay_video(h) for h in data.get("hits") or []])
            else:
                ori = {"landscape": "horizontal", "portrait": "vertical"}.get(orientation, "all")
                data = _get_json(f"https://pixabay.com/api/?key={k}&q={q}&image_type=photo&orientation={ori}&per_page={per}&safesearch=true")
                found.append([_pixabay_photo(h) for h in data.get("hits") or []])
        except BrollError as err:
            errors.append(str(err))
    if not found and errors:
        raise BrollError(" ".join(errors))
    out: list[dict] = []
    for i in range(max((len(f) for f in found), default=0)):
        for f in found:
            if i < len(f):
                c = f[i]
                if c["files"] and _fits(c, orientation) and (kind == "photo" or c["seconds"] >= (min_seconds or 0)):
                    out.append(c)
    _remember(out)
    return out[:limit]


def details(cid: str) -> dict:
    """A candidate by its id ("pexels:123"), from the last searches or asked for again."""
    with _seen_lock:
        if cid in _seen:
            return _seen[cid]
    source, _, sid = cid.partition(":")
    have = keys()
    if source not in KEY_ENV or not sid.isdigit():
        raise BrollError(f'"{cid}" is not a stock id (they look like pexels:123456 or pixabay:98765).')
    if source not in have:
        raise BrollError(NO_KEY_HELP)
    if source == "pexels":
        try:
            c = _pexels_video(_get_json(f"https://api.pexels.com/videos/videos/{sid}", {"Authorization": have["pexels"]}))
        except BrollError:
            c = _pexels_photo(_get_json(f"https://api.pexels.com/v1/photos/{sid}", {"Authorization": have["pexels"]}))
    else:
        k = urllib.parse.quote(have["pixabay"])
        hits = _get_json(f"https://pixabay.com/api/videos/?key={k}&id={sid}").get("hits") or []
        c = _pixabay_video(hits[0]) if hits else None
        if not c:
            hits = _get_json(f"https://pixabay.com/api/?key={k}&id={sid}").get("hits") or []
            if not hits:
                raise BrollError(f"Pixabay has nothing with the id {sid}.")
            c = _pixabay_photo(hits[0])
    _remember([c])
    return c


def best_file(c: dict) -> dict:
    """The largest file that fits 3840 x 2160 (an mp4 for a clip); the smallest when every file is larger."""
    files = [f for f in c.get("files") or [] if f.get("url")]
    if c.get("kind") == "video":
        files = [f for f in files if "mp4" in (f.get("type") or "mp4")] or files
    if not files:
        raise BrollError(f"{c['id']} has no file to download.")
    fit = [f for f in files if (f.get("width") or 0) <= MAX_W and (f.get("height") or 0) <= MAX_H and (f.get("width") or 0) * (f.get("height") or 0) > 0]
    if fit:
        return max(fit, key=lambda f: (f["width"] * f["height"], f.get("fps") or 0))
    if c.get("kind") == "photo":
        return files[0]  # a photo larger than 4K is shrunk on import
    return min(files, key=lambda f: (f.get("width") or 0) * (f.get("height") or 0))


def download(url: str, dst: Path, max_bytes: int = MAX_STOCK_BYTES) -> int:
    url = _check_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    total = 0
    try:
        with _urlopen(req, timeout=60) as res, open(dst, "wb") as out:  # noqa: S310 - checked above
            while True:
                chunk = res.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise BrollError(f"The file is larger than {max_bytes // (1024 * 1024)} MB.")
                out.write(chunk)
    except BrollError:
        dst.unlink(missing_ok=True)
        raise
    except Exception as err:  # noqa: BLE001 - network errors come in many types
        dst.unlink(missing_ok=True)
        raise BrollError(f"The download failed: {err}") from None
    return total


def preview(url: str, max_bytes: int = 2_000_000) -> bytes | None:
    """A candidate's preview picture (for Claude to look at), or None."""
    if not url:
        return None
    try:
        req = urllib.request.Request(_check_url(url), headers={"User-Agent": USER_AGENT, "Accept": "image/*"})
        with _urlopen(req, timeout=TIMEOUT) as res:  # noqa: S310 - checked above
            data = res.read(max_bytes + 1)
            return data if len(data) <= max_bytes else None
    except Exception:  # noqa: BLE001 - a missing preview only means Claude sees one picture less
        return None


def credit_line(name: str, c: dict) -> str:
    who = c.get("author") or "an unnamed creator"
    where = {"pexels": "Pexels", "pixabay": "Pixabay"}.get(c.get("source"), c.get("source") or "stock")
    title = f'"{c["title"]}" ' if c.get("title") else ""
    return f"- asset://{name}: {title}by {who}" + (f" ({c['authorUrl']})" if c.get("authorUrl") else "") + f" on {where}, {c.get('page') or ''}. {c.get('licence') or ''}".rstrip()


def add_credit(store: Store, pid: str, line: str) -> None:
    head = "# Credits\n\nStock b-roll in this video. Neither licence asks for credit; the record stays with the video (and can go in the description).\n"
    try:
        current = store.read_doc(pid, "CREDITS.md")
    except StoreError:
        current = head
    if line in current:
        return
    store.write_doc(pid, "CREDITS.md", current.rstrip("\n") + "\n" + line + "\n")


def import_stock(store: Store, pid: str, ffmpeg: str, cid: str, start: float | None = None, seconds: float | None = None, name: str | None = None) -> dict:
    """Downloads a candidate's best file, trims and converts it into the assets, records its credit. Returns
    the asset {name, kind, seconds, width, height, fps}."""
    c = details(cid)
    f = best_file(c)
    video = c["kind"] == "video"
    if video and c.get("seconds") and start and start >= c["seconds"]:
        raise BrollError(f"The clip is {c['seconds']:.1f} s long, so it can't start at {start:g} s.")
    ext = ".mp4" if video else ".jpg"
    wanted = name or f"broll-{(c.get('title') or c['source'])[:30]}-{cid.split(':')[1]}"
    asset = free_name(store, pid, wanted, ext)
    raw = incoming_dir(store, pid) / f"{uuid.uuid4().hex}{'.mp4' if video else os.path.splitext(urllib.parse.urlsplit(f['url']).path)[1] or '.jpg'}"
    try:
        download(f["url"], raw)
        dst = store.assets_dir(pid) / asset
        if video:
            facts = convert(ffmpeg, raw, dst, start, seconds)
        else:
            r = subprocess.run(photo_args(ffmpeg, raw, dst), capture_output=True, text=True, timeout=300)
            if r.returncode != 0 or not dst.exists():
                raise BrollError("FFmpeg couldn't convert the photo: " + (r.stderr or "").strip()[-300:])
            facts = {**probe(ffmpeg, dst), "seconds": 0.0}
    finally:
        raw.unlink(missing_ok=True)
    write_meta(store, pid, asset, {
        "kind": "video" if video else "image", "state": "ready", "source": c["source"], "stockId": cid, "title": c.get("title"),
        "author": c.get("author"), "authorUrl": c.get("authorUrl"), "page": c.get("page"), "licence": c.get("licence"), **facts, "at": time.time(),
    })
    add_credit(store, pid, credit_line(asset, c))
    return {"name": asset, "kind": "video" if video else "image", **facts}


def describe(c: dict) -> str:
    """One candidate as a line Claude reads."""
    size = f"{c['width']} x {c['height']}" if c.get("width") else "size unknown"
    length = f", {c['seconds']:.0f} s" if c.get("kind") == "video" else ""
    best = best_file(c) if c.get("files") else {}
    got = f", imports at {best.get('width')} x {best.get('height')}" if best.get("width") else ""
    return f"{c['id']}: {c.get('title') or 'untitled'}{length}, {size}{got}, by {c.get('author') or 'unknown'} ({c.get('page')})"
