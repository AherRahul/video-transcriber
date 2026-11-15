"""
Screenshots of a video at sensible moments, each with its time and what is said then: layout references
for Motion. Before Claude designs a page it can look at what the source shows at that point and how much
it puts on one screen; the screenshots are for looking at, never for showing in a video.

1. Download a video-only stream of at most 720p (mp4 first) into a temp folder (yt-dlp).
2. Pick the moments: FFmpeg's scene-change detection (a new shot) merged with a steady grid (one every
   15 s), no two closer than 4 s, at most 120 in all.
3. Take each frame as a JPEG 1280 wide and pair it with what is said around it (the transcript lines from
   4 s before to 6 s after, trimmed to about two sentences).

transcriber-data/frames/<jobId>/    next to backend, ignored by Git; TRANSCRIBER_DATA_DIR moves it.
  job.json        the source (title, link, length) and how the screenshots went (state, message)
  manifest.json   [{t, file, text}], one per screenshot, in time order
  frame-01m15s.jpg ...
Folders older than 14 days are deleted when the app starts.

Steps 2 and 3 run on any local video file (take_screenshots), so they are tested without the network.
Nothing here ever fails a transcript: run_for_job reports why there are no screenshots instead.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

import yt_dlp

import transcriber as tr

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("TRANSCRIBER_DATA_DIR") or (ROOT_DIR / "transcriber-data"))
FRAMES_DIR = DATA_DIR / "frames"

SCENE_THRESHOLD = 0.22  # FFmpeg's scene score (0 to 1) above which a frame starts a new shot (0.3 missed cuts between dark screens)
GRID_SECONDS = 15.0  # one screenshot at least this often, so a long shot is covered too
MIN_GAP_SECONDS = 4.0  # never two screenshots closer than this
MAX_SHOTS = 120
SETTLE_SECONDS = 0.5  # a new shot is taken this long after its cut, once a dissolve or wipe is over
FIRST_SECONDS = 1.0  # the opening shot is taken here: the very first frame is often black
END_MARGIN = 0.25  # nothing in the last quarter second (the last frame can be missing)
FRAME_SIZE = 1280  # JPEG 1280 wide (a portrait video: 1280 tall)
TEXT_BEFORE, TEXT_AFTER = 4.0, 6.0  # what is said from 4 s before a screenshot to 6 s after it
TEXT_SENTENCES, TEXT_MIN_WORDS, TEXT_MAX_WORDS = 2, 12, 40
MAX_VIDEO_BYTES = 1_500_000_000  # a bigger stream is not downloaded
KEEP_DAYS = 14
WORKERS = 4  # frames taken at once (each is its own short FFmpeg run)

# A job id (uuid hex, 12 characters) and a frame's file name: nothing else is ever read from disk.
_JOB_RE = re.compile(r"^[a-z0-9]{6,32}$")
FILE_RE = re.compile(r"^frame-\d{2,}m\d{2}s(?:-\d+)?\.jpg$")

# This part's progress: (percent or None, message)
Progress = Callable[[float | None, str], None]


def _noop(_pct: float | None, _msg: str) -> None:
    pass


class ShotsError(Exception):
    """Why no screenshots were taken, in one sentence for the page."""


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------


def clock(seconds: float) -> str:
    """75.6 -> "1:15", 3725 -> "1:02:05" (whole seconds, rounded down, like the page's times)."""
    s = max(0, int(seconds))
    h, m, sec = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def frame_name(t: float) -> str:
    """75.6 -> frame-01m15s.jpg (a 4 s spacing means no two screenshots share a second)."""
    s = max(0, int(t))
    return f"frame-{s // 60:02d}m{s % 60:02d}s.jpg"


def _read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def _write_json(path: Path, data) -> None:
    """Through a temporary file, so a reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def ffmpeg_exe() -> str | None:
    """The ffmpeg program, from the same place the transcriber finds it."""
    folder = tr.find_ffmpeg()
    if not folder:
        return None
    exe = Path(folder) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    return str(exe) if exe.exists() else None


def _last_line(text: str) -> str:
    lines = [ln.strip() for ln in text.replace("\r", "\n").splitlines() if ln.strip()]
    return lines[-1][:200] if lines else "no details"


# ---------------------------------------------------------------------------------------------
# Step 1: the video, without sound
# ---------------------------------------------------------------------------------------------

# Video only, 720p at most, mp4 (H.264 decodes fastest) first. A site with no separate video stream
# (a direct file, many social sites) gives its normal file instead. `<=?` lets a stream of unknown height in.
VIDEO_FORMAT = "/".join(
    [
        "bv[height<=?720][ext=mp4][vcodec^=avc]",
        "bv[height<=?720][ext=mp4]",
        "bv[height<=?720]",
        "b[height<=?720]",
        "bv",
        "b",
    ]
)


def download_video(url: str, folder: Path, progress: Callable[[float | None], None] | None = None) -> Path:
    """The video stream into folder/video.<ext>. Raises ShotsError with the site's reason."""

    def hook(d: dict) -> None:
        if progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            progress(min(100.0, done / total * 100) if total else None)

    opts = tr._ydl_opts(
        skip_download=False,
        format=VIDEO_FORMAT,
        outtmpl=str(folder / "video.%(ext)s"),
        progress_hooks=[hook],
        max_filesize=MAX_VIDEO_BYTES,
    )
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except yt_dlp.utils.DownloadError as err:
        raise ShotsError(f"The video could not be downloaded: {tr._friendly(err)}") from err
    files = [p for p in folder.iterdir() if p.name.startswith("video.") and not p.name.endswith((".part", ".ytdl"))]
    if not files:
        # yt-dlp skips a file over max_filesize without an error
        raise ShotsError(f"The video could not be downloaded (it may be larger than {MAX_VIDEO_BYTES // 1_000_000_000} GB at 720p).")
    return files[0]


# ---------------------------------------------------------------------------------------------
# Step 2: the moments
# ---------------------------------------------------------------------------------------------

_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
_PTS_RE = re.compile(r"pts_time:\s*(-?\d+(?:\.\d+)?)")
_TIME_RE = re.compile(r"\btime=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")


def probe_duration(video: Path, exe: str) -> float | None:
    """The video's length from FFmpeg's header read (no ffprobe needed), or None."""
    res = subprocess.run([exe, "-hide_banner", "-nostdin", "-i", str(video)], capture_output=True, text=True, errors="replace", timeout=120)
    m = _DURATION_RE.search(res.stderr)
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def scene_changes(
    video: Path,
    exe: str,
    duration: float | None = None,
    threshold: float = SCENE_THRESHOLD,
    progress: Callable[[float], None] | None = None,
) -> list[float]:
    """The times where a new shot starts: frames whose scene score is above threshold, as showinfo
    prints them. The picture is scaled to 320 wide first; the scores barely change and the scan, which
    decodes every frame, runs several times faster. FFmpeg's stats line (time=...) gives the progress."""
    vf = f"scale=320:-2,select='gt(scene,{threshold})',showinfo"
    cmd = [exe, "-hide_banner", "-nostdin", "-i", str(video), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", vf, "-f", "null", "-"]
    cuts: list[float] = []
    tail: list[str] = []
    buf = b""
    with subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as proc:  # closes the pipe and waits
        assert proc.stderr is not None
        while True:
            chunk = proc.stderr.read1(65536)  # whatever is there: the stats line comes with a \r, not a \n
            if not chunk:
                break
            buf += chunk
            *lines, buf = re.split(rb"[\r\n]", buf)
            for raw in lines:
                line = raw.decode("utf-8", errors="replace")
                if not line.strip():
                    continue
                if "showinfo" in line and "pts_time:" in line:
                    m = _PTS_RE.search(line)
                    if m:
                        cuts.append(float(m.group(1)))
                elif progress and duration and "time=" in line:
                    m = _TIME_RE.search(line)
                    if m:
                        at = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                        progress(min(100.0, at / duration * 100))
                tail = (tail + [line])[-4:]
    if proc.returncode != 0:
        raise ShotsError(f"FFmpeg could not read the video ({_last_line(chr(10).join(tail))}).")
    return sorted({round(c, 3) for c in cuts if c >= 0})


def pick_moments(
    cuts: list[float],
    duration: float,
    grid: float = GRID_SECONDS,
    min_gap: float = MIN_GAP_SECONDS,
    cap: int = MAX_SHOTS,
    settle: float = SETTLE_SECONDS,
    first: float = FIRST_SECONDS,
) -> list[float]:
    """When to take the screenshots, in seconds, in time order.

    - Every shot is a candidate: the opening shot at `first`, each cut `settle` seconds after it.
    - Shots closer than min_gap to one already taken are dropped, the longest shots chosen first, so a
      quick flash between two long shots gives way to them.
    - Then a steady grid (every `grid` seconds) fills the long stretches, again min_gap from the rest.
    - More than cap: an even pick across the list (first and last kept), so every part of the video stays.
    """
    end = duration - END_MARGIN
    if end <= 0:
        return []
    starts = [0.0] + [c for c in sorted(set(cuts)) if 0 < c < end]
    shots = []  # (moment, how long the shot lasts)
    for i, c in enumerate(starts):
        nxt = starts[i + 1] if i + 1 < len(starts) else duration
        t = min(first, end) if i == 0 else min(c + settle, end)
        shots.append((t, nxt - c))
    chosen: list[float] = []

    def free(t: float) -> bool:
        return all(abs(t - x) >= min_gap for x in chosen)

    for t, _length in sorted(shots, key=lambda s: (-s[1], s[0])):
        if free(t):
            chosen.append(t)
    if grid > 0:
        k = 1
        while k * grid <= end:
            if free(k * grid):
                chosen.append(k * grid)
            k += 1
    chosen.sort()
    if cap > 0 and len(chosen) > cap:
        n = len(chosen)
        chosen = [chosen[n // 2]] if cap == 1 else [chosen[round(i * (n - 1) / (cap - 1))] for i in range(cap)]
    return [round(t, 2) for t in chosen]


# ---------------------------------------------------------------------------------------------
# Step 3: the frames and what is said then
# ---------------------------------------------------------------------------------------------

_SOUND_TAG = re.compile(r"\[[^\]]{0,40}\]")  # [Music], [Applause]
_SENTENCE = re.compile(r"[.!?।]+[\"'”’)\]]*(?=\s|$)")  # . ! ? and the Hindi danda, with closing quotes


def _seg(seg) -> tuple[float, float, str]:
    """A transcript line as (start, end, text): a transcriber Segment or a {start, end, text} dict."""
    if isinstance(seg, dict):
        return float(seg.get("start", 0)), float(seg.get("end", 0)), str(seg.get("text", ""))
    return float(seg.start), float(seg.end), str(seg.text)


def text_around(
    segments,
    t: float,
    before: float = TEXT_BEFORE,
    after: float = TEXT_AFTER,
    sentences: int = TEXT_SENTENCES,
    max_words: int = TEXT_MAX_WORDS,
) -> str:
    """What is said around a screenshot at t: the transcript lines that overlap [t - before, t + after],
    joined, then trimmed to about two sentences, starting with the one being said at t.

    A line's words are spread evenly over its time, which tells which word is being said at t. Auto-captions
    have no full stops (the whole window is one "sentence"), so anything over max_words becomes a window of
    max_words words that starts a few words before t, marked with ... where it was cut."""
    words: list[tuple[str, float]] = []  # (word, its estimated time)
    for seg in segments:
        start, end, text = _seg(seg)
        if end <= t - before or start >= t + after:
            continue
        parts = re.sub(r"\s+", " ", _SOUND_TAG.sub(" ", text)).split()
        for i, w in enumerate(parts):
            words.append((w, start + (i + 0.5) / len(parts) * max(0.0, end - start)))
    if not words:
        return ""
    # the word being said at t (the last one when everything was said before it)
    k = next((i for i, (_w, wt) in enumerate(words) if wt >= t), len(words) - 1)

    def ends_sentence(i: int) -> bool:  # "came." or "out!" or 'said."' (not "3.5": the stop must end the word)
        return bool(_SENTENCE.search(words[i][0]))

    first = k  # back to the start of the sentence being said
    while first > 0 and not ends_sentence(first - 1):
        first -= 1
    # forward: that sentence, then the next ones until there are two (and enough words to say something)
    last, count = first, 0
    while last < len(words):
        stop = last
        while stop < len(words) - 1 and not ends_sentence(stop):
            stop += 1
        if count and stop + 1 - first > max_words:
            break
        last, count = stop + 1, count + 1
        if count >= sentences and last - first >= TEXT_MIN_WORDS:
            break
    if last - first <= max_words:
        return " ".join(w for w, _ in words[first:last])
    # too long for the cap (no full stops): max_words words from a few words before t
    lo = max(first, min(k - 4, len(words) - max_words))
    hi = min(len(words), lo + max_words)
    text = " ".join(w for w, _ in words[lo:hi]).rstrip(",;:")
    return ("..." if lo > first else "") + text + ("..." if hi < last else "")


def extract_frame(exe: str, video: Path, t: float, out: Path) -> bool:
    """One frame at t seconds as a JPEG 1280 wide (seeking before -i is fast and exact in today's FFmpeg)."""
    vf = f"scale={FRAME_SIZE}:{FRAME_SIZE}:force_original_aspect_ratio=decrease:force_divisible_by=2"
    cmd = [exe, "-hide_banner", "-nostdin", "-v", "error", "-ss", f"{t:.3f}", "-i", str(video), "-map", "0:v:0", "-frames:v", "1", "-vf", vf, "-q:v", "3", "-y", str(out)]
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        return False
    return res.returncode == 0 and out.exists() and out.stat().st_size > 0


def take_screenshots(
    video: Path,
    segments,
    out_dir: Path,
    *,
    duration: float | None = None,
    progress: Progress | None = None,
    grid: float = GRID_SECONDS,
    min_gap: float = MIN_GAP_SECONDS,
    cap: int = MAX_SHOTS,
    threshold: float = SCENE_THRESHOLD,
) -> list[dict]:
    """Steps 2 and 3 on a local video file: the JPEGs and manifest.json in out_dir. Returns the manifest,
    [{t, file, text}] in time order. `duration` is the fallback when FFmpeg can't tell the length."""
    progress = progress or _noop
    exe = ffmpeg_exe()
    if not exe:
        raise ShotsError("FFmpeg was not found, so no screenshots were taken.")
    length = probe_duration(video, exe) or duration
    if not length or length <= 0:
        raise ShotsError("Could not tell how long the video is.")
    progress(0, "Finding the scene changes")
    cuts = scene_changes(video, exe, length, threshold, lambda pct: progress(pct * 0.6, "Finding the scene changes"))
    moments = pick_moments(cuts, length, grid=grid, min_gap=min_gap, cap=cap)
    if not moments:
        raise ShotsError("The video is too short for screenshots.")
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("frame-*.jpg"):  # a second run starts clean
        old.unlink(missing_ok=True)
    names: list[str] = []
    for t in moments:
        name, n = frame_name(t), 2
        while name in names:  # only with a spacing under a second
            name = frame_name(t).replace(".jpg", f"-{n}.jpg")
            n += 1
        names.append(name)

    jobs = list(zip(moments, names))

    def one(job: tuple[float, str]) -> bool:
        return extract_frame(exe, video, job[0], out_dir / job[1])

    items: list[dict] = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        # map keeps the order, so the progress counts up and the manifest stays in time order
        for done, ((t, name), ok) in enumerate(zip(jobs, pool.map(one, jobs)), 1):
            progress(60 + 40 * done / len(moments), f"Taking screenshots ({done} of {len(moments)})")
            if ok:
                items.append({"t": t, "file": name, "text": text_around(segments, t)})
    _write_json(out_dir / "manifest.json", items)
    return items


# ---------------------------------------------------------------------------------------------
# A transcription job's screenshots
# ---------------------------------------------------------------------------------------------


def job_folder(job_id: str) -> Path | None:
    """The job's folder (whether or not it exists), or None for an id that isn't one."""
    return FRAMES_DIR / job_id if _JOB_RE.match(job_id or "") else None


def _clear(folder: Path) -> None:
    """Removes a failed run's frames, so a half-taken set is never served."""
    for f in folder.glob("frame-*.jpg"):
        f.unlink(missing_ok=True)
    (folder / "manifest.json").unlink(missing_ok=True)


def run_for_job(job_id: str, transcript: tr.Transcript, progress: Progress = _noop) -> dict:
    """The screenshots for a finished transcript: download, pick, take, pair. Never raises (the transcript
    is already done); returns {state: "done" | "none", message, count} and keeps the same in job.json."""
    folder = job_folder(job_id)
    if folder is None:
        return {"state": "none", "message": "Not a job id.", "count": 0}
    meta = {"title": transcript.title, "url": transcript.url, "duration": transcript.duration, "at": round(time.time(), 3)}
    _write_json(folder / "job.json", {**meta, "state": "running", "message": "Taking screenshots"})
    tmp = Path(tempfile.mkdtemp(prefix="vt-frames-"))
    downloading = "Downloading the video (720p at most, no sound)"
    try:
        progress(0, downloading)
        video = download_video(transcript.url, tmp, lambda pct: progress(None if pct is None else pct * 0.4, downloading))
        items = take_screenshots(
            video,
            transcript.segments,
            folder,
            duration=transcript.duration,
            progress=lambda pct, msg: progress(40 + 0.6 * (pct or 0), msg),
        )
        if not items:
            raise ShotsError("FFmpeg could not take any frames from the video.")
        state = {"state": "done", "message": f"{len(items)} screenshots", "count": len(items)}
    except ShotsError as err:
        _clear(folder)
        state = {"state": "none", "message": str(err), "count": 0}
    except Exception as err:  # noqa: BLE001 - the transcript is done; report anything else here
        _clear(folder)
        state = {"state": "none", "message": f"Something went wrong: {type(err).__name__}: {err}"[:300], "count": 0}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    _write_json(folder / "job.json", {**meta, **state})
    return state


def load(job_id: str) -> dict | None:
    """A job's screenshots from disk (they outlive the job in memory and a restart), or None.
    {folder, state, message, title, url, duration, items: [{t, file, text}]}; only frames on disk are listed."""
    folder = job_folder(job_id)
    if folder is None or not folder.is_dir():
        return None
    meta = _read_json(folder / "job.json", {}) or {}
    raw = _read_json(folder / "manifest.json", []) or []
    items = [
        {"t": float(it["t"]), "file": it["file"], "text": str(it.get("text") or "")}
        for it in raw
        if isinstance(it, dict) and isinstance(it.get("t"), (int, float)) and FILE_RE.match(str(it.get("file", ""))) and (folder / it["file"]).is_file()
    ]
    return {
        "folder": folder,
        "state": meta.get("state") or ("done" if items else "none"),
        "message": meta.get("message") or "",
        "title": meta.get("title") or "",
        "url": meta.get("url") or "",
        "duration": meta.get("duration"),
        "items": items,
    }


def frame_path(job_id: str, file: str) -> Path | None:
    """One frame's file, only when the name is a frame's and it exists."""
    folder = job_folder(job_id)
    if folder is None or not FILE_RE.match(file or ""):
        return None
    f = folder / file
    return f if f.is_file() else None


def references_markdown(found: dict) -> str:
    """REFERENCES.md for the zip: the source, then a table of time, file and what is said."""
    lines = ["# Screenshots of the source", ""]
    if found.get("title") or found.get("url"):
        lines += [f"Source: {found.get('title') or 'the video'}" + (f" ({found['url']})" if found.get("url") else ""), ""]
    lines += [
        f"{len(found['items'])} screenshots, at each new scene and at least every {int(GRID_SECONDS)} seconds, each with what is "
        f"said around it ({int(TEXT_BEFORE)} s before to {int(TEXT_AFTER)} s after). They are layout references: what the source "
        "shows at each point and how much it puts on one screen.",
        "",
        "| Time | File | What is said |",
        "|------|------|--------------|",
    ]
    for it in found["items"]:
        text = (it.get("text") or "").replace("|", "\\|") or "(no speech)"
        lines.append(f"| {clock(it['t'])} | {it['file']} | {text} |")
    return "\n".join(lines) + "\n"


def zip_bytes(found: dict) -> bytes:
    """All the JPEGs plus REFERENCES.md and references.json, in one zip (the JPEGs stored, not squeezed)."""
    refs = {
        "title": found.get("title") or "",
        "url": found.get("url") or "",
        "duration": found.get("duration"),
        "frames": [{"t": it["t"], "time": clock(it["t"]), "file": it["file"], "text": it.get("text") or ""} for it in found["items"]],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("REFERENCES.md", references_markdown(found))
        z.writestr("references.json", json.dumps(refs, ensure_ascii=False, indent=1))
        for it in found["items"]:
            z.write(found["folder"] / it["file"], it["file"], compress_type=zipfile.ZIP_STORED)
    return buf.getvalue()


def cleanup(days: float = KEEP_DAYS) -> int:
    """Deletes job folders untouched for `days` (run when the app starts). Returns how many went."""
    if not FRAMES_DIR.is_dir():
        return 0
    cutoff = time.time() - days * 86400
    gone = 0
    for d in FRAMES_DIR.iterdir():
        try:
            if d.is_dir() and _JOB_RE.match(d.name) and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
                gone += 1
        except OSError:
            continue
    return gone
