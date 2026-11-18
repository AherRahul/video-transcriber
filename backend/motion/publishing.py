"""
Where a video goes and what its upload needs: YouTube playlists and Udemy courses (collections), each video's
place in one (episode or lecture number, Udemy section), its publishing details in one fixed format, and
how far it has got (exported, downloaded, uploaded).

The details are what a top educational creator pastes into the upload, nothing more: the title, the post
description and the tags for YouTube; the lecture title, its description and a quiz for Udemy. Every field is
plain text (YouTube and Udemy show Markdown as typed, so it is stripped), and nothing promises what the
video doesn't deliver.

YouTube (one video in a playlist)
  titles          3 to 5 options, at most 70 characters (YouTube cuts the rest), the main keyword early
  title           the one chosen (the first option until the user picks)
  primaryKeyword  the phrase people search for this topic: in the title and the description's first line
  description     the post, 200 to 350 words of plain text: a first line of at most 150 characters with the
                  main keyword (all that search shows), what the viewer learns, the key points, the episodes
                  either side by name, real links; a {chapters} line where the chapters go (filled from the
                  video's parts, so they follow the voice's timing)
  hashtags        3 to 5, put on the last line (YouTube shows the first 3 above the title)
  tags            10 to 15 search phrases, under 500 characters together
  post            the user's own final text from Details, used as it is (its chapter lines still follow the
                  video); Claude writing a new description clears it

Udemy (one lecture in a course; no AlgoInsight website, URL, price or platform anywhere)
  lectureTitle        at most 80 characters, the skill or concept first
  lectureDescription  2 to 4 sentences: what the learner will understand or be able to do
  objectives          2 to 4 measurable outcomes ("explain", "choose", "calculate")
  keyTerms, resources the terms the lecture introduces; real links only
  quiz                2 or 3 questions: {question, options (4), answer (index), why}
  freePreview         whether it works as the course's free preview, and freePreviewWhy
  post                the user's own final lecture description

Collections: a YouTube playlist {title, description}; a Udemy course {title (60), subtitle (120),
description (200 words or more), objectives (4 or more), requirements, audience, level}.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from pathlib import Path

KINDS = {"youtube": "YouTube playlist", "udemy": "Udemy course"}
LEVELS = ("Beginner", "Intermediate", "Expert", "All levels")
CHAPTERS_MARK = "{chapters}"  # where the chapters go in Claude's description

# what each field may hold: (kind, max length) or (kind, max items, max length of each)
YOUTUBE_FIELDS = {
    "titles": ("list", 5, 100),
    "title": ("text", 100),
    "primaryKeyword": ("text", 100),
    "description": ("plain", 4500),
    "hashtags": ("list", 5, 60),
    "tags": ("list", 20, 100),
    "post": ("plain", 5000),  # YouTube's limit for a description
}
UDEMY_FIELDS = {
    "lectureTitle": ("text", 80),
    "lectureDescription": ("plain", 2000),
    "objectives": ("list", 6, 200),
    "keyTerms": ("list", 15, 80),
    "resources": ("links", 12),
    "quiz": ("quiz", 5),
    "freePreview": ("bool",),
    "freePreviewWhy": ("text", 300),
    "post": ("plain", 4000),
}
PLAYLIST_FIELDS = {"title": ("text", 150), "description": ("plain", 5000)}
COURSE_FIELDS = {
    "title": ("text", 60), "subtitle": ("text", 120), "description": ("plain", 6000), "objectives": ("list", 12, 160),
    "requirements": ("list", 8, 160), "audience": ("list", 8, 160), "level": ("level",),
}
TAGS_TOTAL = 500  # YouTube's limit for all tags together
TITLE_SHOWN = 70  # what YouTube shows of a title before it cuts it
HOOK_SHOWN = 150  # what search shows of a description

# zero-width characters a paste brings along (a name like "AI​​System" looks right and isn't)
_INVISIBLE = re.compile("[​-‍⁠﻿]")


class PublishingError(Exception):
    pass


def _text(v, limit: int) -> str:
    s = _INVISIBLE.sub("", str(v or ""))
    s = s.replace("**", "")  # bold marks show as typed on YouTube and Udemy
    return re.sub(r"[ \t]+", " ", s).strip()[:limit]


def plain_text(v, limit: int) -> str:
    """Text as YouTube and Udemy show it: Markdown taken out (headings, bold, code marks, [label](link)),
    bullets as "- ", at most one empty line between paragraphs."""
    s = _INVISIBLE.sub("", str(v or "")).replace("\r\n", "\n")
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"(?<![\w])__(.+?)__(?![\w])", r"\1", s)
    s = s.replace("**", "").replace("`", "")
    s = re.sub(r"(?m)^[ \t]{0,3}#{1,6}[ \t]+", "", s)  # a heading line (a hashtag has no space after #)
    s = re.sub(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)", r"\1: \2", s)
    s = re.sub(r"(?m)^[ \t]*[*•][ \t]+", "- ", s)
    s = re.sub(r"(?m)^[ \t]*>[ \t]?", "", s)  # quote marks
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()[:limit]


def url_ok(url: str) -> bool:
    return bool(re.match(r"^https?://[^\s/$.?#].[^\s]*$", url))


def clean_fields(raw: dict, spec: dict) -> dict:
    """Keeps the known fields, each trimmed to what it may hold. Unknown fields are dropped."""
    if not isinstance(raw, dict):
        raise PublishingError("details must be an object")
    out: dict = {}
    for key, rule in spec.items():
        if key not in raw:
            continue
        v = raw[key]
        kind = rule[0]
        if kind == "text":
            out[key] = _text(v, rule[1])
        elif kind == "plain":
            out[key] = plain_text(v, rule[1])
        elif kind == "list":
            items = v if isinstance(v, list) else [x for x in re.split(r"[\n,]", str(v or ""))]
            seen, kept = set(), []
            for t in (_text(x, rule[2]) for x in items):
                if t and t.lower() not in seen:
                    seen.add(t.lower())
                    kept.append(t)
            out[key] = kept[: rule[1]]
        elif kind == "links":
            links = []
            for item in v if isinstance(v, list) else []:
                if isinstance(item, dict) and url_ok(str(item.get("url") or "").strip()):
                    links.append({"label": _text(item.get("label") or item["url"], 120), "url": str(item["url"]).strip()[:500]})
            out[key] = links[: rule[1]]
        elif kind == "quiz":
            qs = []
            for q in v if isinstance(v, list) else []:
                if not isinstance(q, dict) or not _text(q.get("question"), 300):
                    continue
                options = [_text(o, 200) for o in (q.get("options") or [])][:6]
                answer = q.get("answer")
                qs.append({
                    "question": _text(q.get("question"), 300),
                    "options": options,
                    "answer": answer if isinstance(answer, int) and 0 <= answer < len(options) else None,
                    "why": _text(q.get("why"), 300),
                })
            out[key] = qs[: rule[1]]
        elif kind == "bool":
            out[key] = bool(v)
        elif kind == "level":
            out[key] = v if v in LEVELS else None
    if "hashtags" in out:
        tags = []
        for h in out["hashtags"]:
            word = re.sub(r"[^\w]", "", h.lstrip("#"))
            if word and ("#" + word).lower() not in (t.lower() for t in tags):
                tags.append("#" + word)
        out["hashtags"] = tags
    if "tags" in out:
        kept, total = [], 0
        for t in out["tags"]:
            if total + len(t) + 1 > TAGS_TOTAL:
                break
            kept.append(t)
            total += len(t) + 1
        out["tags"] = kept
    return out


def _words(s: str) -> list[str]:
    return [w.lower().removesuffix("'s") for w in re.findall(r"[A-Za-z0-9][A-Za-z0-9'.+#-]*", s or "")]


def keyword_missing(keyword: str, text: str) -> list[str]:
    """The keyword's words that the text doesn't have (a word counts when the text has it or a longer form
    of it: "chatgpt" in "ChatGPT's", "learn" in "learning")."""
    have = _words(text)
    return [w for w in _words(keyword) if not any(h == w or h.startswith(w) for h in have)]


def details_warnings(platform: str, d: dict) -> list[str]:
    """What a top creator would still fix (said back to Claude after write_details, and shown in Details)."""
    w = []
    if platform == "youtube":
        titles = d.get("titles") or []
        if len(titles) < 3:
            w.append("give 3 to 5 title options")
        for t in titles:
            if len(t) > TITLE_SHOWN:
                w.append(f'title "{t}" is {len(t)} characters: YouTube cuts it after about {TITLE_SHOWN}')
            elif len(t) < 30:
                w.append(f'title "{t}" is only {len(t)} characters: say what the video teaches, with the search phrase')
        kw = d.get("primaryKeyword") or ""
        desc = d.get("post") or d.get("description") or ""
        if not kw:
            w.append("name the main keyword (primaryKeyword): the phrase people search for this topic")
        else:
            if d.get("title") and keyword_missing(kw, d["title"]):
                w.append(f'the title doesn\'t carry the main keyword "{kw}"')
            if desc and keyword_missing(kw, desc[:HOOK_SHOWN]):
                w.append(f'the description\'s first {HOOK_SHOWN} characters (all that search shows) don\'t carry "{kw}"')
        n = len(_words(desc))
        if n < 200:
            w.append(f"the description has {n} words: write 200 to 350, so search knows what the video covers")
        elif n > 500:
            w.append(f"the description has {n} words: keep it under about 350, the viewer reads the top")
        if not 3 <= len(d.get("hashtags") or []) <= 5:
            w.append(f"{len(d.get('hashtags') or [])} hashtags: use 3 to 5 (the first 3 show above the title)")
        if not 10 <= len(d.get("tags") or []) <= 15:
            w.append(f"{len(d.get('tags') or [])} tags: aim for 10 to 15")
    else:
        if not 2 <= len(d.get("objectives") or []) <= 4:
            w.append("2 to 4 objectives")
        if not 2 <= len(d.get("quiz") or []) <= 3:
            w.append("2 or 3 quiz questions")
        if any(q.get("answer") is None or len(q.get("options") or []) != 4 for q in d.get("quiz") or []):
            w.append("each quiz question needs 4 options and the answer's index")
        text = " ".join(str(v) for v in d.values()).lower()
        if "algoinsight" in text:
            w.append("a Udemy lecture can't name AlgoInsight (no website, URL, price or platform of ours)")
    return w


_TS_LINE = re.compile(r"^\s*\d{1,2}:\d{2}(?::\d{2})?\s+\S")


_PART_PREFIX = re.compile(r"^\s*part\s+\d+\s*[·:.\-]\s*", re.IGNORECASE)


def chapter_lines(chapters: list[dict], clock) -> str:
    """The chapters as YouTube reads them: a time and the part's own name ("Part 2 · Three sources" becomes
    "Three sources": the name is what search shows as a key moment)."""
    return "\n".join(f"{clock(c['start'])} {_PART_PREFIX.sub('', c['title']) or c['title']}" for c in chapters)


def refresh_chapters(text: str, lines: str) -> str:
    """The user's own text with its chapter lines (the run of time stamps from 0:00) replaced by the video's
    current ones, so a new voice's timing still reaches a description edited by hand."""
    rows = text.split("\n")
    for i, row in enumerate(rows):
        if _TS_LINE.match(row) and row.strip().startswith("0:00"):
            j = i
            while j < len(rows) and _TS_LINE.match(rows[j]):
                j += 1
            return "\n".join(rows[:i] + lines.split("\n") + rows[j:])
    return text


def youtube_description(d: dict, chapters: list[dict], clock) -> str:
    """The post as it is pasted into YouTube: the user's own text when they edited it in Details, else
    Claude's description with the chapters where it put {chapters} (or at the end) and the hashtags last."""
    lines = chapter_lines(chapters, clock) if len(chapters) >= 2 else ""
    if d.get("post"):
        return refresh_chapters(d["post"], lines) if lines else d["post"]
    body = (d.get("description") or "").strip()
    block = f"Chapters\n{lines}" if lines else ""
    if CHAPTERS_MARK in body:
        body = re.sub(r"[ \t]*\{chapters\}[ \t]*", lambda _: block, body)
    elif block and body:
        body = f"{body}\n\n{block}"
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    tags = [h for h in d.get("hashtags") or [] if h.lower() not in body.lower()]
    return (body + ("\n\n" + " ".join(tags) if tags else "")).strip()


def udemy_description(d: dict) -> str:
    """The lecture description as it is pasted into Udemy: the user's own text, else the description and
    what the learner will be able to do."""
    if d.get("post"):
        return d["post"]
    parts = [d["lectureDescription"]] if d.get("lectureDescription") else []
    if d.get("objectives"):
        parts.append("By the end of this lecture you will be able to:\n" + "\n".join(f"- {o}" for o in d["objectives"]))
    return "\n\n".join(parts)


def details_markdown(title: str, place: str, details: dict, chapters: list[dict], clock) -> str:
    """Every publishing detail of one video in one file (the publishing kit): each field under its name, the
    text itself exactly as it is pasted."""
    out = [f"# {title}", "", place, ""]
    yt = details.get("youtube") or {}
    if yt:
        out += ["## YouTube", ""]
        if yt.get("title"):
            out += ["Title:", yt["title"], ""]
        others = [t for t in yt.get("titles") or [] if t != yt.get("title")]
        if others:
            out += ["Other titles:"] + others + [""]
        out += ["Description:", youtube_description(yt, chapters, clock), ""]
        if yt.get("tags"):
            out += ["Tags:", ", ".join(yt["tags"]), ""]
    ud = details.get("udemy") or {}
    if ud:
        out += ["## Udemy", ""]
        if ud.get("lectureTitle"):
            out += ["Lecture title:", ud["lectureTitle"], ""]
        out += ["Lecture description:", udemy_description(ud), ""]
        if ud.get("quiz"):
            out += ["Quiz:", ""]
            for i, q in enumerate(ud["quiz"], 1):
                out.append(f"{i}. {q['question']}")
                for k, o in enumerate(q.get("options") or []):
                    out.append(f"   {'*' if q.get('answer') == k else '-'} {o}")
                if q.get("why"):
                    out.append(f"   Why: {q['why']}")
            out.append("")
    return "\n".join(out).rstrip() + "\n"


class Collections:
    """The playlists and courses, in collections.json next to the projects folder."""

    def __init__(self, root: Path):
        self.path = Path(root) / "collections.json"
        self._lock = threading.Lock()

    def _read(self) -> list[dict]:
        from .store import read_json  # the store's tolerant reader (Windows file locks)

        data = read_json(self.path, {"collections": []})
        items = list(data.get("collections") or [])
        for c in items:  # a name saved before the invisible characters were taken out
            c["title"] = _INVISIBLE.sub("", c.get("title") or "")
        return items

    def _write(self, items: list[dict]) -> None:
        from .store import write_json

        write_json(self.path, {"collections": items})

    def list(self) -> list[dict]:
        return self._read()

    def get(self, cid: str) -> dict | None:
        return next((c for c in self._read() if c["id"] == cid), None)

    def create(self, kind: str, title: str) -> dict:
        if kind not in KINDS:
            raise PublishingError("kind must be youtube (a playlist) or udemy (a course)")
        title = _text(title, 150)
        if not title:
            raise PublishingError("A playlist or course needs a name.")
        with self._lock:
            items = self._read()
            if any(c["kind"] == kind and c["title"].lower() == title.lower() for c in items):
                raise PublishingError(f'There is already a {KINDS[kind]} called "{title}".')
            c = {"id": uuid.uuid4().hex[:10], "kind": kind, "title": title, "meta": {}, "createdAt": time.time()}
            items.append(c)
            self._write(items)
            return c

    def update(self, cid: str, fields: dict) -> dict:
        with self._lock:
            items = self._read()
            c = next((x for x in items if x["id"] == cid), None)
            if not c:
                raise PublishingError("No such playlist or course.")
            if "title" in fields:
                t = _text(fields["title"], 150)
                if not t:
                    raise PublishingError("A playlist or course needs a name.")
                c["title"] = t
            if "meta" in fields:
                spec = COURSE_FIELDS if c["kind"] == "udemy" else PLAYLIST_FIELDS
                c["meta"] = {**(c.get("meta") or {}), **clean_fields(fields["meta"], spec)}
            self._write(items)
            return c

    def delete(self, cid: str) -> None:
        with self._lock:
            items = self._read()
            self._write([c for c in items if c["id"] != cid])
