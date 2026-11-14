"""
Narration: what the voice says, when each <cue/> is spoken, and the ElevenLabs call that makes the audio.

The voice is the AlgoInsight YouTube voice: "Pooja" (fydPJq00SigRIaPxWgiS) on Eleven v4, read steadily
(stability 0.5, similarity 0.75, style 0, speaker boost) - the same settings as the daily films
(AlgoInsight server/src/services/tts.service.ts, V4_NARRATION_PERFORMANCE).

A scene's narration is written the way the captions should read, with <cue/> marks where the picture
should react. The spoken text is that narration with the project's pronunciation table applied (LLM ->
"L-L-M"). ElevenLabs' with-timestamps endpoint returns the start time of every character it spoke, so each
<cue/> lands on its exact word. Before the audio exists, the times are estimated at 2.9 words a second
(the voice runs about 16 percent faster than 2.5 words a second).

Audio is only made when the user presses Generate voice: nothing here is called by Claude.
Clips are content-addressed (voice, model, settings and text), so an unchanged scene is never billed twice.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

VOICE = {
    "id": os.environ.get("MOTION_VOICE_ID") or "fydPJq00SigRIaPxWgiS",
    "name": os.environ.get("MOTION_VOICE_NAME") or "Pooja",
    "model": "eleven_v4",
    "settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0, "use_speaker_boost": True},
}
WORDS_PER_SECOND = 2.9
ELEVENLABS = "https://api.elevenlabs.io/v1/text-to-speech"
OUTPUT_FORMAT = "mp3_44100_128"
CUE_RE = re.compile(r"<\s*cue\s*/?\s*>", re.IGNORECASE)
TAG_RE = re.compile(r"<[^>]+>")


class VoiceError(Exception):
    pass


# ── the text ──


def _apply(text: str, table: list[dict]) -> str:
    """The pronunciation table, longest first, on whole words only (so "AI" doesn't touch "AIR")."""
    for entry in sorted(table, key=lambda e: -len(e.get("written", ""))):
        written, said = entry.get("written", ""), entry.get("spoken", "")
        if written and said and written != said:
            text = re.sub(r"(?<![\w-])" + re.escape(written) + r"(?![\w-])", said, text)
    return text


def spoken(narration: str, table: list[dict]) -> tuple[str, list[int]]:
    """(the text the voice is sent, where each <cue/> falls in it as a character offset)."""
    parts = CUE_RE.split(narration or "")
    text, offsets = "", []
    for i, part in enumerate(parts):
        seg = re.sub(r"\s+", " ", _apply(TAG_RE.sub(" ", part), table)).strip()
        if i > 0:
            offsets.append(len(text) + (1 if text and seg else 0))
        if seg:
            text = f"{text} {seg}" if text else seg
    return text, offsets


def caption_text(narration: str) -> str:
    """The narration as the captions and the script show it: no cue marks."""
    return re.sub(r"\s+", " ", TAG_RE.sub(" ", CUE_RE.sub(" ", narration or ""))).strip()


def words(text: str) -> int:
    return len([w for w in text.split() if re.search(r"\w", w)])


def estimate_seconds(text: str) -> float:
    return round(max(0.6, words(text) / WORDS_PER_SECOND), 2) if text.strip() else 0.0


def clip_hash(text: str, voice: dict | None = None) -> str:
    v = voice or VOICE
    key = json.dumps([v["id"], v["model"], v["settings"], text], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]


def count_cues(narration: str) -> int:
    return len(CUE_RE.findall(narration or ""))


NARRATION_RULES = [
    (re.compile(r"\d"), "digits (write numbers in words: thirty two)"),
    (re.compile(r"[—–]|\s-\s"), "dashes (use a comma or a full stop)"),
    (re.compile(r"[()\[\]{}]"), "brackets or parentheses"),
    (re.compile(r";"), "semicolons"),
    (re.compile(r"(?<![A-Z])/(?![A-Z])"), "slashes (only inside a short form like CI/CD)"),
    (re.compile(r"\bvs\.?\b", re.IGNORECASE), '"vs" (say "versus" or rephrase)'),
    (re.compile(r"[%&@#*_=+<>]"), "symbols like % & @ # (say them in words)"),
    (re.compile(r"[\"“”]"), "quotation marks"),
]


def check_narration(narration: str) -> list[str]:
    """The daily films' voice rules: what in a narration would be read wrong or sound written."""
    text = CUE_RE.sub(" ", narration or "")
    out = []
    for rx, what in NARRATION_RULES:
        if rx.search(text):
            out.append(f"Narration has {what}.")
    if re.search(r"\[[a-z ]+\]|<break", narration or "", re.IGNORECASE):
        out.append("Narration has audio tags or SSML; the voice reads plain text only.")
    return out


# ── times ──


def map_alignment(text: str, chars: list[str], starts: list[float]) -> list[float]:
    """A start time for every character of `text` from the characters ElevenLabs reports."""
    if "".join(chars) == text:
        return list(starts)
    times: list[float] = []
    j, last = 0, 0.0
    for ch in text:
        while j < len(chars) and chars[j] != ch and not ch.isspace():
            j += 1  # a character the service added (normalised punctuation, spacing)
        if j < len(chars) and chars[j] == ch:
            last = starts[j]
            j += 1
        times.append(last)
    return times


def cue_times(text: str, offsets: list[int], speech: float, char_times: list[float] | None) -> list[float]:
    """Seconds into the speech at which each cue's words begin (measured when there is audio)."""
    out = []
    n = max(1, len(text))
    for o in offsets:
        i = o
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            out.append(round(speech, 3))
        elif char_times and i < len(char_times):
            out.append(round(min(char_times[i], speech), 3))
        else:
            out.append(round(speech * i / n, 3))
    return out


# ── ElevenLabs ──


def api_key() -> str | None:
    return os.environ.get("ELEVENLABS_API_KEY") or None


def synthesize(text: str, voice: dict | None = None, timeout: float = 180) -> tuple[bytes, list[float]]:
    """(mp3 bytes, the start time of each character of `text`). Raises VoiceError with a readable reason."""
    key = api_key()
    if not key:
        raise VoiceError("No ElevenLabs key: put ELEVENLABS_API_KEY=... in backend\\.env, then restart the app.")
    v = voice or VOICE
    body = json.dumps({"text": text, "model_id": v["model"], "voice_settings": v["settings"]}).encode("utf-8")
    req = urllib.request.Request(
        f"{ELEVENLABS}/{v['id']}/with-timestamps?output_format={OUTPUT_FORMAT}",
        data=body,
        method="POST",
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - fixed https endpoint
            data = json.loads(res.read())
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")[:300]
        if err.code == 401:
            raise VoiceError("ElevenLabs rejected the key (401). Check ELEVENLABS_API_KEY in backend\\.env.") from err
        if err.code == 429:
            raise VoiceError("ElevenLabs is rate limiting or the quota is used up (429): " + detail) from err
        raise VoiceError(f"ElevenLabs error {err.code}: {detail}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise VoiceError(f"Could not reach ElevenLabs: {err}") from err
    audio = base64.b64decode(data.get("audio_base64") or "")
    if not audio:
        raise VoiceError("ElevenLabs returned no audio.")
    a = data.get("alignment") or {}
    chars, starts = a.get("characters") or [], a.get("character_start_times_seconds") or []
    return audio, (map_alignment(text, chars, starts) if chars and starts else [])


def probe_seconds(path: Path, ffmpeg_dir: str | None) -> float | None:
    if not ffmpeg_dir:
        return None
    exe = Path(ffmpeg_dir) / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    try:
        out = subprocess.run([str(exe), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, timeout=30)
        return round(float(out.stdout.strip()), 3)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def save_clip(folder: Path, h: str, text: str, audio: bytes, char_times: list[float], ffmpeg_dir: str | None) -> dict:
    folder.mkdir(parents=True, exist_ok=True)
    mp3 = folder / f"{h}.mp3"
    mp3.write_bytes(audio)
    seconds = probe_seconds(mp3, ffmpeg_dir) or (max(char_times) + 0.3 if char_times else estimate_seconds(text))
    meta = {"hash": h, "text": text, "seconds": round(seconds, 3), "charTimes": [round(t, 3) for t in char_times]}
    (folder / f"{h}.json").write_text(json.dumps(meta), encoding="utf-8")
    return meta


def load_clip(folder: Path, h: str) -> dict | None:
    f = folder / f"{h}.json"
    if not f.exists() or not (folder / f"{h}.mp3").exists():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except ValueError:
        return None


# ── the whole narration as one track ──


_FILTER_FLAG: dict[str, list[str]] = {}


def filter_file_args(ffmpeg_exe: str, script: Path) -> list[str]:
    """How this FFmpeg reads a filter graph from a file: -/filter_complex (7.0 and later; 8 and 9 dropped the
    old flag) or -filter_complex_script (older). A file keeps long graphs under Windows' command-line limit."""
    if ffmpeg_exe not in _FILTER_FLAG:
        try:
            out = subprocess.run([ffmpeg_exe, "-hide_banner", "-version"], capture_output=True, text=True, timeout=20).stdout
            m = re.search(r"ffmpeg version n?(\d+)", out)
            major = int(m.group(1)) if m else 7
        except (OSError, subprocess.SubprocessError, ValueError):
            major = 7
        _FILTER_FLAG[ffmpeg_exe] = ["-/filter_complex"] if major >= 7 else ["-filter_complex_script"]
    return _FILTER_FLAG[ffmpeg_exe] + [str(script)]


def build_track(out: Path, clips: list[tuple[float, Path]], total: float, ffmpeg_dir: str) -> None:
    """One audio file as long as the video, each clip placed at its start time (seconds), silence between."""
    exe = str(Path(ffmpeg_dir) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
    out.parent.mkdir(parents=True, exist_ok=True)
    work = out.with_suffix(".part" + out.suffix)
    if not clips:
        cmd = [exe, "-v", "error", "-y", "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=mono", "-t", f"{total:.3f}", "-c:a", "aac", "-b:a", "160k", str(work)]
    else:
        script = out.with_suffix(".filter.txt")
        lines, labels = [], []
        for k, (start, _) in enumerate(clips):
            ms = max(0, round(start * 1000))
            lines.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=mono,adelay={ms}|{ms}[a{k}];")
            labels.append(f"[a{k}]")
        lines.append("".join(labels) + f"amix=inputs={len(clips)}:normalize=0:dropout_transition=0,apad=whole_dur={total:.3f},atrim=0:{total:.3f}[out]")
        script.write_text("\n".join(lines), encoding="utf-8")
        cmd = [exe, "-v", "error", "-y"]
        for _, path in clips:
            cmd += ["-i", str(path)]
        cmd += [*filter_file_args(exe, script), "-map", "[out]", "-c:a", "aac", "-b:a", "160k", str(work)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if res.returncode != 0:
            raise VoiceError("FFmpeg could not build the narration track: " + res.stderr[-400:])
        os.replace(work, out)
    finally:
        work.unlink(missing_ok=True)
        out.with_suffix(".filter.txt").unlink(missing_ok=True)
