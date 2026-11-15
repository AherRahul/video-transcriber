"""
Motion projects on disk. Plain JSON and HTML files, so a project can be read, copied or backed up by hand.

motion-data/
  brand-kits/<kitId>/kit.json, <logo file>
  projects/<projectId>/
    project.json          title, aspect, brand kit, settings, version, the ordered scene list
    scenes/<sceneId>.html one self-contained scene (markup + <style> + <script>)
    thumbnail.html        the YouTube thumbnail: one still in the same file format as a scene (its rev and
                          props are project.json's `thumbnail`)
    assets/<name>         uploads (images, audio, documents) referenced as asset://<name>
    chat.json             the conversation with Claude (API messages, a pending style question, totals)
    log.json              what the chat panel shows
    history/<n>/          snapshots taken before each change, for Undo
    renders/              exported MP4s with their captions (.srt, .vtt), the per-scene cache, library
                          posters and the rendered thumbnail (thumbnail-<hash>.jpg)
    voice/<hash>.mp3|json narration clips (content-addressed) with the time of every character
    docs/<name>.md        documents Claude writes for the user (facts, the YouTube details, notes)
    source.json           the timed reference transcript the video is built from: its lines are the points
                          the video must cover (each scene's `covers` names the source times it teaches)

Every write bumps the project's `version`. Each scene also has its own `rev`, so a direct edit made from
the page is refused (409) when the scene changed underneath it.

A narrated scene's length comes from its narration: a short lead-in (the page change), the speech, a short
tail and any hold. Before the voice exists the speech is estimated; after Generate voice it is the clip's
real length, and every <cue/> moves to its spoken word. The captions follow the same clock.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import struct
import threading
import time
import uuid
from collections import defaultdict
from html import escape as html_escape
from html.parser import HTMLParser
from pathlib import Path

from . import voice as vc

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.environ.get("MOTION_DATA_DIR") or (ROOT_DIR / "motion-data"))
SEED_DIR = Path(__file__).resolve().parent / "seed"

# The stage is the scene's coordinate system in CSS pixels; the export renders it 1:1 at 1080p.
ASPECTS: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
}
DEFAULT_ASPECT = "9:16"
FPS = 30
# tear and turn are the paper look's page changes: a new part tears the page away, the next page turns over
TRANSITIONS = ("cut", "fade", "slide-up", "slide-left", "zoom", "wipe", "tear", "turn")
SCENE_KINDS = ("scene", "endscreen", "promo")
# Where a video goes, and what that allows. A Udemy film shows no website, URL, price or platform of ours
# (the film style guide), so the logo card, the web address, the promo and the end screen are all off.
DESTINATIONS = ("youtube", "udemy")
CLOSING_KEYS = ("logo", "url", "promo", "endscreen")
CLOSING_KINDS = ("promo", "endscreen")  # scenes the video's settings add at the end, never Claude
PROMO_DIR = Path(__file__).resolve().parent / "seed" / "promo"
THEMES = ("plain", "paper")
PAPER_STAGE = (1600, 900)  # the daily films' design units (16:9), exported at 1080p or 4K
MOTION_STYLES = ("snappy", "smooth")
MAX_SCENES = 120
MAX_TOTAL_SECONDS = 45 * 60.0
LEAD_SECONDS = 0.75  # the page change, before the voice starts
LEAD_CUT_SECONDS = 0.3
TAIL_SECONDS = 0.6  # a breath after the last word
MAX_SCENE_BYTES = 200_000
MAX_ASSET_BYTES = 60 * 1024 * 1024
MAX_SNAPSHOTS = 40
THUMBNAIL_FILE = "thumbnail.html"
THUMBNAIL_WORDS = 5  # a YouTube thumbnail reads at a glance: three to five very large words
# A video made from a timed source runs at least 10 and at most 30 minutes (the founder's rule for the daily
# films), and lands between 90 percent and 150 percent of its target: explaining simply takes a little longer.
SOURCE_MIN_SECONDS = 10 * 60.0
SOURCE_MAX_SECONDS = 30 * 60.0
LENGTH_LOW, LENGTH_HIGH = 0.9, 1.5
COPY_RUN_WORDS = 8  # this many of the source's words in a row, in the same order, is copying
PALETTE_ROLES = ("bg", "surface", "ink", "muted", "accent", "accent2")

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
HOLE_RE = re.compile(r"\{\{\s*([\w.-]+)\s*\}\}")
ASSET_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",  # images
    ".mp3", ".wav", ".m4a", ".aac", ".ogg",  # audio
    ".pdf", ".txt", ".md", ".csv", ".json", ".srt", ".vtt",  # documents
    ".woff", ".woff2", ".ttf", ".otf",  # fonts
}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg"}


class StoreError(Exception):
    """A request the store refuses. `status` is the HTTP status the API answers with."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ── small helpers ──────────────────────────────────────────────────────────────


def now() -> float:
    return round(time.time(), 3)


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:10]


def slugify(text: str, fallback: str = "video") -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:48] or fallback


def _windows_retry(action, tries: int = 40):
    """Windows refuses to replace or open a file that another reader holds open for a moment (a request
    reading the same file, a virus scanner, the search indexer): WinError 5 or 32, a PermissionError.
    Wait a little and try again (up to about 6 seconds) instead of failing Claude's whole turn."""
    for attempt in range(tries):
        try:
            return action()
        except PermissionError:
            if os.name != "nt" or attempt == tries - 1:
                raise
            time.sleep(0.02 + 0.01 * attempt)


def read_json(path: Path, default=None):
    try:
        return json.loads(_windows_retry(lambda: path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return default


def write_json(path: Path, data) -> None:
    """Write through a temporary file, so a crash never leaves half a JSON file behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    body = json.dumps(data, ensure_ascii=False, indent=1)
    _windows_retry(lambda: tmp.write_text(body, encoding="utf-8"))
    _windows_retry(lambda: os.replace(tmp, path))


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    _windows_retry(lambda: tmp.write_text(text, encoding="utf-8", newline="\n"))
    _windows_retry(lambda: os.replace(tmp, path))


# ── the reference source: its timed lines, what each scene covers, copying ─────

_CLOCK = r"(?:\d{1,2}:)?\d{1,3}:\d{2}"
_SRC_LINE_RE = re.compile(r"^[\[(]?\s*(" + _CLOCK + r")(?:[.,]\d{1,3})?\s*[\])]?\s*[-:]?\s*(.*)$")
_SRC_CUE_RE = re.compile(r"^(" + _CLOCK + r")(?:[.,]\d{1,3})?\s*-->")
_COVER_RE = re.compile(r"^\s*(" + _CLOCK + r")\s*(?:(?:-|to)\s*(" + _CLOCK + r"))?\s*$")
_WORD_RE = re.compile(r"[a-z0-9']+")


def clock_seconds(text: str) -> float:
    """'1:40' -> 100, '1:02:03' -> 3723."""
    parts = [int(x) for x in text.strip().split(":")]
    if parts[-1] >= 60 or (len(parts) == 3 and parts[1] >= 60):
        raise ValueError(text)
    return float(parts[-1] + 60 * parts[-2] + (3600 * parts[0] if len(parts) == 3 else 0))


def parse_source(text: str) -> list[dict]:
    """The timed lines of a transcript ([m:ss] text, m:ss text, or SRT/VTT cues), as [{t, text}].
    An untimed line joins the line before it (a caption that wrapped); lines before the first time (a
    title, a link) are left out."""
    lines: list[dict] = []
    cue_at = None  # an SRT/VTT cue's start, waiting for its text
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            cue_at = None
            continue
        m = _SRC_CUE_RE.match(line)
        if m:
            try:
                cue_at = clock_seconds(m.group(1))
            except ValueError:
                cue_at = None
            continue
        if cue_at is not None:
            if cue_at >= 0:
                lines.append({"t": cue_at, "text": line})
                cue_at = -1.0  # the cue's next lines join this one
            elif lines:
                lines[-1]["text"] = lines[-1]["text"] + " " + line
            continue
        m = _SRC_LINE_RE.match(line)
        if m and m.group(2).strip():
            try:
                lines.append({"t": clock_seconds(m.group(1)), "text": m.group(2).strip()})
                continue
            except ValueError:
                pass
        if line.isdigit():
            continue  # an SRT cue number
        if lines:
            lines[-1]["text"] = (lines[-1]["text"] + " " + line).strip()
    for ln in lines:
        ln["text"] = ln["text"][:400]
    return lines


def parse_cover(item) -> tuple[float, float]:
    """One `covers` entry: a source time ('1:48') or range ('1:40-2:17'), as (start, end) seconds."""
    m = _COVER_RE.match(str(item))
    try:
        if not m:
            raise ValueError(item)
        a = clock_seconds(m.group(1))
        b = clock_seconds(m.group(2)) if m.group(2) else a
    except ValueError:
        raise StoreError(f"covers entry {item!r} must be a source time like 1:48 or a range like 1:40-2:17.") from None
    return (a, b) if a <= b else (b, a)


def clean_covers(raw) -> list[str]:
    if isinstance(raw, str):
        raw = [x for x in re.split(r"[,;]", raw) if x.strip()]
    if not isinstance(raw, list):
        raise StoreError("covers must be a list of source times or ranges, like ['1:40-2:17', '2:30'].")
    out = []
    for item in raw[:200]:
        a, b = parse_cover(item)
        out.append(fmt_clock(a) if a == b else f"{fmt_clock(a)}-{fmt_clock(b)}")
    return out


def clean_skips(raw) -> list[dict]:
    """Source lines left out on purpose (a greeting, an ad, a plug for their channel), each with why."""
    if not isinstance(raw, list):
        raise StoreError("sourceSkips must be a list of {range, reason}.")
    out = []
    for item in raw[:100]:
        if not isinstance(item, dict) or not str(item.get("reason") or "").strip():
            raise StoreError("Each sourceSkips entry needs a range (like 9:59-10:08) and a reason (why the video leaves it out).")
        a, b = parse_cover(item.get("range"))
        out.append({"range": fmt_clock(a) if a == b else f"{fmt_clock(a)}-{fmt_clock(b)}", "reason": str(item["reason"]).strip()[:200]})
    return out


def coverage(lines: list[dict], scenes: list[dict], skips: list[dict]) -> dict:
    """Which source lines a scene covers (its `covers` ranges hold the line's time), which are skipped on
    purpose, and which nothing covers yet."""
    spans = [(a, b, s["id"]) for s in scenes for a, b in (parse_cover(c) for c in s.get("covers") or [])]
    skip_spans = [parse_cover(k["range"]) for k in skips]
    covered = skipped = 0
    missing, by_line = [], []
    for ln in lines:
        who = [sid for a, b, sid in spans if a <= ln["t"] <= b]
        if who:
            covered += 1
            by_line.append(who)
        elif any(a <= ln["t"] <= b for a, b in skip_spans):
            skipped += 1
            by_line.append(["skipped"])
        else:
            missing.append(ln)
            by_line.append([])
    return {"total": len(lines), "covered": covered, "skipped": skipped, "missing": missing, "byLine": by_line}


def _words_of(text: str) -> list[str]:
    return _WORD_RE.findall(vc.CUE_RE.sub(" ", text).lower().replace("’", "'"))


def source_grams(lines: list[dict], n: int = COPY_RUN_WORDS) -> set[tuple]:
    words = _words_of(" ".join(ln["text"] for ln in lines))
    return {tuple(words[i:i + n]) for i in range(len(words) - n + 1)}


def copied_phrases(narration: str, grams: set[tuple], n: int = COPY_RUN_WORDS) -> list[str]:
    """Runs of n or more words that appear in the source in the same order: the narration is copying it."""
    words = _words_of(narration)
    phrases, start, end = [], None, None
    for i in range(len(words) - n + 1):
        if tuple(words[i:i + n]) not in grams:
            continue
        if start is not None and i <= end:
            end = i + n
        else:
            if start is not None:
                phrases.append(" ".join(words[start:end]))
            start, end = i, i + n
    if start is not None:
        phrases.append(" ".join(words[start:end]))
    return phrases


# ── references: screenshots of the source, for looking at (never for showing) ──

MAX_REFERENCES = 120
REF_ASSET_RE = re.compile(r"\bref-\d{2,}m\d{2}s(?:-\d+)?\.jpg\b")


def ref_clock(seconds: float) -> str:
    """A reference's time, rounded down like its asset name: 75.6 -> 1:15 (ref-01m15s.jpg)."""
    s = max(0, int(seconds))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def ref_asset_name(seconds: float) -> str:
    """75.6 -> ref-01m15s.jpg."""
    s = max(0, int(seconds))
    return f"ref-{s // 60:02d}m{s % 60:02d}s.jpg"


def references_markdown(refs: list[dict], title: str | None = None, url: str | None = None) -> str:
    """docs/REFERENCES.md: what the screenshots are for, then a table of time, asset and what is said."""
    lines = ["# References: screenshots of the source", ""]
    if title or url:
        lines += [f"Source: {title or 'the video'}" + (f" ({url})" if url else ""), ""]
    lines += [
        f"{len(refs)} screenshots of the source video, each with what is said around it. They are for looking at, "
        "not for showing: what the source puts on screen at each point and how much fits on one screen. Every page "
        "is designed in our own paper look, and never copies their layout, words, brand, logos, characters, numbers "
        "or images. Claude sees them with view_references.",
        "",
        "| Time | Asset | What is said |",
        "|------|-------|--------------|",
    ]
    for r in refs:
        text = (r.get("text") or "").replace("|", "\\|") or "(no speech)"
        lines.append(f"| {ref_clock(r['t'])} | {r['asset']} | {text} |")
    return "\n".join(lines) + "\n"


def promo_template() -> dict:
    """The AlgoInsight promo (seed/promo/promo.json and its scene files)."""
    return json.loads((PROMO_DIR / "promo.json").read_text(encoding="utf-8"))


def destination_of(p: dict) -> str:
    return p.get("destination") if p.get("destination") in DESTINATIONS else "youtube"


def closing_of(p: dict) -> dict:
    """What the video adds around its own scenes. A project from before these settings keeps what it had:
    the logo and web address on, no promo, and an end screen only if it already has one."""
    saved = p.get("closing") if isinstance(p.get("closing"), dict) else None
    if saved is None:
        has_end = any(s.get("kind") == "endscreen" for s in p.get("scenes", []))
        saved = {"logo": True, "url": True, "promo": False, "endscreen": has_end}
    out = {k: bool(saved.get(k, k != "promo")) for k in CLOSING_KEYS}
    if destination_of(p) == "udemy":
        out = {k: False for k in CLOSING_KEYS}
    return out


def length_window(target: float) -> tuple[float, float]:
    """The lengths a video with this target may have."""
    return target * LENGTH_LOW, min(MAX_TOTAL_SECONDS, target * LENGTH_HIGH)


def target_from_source(seconds: float) -> float:
    """A timed source's own length, held to the daily films' 10 to 30 minutes."""
    return max(SOURCE_MIN_SECONDS, min(SOURCE_MAX_SECONDS, float(seconds)))


def is_hex(value) -> bool:
    return isinstance(value, str) and bool(HEX_RE.match(value.strip()))


def safe_asset_name(name: str) -> str:
    """A file name that is safe on disk and in a URL: letters, digits, dot, dash, underscore."""
    base = Path(name).name
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-")[:60] or "file"
    ext = ext.lower()
    if ext == ".jpeg":
        ext = ".jpg"
    return stem + ext


def image_size(path: Path) -> tuple[int, int] | None:
    """Width and height of a PNG, JPEG, GIF or WebP from its header (no imaging library needed)."""
    try:
        with open(path, "rb") as f:
            head = f.read(64)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                return struct.unpack(">II", head[16:24])
            if head[:6] in (b"GIF87a", b"GIF89a"):
                return struct.unpack("<HH", head[6:10])
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                kind = head[12:16]
                if kind == b"VP8X":
                    w = 1 + int.from_bytes(head[24:27], "little")
                    h = 1 + int.from_bytes(head[27:30], "little")
                    return w, h
                if kind == b"VP8 ":
                    w, h = struct.unpack("<HH", head[26:30])
                    return w & 0x3FFF, h & 0x3FFF
                if kind == b"VP8L":
                    b = head[21:25]
                    w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                    h = 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                    return w, h
            if head[:2] == b"\xff\xd8":
                f.seek(2)
                while True:
                    marker = f.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None
                    if marker[1] in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        f.read(3)
                        h, w = struct.unpack(">HH", f.read(4))
                        return w, h
                    size = struct.unpack(">H", f.read(2))[0]
                    f.seek(size - 2, 1)
    except (OSError, struct.error):
        return None
    return None


def asset_kind(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in {".woff", ".woff2", ".ttf", ".otf"}:
        return "font"
    return "document"


# ── scene checks (warnings returned to Claude after a write) ──────────────────────


class _SceneScan(HTMLParser):
    """Collects data-ids, elements with visible text but no data-id, and the text itself."""

    TEXTY = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "div", "li", "img", "text", "tspan", "button", "strong", "em", "b", "i", "code", "small", "label"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.stack: list[tuple[str, bool]] = []  # (tag, has a data-id here or above)
        self.unlabelled: list[str] = []
        self.words = 0
        self._skip = 0  # inside <style> or <script>

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("style", "script"):
            self._skip += 1
            return
        did = a.get("data-id")
        if did:
            self.ids.append(did)
        inherited = bool(did) or (self.stack[-1][1] if self.stack else False)
        if tag == "img" and not did and not inherited:
            self.unlabelled.append("<img>")
        if tag not in ("img", "br", "hr", "input", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "stop", "use"):
            self.stack.append((tag, inherited))

    def handle_endtag(self, tag):
        if tag in ("style", "script"):
            self._skip = max(0, self._skip - 1)
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self._skip:
            return
        text = data.strip()
        if not text:
            return
        self.words += len(HOLE_RE.sub("x", text).split())
        if self.stack and not self.stack[-1][1]:
            self.unlabelled.append(f"<{self.stack[-1][0]}> \"{text[:30]}\"")


FORBIDDEN = [
    (re.compile(r"\bsetTimeout\s*\(|\bsetInterval\s*\("), "setTimeout/setInterval (time must come only from tl)"),
    (re.compile(r"\brequestAnimationFrame\s*\("), "requestAnimationFrame (time must come only from tl)"),
    (re.compile(r"\bDate\.now\s*\(|\bnew\s+Date\s*\(|performance\.now\s*\("), "the clock (Date/performance.now)"),
    (re.compile(r"\bMath\.random\s*\("), "Math.random (use random() so every render matches)"),
    (re.compile(r"\bfetch\s*\(|XMLHttpRequest|import\s*\("), "network access"),
    (re.compile(r"@keyframes|(?<![-\w])animation\s*:|(?<![-\w])transition\s*:"), "CSS animations/transitions (they can't be scrubbed; animate on tl)"),
    (re.compile(r"\.play\s*\(\s*\)|\.repeat\s*\(\s*-1\s*\)|repeat\s*:\s*-1"), "play()/infinite repeats (a scene must be finite and seekable)"),
]


def check_scene(source: str, props: dict) -> list[str]:
    """Warnings about a scene's code: they go back to Claude with the tool result, so it can fix them."""
    warnings: list[str] = []
    scan = _SceneScan()
    try:
        scan.feed(source)
        scan.close()
    except Exception as err:  # noqa: BLE001 - a parser hiccup is only a warning
        warnings.append(f"Could not fully parse the markup: {err}")
    dupes = sorted({i for i in scan.ids if scan.ids.count(i) > 1})
    if dupes:
        warnings.append("Duplicate data-id values (each must be unique): " + ", ".join(dupes))
    if scan.unlabelled:
        warnings.append("Visible elements without a data-id (comments can't target them): " + "; ".join(scan.unlabelled[:6]))
    holes = set(HOLE_RE.findall(source))
    missing = sorted(h for h in holes if not h.startswith("brand.") and h not in props)
    if missing:
        warnings.append("Holes with no matching prop: " + ", ".join("{{" + h + "}}" for h in missing))
    for rx, what in FORBIDDEN:
        if rx.search(source):
            warnings.append(f"Uses {what}.")
    # colours written as hex outside the script; url(#id) and href="#id" references are not colours
    markup = re.sub(r"<script[\s\S]*?</script>", "", source)
    markup = re.sub(r"url\(\s*['\"]?#[^)]*\)|href\s*=\s*['\"]#[^'\"]*['\"]", "", markup)
    hexes = sorted(set(re.findall(r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b", markup)))
    if hexes:
        warnings.append("Hard-coded colours " + ", ".join(hexes[:6]) + ": use the brand CSS variables (var(--accent) ...) instead.")
    # code shown in a p-code panel is read line by line with the voice, not as words on the page, so its
    # props don't count toward the word budget (the player's layout report leaves them out too)
    code_keys = {
        k
        for block in re.findall(r"<pre\b[^>]*\bp-code\b[^>]*>([\s\S]*?)</pre>", source, re.IGNORECASE)
        for k in HOLE_RE.findall(block)
    }
    prop_words = sum(
        len(str(v).split()) for k, v in props.items() if isinstance(v, str) and k not in code_keys and not str(v).startswith("asset://")
    )
    if scan.words + prop_words > 40:
        warnings.append(f"About {scan.words + prop_words} words of text in this scene: keep each moment to 12 words or fewer.")
    if "<script" not in source:
        warnings.append("No <script>: nothing animates in this scene.")
    return warnings


def check_thumbnail(source: str, props: dict) -> list[str]:
    """The scene checks, as they apply to a still: a script is optional (anything it animates must be in
    place by the frame the thumbnail is taken at), and the word limit is the thumbnail's own (3 to 5)."""
    warnings = [w for w in check_scene(source, props) if not w.startswith(("No <script>", "About "))]
    # the words a viewer reads: the markup's text with every {{hole}} filled from the props
    filled = HOLE_RE.sub(lambda m: html_escape(str(props.get(m.group(1), "x"))), source)
    scan = _SceneScan()
    try:
        scan.feed(filled)
        scan.close()
    except Exception:  # noqa: BLE001 - check_scene has already reported a markup problem
        pass
    if scan.words > THUMBNAIL_WORDS:
        warnings.append(f"About {scan.words} words on the thumbnail: keep it to 3 to 5 very large words.")
    return warnings


# ── the store ──────────────────────────────────────────────────────────────────


class Store:
    def __init__(self, root: Path = DATA_DIR):
        self.root = Path(root)
        self.projects_dir = self.root / "projects"
        self.kits_dir = self.root / "brand-kits"
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.kits_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.RLock] = defaultdict(threading.RLock)
        self._locks_guard = threading.Lock()
        self._seed_kits()

    def lock(self, key: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks[key]

    # ── brand kits ──

    def _seed_kits(self) -> None:
        """The first run gets the two AlgoInsight looks (the brand and the graph paper)."""
        if any(self.kits_dir.iterdir()):
            self._upgrade_seed_kits()
            return
        for kit in SEED_KITS:
            kit = json.loads(json.dumps(kit))
            logo = kit.pop("_logoSeed", None)
            icon = kit.pop("_iconSeed", None)
            folder = self.kits_dir / kit["id"]
            folder.mkdir(parents=True, exist_ok=True)
            if logo and (SEED_DIR / logo).exists():
                shutil.copyfile(SEED_DIR / logo, folder / ("logo" + Path(logo).suffix))
                kit["logo"] = "logo" + Path(logo).suffix
            if icon and (SEED_DIR / icon).exists():
                shutil.copyfile(SEED_DIR / icon, folder / ("icon" + Path(icon).suffix))
                kit["icon"] = "icon" + Path(icon).suffix
            kit["createdAt"] = kit["updatedAt"] = now()
            kit["seedVersion"] = SEED_VERSION
            write_json(folder / "kit.json", kit)

    def _upgrade_seed_kits(self) -> None:
        """Kits seeded by an earlier version get the fields added since (theme, tagline, hand font, icon).
        Only missing fields are filled; anything the user changed stays as it is."""
        for seed in SEED_KITS:
            folder = self.kits_dir / seed["id"]
            kit = read_json(folder / "kit.json")
            if not kit or kit.get("seedVersion", 1) >= SEED_VERSION:
                continue
            for key in ("theme", "tagline", "wordmark", "style", "background"):
                if not kit.get(key) and seed.get(key):
                    kit[key] = seed[key]
            kit["fonts"] = {**seed.get("fonts", {}), **(kit.get("fonts") or {})}
            kit["extras"] = {**seed.get("extras", {}), **(kit.get("extras") or {})}
            icon = seed.get("_iconSeed")
            if icon and not kit.get("icon") and (SEED_DIR / icon).exists():
                shutil.copyfile(SEED_DIR / icon, folder / ("icon" + Path(icon).suffix))
                kit["icon"] = "icon" + Path(icon).suffix
            kit["seedVersion"] = SEED_VERSION
            write_json(folder / "kit.json", kit)

    def list_kits(self) -> list[dict]:
        kits = []
        for folder in sorted(self.kits_dir.iterdir()):
            kit = read_json(folder / "kit.json")
            if kit:
                kits.append(kit)
        kits.sort(key=lambda k: (not k.get("builtin"), k.get("name", "").lower()))
        return kits

    def get_kit(self, kit_id: str | None) -> dict | None:
        if not kit_id or not ID_RE.match(kit_id):
            return None
        return read_json(self.kits_dir / kit_id / "kit.json")

    def kit_logo_path(self, kit_id: str, which: str = "logo") -> Path | None:
        """The kit's logo, or with which="icon" the square icon its paper logo card shows."""
        kit = self.get_kit(kit_id)
        if not kit or not kit.get(which):
            return None
        p = self.kits_dir / kit_id / kit[which]
        return p if p.exists() else None

    def normalize_kit(self, data: dict, base: dict | None = None) -> dict:
        """Validates a kit coming from the page or from Claude, filling gaps from `base` or the defaults."""
        base = base or DEFAULT_KIT
        kit: dict = {}
        kit["name"] = str(data.get("name") or base.get("name") or "Brand kit").strip()[:60]
        palette = dict(base.get("palette", {}))
        for role in PALETTE_ROLES:
            value = (data.get("palette") or {}).get(role)
            if value is not None:
                if not is_hex(value):
                    raise StoreError(f"palette.{role} must be a hex colour like #1a2b3c, not {value!r}")
                palette[role] = value.strip().lower()
        kit["palette"] = palette
        extras = {}
        for key, value in ((data.get("extras") if data.get("extras") is not None else base.get("extras")) or {}).items():
            name = re.sub(r"[^a-z0-9-]+", "-", str(key).lower()).strip("-")[:24]
            if name and is_hex(value):
                extras[name] = value.strip().lower()
        kit["extras"] = dict(list(extras.items())[:16])
        theme = data.get("theme", base.get("theme", "plain"))
        kit["theme"] = theme if theme in THEMES else "plain"
        kit["tagline"] = str(data.get("tagline", base.get("tagline", "")) or "")[:80]
        kit["wordmark"] = str(data.get("wordmark", base.get("wordmark", "")) or "")[:40]
        fonts = dict(base.get("fonts", {}))
        for role in ("display", "body", "mono", "hand"):
            value = (data.get("fonts") or {}).get(role)
            if value:
                fonts[role] = re.sub(r"[^\w .'-]+", "", str(value)).strip()[:60] or fonts.get(role)
        kit["fonts"] = fonts
        radius = data.get("radius", base.get("radius", 12))
        kit["radius"] = max(0, min(64, int(radius))) if isinstance(radius, (int, float)) else 12
        motion = data.get("motion", base.get("motion", "snappy"))
        kit["motion"] = motion if motion in MOTION_STYLES else "snappy"
        kit["background"] = str(data.get("background", base.get("background", "")) or "")[:2000]
        kit["style"] = str(data.get("style", base.get("style", "")) or "")[:2000]
        end = {**(base.get("endCard") or {}), **(data.get("endCard") or {})}
        kit["endCard"] = {
            "enabled": bool(end.get("enabled", True)),
            "headline": str(end.get("headline", ""))[:120],
            "cta": str(end.get("cta", ""))[:120],
            "url": str(end.get("url", ""))[:120],
        }
        return kit

    def create_kit(self, data: dict, base_id: str | None = None) -> dict:
        base = self.get_kit(base_id) if base_id else None
        kit = self.normalize_kit(data, base)
        kit_id = slugify(kit["name"], "kit")[:30] + "-" + uuid.uuid4().hex[:4]
        kit.update(id=kit_id, builtin=False, logo=None, icon=None, createdAt=now(), updatedAt=now())
        folder = self.kits_dir / kit_id
        folder.mkdir(parents=True)
        for which in ("logo", "icon"):
            if base and base.get(which) and (self.kits_dir / base["id"] / base[which]).exists():
                shutil.copyfile(self.kits_dir / base["id"] / base[which], folder / base[which])
                kit[which] = base[which]
        write_json(folder / "kit.json", kit)
        return kit

    def update_kit(self, kit_id: str, data: dict) -> dict:
        with self.lock("kit:" + kit_id):
            old = self.get_kit(kit_id)
            if not old:
                raise StoreError("No such brand kit.", 404)
            kit = self.normalize_kit(data, old)
            kit.update(id=kit_id, builtin=old.get("builtin", False), logo=old.get("logo"), icon=old.get("icon"), createdAt=old.get("createdAt", now()), updatedAt=now())
            write_json(self.kits_dir / kit_id / "kit.json", kit)
            return kit

    def set_kit_logo(self, kit_id: str, filename: str | None, data: bytes | None) -> dict:
        with self.lock("kit:" + kit_id):
            kit = self.get_kit(kit_id)
            if not kit:
                raise StoreError("No such brand kit.", 404)
            folder = self.kits_dir / kit_id
            if kit.get("logo") and (folder / kit["logo"]).exists():
                (folder / kit["logo"]).unlink()
            kit["logo"] = None
            if data:
                ext = os.path.splitext(filename or "")[1].lower()
                if ext not in IMAGE_EXT:
                    raise StoreError("The logo must be a PNG, JPG, WebP, GIF or SVG image.")
                if len(data) > 5 * 1024 * 1024:
                    raise StoreError("The logo is larger than 5 MB.")
                name = "logo" + (".jpg" if ext == ".jpeg" else ext)
                (folder / name).write_bytes(data)
                kit["logo"] = name
            kit["updatedAt"] = now()
            write_json(folder / "kit.json", kit)
            return kit

    def delete_kit(self, kit_id: str) -> None:
        if not self.get_kit(kit_id):
            raise StoreError("No such brand kit.", 404)
        shutil.rmtree(self.kits_dir / kit_id)

    # ── projects ──

    def _dir(self, pid: str) -> Path:
        if not pid or not re.match(r"^[a-z0-9]{6,32}$", pid):
            raise StoreError("No such video.", 404)
        d = self.projects_dir / pid
        if not (d / "project.json").exists():
            raise StoreError("No such video.", 404)
        return d

    def list_projects(self) -> list[dict]:
        out = []
        for folder in self.projects_dir.iterdir():
            p = read_json(folder / "project.json")
            if not p:
                continue
            total = sum(s["duration"] for s in p["scenes"])
            out.append(
                {
                    "id": p["id"],
                    "title": p["title"],
                    "aspect": p["aspect"],
                    "scenes": len(p["scenes"]),
                    "duration": round(total, 2),
                    "version": p["version"],
                    "createdAt": p["createdAt"],
                    "updatedAt": p["updatedAt"],
                    "brandKitId": p.get("brandKitId"),
                }
            )
        out.sort(key=lambda x: x["updatedAt"], reverse=True)
        return out

    def create_project(
        self,
        title: str = "",
        aspect: str = DEFAULT_ASPECT,
        brand_kit_id: str | None = None,
        settings: dict | None = None,
        target_seconds: float | None = None,
    ) -> dict:
        pid = uuid.uuid4().hex[:12]
        if aspect not in ASPECTS:
            aspect = DEFAULT_ASPECT
        if brand_kit_id and not self.get_kit(brand_kit_id):
            brand_kit_id = None
        if brand_kit_id is None:
            kits = self.list_kits()
            brand_kit_id = kits[0]["id"] if kits else None
        kit = self.get_kit(brand_kit_id)
        paper = bool(kit and kit.get("theme") == "paper")
        if paper:
            aspect = "16:9"  # the paper look is the daily films' 16:9 frame
        project = {
            "destination": "youtube",
            # the end screen by default in the paper look (a short in another kit gets one when Claude plans
            # it, or from the settings); the promo is a choice
            "closing": {"logo": True, "url": True, "promo": False, "endscreen": paper},
            "id": pid,
            "title": (title or "Untitled video").strip()[:120],
            "aspect": aspect,
            "fps": FPS,
            "brandKitId": brand_kit_id,
            "brief": {},
            "audio": None,
            "settings": {"model": None, "effort": None, "engine": None, **(settings or {})},
            "targetSeconds": round(float(target_seconds), 1) if target_seconds else None,
            "pronunciations": [dict(p) for p in DEFAULT_PRONUNCIATIONS],
            "voice": json.loads(json.dumps(vc.VOICE)),
            "scenes": [],
            "version": 1,
            "createdAt": now(),
            "updatedAt": now(),
        }
        folder = self.projects_dir / pid
        (folder / "scenes").mkdir(parents=True)
        (folder / "assets").mkdir()
        write_json(folder / "project.json", project)
        return project

    def get_project(self, pid: str) -> dict:
        p = read_json(self._dir(pid) / "project.json")
        if p is not None:
            # settings a project from before them gets filled in (and saved with its next change)
            p["destination"] = destination_of(p)
            p["closing"] = closing_of(p)
        return p

    def _save(self, pid: str, project: dict) -> dict:
        self._derive(pid, project)
        project["version"] = int(project.get("version", 0)) + 1
        project["updatedAt"] = now()
        write_json(self._dir(pid) / "project.json", project)
        return project

    # ── narration timing ──

    def stage_size(self, p: dict) -> tuple[int, int]:
        kit = self.get_kit(p.get("brandKitId"))
        if kit and kit.get("theme") == "paper":
            return PAPER_STAGE
        return ASPECTS[p["aspect"]]

    def voice_of(self, p: dict) -> dict:
        return p.get("voice") or vc.VOICE

    def timing(self, pid: str, p: dict, s: dict) -> dict:
        """How a scene's narration sits in time: where the voice starts (lead), how long it speaks, whether the
        audio is current, and each cue's time in seconds from the scene's start."""
        narration = s.get("narration") or ""
        lead = LEAD_SECONDS if s.get("transition", "fade") != "cut" else LEAD_CUT_SECONDS
        if not narration.strip() or s.get("kind") == "endscreen":
            return {"narrated": False, "lead": lead, "speech": 0.0, "voiced": False, "stale": False, "hash": None, "cues": [lead], "words": 0, "chars": 0}
        text, offsets = vc.spoken(narration, p.get("pronunciations") or [])
        h = vc.clip_hash(text, self.voice_of(p))
        clip = vc.load_clip(self._dir(pid) / "voice", h) if (s.get("voice") or {}).get("hash") == h else None
        speech = clip["seconds"] if clip else vc.estimate_seconds(text)
        cues = [lead] + [round(lead + t, 3) for t in vc.cue_times(text, offsets, speech, clip["charTimes"] if clip else None)]
        return {
            "narrated": True,
            "lead": lead,
            "speech": round(speech, 3),
            "voiced": bool(clip),
            "stale": bool(s.get("voice")) and not clip,
            "hash": h,
            "cues": cues,
            "words": vc.words(text),
            "chars": len(text),
            "spoken": text,
        }

    def _derive(self, pid: str, p: dict) -> None:
        """Narrated scenes take their length from the speech (snapped to whole frames)."""
        for s in p["scenes"]:
            s.setdefault("kind", "scene")
            t = self.timing(pid, p, s)
            if t["narrated"]:
                total = t["lead"] + t["speech"] + TAIL_SECONDS + float(s.get("hold") or 0)
                s["duration"] = round(math.ceil(total * FPS - 1e-6) / FPS, 3)

    def delete_project(self, pid: str) -> None:
        shutil.rmtree(self._dir(pid))

    def update_project(self, pid: str, fields: dict, base_version: int | None = None) -> dict:
        """Title, aspect, brand kit, soundtrack or Claude settings, from the page or from Claude."""
        with self.lock(pid):
            p = self.get_project(pid)
            if base_version is not None and base_version != p["version"]:
                raise StoreError("The video changed in the meantime. Reload and try again.", 409)
            if "title" in fields:
                p["title"] = str(fields["title"] or "Untitled video").strip()[:120]
            if "aspect" in fields:
                if fields["aspect"] not in ASPECTS:
                    raise StoreError("aspect must be one of " + ", ".join(ASPECTS))
                p["aspect"] = fields["aspect"]
            if "brandKitId" in fields:
                kit = self.get_kit(fields["brandKitId"]) if fields["brandKitId"] else None
                if fields["brandKitId"] and not kit:
                    raise StoreError("No such brand kit.", 404)
                p["brandKitId"] = fields["brandKitId"]
                if kit and kit.get("theme") == "paper":
                    p["aspect"] = "16:9"
            if "targetSeconds" in fields:
                v = fields["targetSeconds"]
                p["targetSeconds"] = round(max(10.0, min(MAX_TOTAL_SECONDS, float(v))), 1) if v else None
            if "pronunciations" in fields:
                p["pronunciations"] = _clean_pronunciations(fields["pronunciations"])
            if "audio" in fields:
                audio = fields["audio"]
                if audio and not (self._dir(pid) / "assets" / audio).exists():
                    raise StoreError("No such audio file in this video's assets.")
                p["audio"] = audio or None
            if "brief" in fields and isinstance(fields["brief"], dict):
                p["brief"] = {k: str(v)[:300] for k, v in fields["brief"].items() if v not in (None, "")}
            if "settings" in fields and isinstance(fields["settings"], dict):
                p["settings"] = {**p.get("settings", {}), **{k: v for k, v in fields["settings"].items() if k in ("model", "effort", "engine")}}
            if "destination" in fields:
                d = fields["destination"]
                if d not in DESTINATIONS:
                    raise StoreError("destination must be youtube or udemy")
                if d == "youtube" and destination_of(p) == "udemy":
                    # back from Udemy: our logo, web address and end screen return; the promo stays a choice
                    p["closing"] = {"logo": True, "url": True, "promo": False, "endscreen": True}
                p["destination"] = d
            if "closing" in fields:
                c = fields["closing"]
                if not isinstance(c, dict):
                    raise StoreError("closing must be an object like {promo: true}")
                if destination_of(p) == "udemy" and any(c.get(k) for k in CLOSING_KEYS):
                    raise StoreError("A Udemy video can't show our logo, web address, promo or end screen. Switch it to YouTube first.")
                current = closing_of(p)
                for k in CLOSING_KEYS:
                    if k in c:
                        current[k] = bool(c[k])
                p["closing"] = current
            if any(k in fields for k in ("destination", "closing", "brandKitId")):
                self._apply_closing(pid, p)
                self._check_total(pid, p)
            return self._save(pid, p)

    # ── scenes ──

    @staticmethod
    def _find(p: dict, sid: str) -> dict:
        for s in p["scenes"]:
            if s["id"] == sid:
                return s
        raise StoreError(f"No scene with id {sid!r}. Scenes: " + (", ".join(s["id"] for s in p["scenes"]) or "none yet"), 404)

    def scene_source(self, pid: str, sid: str) -> str | None:
        p = self.get_project(pid)
        s = self._find(p, sid)
        f = self._dir(pid) / s["file"]
        return f.read_text(encoding="utf-8") if f.exists() else None

    @staticmethod
    def _clean_duration(value, default: float = 4.0) -> float:
        try:
            d = float(value)
        except (TypeError, ValueError):
            return default
        return round(max(0.5, min(60.0, d)), 2)

    def write_storyboard(
        self,
        pid: str,
        scenes: list[dict],
        title: str | None = None,
        aspect: str | None = None,
        brief: dict | None = None,
        target_minutes=None,
        source_skips=None,
    ) -> tuple[dict, list[str]]:
        """Sets the ordered scene list. Scenes that keep their id keep their code; dropped scenes are deleted.
        target_minutes changes the length to aim for (only when the user asked for one); source_skips lists
        the source lines left out on purpose."""
        with self.lock(pid):
            p = self.get_project(pid)
            if not isinstance(scenes, list) or not scenes:
                raise StoreError("scenes must be a non-empty list")
            if len(scenes) > MAX_SCENES:
                raise StoreError(f"At most {MAX_SCENES} scenes.")
            old = {s["id"]: s for s in p["scenes"]}
            closing_ids = {sid for sid, s in old.items() if s.get("kind") in CLOSING_KINDS}
            new_list, seen, notes = [], set(), []
            wants_end = False
            for raw in scenes:
                sid = str(raw.get("id", "")).strip().lower()
                # the promo and the end screen come from the video's settings, not the storyboard: an end
                # screen in the plan only turns that setting on (when the video may have one)
                if raw.get("kind") in CLOSING_KINDS or sid in closing_ids:
                    wants_end = wants_end or raw.get("kind") == "endscreen" or old.get(sid, {}).get("kind") == "endscreen"
                    continue
                if not ID_RE.match(sid):
                    raise StoreError(f"Scene id {sid!r} must be lowercase letters, digits and dashes (for example s1 or hook).")
                if sid in seen:
                    raise StoreError(f"Scene id {sid!r} is used twice.")
                seen.add(sid)
                transition = raw.get("transition") or old.get(sid, {}).get("transition") or "fade"
                if transition not in TRANSITIONS:
                    transition = "fade"
                prev = old.get(sid, {})
                kind = raw.get("kind") if raw.get("kind") in SCENE_KINDS else prev.get("kind", "scene")
                entry = {
                    **(prev or {"props": {}, "levers": [], "rev": 0, "status": "planned"}),
                    "id": sid,
                    "kind": kind,
                    "name": str(raw.get("name") or sid)[:60],
                    "idea": str(raw.get("idea") or prev.get("idea", ""))[:400],
                    "file": f"scenes/{sid}.html",
                    "duration": self._clean_duration(raw.get("duration"), prev.get("duration", 15.0 if kind == "endscreen" else 4.0)),
                    "transition": transition,
                    "label": str(raw.get("label", prev.get("label", "")) or "")[:80],
                    "part": str(raw.get("part", prev.get("part", "")) or "")[:60],
                    "narration": str(raw.get("narration", prev.get("narration", "")) or "")[:6000],
                    "covers": clean_covers(raw["covers"]) if raw.get("covers") is not None else prev.get("covers", []),
                }
                new_list.append(entry)
            if not new_list:
                raise StoreError("The storyboard needs at least one scene of the video's own (the promo and the end screen come from its settings).")
            p["scenes"] = new_list + [old[sid] for sid in old if sid in closing_ids]
            if wants_end and destination_of(p) == "youtube" and not closing_of(p)["endscreen"]:
                p["closing"] = {**closing_of(p), "endscreen": True}
            self._apply_closing(pid, p)
            if len(p["scenes"]) > MAX_SCENES:
                raise StoreError(f"At most {MAX_SCENES} scenes, counting the promo and the end screen.")
            self._derive(pid, p)
            total = sum(s["duration"] for s in p["scenes"])
            if total > MAX_TOTAL_SECONDS:
                raise StoreError(f"The video would be {total / 60:.1f} min long; the limit is {MAX_TOTAL_SECONDS / 60:.0f} min.")
            final = {s["id"] for s in p["scenes"]}
            for sid in old:
                if sid not in final:
                    f = self._dir(pid) / old[sid]["file"]
                    if f.exists():
                        f.unlink()
                    if sid not in closing_ids:
                        notes.append(f"removed scene {sid}")
            if title:
                p["title"] = str(title).strip()[:120]
            if aspect:
                if aspect not in ASPECTS:
                    raise StoreError("aspect must be one of " + ", ".join(ASPECTS))
                kit = self.get_kit(p.get("brandKitId"))
                if kit and kit.get("theme") == "paper" and aspect != "16:9":
                    notes.append("the paper look is 16:9, so the aspect stays 16:9")
                else:
                    p["aspect"] = aspect
            if isinstance(brief, dict):
                p["brief"] = {k: str(v)[:300] for k, v in brief.items() if v not in (None, "")}
            if target_minutes is not None:
                try:
                    minutes = float(target_minutes)
                except (TypeError, ValueError):
                    raise StoreError("targetMinutes must be a number of minutes, like 0.75 or 12.") from None
                p["targetSeconds"] = round(max(10.0, min(MAX_TOTAL_SECONDS, minutes * 60)), 1) if minutes > 0 else None
            if source_skips is not None:
                p["sourceSkips"] = clean_skips(source_skips)
            return self._save(pid, p), notes

    def write_scene(
        self,
        pid: str,
        sid: str,
        source: str,
        props: dict | None = None,
        levers: list | None = None,
        name: str | None = None,
        text: dict | None = None,
    ) -> tuple[dict, list[str]]:
        with self.lock(pid):
            p = self.get_project(pid)
            s = self._find(p, sid)
            if not isinstance(source, str) or not source.strip():
                raise StoreError("html must be the scene's full source")
            if len(source.encode("utf-8")) > MAX_SCENE_BYTES:
                raise StoreError(f"The scene is larger than {MAX_SCENE_BYTES // 1000} KB; split it or simplify it.")
            props = props if isinstance(props, dict) else s.get("props", {})
            write_text(self._dir(pid) / s["file"], source)
            s["props"] = _clean_props(props)
            for key in ("narration", "label", "part"):
                if text and isinstance(text.get(key), str):
                    s[key] = text[key][:6000 if key == "narration" else 80]
            if isinstance(levers, list):
                s["levers"] = _clean_levers(levers)
            if name:
                s["name"] = str(name)[:60]
            s["status"] = "written"
            s["rev"] = int(s.get("rev", 0)) + 1
            return self._save(pid, p), self._scene_warnings(p, s, source)

    def patch_scene(self, pid: str, sid: str, edits: list[dict]) -> tuple[dict, list[str], int]:
        """Exact find-and-replace edits, applied all or none. Returns (project, warnings, replacements)."""
        with self.lock(pid):
            p = self.get_project(pid)
            s = self._find(p, sid)
            f = self._dir(pid) / s["file"]
            if not f.exists():
                raise StoreError(f"Scene {sid} has no code yet; use write_scene first.")
            text = f.read_text(encoding="utf-8")
            if not isinstance(edits, list) or not edits:
                raise StoreError("edits must be a non-empty list of {find, replace}")
            count_total = 0
            for i, e in enumerate(edits, 1):
                find, repl = e.get("find"), e.get("replace")
                if not isinstance(find, str) or not find or not isinstance(repl, str):
                    raise StoreError(f"Edit {i}: find must be non-empty text and replace must be text.")
                n = text.count(find)
                if n == 0:
                    raise StoreError(f"Edit {i}: the text to find is not in scene {sid} (no edit was applied). Call read_scene to see the current code; find must match exactly, including spaces.")
                if n > 1 and not e.get("all"):
                    raise StoreError(f"Edit {i}: the text to find occurs {n} times in scene {sid} (no edit was applied). Add surrounding text so it is unique, or set all: true.")
                text = text.replace(find, repl) if e.get("all") else text.replace(find, repl, 1)
                count_total += n if e.get("all") else 1
            write_text(f, text)
            s["rev"] = int(s.get("rev", 0)) + 1
            return self._save(pid, p), self._scene_warnings(p, s, text), count_total

    def set_props(self, pid: str, sid: str, props: dict, replace: bool = False) -> dict:
        with self.lock(pid):
            p = self.get_project(pid)
            s = self._find(p, sid)
            if not isinstance(props, dict):
                raise StoreError("props must be an object")
            s["props"] = _clean_props(props if replace else {**s.get("props", {}), **props})
            s["rev"] = int(s.get("rev", 0)) + 1
            return self._save(pid, p)

    def update_timeline(self, pid: str, changes: list[dict] | None = None, order: list[str] | None = None) -> dict:
        """Durations and transitions per scene, and/or a new order (every scene id once)."""
        with self.lock(pid):
            p = self.get_project(pid)
            for c in changes or []:
                s = self._find(p, str(c.get("id")))
                if "duration" in c:
                    self._set_length(pid, p, s, c["duration"])
                if "transition" in c:
                    if c["transition"] not in TRANSITIONS:
                        raise StoreError("transition must be one of " + ", ".join(TRANSITIONS))
                    s["transition"] = c["transition"]
                if "name" in c:
                    s["name"] = str(c["name"])[:60]
                s["rev"] = int(s.get("rev", 0)) + 1
            if order:
                # the closing scenes (promo, end screen) always stay last, so order lists only the rest
                tail = [s for s in p["scenes"] if s.get("kind") in CLOSING_KINDS]
                order = [i for i in order if i not in {s["id"] for s in tail}]
                ids = [s["id"] for s in p["scenes"] if s.get("kind") not in CLOSING_KINDS]
                if sorted(order) != sorted(ids):
                    raise StoreError("order must list every scene id exactly once: " + ", ".join(ids))
                by_id = {s["id"]: s for s in p["scenes"]}
                p["scenes"] = [by_id[i] for i in order] + tail
            self._check_total(pid, p)
            return self._save(pid, p)

    def edit_scene(self, pid: str, sid: str, fields: dict, base_rev: int | None) -> dict:
        """A direct edit from the page's properties panel or code view."""
        with self.lock(pid):
            p = self.get_project(pid)
            s = self._find(p, sid)
            if base_rev is not None and base_rev != s.get("rev", 0):
                raise StoreError("This scene changed in the meantime (Claude or Undo edited it). Your view is now up to date; make the change again.", 409)
            if "source" in fields:
                source = fields["source"]
                if not isinstance(source, str) or not source.strip():
                    raise StoreError("The code can't be empty.")
                if len(source.encode("utf-8")) > MAX_SCENE_BYTES:
                    raise StoreError("The scene is too large.")
                write_text(self._dir(pid) / s["file"], source)
                s["status"] = "written"
            if "props" in fields:
                if not isinstance(fields["props"], dict):
                    raise StoreError("props must be an object")
                s["props"] = _clean_props(fields["props"])
            for key, limit in (("narration", 6000), ("label", 80), ("part", 60)):
                if key in fields:
                    s[key] = str(fields[key] or "")[:limit]
            if "hold" in fields:
                s["hold"] = round(max(0.0, min(30.0, float(fields["hold"] or 0))), 2)
            if "duration" in fields:
                self._set_length(pid, p, s, fields["duration"])
            if "transition" in fields:
                if fields["transition"] not in TRANSITIONS:
                    raise StoreError("transition must be one of " + ", ".join(TRANSITIONS))
                s["transition"] = fields["transition"]
            if "name" in fields:
                s["name"] = str(fields["name"] or s["id"])[:60]
            self._check_total(pid, p)
            s["rev"] = int(s.get("rev", 0)) + 1
            return self._save(pid, p)

    # ── narration, pronunciation, voice, documents ──

    def _set_length(self, pid: str, p: dict, s: dict, wanted) -> None:
        """A narrated scene can't be shorter than its speech: a longer length becomes a hold after the words."""
        t = self.timing(pid, p, s)
        if t["narrated"]:
            base = t["lead"] + t["speech"] + TAIL_SECONDS
            s["hold"] = round(max(0.0, min(30.0, float(wanted) - base)), 2)
        else:
            s["duration"] = self._clean_duration(wanted, s["duration"])

    def _check_total(self, pid: str, p: dict) -> None:
        self._derive(pid, p)
        total = sum(x["duration"] for x in p["scenes"])
        if total > MAX_TOTAL_SECONDS:
            raise StoreError(f"The video would be {total / 60:.1f} min long; the limit is {MAX_TOTAL_SECONDS / 60:.0f} min.")

    def _scene_warnings(self, p: dict, s: dict, source: str) -> list[str]:
        warnings = check_scene(source, s.get("props", {}))
        warnings += vc.check_narration(s.get("narration", ""))
        cues = vc.count_cues(s.get("narration", ""))
        used = [int(n) for n in re.findall(r"\bcue\(\s*(\d+)", source)]
        if used and max(used) > cues:
            warnings.append(f"The script uses cue({max(used)}) but the narration has {cues} <cue/> mark{'s' if cues != 1 else ''}.")
        # a screenshot of the source is for looking at only: it never appears in the video
        refs = self.reference_assets(p)
        shown = sorted({n for n in REF_ASSET_RE.findall(source + " " + json.dumps(s.get("props", {}))) if n in refs})
        if shown:
            warnings.append(f"{', '.join(shown)} {'is a screenshot' if len(shown) == 1 else 'are screenshots'} of the source: a layout reference to look at, never to show. Remove it and draw your own page.")
        return warnings

    def write_script(self, pid: str, entries: list[dict], source_skips=None) -> tuple[dict, list[str]]:
        """Narration (and label, part, covers) for many scenes at once: the script, before the scenes' code."""
        with self.lock(pid):
            p = self.get_project(pid)
            if not isinstance(entries, list) or not entries:
                raise StoreError("scenes must be a non-empty list of {id, narration}")
            notes = []
            for e in entries:
                s = self._find(p, str(e.get("id")))
                for key, limit in (("narration", 6000), ("label", 80), ("part", 60)):
                    if isinstance(e.get(key), str):
                        s[key] = e[key][:limit]
                if e.get("covers") is not None:
                    s["covers"] = clean_covers(e["covers"])
                s["rev"] = int(s.get("rev", 0)) + 1
                for w in vc.check_narration(s.get("narration", "")):
                    notes.append(f"{s['id']}: {w}")
            if source_skips is not None:
                p["sourceSkips"] = clean_skips(source_skips)
            self._check_total(pid, p)
            return self._save(pid, p), notes

    def set_pronunciations(self, pid: str, entries: list, replace: bool = False) -> dict:
        with self.lock(pid):
            p = self.get_project(pid)
            current = {} if replace else {e["written"]: e for e in p.get("pronunciations") or []}
            for e in _clean_pronunciations(entries):
                current[e["written"]] = e
            p["pronunciations"] = [e for e in current.values() if e["spoken"]]
            return self._save(pid, p)

    def link_voice(self, pid: str, sid: str, h: str) -> dict:
        """Marks a scene as voiced by clip `h` (after Generate voice made or found it)."""
        with self.lock(pid):
            p = self.get_project(pid)
            s = self._find(p, sid)
            s["voice"] = {"hash": h}
            return self._save(pid, p)

    def voice_dir(self, pid: str) -> Path:
        d = self._dir(pid) / "voice"
        d.mkdir(exist_ok=True)
        return d

    @property
    def voice_cache_dir(self) -> Path:
        """Clips shared by every video (content-addressed like each video's own): the same words in the same
        voice are paid for once, so the promo's minute of narration costs nothing after the first video."""
        return self.root / "voice-cache"

    def find_clip(self, pid: str, h: str) -> dict | None:
        """This video's clip for a hash, copying it from the shared cache when only the cache has it."""
        folder = self.voice_dir(pid)
        clip = vc.load_clip(folder, h)
        if clip is None and vc.load_clip(self.voice_cache_dir, h) is not None:
            for ext in (".mp3", ".json"):
                shutil.copyfile(self.voice_cache_dir / f"{h}{ext}", folder / f"{h}{ext}")
            clip = vc.load_clip(folder, h)
        return clip

    def share_clip(self, pid: str, h: str) -> None:
        """Puts a newly made clip in the shared cache."""
        self.voice_cache_dir.mkdir(parents=True, exist_ok=True)
        for ext in (".mp3", ".json"):
            src = self._dir(pid) / "voice" / f"{h}{ext}"
            if src.exists() and not (self.voice_cache_dir / f"{h}{ext}").exists():
                shutil.copyfile(src, self.voice_cache_dir / f"{h}{ext}")

    # ── what the video adds at its end: the promo and the end screen ──

    def _promo_entries(self, pid: str, p: dict, existing: dict) -> list[dict]:
        tpl = promo_template()
        out = []
        for t in tpl["scenes"]:
            s = existing.get(t["id"])
            if s is None:
                write_text(self._dir(pid) / "scenes" / f"{t['id']}.html", (PROMO_DIR / t["file"]).read_text(encoding="utf-8"))
                s = {
                    "id": t["id"], "kind": "promo", "name": t["name"], "idea": t["idea"], "file": f"scenes/{t['id']}.html",
                    "duration": 10.0, "transition": t["transition"], "label": t["label"], "part": tpl["part"], "narration": t["narration"],
                    "covers": [], "props": {}, "levers": [], "rev": 1, "status": "written", "promoVersion": tpl["version"],
                }
            out.append(s)
        # the voice must say the promo's short forms right; an entry the user already has wins
        have = {e["written"] for e in p.get("pronunciations") or []}
        p["pronunciations"] = (p.get("pronunciations") or []) + [dict(e) for e in tpl.get("pronunciations", []) if e["written"] not in have]
        return out

    def _apply_closing(self, pid: str, p: dict) -> None:
        """Puts the closing scenes the settings ask for after the video's own scenes: the AlgoInsight promo
        (paper look only), then the end screen. Turning one off removes its scenes; turning it on again
        rebuilds them (and any voice already made for them is reused for free). A video with no scenes of
        its own gets none yet."""
        closing = closing_of(p)
        p["closing"] = closing
        p["destination"] = destination_of(p)
        kit = self.get_kit(p.get("brandKitId"))
        paper = bool(kit and kit.get("theme") == "paper")
        body = [s for s in p["scenes"] if s.get("kind") not in CLOSING_KINDS]
        old = {s["id"]: s for s in p["scenes"] if s.get("kind") in CLOSING_KINDS}
        tail: list[dict] = []
        if body:
            if closing["promo"] and paper:
                tail += self._promo_entries(pid, p, old)
            if closing["endscreen"]:
                end = next((s for s in old.values() if s.get("kind") == "endscreen"), None)
                if end is None:
                    eid = "end" if all(s["id"] != "end" for s in body) else "end-screen"
                    end = {
                        "id": eid, "kind": "endscreen", "name": "End screen", "idea": "The end screen", "file": f"scenes/{eid}.html",
                        "duration": 18.0, "transition": "tear" if paper else "fade", "label": "", "part": "", "narration": "",
                        "covers": [], "props": {}, "levers": [], "rev": 1, "status": "written",
                    }
                tail.append(end)
        keep = {s["id"] for s in tail}
        for sid, s in old.items():
            if sid not in keep:
                f = self._dir(pid) / s["file"]
                if f.exists():
                    f.unlink()
        p["scenes"] = body + tail

    def docs_dir(self, pid: str) -> Path:
        d = self._dir(pid) / "docs"
        d.mkdir(exist_ok=True)
        return d

    def write_doc(self, pid: str, name: str, content: str) -> str:
        stem = re.sub(r"[^A-Za-z0-9_-]+", "-", os.path.splitext(Path(str(name)).name)[0]).strip("-")[:60] or "notes"
        if not isinstance(content, str) or not content.strip():
            raise StoreError("The document is empty.")
        write_text(self.docs_dir(pid) / f"{stem}.md", content[:400_000])
        return f"{stem}.md"

    def list_docs(self, pid: str) -> list[dict]:
        return [{"name": f.name, "bytes": f.stat().st_size, "at": round(f.stat().st_mtime, 3)} for f in sorted(self.docs_dir(pid).glob("*.md"))]

    def read_doc(self, pid: str, name: str) -> str:
        f = self.docs_dir(pid) / Path(name).name
        if not f.exists():
            raise StoreError("No such document.", 404)
        return f.read_text(encoding="utf-8")

    # ── the reference source and the plan's review ──

    def set_source(self, pid: str, name: str, text: str) -> dict | None:
        """Keeps a timed transcript's lines as the points this video must cover. None when it has no times."""
        lines = parse_source(text)
        if len(lines) < 3:
            return None
        src = {"name": name, "seconds": max(ln["t"] for ln in lines), "lines": lines, "at": now()}
        with self.lock(pid):
            write_json(self._dir(pid) / "source.json", src)
        return src

    def get_source(self, pid: str) -> dict | None:
        return read_json(self._dir(pid) / "source.json")

    def add_references(self, pid: str, frames: list[dict], title: str | None = None, url: str | None = None) -> list[dict]:
        """Screenshots of the source ({t, path, text}, from a transcription) become this video's references:
        each JPEG is copied into the assets as ref-<mm>m<ss>s.jpg, docs/REFERENCES.md lists them, and
        project.references = [{t, asset, text}] in time order. Replaces earlier references. They are layout
        references for Claude (view_references), never assets to show in the video."""
        with self.lock(pid):
            p = self.get_project(pid)
            refs = []
            for f in sorted(frames, key=lambda x: float(x.get("t") or 0))[:MAX_REFERENCES]:
                path = Path(f.get("path") or "")
                if path.suffix.lower() not in (".jpg", ".jpeg") or not path.is_file():
                    continue
                t = max(0.0, float(f.get("t") or 0))
                item = self.save_asset(pid, ref_asset_name(t), path.read_bytes())
                refs.append({"t": round(t, 2), "asset": item["name"], "text": re.sub(r"\s+", " ", str(f.get("text") or "")).strip()[:400]})
            if not refs:
                return []
            p["references"] = refs
            self.write_doc(pid, "REFERENCES.md", references_markdown(refs, title, url))
            self._save(pid, p)
            return refs

    def reference_assets(self, p: dict) -> set[str]:
        """The asset names that are references (screenshots of the source)."""
        return {r["asset"] for r in p.get("references") or [] if isinstance(r, dict) and r.get("asset")}

    def plan_review(self, pid: str, p: dict | None = None) -> dict:
        """Where the script stands against its target and source: the length, which source lines no scene
        covers, and narration that repeats the source word for word. Claude may write scene code only when
        `problems` is empty, so a build never starts from a short, partial or copied script."""
        p = p or self.get_project(pid)
        self._derive(pid, p)
        # the length the target is about: the video's own scenes, without the promo and the end screen
        total = sum(s["duration"] for s in p["scenes"] if s.get("kind") not in CLOSING_KINDS)
        problems: list[str] = []
        out: dict = {"total": total, "window": None, "coverage": None, "copied": {}, "problems": problems}
        target = p.get("targetSeconds")
        if target:
            lo, hi = length_window(target)
            out["window"] = (lo, hi)
            if total < lo - 0.5:
                more = int(math.ceil((lo - total) * vc.WORDS_PER_SECOND / 10.0) * 10)
                problems.append(
                    f"The video is {fmt_clock(total)} but must run at least {fmt_clock(lo)} (target {fmt_clock(target)}). "
                    f"The script needs about {more:,} more spoken words: explain each idea more slowly and fully, add worked examples, add scenes."
                )
            elif total > hi + 0.5:
                problems.append(f"The video is {fmt_clock(total)} but may run at most {fmt_clock(hi)} (target {fmt_clock(target)}). Tighten the script.")
        src = self.get_source(pid)
        if src:
            # a short (a reel from a long talk) can't cover every point; anything from 5 minutes up must
            if (target or 0) >= 300:
                cov = coverage(src["lines"], p["scenes"], p.get("sourceSkips") or [])
                out["coverage"] = cov
                if cov["missing"]:
                    shown = "; ".join(f"[{fmt_clock(ln['t'])}] {ln['text'][:90]}" for ln in cov["missing"][:12])
                    problems.append(
                        f"{len(cov['missing'])} of the source's {cov['total']} timed lines are in no scene's covers and not in sourceSkips: {shown}"
                        + (" ..." if len(cov["missing"]) > 12 else "")
                        + ". Teach each point in a scene (and list its time in that scene's covers), or skip it with a reason if it teaches nothing."
                    )
            grams = source_grams(src["lines"])
            for s in p["scenes"]:
                if s.get("kind") not in CLOSING_KINDS and (s.get("narration") or "").strip():
                    phrases = copied_phrases(s["narration"], grams)
                    if phrases:
                        out["copied"][s["id"]] = phrases
            if out["copied"]:
                shown = "; ".join(f'{sid}: "{ph[0]}"' for sid, ph in list(out["copied"].items())[:10])
                problems.append(
                    f"{len(out['copied'])} scene{'s' if len(out['copied']) != 1 else ''} repeat the source word for word ({COPY_RUN_WORDS} or more of its words in a row): {shown}. Say it your own way."
                )
        return out

    def script_markdown(self, pid: str) -> str:
        """The narration as a readable script, with parts, labels and timings (the chapters come from parts)."""
        p = self.get_project(pid)
        lines = [f"# {p['title']}", ""]
        start, part = 0.0, None
        total = sum(s["duration"] for s in p["scenes"])
        voiced = sum(1 for s in p["scenes"] if self.timing(pid, p, s)["voiced"])
        lines.append(f"Length {fmt_clock(total)}, {len(p['scenes'])} scenes, {voiced} voiced.")
        chapters = self.chapters(pid, p)
        if chapters:
            lines += ["", "## Chapters", ""] + [f"{fmt_clock(c['start'])} {c['title']}" for c in chapters]
        for i, s in enumerate(p["scenes"], 1):
            if s.get("part") and s["part"] != part:
                part = s["part"]
                lines += ["", f"## {part}"]
            lines += ["", f"### {i}. {s['name']} ({fmt_clock(start)}, {s['duration']:.1f} s)" + (f" - label: {s['label']}" if s.get("label") else "")]
            if s.get("narration"):
                lines.append(vc.CUE_RE.sub(" <cue/> ", s["narration"]).replace("  ", " ").strip())
            elif s.get("kind") == "endscreen":
                lines.append("(end screen)")
            if s.get("covers"):
                lines += ["", "Source: " + ", ".join(s["covers"])]
            start += s["duration"]
        src = self.get_source(pid)
        if src:
            review = self.plan_review(pid, p)
            cov = review["coverage"] or coverage(src["lines"], p["scenes"], p.get("sourceSkips") or [])
            lines += ["", "## Source coverage", "", f"{src['name']} ({fmt_clock(src['seconds'])}): {cov['covered']} of {cov['total']} timed lines covered, {cov['skipped']} skipped, {len(cov['missing'])} not covered."]
            for k in p.get("sourceSkips") or []:
                lines.append(f"- skipped {k['range']}: {k['reason']}")
            for ln in cov["missing"][:60]:
                lines.append(f"- not covered [{fmt_clock(ln['t'])}] {ln['text']}")
            for sid, phrases in review["copied"].items():
                lines.append(f"- {sid} repeats the source: \"{phrases[0]}\"")
        return "\n".join(lines) + "\n"

    def chapters(self, pid: str, p: dict | None = None) -> list[dict]:
        """YouTube chapters: one per part, at the time its first scene starts (the first at 0:00)."""
        p = p or self.get_project(pid)
        out, start, part = [], 0.0, None
        for s in p["scenes"]:
            if s.get("part") and s["part"] != part:
                part = s["part"]
                out.append({"start": round(start, 2), "title": part})
            start += s["duration"]
        if out:
            out[0]["start"] = 0.0
        return out

    # ── undo snapshots ──

    def snapshot(self, pid: str, label: str) -> None:
        """Copies project.json, the scene files and the thumbnail, so Undo can put them back."""
        with self.lock(pid):
            d = self._dir(pid)
            hist = d / "history"
            hist.mkdir(exist_ok=True)
            existing = sorted((int(x.name) for x in hist.iterdir() if x.name.isdigit()))
            n = (existing[-1] + 1) if existing else 1
            target = hist / str(n)
            shutil.copytree(d / "scenes", target / "scenes")
            shutil.copyfile(d / "project.json", target / "project.json")
            if (d / THUMBNAIL_FILE).exists():
                shutil.copyfile(d / THUMBNAIL_FILE, target / THUMBNAIL_FILE)
            write_json(target / "meta.json", {"label": label, "at": now()})
            for old in existing[: max(0, len(existing) + 1 - MAX_SNAPSHOTS)]:
                shutil.rmtree(hist / str(old), ignore_errors=True)

    def undo_info(self, pid: str) -> dict | None:
        hist = self._dir(pid) / "history"
        if not hist.exists():
            return None
        existing = sorted((int(x.name) for x in hist.iterdir() if x.name.isdigit()))
        if not existing:
            return None
        meta = read_json(hist / str(existing[-1]) / "meta.json", {})
        return {"label": meta.get("label", "the last change"), "at": meta.get("at"), "count": len(existing)}

    def undo(self, pid: str) -> dict:
        with self.lock(pid):
            d = self._dir(pid)
            hist = d / "history"
            existing = sorted((int(x.name) for x in hist.iterdir() if x.name.isdigit())) if hist.exists() else []
            if not existing:
                raise StoreError("Nothing to undo.", 409)
            snap = hist / str(existing[-1])
            current = self.get_project(pid)
            restored = read_json(snap / "project.json")
            shutil.rmtree(d / "scenes")
            shutil.copytree(snap / "scenes", d / "scenes")
            # the thumbnail as it was then (a snapshot without one is from before it existed)
            if (snap / THUMBNAIL_FILE).exists():
                shutil.copyfile(snap / THUMBNAIL_FILE, d / THUMBNAIL_FILE)
            else:
                (d / THUMBNAIL_FILE).unlink(missing_ok=True)
            shutil.rmtree(snap)
            # versions only go up, so the page and any running export notice the change
            restored["version"] = current["version"]
            for s in restored["scenes"]:
                s["rev"] = int(s.get("rev", 0)) + 1000
            if restored.get("thumbnail"):
                restored["thumbnail"]["rev"] = int(restored["thumbnail"].get("rev", 0)) + 1000
            if not (d / THUMBNAIL_FILE).exists():
                restored["thumbnail"] = None
            return self._save(pid, restored)

    # ── assets ──

    def assets_dir(self, pid: str) -> Path:
        return self._dir(pid) / "assets"

    def list_assets(self, pid: str) -> list[dict]:
        out = []
        for f in sorted(self.assets_dir(pid).iterdir()):
            if not f.is_file() or f.suffix == ".tmp":
                continue
            item = {"name": f.name, "kind": asset_kind(f.name), "bytes": f.stat().st_size}
            size = image_size(f) if item["kind"] == "image" else None
            if size:
                item["width"], item["height"] = size
            out.append(item)
        return out

    def save_asset(self, pid: str, filename: str, data: bytes) -> dict:
        name = safe_asset_name(filename)
        ext = os.path.splitext(name)[1]
        if ext not in ASSET_EXT:
            raise StoreError(f"{ext or 'This file type'} is not supported. Use images, audio, PDF, text or font files.")
        if len(data) > MAX_ASSET_BYTES:
            raise StoreError(f"The file is larger than {MAX_ASSET_BYTES // (1024 * 1024)} MB.")
        folder = self.assets_dir(pid)
        stem, i = os.path.splitext(name)[0], 2
        while (folder / name).exists():
            if (folder / name).read_bytes() == data:  # same file again: reuse it
                break
            name = f"{stem}-{i}{ext}"
            i += 1
        (folder / name).write_bytes(data)
        f = folder / name
        item = {"name": name, "kind": asset_kind(name), "bytes": len(data)}
        size = image_size(f) if item["kind"] == "image" else None
        if size:
            item["width"], item["height"] = size
        return item

    def asset_path(self, pid: str, name: str) -> Path:
        safe = Path(name).name
        f = self.assets_dir(pid) / safe
        if safe != name or not f.is_file():
            raise StoreError("No such asset.", 404)
        return f

    def delete_asset(self, pid: str, name: str) -> None:
        self.asset_path(pid, name).unlink()

    # ── chat ──

    # The page reads chat.json (totals, a pending question) while a turn rewrites it after every step. On
    # Windows a file someone is reading can't be replaced (WinError 5), so reads and writes take turns.
    def load_chat(self, pid: str) -> dict:
        with self.lock(f"chat:{pid}"):
            return read_json(self._dir(pid) / "chat.json", {"messages": [], "pending": None, "totals": {}})

    def save_chat(self, pid: str, chat: dict) -> None:
        with self.lock(f"chat:{pid}"):
            write_json(self._dir(pid) / "chat.json", chat)

    def load_log(self, pid: str) -> list[dict]:
        with self.lock(f"log:{pid}"):
            return read_json(self._dir(pid) / "log.json", [])

    def save_log(self, pid: str, log: list[dict]) -> None:
        with self.lock(f"log:{pid}"):
            write_json(self._dir(pid) / "log.json", log)

    def renders_dir(self, pid: str) -> Path:
        d = self._dir(pid) / "renders"
        d.mkdir(exist_ok=True)
        return d

    # ── the YouTube thumbnail ──

    def write_thumbnail(self, pid: str, html: str, props: dict | None = None, base_rev: int | None = None) -> tuple[dict, list[str]]:
        """Saves the thumbnail: one still in the scene file format (style, markup, script), its props in
        project.json's `thumbnail` ({rev, updatedAt, props}). Returns (project, warnings). The caller takes
        the undo snapshot first (Claude's turn does; the page's edit does). base_rev refuses a direct edit
        made over a newer version (409), like a scene's."""
        with self.lock(pid):
            p = self.get_project(pid)
            if not isinstance(html, str) or not html.strip():
                raise StoreError("html must be the thumbnail's full source")
            if len(html.encode("utf-8")) > MAX_SCENE_BYTES:
                raise StoreError(f"The thumbnail is larger than {MAX_SCENE_BYTES // 1000} KB; simplify it.")
            old = p.get("thumbnail") or {}
            if base_rev is not None and base_rev != old.get("rev", 0):
                raise StoreError("The thumbnail changed in the meantime (Claude or Undo edited it). Your view is now up to date; make the change again.", 409)
            clean = _clean_props(props if isinstance(props, dict) else old.get("props") or {})
            write_text(self._dir(pid) / THUMBNAIL_FILE, html)
            p["thumbnail"] = {"rev": int(old.get("rev", 0)) + 1, "updatedAt": now(), "props": clean}
            return self._save(pid, p), check_thumbnail(html, clean)

    def thumbnail_source(self, pid: str) -> str | None:
        f = self._dir(pid) / THUMBNAIL_FILE
        return f.read_text(encoding="utf-8") if f.exists() else None

    def thumbnail_key(self, pid: str, runtime: str = "") -> str | None:
        """A cheap stand-in for the rendered thumbnail's content hash, from project.json and kit.json alone (no
        scene files, no voice clips): the thumbnail's rev and save time (every write and undo changes them),
        the brand kit and its last change, the closing settings the brand shows, the aspect and the player's
        version. None before there is a thumbnail. The picture is cached under this key, so serving an
        unchanged thumbnail never rebuilds the bundle."""
        p = self.get_project(pid)
        th = p.get("thumbnail")
        if not th or not (self._dir(pid) / THUMBNAIL_FILE).exists():
            return None
        kit = self.get_kit(p.get("brandKitId")) or {}
        raw = [runtime, th.get("rev"), th.get("updatedAt"), p.get("brandKitId"), kit.get("updatedAt"), kit.get("seedVersion"), p.get("aspect"), closing_of(p)]
        return hashlib.sha256(json.dumps(raw, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]

    def thumbnail_view(self, pid: str, runtime: str = "") -> dict:
        """What the page's thumbnail editor shows: {html, props, rev, url}; html and url are None before there
        is one. The url's v changes whenever the picture can (the thumbnail or the brand), so the page may
        cache it for good."""
        p = self.get_project(pid)
        th = p.get("thumbnail") or {}
        html = self.thumbnail_source(pid) if th else None
        key = self.thumbnail_key(pid, runtime) if html is not None else None
        return {
            "html": html,
            "props": th.get("props") or {},
            "rev": th.get("rev", 0),
            "url": f"/api/motion/projects/{pid}/thumbnail.jpg?v={th.get('rev', 0)}-{key[:8]}" if key else None,
        }

    def thumbnail_bundle(self, pid: str) -> dict:
        """The project's bundle with its scenes replaced by the thumbnail alone: a 3 second "thumbnail" scene
        (a still with no frame chrome, label or page change) that the renderer photographs at 2.95 s. The
        stage is 16:9 whatever the video's aspect (1600 x 900 in the paper look, 1920 x 1080 otherwise),
        since YouTube shows the thumbnail at 1280 x 720."""
        th = self.get_project(pid).get("thumbnail")
        source = self.thumbnail_source(pid) if th else None
        if source is None:
            raise StoreError("This video has no thumbnail yet.", 404)
        b = self.bundle(pid)
        if b["theme"] != "paper":
            b["aspect"], b["width"], b["height"] = "16:9", *ASPECTS["16:9"]
        b["scenes"] = [
            {
                "id": "thumbnail",
                "kind": "thumbnail",
                "name": "Thumbnail",
                "idea": "The YouTube thumbnail",
                "start": 0.0,
                "duration": 3.0,
                "transition": "cut",
                "label": "",
                "part": "",
                "narration": "",
                "hold": 0,
                "lead": 0.3,
                "speech": 0.0,
                "cues": [0.3],
                "voiced": False,
                "stale": False,
                "props": th.get("props") or {},
                "levers": [],
                "rev": th.get("rev", 0),
                "status": "written",
                "source": source,
            }
        ]
        b["duration"] = 3.0
        b["narration"] = None  # a still: no voice, music or sounds
        b["audio"] = None
        return b

    # ── what the player and Claude see ──

    def bundle(self, pid: str) -> dict:
        """Everything the player needs to draw the video: settings, brand tokens, scenes with their code."""
        p = self.get_project(pid)
        self._derive(pid, p)
        d = self._dir(pid)
        width, height = self.stage_size(p)
        kit = self.get_kit(p.get("brandKitId")) or {**DEFAULT_KIT, "id": None}
        brand = {k: kit.get(k) for k in ("id", "name", "palette", "extras", "fonts", "radius", "motion", "background", "endCard", "theme", "tagline", "wordmark")}
        brand["wordmark"] = brand.get("wordmark") or kit.get("name")
        v = int(kit.get("updatedAt", 0))
        brand["logoUrl"] = f"/api/motion/brand-kits/{kit['id']}/logo?v={v}" if kit.get("logo") and kit.get("id") else None
        brand["iconUrl"] = f"/api/motion/brand-kits/{kit['id']}/icon?v={v}" if kit.get("icon") and kit.get("id") else None
        closing = closing_of(p)
        brand["showLogo"] = closing["logo"]  # the frame's logo card (off on a Udemy film)
        brand["showUrl"] = closing["url"]  # the frame's web address (off on a Udemy film)
        scenes, start = [], 0.0
        for s in p["scenes"]:
            f = d / s["file"]
            t = self.timing(pid, p, s)
            scenes.append(
                {
                    "id": s["id"],
                    "kind": s.get("kind", "scene"),
                    "name": s["name"],
                    "idea": s.get("idea", ""),
                    "start": round(start, 3),
                    "duration": s["duration"],
                    "transition": s["transition"],
                    "label": s.get("label", ""),
                    "part": s.get("part", ""),
                    "narration": s.get("narration", ""),
                    "hold": s.get("hold", 0),
                    "lead": t["lead"],
                    "speech": t["speech"],
                    "cues": t["cues"],
                    "voiced": t["voiced"],
                    "stale": t["stale"],
                    "props": s.get("props", {}),
                    "levers": s.get("levers", []),
                    "rev": s.get("rev", 0),
                    "status": s.get("status", "planned"),
                    "source": f.read_text(encoding="utf-8") if f.exists() else None,
                }
            )
            start += s["duration"]
        track = self.narration_plan(pid, p)
        return {
            "projectId": pid,
            "version": p["version"],
            "title": p["title"],
            "aspect": p["aspect"],
            "theme": kit.get("theme") or "plain",
            "destination": destination_of(p),
            "closing": closing,
            "width": width,
            "height": height,
            "fps": p.get("fps", FPS),
            "duration": round(start, 3),
            "brand": brand,
            "assetBase": f"/api/motion/projects/{pid}/assets/",
            "themeBase": "/assets/motion/",
            "audio": f"/api/motion/projects/{pid}/assets/{p['audio']}" if p.get("audio") else None,
            "narration": {"url": f"/api/motion/projects/{pid}/narration.m4a?h={track['hash']}", "hash": track["hash"]} if track["clips"] else None,
            "scenes": scenes,
        }

    def narration_plan(self, pid: str, p: dict | None = None) -> dict:
        """Where each voiced scene's clip starts in the video, and a hash of that layout (the track's cache key)."""
        p = p or self.get_project(pid)
        self._derive(pid, p)
        clips, start, keys = [], 0.0, []
        vdir = self._dir(pid) / "voice"
        for s in p["scenes"]:
            t = self.timing(pid, p, s)
            if t["voiced"]:
                clips.append((round(start + t["lead"], 3), vdir / f"{t['hash']}.mp3"))
                keys.append([round(start + t["lead"], 3), t["hash"]])
            start += s["duration"]
        h = hashlib.sha256(json.dumps([keys, round(start, 3)]).encode()).hexdigest()[:16]
        return {"hash": h, "clips": clips, "total": round(start, 3)}

    def caption_cues(self, pid: str, p: dict | None = None) -> list[dict]:
        """The video's captions as cues [{start, end, text}] in seconds: the written narration (no cue marks,
        the pronunciation table not applied, so "LLM" stays "LLM"), timed by the voice. A voiced scene's words
        sit where its clip says them, placed like the narration track (the scene's start plus its lead plus
        the character's time); a narrated scene without its voice yet uses the estimate (2.9 words a second)."""
        p = p or self.get_project(pid)
        self._derive(pid, p)
        table = p.get("pronunciations") or []
        vdir = self._dir(pid) / "voice"
        cues: list[dict] = []
        start = 0.0
        for s in p["scenes"]:
            t = self.timing(pid, p, s)
            words = vc.caption_text(s.get("narration") or "").split() if t["narrated"] else []
            if words:
                clip = vc.load_clip(vdir, t["hash"]) if t["voiced"] else None
                base = start + t["lead"]
                char_times = (clip.get("charTimes") or []) if clip else None  # None: no voice yet, use the estimate
                timed = vc.timed_words(words, table, t["spoken"], t["speech"], char_times)
                # one passage per scene: a caption never runs across a page change
                cues += vc.caption_cues([(w, base + a, base + b) for w, a, b in timed])
            start += s["duration"]
        return vc.settle_cues(cues, start)

    def captions(self, pid: str, fmt: str) -> str:
        """The captions as SRT or WebVTT text (fmt "srt" or "vtt")."""
        if fmt not in ("srt", "vtt"):
            raise StoreError("Captions come as srt or vtt.")
        cues = self.caption_cues(pid)
        return vc.to_srt(cues) if fmt == "srt" else vc.to_vtt(cues)

    def voice_status(self, pid: str) -> dict:
        p = self.get_project(pid)
        rows, chars_needed = [], 0
        for s in p["scenes"]:
            t = self.timing(pid, p, s)
            if not t["narrated"]:
                continue
            # made before (by this video, or by another one with the same words): linking it costs nothing
            exists = vc.load_clip(self._dir(pid) / "voice", t["hash"]) is not None or vc.load_clip(self.voice_cache_dir, t["hash"]) is not None
            state = "voiced" if t["voiced"] else ("ready" if exists else ("changed" if t["stale"] else "none"))
            if state in ("none", "changed"):
                chars_needed += t["chars"]
            rows.append({"id": s["id"], "name": s["name"], "state": state, "words": t["words"], "chars": t["chars"], "seconds": t["speech"]})
        return {
            "voice": {k: self.voice_of(p)[k] for k in ("id", "name", "model")},
            "scenes": rows,
            "charsNeeded": chars_needed,
            "voiced": sum(1 for r in rows if r["state"] == "voiced"),
            "total": len(rows),
            "keySet": vc.api_key() is not None,
        }

    def state_summary(self, pid: str) -> str:
        """The project as text, sent with every message so Claude works from what is really there."""
        p = self.get_project(pid)
        self._derive(pid, p)
        w, h = self.stage_size(p)
        kit = self.get_kit(p.get("brandKitId"))
        total = sum(s["duration"] for s in p["scenes"])
        theme = (kit or {}).get("theme") or "plain"
        lines = [f'<project_state version="{p["version"]}">']
        lines.append(f'title: {p["title"]}')
        lines.append(f'theme: {theme}' + (" (the AlgoInsight daily paper look: the frame draws the logo card, title, part tag and watermark; scenes draw the page)" if theme == "paper" else ""))
        lines.append(f'aspect: {p["aspect"]} (stage {w} x {h} px), {p.get("fps", FPS)} fps, length now {fmt_clock(total)}')
        closing = closing_of(p)
        if destination_of(p) == "udemy":
            lines.append("made for: Udemy. No website, URL, price or platform of ours (AlgoInsight) on screen or in the narration; the frame has no logo card or web address, and there is no promo or end screen")
        else:
            on = [n for k, n in (("logo", "logo card"), ("url", "web address"), ("promo", "AlgoInsight promo"), ("endscreen", "end screen")) if closing[k]]
            lines.append("made for: YouTube; the video's settings add " + (", ".join(on) if on else "nothing") + " (the promo and the end screen are added after your scenes; never plan, write or edit them)")
        review = self.plan_review(pid, p)
        if review["window"]:
            lo, hi = review["window"]
            lines.append(f'target length: {fmt_clock(p["targetSeconds"])}; the whole video must run between {fmt_clock(lo)} and {fmt_clock(hi)}')
        src = self.get_source(pid)
        if src:
            cov = review["coverage"]
            line = f'source: {src["name"]}, {fmt_clock(src["seconds"])}, {len(src["lines"])} timed lines (the points to cover; read_source lists them with what covers each)'
            if cov:
                line += f'; {cov["covered"]} covered by scenes, {cov["skipped"]} skipped, {len(cov["missing"])} not covered yet'
            lines.append(line)
            if p.get("sourceSkips"):
                lines.append("source skips: " + "; ".join(f'{k["range"]} ({k["reason"]})' for k in p["sourceSkips"]))
        refs = p.get("references") or []
        if refs:
            lines.append(f'references: {len(refs)} screenshots of the source, {ref_clock(refs[0]["t"])}-{ref_clock(refs[-1]["t"])} (view_references; to look at, never to show)')
        if review["problems"]:
            lines.append("before any scene code (write_scene is refused until these are fixed):")
            lines += [f"  - {x}" for x in review["problems"]]
        elif (p.get("targetSeconds") or src) and p["scenes"]:
            lines.append("script check: length, source coverage and own wording all pass")
        if p.get("brief"):
            lines.append("brief: " + json.dumps(p["brief"], ensure_ascii=False, sort_keys=True))
        vs = self.voice_status(pid)
        voice = self.voice_of(p)
        lines.append(f'voice: {voice["name"]} on {voice["model"]}; {vs["voiced"]} of {vs["total"]} narrated scenes voiced (the user makes the audio with Generate voice)')
        if p.get("pronunciations"):
            lines.append("pronunciations: " + "; ".join(f'{e["written"]} -> {e["spoken"]}' for e in p["pronunciations"][:60]))
        docs = self.list_docs(pid)
        if docs:
            lines.append("documents: " + ", ".join(d["name"] for d in docs))
        th = p.get("thumbnail")
        if th and (self._dir(pid) / THUMBNAIL_FILE).exists():
            tprops = json.dumps(th.get("props") or {}, ensure_ascii=False, sort_keys=True)
            lines.append(f'thumbnail: written (rev {th.get("rev", 0)}), props {tprops[:300] + "...}" if len(tprops) > 300 else tprops}; write_thumbnail replaces it')
        else:
            lines.append("thumbnail: none yet (design it with write_thumbnail at the hand-off)")
        if kit:
            pal = ", ".join(f"{k} {v}" for k, v in kit["palette"].items())
            ext = ", ".join(f"{k} {v}" for k, v in (kit.get("extras") or {}).items())
            lines.append(f'brand kit: {kit["name"]} (id {kit["id"]}{", has a logo" if kit.get("logo") else ", no logo"})')
            lines.append(f"  palette: {pal}" + (f"; extras: {ext}" if ext else ""))
            lines.append(f'  fonts: display {kit["fonts"].get("display")}, body {kit["fonts"].get("body")}, mono {kit["fonts"].get("mono")}; radius {kit.get("radius")}px; motion {kit.get("motion")}')
            if kit.get("background"):
                lines.append("  background: set (var(--bg-image))")
            if kit.get("style"):
                lines.append("  style notes: " + kit["style"].replace("\n", " ")[:600])
            ec = kit.get("endCard") or {}
            if ec.get("enabled"):
                lines.append(f'  end card: headline "{ec.get("headline", "")}", cta "{ec.get("cta", "")}", url "{ec.get("url", "")}"')
        else:
            lines.append("brand kit: none (use the defaults)")
        refs_named = self.reference_assets(p)  # the references have their own line above
        assets = [a for a in self.list_assets(pid) if a["name"] not in refs_named]
        if assets:
            lines.append("assets: " + ", ".join(a["name"] + (f' ({a["width"]}x{a["height"]})' if a.get("width") else f' ({a["kind"]})') for a in assets))
        if p.get("audio"):
            lines.append(f'soundtrack: {p["audio"]}')
        if p["scenes"]:
            lines.append("scenes (start, length, transition in, code status, part, label, narration words and cues, voice, props):")
            start = 0.0
            for i, s in enumerate(p["scenes"], 1):
                t = self.timing(pid, p, s)
                props = json.dumps(s.get("props", {}), ensure_ascii=False, sort_keys=True)
                if len(props) > 300:
                    props = props[:300] + "...}"
                extra = []
                if s.get("kind") == "endscreen":
                    extra.append("END SCREEN (drawn by the player, added by the settings)")
                elif s.get("kind") == "promo":
                    extra.append("ALGOINSIGHT PROMO (added by the settings; leave it alone)")
                if s.get("part"):
                    extra.append(f'part "{s["part"]}"')
                if s.get("label"):
                    extra.append(f'label "{s["label"]}"')
                if t["narrated"]:
                    extra.append(f'{t["words"]} words, {vc.count_cues(s["narration"])} cues, ' + ("voiced" if t["voiced"] else "voice changed" if t["stale"] else "estimated timing"))
                if s.get("covers"):
                    extra.append("covers " + ", ".join(s["covers"]))
                lines.append(f'  {i}. {s["id"]} "{s["name"]}" at {fmt_clock(start)}, {s["duration"]:.1f} s, {s["transition"]}, {s.get("status", "planned")}' + (", " + ", ".join(extra) if extra else "") + f", props {props}")
                start += s["duration"]
        else:
            lines.append("scenes: none yet")
        lines.append("</project_state>")
        return "\n".join(lines)


def fmt_clock(seconds: float) -> str:
    s = int(round(seconds or 0))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def _clean_pronunciations(entries) -> list[dict]:
    out = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        written = str(e.get("written") or "").strip()[:40]
        said = str(e.get("spoken") or "").strip()[:80]
        if written:
            out.append({"written": written, "spoken": said})
    return out[:200]


# The short forms the AlgoInsight films always say this way (the founder's decisions; more per video).
DEFAULT_PRONUNCIATIONS = [
    {"written": "AI", "spoken": "A-I"},
    {"written": "LLM", "spoken": "L-L-M"},
    {"written": "LLMs", "spoken": "L-L-Ms"},
    {"written": "API", "spoken": "A-P-I"},
    {"written": "APIs", "spoken": "A-P-Is"},
    {"written": "CI/CD", "spoken": "C-I C-D"},
    {"written": "IP", "spoken": "I-P"},
    {"written": "CPU", "spoken": "C-P-U"},
]


def _clean_props(props: dict) -> dict:
    out = {}
    for k, v in list(props.items())[:40]:
        key = re.sub(r"[^\w-]+", "", str(k))[:40]
        if not key:
            continue
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[key] = v if not isinstance(v, str) else v[:2000]
        elif isinstance(v, list):
            out[key] = [x if not isinstance(x, str) else x[:500] for x in v[:50] if isinstance(x, (str, int, float, bool))]
    return out


LEVER_TYPES = ("text", "textarea", "color", "number", "image", "select", "toggle")


def _clean_levers(levers: list) -> list[dict]:
    out = []
    for lv in levers[:30]:
        if not isinstance(lv, dict) or not lv.get("key"):
            continue
        t = lv.get("type") if lv.get("type") in LEVER_TYPES else "text"
        item = {"key": str(lv["key"])[:40], "type": t, "label": str(lv.get("label") or lv["key"])[:60]}
        for k in ("min", "max", "step"):
            if isinstance(lv.get(k), (int, float)):
                item[k] = lv[k]
        if t == "select" and isinstance(lv.get("options"), list):
            item["options"] = [str(o)[:60] for o in lv["options"][:20]]
        out.append(item)
    return out


# ── seed brand kits ────────────────────────────────────────────────────────────

DEFAULT_KIT = {
    "name": "Default",
    "palette": {"bg": "#0f1115", "surface": "#1b1f2a", "ink": "#f5f5f2", "muted": "#9aa1ad", "accent": "#4f8cff", "accent2": "#f5b14c"},
    "extras": {},
    "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono", "hand": "Caveat"},
    "radius": 12,
    "motion": "snappy",
    "theme": "plain",
    "tagline": "",
    "background": "",
    "style": "",
    "endCard": {"enabled": False, "headline": "", "cta": "", "url": ""},
}

SEED_VERSION = 3  # bump when the seed kits gain fields, so older installs are upgraded

SEED_KITS = [
    {
        "id": "algoinsight",
        "name": "AlgoInsight",
        "builtin": True,
        "theme": "plain",
        "tagline": "YOUR MENTOR FROM PREP TO OFFER",
        "wordmark": "AlgoInsight",
        "_iconSeed": "algoinsight-icon.png",
        "_logoSeed": "algoinsight-logo-white.png",
        "palette": {"bg": "#0b1020", "surface": "#141b34", "ink": "#ffffff", "muted": "#94a3b8", "accent": "#6366f1", "accent2": "#9333ea"},
        "extras": {"lavender": "#c7d2fe", "violet": "#c084fc", "pink": "#f0abfc", "good": "#22c55e", "bad": "#ef4444"},
        "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"},
        "radius": 16,
        "motion": "snappy",
        "background": "radial-gradient(1200px 900px at 15% 10%, rgba(99,102,241,0.28), transparent 60%), radial-gradient(1000px 800px at 90% 85%, rgba(147,51,234,0.22), transparent 60%)",
        "style": "Navy night background with soft indigo and purple glows. Headings in Inter 800 with tight tracking; the key word can take the indigo-to-purple gradient (var(--accent) to var(--accent2)). Cards are var(--surface) with a 1px border in rgba(255,255,255,0.08) and the kit radius. The logo is the white horizontal lockup.",
        "endCard": {"enabled": True, "headline": "Your mentor from prep to offer", "cta": "Learn it properly at", "url": "algoinsight.io"},
    },
    {
        "id": "algoinsight-paper",
        "name": "AlgoInsight Paper",
        "builtin": True,
        "_logoSeed": "algoinsight-logo.png",
        "_iconSeed": "algoinsight-icon.png",
        "theme": "paper",
        "tagline": "YOUR MENTOR FROM PREP TO OFFER",
        "wordmark": "AlgoInsight",
        "palette": {"bg": "#f1f6fd", "surface": "#ffffff", "ink": "#141414", "muted": "#475569", "accent": "#fde047", "accent2": "#e11d48"},
        "extras": {"grid": "#cddef4", "grid-strong": "#aecaec", "lemon": "#fef08a", "sky": "#bfdbfe", "mint": "#bbf7d0", "pink": "#fbcfe8", "peach": "#fed7aa", "pass": "#16a34a", "fail": "#dc2626", "window": "#0b1020", "ink-2": "#475569", "faint": "#94a3b8", "chrome-title": "#334155", "marker": "#fde047", "pen": "#e11d48", "stamp-ok": "#15803d"},
        "fonts": {"display": "Bricolage Grotesque", "body": "Inter", "mono": "JetBrains Mono", "hand": "Caveat"},
        "radius": 18,
        "motion": "snappy",
        "background": "linear-gradient(#aecaec 1.4px, transparent 1.4px) 0 0 / 140px 140px, linear-gradient(90deg, #aecaec 1.4px, transparent 1.4px) 0 0 / 140px 140px, linear-gradient(#cddef4 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, #cddef4 1px, transparent 1px) 0 0 / 28px 28px",
        "style": "The AlgoInsight daily films: paper and ink on pale blue graph paper. Use the paper components (p-card, p-sticky, p-head, p-marked, p-note, p-arrow, p-stamp, p-badge, p-window) and the fx entrances. Thick ink edges and hard offset shadows, never soft shadows or gradients. Marker behind key words, red pen for asides, one sticker-like accent at a time. Blue graph paper and cool slate greys, never cream.",
        "endCard": {"enabled": True, "headline": "Your mentor from prep to offer", "cta": "Learn it properly at", "url": "algoinsight.io"},
    },
]
