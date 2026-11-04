"""
Turns a video URL into a transcript.

1. Ask yt-dlp about the video (title, length, captions). No download yet.
2. If the video has captions, use them: fast, free, and human-written ones are the most accurate.
3. Otherwise download only the audio and run Whisper on this machine (faster-whisper, CPU).

Nothing here bypasses logins, DRM or bot checks: such videos fail with a clear message.
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import urljoin

import yt_dlp

# ---------------------------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------------------------


@dataclass
class Segment:
    start: float  # seconds
    end: float
    text: str


@dataclass
class Transcript:
    title: str
    url: str
    duration: float | None
    language: str | None
    source: str  # "captions" | "auto-captions" | "whisper"
    segments: list[Segment] = field(default_factory=list)


class TranscriptError(Exception):
    """A failure we can explain to the user in one sentence."""


# Progress callback: (stage, percent or None, message)
Progress = Callable[[str, float | None, str], None]


def _noop(_stage: str, _pct: float | None, _msg: str) -> None:
    pass


# ---------------------------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------------------------


def find_ffmpeg() -> str | None:
    """FFmpeg's folder: FFMPEG_LOCATION, then PATH, then the winget install."""
    env = os.environ.get("FFMPEG_LOCATION")
    if env and Path(env).exists():
        return env
    on_path = shutil.which("ffmpeg")
    if on_path:
        return str(Path(on_path).parent)
    winget = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    if winget.exists():
        for exe in winget.glob("Gyan.FFmpeg*/*/bin/ffmpeg.exe"):
            return str(exe.parent)
    return None


def _ydl_opts(**extra) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "skip_download": True,
    }
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg
    opts.update(extra)
    return opts


_FRIENDLY_ERRORS = [
    (r"Sign in to confirm|not a bot", "The site asked for a sign-in to prove this is not a bot, so this video can't be fetched."),
    (r"logged-in|--cookies|login required|requires authentication", "This site only lets signed-in users download this video, so it can't be fetched."),
    (r"age-restricted|confirm your age|inappropriate for some users", "This video is age-restricted and needs a sign-in."),
    (r"Private video|video is private", "This video is private."),
    (r"members-only|Join this channel", "This video is for channel members only."),
    (r"DRM", "This video is DRM-protected, so it can't be transcribed."),
    (r"Unsupported URL", "This URL is not a video page we can read."),
    (r"Video unavailable|This video is unavailable|HTTP Error 404", "This video is unavailable."),
    (r"getaddrinfo|Name or service not known|timed out|Connection (refused|reset|aborted)", "Could not reach the site. Check the URL and the network."),
]


def _friendly(err: Exception) -> TranscriptError:
    text = re.sub(r"\x1b\[[0-9;]*m", "", str(err))
    for pattern, message in _FRIENDLY_ERRORS:
        if re.search(pattern, text, re.IGNORECASE):
            return TranscriptError(message)
    return TranscriptError(text.replace("ERROR: ", "").strip()[:300] or "The video could not be read.")


# ---------------------------------------------------------------------------------------------
# Step 1: video info
# ---------------------------------------------------------------------------------------------


def fetch_info(url: str) -> dict:
    try:
        with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as err:
        raise _friendly(err) from err
    if not info:
        raise TranscriptError("The video could not be read.")
    if info.get("_type") == "playlist":
        entries = [e for e in info.get("entries") or [] if e]
        if not entries:
            raise TranscriptError("This is a playlist with no videos we can read.")
        info = entries[0]
    return info


# ---------------------------------------------------------------------------------------------
# Step 2: captions
# ---------------------------------------------------------------------------------------------

# Formats we can read, best first. json3 is YouTube's own and has no rolling duplicates.
_CAPTION_EXTS = ["json3", "vtt", "srv3", "srt"]


def _base_lang(code: str) -> str:
    return code.split("-")[0].lower()


def _pick_track(tracks: dict, wanted: str | None, video_lang: str | None) -> tuple[str, dict] | None:
    """The best caption track: the wanted language, else the video's own, else English, else any."""
    if not tracks:
        return None
    codes = [c for c in tracks if c != "live_chat"]
    if not codes:
        return None

    def first(match: Callable[[str], bool]) -> str | None:
        return next((c for c in codes if match(c)), None)

    choice = None
    for lang in [wanted, video_lang, "en"]:
        if not lang:
            continue
        base = _base_lang(lang)
        # Prefer "en-orig" (the original-language auto track), then exact, then same base.
        choice = (
            first(lambda c: c == f"{base}-orig")
            or first(lambda c: c.lower() == lang.lower())
            or first(lambda c: _base_lang(c) == base)
        )
        if choice:
            break
    choice = choice or codes[0]

    formats = tracks[choice] or []
    for ext in _CAPTION_EXTS:
        fmt = next((f for f in formats if f.get("ext") == ext and f.get("url")), None)
        if fmt:
            return choice, fmt
    return None


def _ts(value: str) -> float:
    """'00:01:02.500', '01:02.500' or '00:01:02,500' → seconds."""
    value = value.strip().replace(",", ".")
    parts = value.split(":")
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return seconds


_TAG = re.compile(r"<[^>]+>")


def _clean(text: str) -> str:
    text = _TAG.sub("", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def parse_json3(raw: str) -> list[Segment]:
    data = json.loads(raw)
    out: list[Segment] = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        text = _clean("".join(s.get("utf8", "") for s in segs))
        if not text:
            continue
        start = ev.get("tStartMs", 0) / 1000
        end = start + ev.get("dDurationMs", 0) / 1000
        out.append(Segment(start, end, text))
    return out


_CUE = re.compile(
    r"(?P<start>(?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*(?P<end>(?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})[^\n]*\n(?P<text>.*?)(?=\n\s*\n|\Z)",
    re.DOTALL,
)


def parse_vtt_or_srt(raw: str) -> list[Segment]:
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    out: list[Segment] = []
    for m in _CUE.finditer(raw):
        lines = [_clean(line) for line in m.group("text").split("\n")]
        lines = [line for line in lines if line]
        if not lines:
            continue
        out.append(Segment(_ts(m.group("start")), _ts(m.group("end")), " ".join(lines)))
    return _drop_rolling_repeats(out)


def _drop_rolling_repeats(segments: list[Segment]) -> list[Segment]:
    """Auto-captions in VTT repeat the previous line in the next cue; keep only the new words."""
    out: list[Segment] = []
    for seg in segments:
        if out:
            prev = out[-1].text
            if seg.text == prev:
                out[-1].end = max(out[-1].end, seg.end)
                continue
            if seg.text.startswith(prev):
                seg = Segment(seg.start, seg.end, seg.text[len(prev):].strip())
                if not seg.text:
                    continue
        out.append(seg)
    return out


def fetch_captions(info: dict, wanted_lang: str | None) -> tuple[str, str, list[Segment]] | None:
    """(source, language, segments) from the video's captions, or None when it has none."""
    video_lang = info.get("language")
    for source, tracks in (("captions", info.get("subtitles")), ("auto-captions", info.get("automatic_captions"))):
        picked = _pick_track(tracks or {}, wanted_lang, video_lang)
        if not picked:
            continue
        lang, fmt = picked
        try:
            segments = _download_track(fmt)
        except Exception:  # noqa: BLE001 - a caption we can't fetch: try the next one, then Whisper
            continue
        if segments:
            return source, lang, segments
    return None


def _download_track(fmt: dict) -> list[Segment]:
    """One caption track. Some come as an HLS playlist of caption files: fetch and join them."""
    with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:

        def get(url: str) -> str:
            return ydl.urlopen(url).read().decode("utf-8", errors="replace")

        raw = get(fmt["url"])
        if not raw.lstrip().startswith("#EXTM3U"):
            return parse_json3(raw) if fmt.get("ext") == "json3" else parse_vtt_or_srt(raw)
        parts = [line.strip() for line in raw.splitlines() if line.strip() and not line.startswith("#")]
        segments: list[Segment] = []
        for part in parts[:500]:
            segments.extend(parse_vtt_or_srt(get(urljoin(fmt["url"], part))))
        return _drop_rolling_repeats(segments)


# ---------------------------------------------------------------------------------------------
# Step 3: audio + Whisper
# ---------------------------------------------------------------------------------------------

_models: dict[str, object] = {}

WHISPER_MODELS = ["tiny", "base", "small", "medium"]
DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "small")


def _whisper(model_name: str):
    from faster_whisper import WhisperModel  # imported late: slow to load, not needed for captions

    if model_name not in _models:
        _models[model_name] = WhisperModel(model_name, device="cpu", compute_type="int8")
    return _models[model_name]


def download_audio(url: str, folder: Path, progress: Progress) -> Path:
    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            pct = (done / total * 100) if total else None
            progress("downloading", pct, "Downloading the audio")

    opts = _ydl_opts(
        skip_download=False,
        format="bestaudio/best",
        outtmpl=str(folder / "audio.%(ext)s"),
        progress_hooks=[hook],
    )
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except yt_dlp.utils.DownloadError as err:
        raise _friendly(err) from err
    files = [p for p in folder.iterdir() if p.name.startswith("audio.") and not p.name.endswith(".part")]
    if not files:
        raise TranscriptError("The audio could not be downloaded.")
    return files[0]


SAMPLE_RATE = 16_000


def decode_audio(audio: Path):
    """16 kHz mono float32 samples, decoded by FFmpeg.

    faster-whisper's own decoder (PyAV) breaks with PyAV 19 ("unexpected keyword argument
    'metadata_errors'"), and FFmpeg is needed anyway, so FFmpeg does the decoding.
    """
    import subprocess

    import numpy as np

    folder = find_ffmpeg()
    if not folder:
        return str(audio)  # no FFmpeg: let faster-whisper try its own decoder
    exe = str(Path(folder) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
    cmd = [exe, "-nostdin", "-v", "error", "-i", str(audio), "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", errors="replace").strip().splitlines()[-1:] or ["no audio"]
        raise TranscriptError(f"The audio could not be decoded ({detail[0][:200]}).")
    return np.frombuffer(proc.stdout, np.int16).astype(np.float32) / 32768.0


def run_whisper(audio: Path, model_name: str, wanted_lang: str | None, progress: Progress) -> tuple[str, list[Segment]]:
    progress("loading-model", None, f"Loading the speech model ({model_name})")
    model = _whisper(model_name)
    progress("decoding", None, "Preparing the audio")
    samples = decode_audio(audio)
    progress("transcribing", 0, "Turning speech into text")
    segments_iter, info = model.transcribe(
        samples,
        language=_base_lang(wanted_lang) if wanted_lang else None,
        vad_filter=True,  # skip silence: faster, and fewer invented words
        beam_size=5,
    )
    total = info.duration or 0
    out: list[Segment] = []
    for seg in segments_iter:
        text = seg.text.strip()
        if text:
            out.append(Segment(seg.start, seg.end, text))
        if total:
            progress("transcribing", min(99.0, seg.end / total * 100), "Turning speech into text")
    return info.language, out


# ---------------------------------------------------------------------------------------------
# Whole pipeline
# ---------------------------------------------------------------------------------------------


def transcribe_url(
    url: str,
    *,
    language: str | None = None,
    model: str = DEFAULT_MODEL,
    force_whisper: bool = False,
    progress: Progress = _noop,
) -> Transcript:
    url = url.strip()
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise TranscriptError("Enter a full video URL, starting with http:// or https://.")
    if model not in WHISPER_MODELS:
        raise TranscriptError(f"Unknown speech model: {model}.")

    progress("info", None, "Reading the video")
    info = fetch_info(url)
    title = info.get("title") or url
    duration = info.get("duration")
    page_url = info.get("webpage_url") or url

    if info.get("is_live"):
        raise TranscriptError("This is a live stream. Try again once it has ended.")

    if not force_whisper:
        progress("captions", None, "Looking for captions")
        found = fetch_captions(info, language)
        if found:
            source, lang, segments = found
            return Transcript(title, page_url, duration, lang, source, segments)

    folder = Path(tempfile.mkdtemp(prefix="vt-"))
    try:
        audio = download_audio(page_url, folder, progress)
        lang, segments = run_whisper(audio, model, language, progress)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    if not segments:
        raise TranscriptError("No speech was found in this video.")
    return Transcript(title, page_url, duration, lang, "whisper", segments)


# ---------------------------------------------------------------------------------------------
# Output formats
# ---------------------------------------------------------------------------------------------


def _clock(seconds: float, sep: str) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


def to_txt(t: Transcript, timestamps: bool = True) -> str:
    if not timestamps:
        return " ".join(s.text for s in t.segments) + "\n"
    return "\n".join(f"[{_clock(s.start, '.')[:-4]}] {s.text}" for s in t.segments) + "\n"


def to_srt(t: Transcript) -> str:
    blocks = [
        f"{i}\n{_clock(s.start, ',')} --> {_clock(s.end, ',')}\n{s.text}\n" for i, s in enumerate(t.segments, 1)
    ]
    return "\n".join(blocks)


def to_vtt(t: Transcript) -> str:
    cues = [f"{_clock(s.start, '.')} --> {_clock(s.end, '.')}\n{s.text}\n" for s in t.segments]
    return "WEBVTT\n\n" + "\n".join(cues)
