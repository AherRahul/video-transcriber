"""
Narration: what the voice says, when each <cue/> is spoken, and the ElevenLabs call that makes the audio.

The voice is the AlgoInsight YouTube voice: "Pooja" (fydPJq00SigRIaPxWgiS) on Eleven v4, read steadily
(stability 0.5, similarity 0.75, style 0, speaker boost) - the same settings as the daily films
(AlgoInsight server/src/services/tts.service.ts, V4_NARRATION_PERFORMANCE).

A scene's narration is written the way the captions should read, with <cue/> marks where the picture
should react. The spoken text is that narration with the project's pronunciation table applied (LLM ->
"L-L-M"). ElevenLabs' with-timestamps endpoint returns the start time of every character it spoke, so each
<cue/> lands on its exact word. Before the audio exists, the times are estimated at 2.9 words a second
(the voice runs about 16 percent faster than 2.5 words a second). The captions (SRT and VTT) are the written
narration timed the same way: each written word is found in the spoken text and takes its character's time.

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
# A place in Claude's draft for the user's own words: [[you: a time an interview went wrong because of
# this]]. Claude leaves one where only the user can say it (a story of their own, an opinion, a real number
# from their own runs) instead of making it up. The user replaces each with their words before the script
# is approved; the voice never reads one.
SLOT_RE = re.compile(r"\[\[\s*you\s*:\s*(.*?)\s*\]\]", re.IGNORECASE | re.DOTALL)


def slots(narration: str) -> list[str]:
    """What each place left for the user's own words asks for, in order."""
    return [m.group(1).strip() for m in SLOT_RE.finditer(narration or "")]


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
    """The daily films' voice rules: what in a narration would be read wrong or sound written. A place left
    for the user's own words ([[you: ...]]) is not narration yet, so it isn't checked."""
    narration = SLOT_RE.sub(" ", narration or "")
    text = CUE_RE.sub(" ", narration)
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


# ── captions: the written narration, timed by the voice ──
#
# Captions show what the narration says as it is WRITTEN (LLM, not L-L-M; no cue marks), but they are timed
# by what the voice SAID: each written word is found in the spoken text, and the voice's time for that
# character is when the word appears.

CAPTION_LINE = 42  # characters a caption line holds (the usual broadcast and YouTube width)
CAPTION_LINES = 2
CAPTION_MIN, CAPTION_MAX = 1.0, 7.0  # seconds a caption stays up
CAPTION_LINGER = 0.4  # a caption may stay this long after its last word, for reading, if nothing follows
_SENTENCE_END = re.compile(r"[.!?]['\")\]]*$")
_CLAUSE_END = re.compile(r"[,;:]['\")\]]*$")


def word_spans(words: list[str], table: list[dict], text: str) -> list[tuple[int, int]]:
    """Where each written word is said in the spoken `text`, as [start, end) character offsets.

    The pronunciation table is applied word by word ("LLM," becomes "L-L-M,"); when the words joined back
    together are exactly the spoken text, every word gets its own exact span. When they aren't (an entry of
    several words, or text changed some other way), the spans are spread in proportion to the written
    characters instead, which is never more than a word or two off."""
    said = [_apply(w, table) for w in words]
    if " ".join(said) == text:
        out, pos = [], 0
        for s in said:
            out.append((pos, pos + len(s)))
            pos += len(s) + 1
        return out
    written = max(1, len(" ".join(words)))
    k = len(text) / written
    out, pos = [], 0
    for w in words:
        a = min(len(text), int(pos * k))
        b = min(len(text), max(a + 1, int((pos + len(w)) * k)))
        out.append((a, b))
        pos += len(w) + 1
    return out


def timed_words(words: list[str], table: list[dict], text: str, speech: float, char_times: list[float] | None) -> list[tuple[str, float, float]]:
    """Each written word with the seconds into the speech at which it starts and ends.

    With the voice's character times a word starts at its first spoken character and ends where the next
    character (the space after it) starts. char_times None means there is no voice yet: the words are spread
    at the estimate's pace, 2.9 words a second. An empty list (a clip made without character times) spreads
    them over the clip's real length instead."""
    if not words:
        return []
    if char_times is None:
        return [(w, i / WORDS_PER_SECOND, (i + 1) / WORDS_PER_SECOND) for i, w in enumerate(words)]
    if not char_times:
        spans = word_spans(words, table, text)
        n = max(1, len(text))
        return [(w, speech * a / n, speech * b / n) for w, (a, b) in zip(words, spans)]
    spans = word_spans(words, table, text)
    n, length = len(char_times), max(1, len(text))

    def at(i: int) -> float:
        # one time per character of the spoken text; scaled if a clip's list is a different length
        j = i if n == length else int(i * n / length)
        return float(char_times[max(0, min(n - 1, j))])

    out, last = [], 0.0
    for w, (a, b) in zip(words, spans):
        start = max(last, min(at(a), speech))
        end = at(b) if b < length else min(speech, float(char_times[-1]) + 0.35)
        end = max(start + 0.05, min(end, speech))
        out.append((w, start, end))
        last = start
    return out


def caption_cues(words: list[tuple[str, float, float]]) -> list[dict]:
    """Caption cues for one passage of timed words: at most two lines of 42 characters and at most seven
    seconds each. A sentence's end closes a cue once it has been up a second; a cue that would overflow is
    broken at its last comma (when that leaves a real first part), else before the word that didn't fit."""
    cues: list[dict] = []
    cur: list[tuple[str, float, float]] = []

    def text_of(ws) -> str:
        return " ".join(w for w, _, _ in ws)

    def fits(ws) -> bool:
        if len(ws) == 1:
            return True  # one word always fits (a long web address gets a line of its own)
        return caption_lines(text_of(ws)) is not None and ws[-1][2] - ws[0][1] <= CAPTION_MAX

    def emit(ws) -> None:
        if ws:
            cues.append({"start": ws[0][1], "end": ws[-1][2], "text": text_of(ws)})

    for w in words:
        while cur and not fits(cur + [w]):
            k = max((i for i, x in enumerate(cur[:-1]) if _CLAUSE_END.search(x[0])), default=None)
            if k is not None and (len(text_of(cur[: k + 1])) >= 20 or cur[k][2] - cur[0][1] >= CAPTION_MIN):
                emit(cur[: k + 1])
                cur = cur[k + 1:]
            else:
                emit(cur)
                cur = []
        cur.append(w)
        if _SENTENCE_END.search(w[0]) and cur[-1][2] - cur[0][1] >= CAPTION_MIN:
            emit(cur)
            cur = []
    emit(cur)
    return cues


def caption_lines(text: str) -> list[str] | None:
    """The cue's text as one line, or two balanced lines, each at most 42 characters (None if it can't be)."""
    if len(text) <= CAPTION_LINE:
        return [text]
    best = None
    for i, ch in enumerate(text):
        if ch == " ":
            a, b = text[:i], text[i + 1:]
            if len(a) <= CAPTION_LINE and len(b) <= CAPTION_LINE and (best is None or max(len(a), len(b)) < max(len(best[0]), len(best[1]))):
                best = (a, b)
    return list(best) if best else None


def settle_cues(cues: list[dict], total: float) -> list[dict]:
    """Every cue up at least a second and at most seven (a short one stays longer for reading, never into
    the next cue or past the video's end), in order, never overlapping."""
    cues.sort(key=lambda c: c["start"])
    for i, c in enumerate(cues):
        nxt = cues[i + 1]["start"] if i + 1 < len(cues) else total
        end = max(c["end"] + CAPTION_LINGER, c["start"] + CAPTION_MIN)
        end = min(end, c["start"] + CAPTION_MAX, nxt - 0.04, total)
        c["end"] = round(max(end, c["start"] + 0.1), 3)
        c["start"] = round(c["start"], 3)
    return cues


def _clock(t: float, sep: str) -> str:
    ms = max(0, round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_srt(cues: list[dict]) -> str:
    """SubRip: numbered cues, 00:01:02,345 times."""
    blocks = []
    for i, c in enumerate(cues, 1):
        lines = caption_lines(c["text"]) or [c["text"]]
        blocks.append(f"{i}\n{_clock(c['start'], ',')} --> {_clock(c['end'], ',')}\n" + "\n".join(lines) + "\n")
    return "\n".join(blocks)


def to_vtt(cues: list[dict]) -> str:
    """WebVTT: the WEBVTT header, 00:01:02.345 times, and the text escaped (& and < mean markup there)."""
    blocks = ["WEBVTT\n"]
    for c in cues:
        lines = caption_lines(c["text"]) or [c["text"]]
        safe = [ln.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") for ln in lines]
        blocks.append(f"{_clock(c['start'], '.')} --> {_clock(c['end'], '.')}\n" + "\n".join(safe) + "\n")
    return "\n".join(blocks)


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
