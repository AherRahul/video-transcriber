"""
A draft brand kit from a website: its colours (CSS variables and the colours its stylesheets use most),
its fonts, its name and its logo. The page's Brand Kit editor shows the draft for the user to adjust and
save; Claude gets the same draft plus a screenshot, so it can check which colour plays which role.

Only public http(s) addresses are fetched: anything that resolves to this computer or the local network is
refused, so a link in a document can't make the app read local services.
"""

from __future__ import annotations

import colorsys
import ipaddress
import re
import socket
import urllib.parse
import urllib.request
from collections import Counter
from html.parser import HTMLParser

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
GENERIC_FONTS = {
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif",
    "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "inherit", "initial", "unset",
    "emoji", "math", "fangsong", "var", "revert",
}
ICON_FONTS = ("awesome", "icon", "material", "glyph", "symbols", "fa-", "dashicons", "lucide")


class FetchError(Exception):
    pass


def check_public_url(url: str) -> str:
    """Refuses non-http(s) links and hosts on this machine or the private network."""
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("Only http and https links can be read.")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as err:
        raise FetchError(f"Could not find {parts.hostname}.") from err
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise FetchError(f"{parts.hostname} is on this computer or the local network, so it is not read.")
    return urllib.parse.urlunsplit(parts)


def fetch(url: str, max_bytes: int = 3_000_000, timeout: float = 15.0) -> tuple[bytes, str, str]:
    """(body, content type, final URL). Raises FetchError with a readable reason."""
    url = check_public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Language": "en"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - checked above
            final = res.geturl()
            check_public_url(final)
            body = res.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise FetchError(f"The file at {url} is larger than {max_bytes // 1_000_000} MB.")
            return body, res.headers.get("Content-Type", ""), final
    except FetchError:
        raise
    except Exception as err:  # noqa: BLE001 - network errors come in many types
        raise FetchError(f"Could not read {url}: {err}") from err


# ── reading a page for facts ──


class _TextScan(HTMLParser):
    """The readable text of a page: headings, paragraphs, lists and tables, without scripts and menus."""

    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "template", "iframe"}
    BLOCK = {"p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "pre", "blockquote", "dd", "dt"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")
            if tag in ("h1", "h2", "h3"):
                self.parts.append("## ")
            elif tag == "li":
                self.parts.append("- ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag == "title":
            self._in_title = False
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def page_text(url: str, max_chars: int = 60_000) -> dict:
    """The text of a public web page (for facts and dates), cut at `max_chars`."""
    body, ctype, final = fetch(url, max_bytes=5_000_000)
    kind = ctype.split(";")[0].strip().lower()
    if kind == "application/pdf" or body[:5] == b"%PDF-":
        raise FetchError("That link is a PDF. Download it and attach it to the message instead, so Claude can read it.")
    text = body.decode("utf-8", errors="replace")
    title = ""
    if "html" in kind or text.lstrip()[:200].lower().startswith(("<!doctype", "<html")):
        scan = _TextScan()
        try:
            scan.feed(text)
        except Exception:  # noqa: BLE001 - keep what was parsed
            pass
        text, title = "".join(scan.parts), scan.title.strip()
    elif not kind.startswith("text/") and kind not in ("application/json", "application/xml"):
        raise FetchError(f"That link is not a page Claude can read ({kind or 'unknown type'}).")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n\s*(\n\s*)+", "\n\n", text).strip()
    return {"url": final, "title": title[:200], "text": text[:max_chars], "truncated": len(text) > max_chars}


# ── colours ──


def _clamp(x: float) -> int:
    return max(0, min(255, round(x)))


def to_hex(value: str) -> str | None:
    """#rgb, #rrggbb, #rrggbbaa, rgb()/rgba() and hsl()/hsla() to #rrggbb (None for transparent ones)."""
    v = value.strip().lower()
    m = re.fullmatch(r"#([0-9a-f]{3,8})", v)
    if m:
        h = m.group(1)
        if len(h) in (3, 4):
            if len(h) == 4 and h[3] in "0123456":
                return None
            h = "".join(c * 2 for c in h[:3])
        elif len(h) == 8:
            if int(h[6:], 16) < 128:
                return None
            h = h[:6]
        elif len(h) != 6:
            return None
        return "#" + h
    m = re.fullmatch(r"rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)", v)
    if m:
        a = m.group(4)
        if a is not None:
            alpha = float(a[:-1]) / 100 if a.endswith("%") else float(a)
            if alpha < 0.5:
                return None
        return "#%02x%02x%02x" % tuple(_clamp(float(m.group(i))) for i in (1, 2, 3))
    m = re.fullmatch(r"hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)", v)
    if m:
        a = m.group(4)
        if a is not None:
            alpha = float(a[:-1]) / 100 if a.endswith("%") else float(a)
            if alpha < 0.5:
                return None
        r, g, b = colorsys.hls_to_rgb(float(m.group(1)) / 360, float(m.group(3)) / 100, float(m.group(2)) / 100)
        return "#%02x%02x%02x" % (_clamp(r * 255), _clamp(g * 255), _clamp(b * 255))
    return None


def _rgb(h: str) -> tuple[float, float, float]:
    return tuple(int(h[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def luminance(h: str) -> float:
    def ch(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = _rgb(h)
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def hls(h: str) -> tuple[float, float, float]:
    return colorsys.rgb_to_hls(*_rgb(h))


def mix(a: str, b: str, t: float) -> str:
    ra, rb = _rgb(a), _rgb(b)
    return "#%02x%02x%02x" % tuple(_clamp((x + (y - x) * t) * 255) for x, y in zip(ra, rb))


# ── page parsing ──


class _PageScan(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stylesheets: list[str] = []
        self.styles: list[str] = []
        self.inline: list[str] = []
        self.icons: list[tuple[str, str]] = []  # (rel, href)
        self.logo_imgs: list[str] = []
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_style = False
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag == "link":
            rel = a.get("rel", "").lower()
            if "stylesheet" in rel and a.get("href"):
                self.stylesheets.append(a["href"])
            if "icon" in rel and a.get("href"):
                self.icons.append((rel, a["href"]))
        elif tag == "style":
            self._in_style = True
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key:
                self.meta[key] = a.get("content", "")
        elif tag == "img":
            hint = " ".join(a.get(k, "") for k in ("src", "alt", "class", "id")).lower()
            if "logo" in hint and a.get("src"):
                self.logo_imgs.append(a["src"])
        if a.get("style"):
            self.inline.append(a["style"])

    def handle_endtag(self, tag):
        if tag == "style":
            self._in_style = False
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_style:
            self.styles.append(data)
        elif self._in_title:
            self.title += data


def _font_names(decl: str) -> list[str]:
    out = []
    for part in decl.split(","):
        name = part.strip().strip("'\"").strip()
        low = name.lower()
        if not name or low in GENERIC_FONTS or low.startswith("var(") or any(x in low for x in ICON_FONTS):
            continue
        out.append(name)
    return out


def extract(url: str) -> dict:
    """Reads the site and returns {draft, candidates, source}. The draft is not saved."""
    body, ctype, final = fetch(url)
    if "html" not in ctype and not body.lstrip()[:200].lower().startswith((b"<!doctype", b"<html")):
        raise FetchError("That link is not a web page.")
    html = body.decode("utf-8", errors="replace")
    scan = _PageScan()
    try:
        scan.feed(html)
    except Exception:  # noqa: BLE001 - keep whatever was parsed
        pass

    css_parts = list(scan.styles)
    google_families: list[str] = []
    for href in scan.stylesheets[:8]:
        full = urllib.parse.urljoin(final, href)
        if "fonts.googleapis.com" in full:
            for fam in urllib.parse.parse_qs(urllib.parse.urlsplit(full).query).get("family", []):
                google_families.append(fam.split(":")[0].replace("+", " "))
            continue
        if len(css_parts) > 12:
            break
        try:
            data, _, _ = fetch(full, max_bytes=1_500_000, timeout=10)
            css_parts.append(data.decode("utf-8", errors="replace"))
        except FetchError:
            continue
    css = "\n".join(css_parts) + "\n" + ";".join(scan.inline)

    # CSS custom properties that hold colours, with the names that hint at their role
    variables: dict[str, str] = {}
    for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;}{]+)", css):
        hx = to_hex(value)
        if hx and name not in variables:
            variables[name] = hx

    counts: Counter[str] = Counter()
    for m in re.finditer(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)", css):
        hx = to_hex(m.group(0))
        if hx:
            counts[hx] += 1
    theme = to_hex(scan.meta.get("theme-color", "")) if scan.meta.get("theme-color") else None

    def rule_value(selector_rx: str, prop: str) -> str | None:
        for m in re.finditer(selector_rx + r"[^{]*\{([^}]*)\}", css, flags=re.I):
            mm = re.search(r"(?:^|;)\s*" + prop + r"\s*:\s*([^;]+)", m.group(1), flags=re.I)
            if mm:
                return mm.group(1).strip()
        return None

    def var_or_hex(value: str | None) -> str | None:
        if not value:
            return None
        mv = re.search(r"var\(\s*(--[\w-]+)", value)
        if mv:
            return variables.get(mv.group(1))
        first = re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)", value)
        return to_hex(first.group(0)) if first else None

    body_bg = var_or_hex(rule_value(r"(?:^|[},\s])(?:html|body|:root)\b", r"background(?:-color)?"))
    body_ink = var_or_hex(rule_value(r"(?:^|[},\s])(?:html|body|:root)\b", r"color"))

    def named(*hints: str) -> str | None:
        for hint in hints:
            for name, hx in variables.items():
                if hint in name.lower():
                    return hx
        return None

    bg = body_bg or named("--background", "--bg", "-bg") or None
    if not bg:
        neutrals = [c for c, _ in counts.most_common(40) if hls(c)[2] < 0.15 and (hls(c)[1] > 0.93 or hls(c)[1] < 0.12)]
        bg = neutrals[0] if neutrals else "#ffffff"
    ink = body_ink or named("--foreground", "--text", "--ink", "-fg")
    if not ink or contrast(ink, bg) < 4.5:
        # the most used colour that reads well on the background, else plain near-black or white
        readable = [c for c, _ in counts.most_common(40) if contrast(c, bg) >= 7]
        ink = readable[0] if readable else ("#111111" if luminance(bg) > 0.4 else "#ffffff")

    def saturated(c: str) -> bool:
        h, light, s = hls(c)
        return s > 0.35 and 0.2 < light < 0.8

    accents = []
    for cand in [named("--primary", "--brand", "--accent", "-primary", "-brand", "-accent"), theme] + [c for c, _ in counts.most_common(60)]:
        if cand and saturated(cand) and contrast(cand, bg) > 1.6:
            if all(abs(hls(cand)[0] - hls(a)[0]) > 0.08 for a in accents):
                accents.append(cand)
        if len(accents) == 2:
            break
    accent = accents[0] if accents else ("#4f8cff" if luminance(bg) < 0.4 else "#2453d6")
    accent2 = accents[1] if len(accents) > 1 else mix(accent, ink, 0.35)
    surface = named("--card", "--surface", "--panel") or mix(bg, ink, 0.06)
    muted = named("--muted", "--secondary-text", "--subtle") or mix(ink, bg, 0.45)

    # fonts: heading rules first, then body, then whatever the CSS uses most
    font_counts: Counter[str] = Counter()
    for decl in re.findall(r"font-family\s*:\s*([^;}{]+)", css, flags=re.I):
        names = _font_names(decl)
        if names:
            font_counts[names[0]] += 1
    for fam in google_families:
        font_counts[fam] += 3
    for fam in re.findall(r"@font-face\s*\{[^}]*font-family\s*:\s*['\"]?([^;'\"}]+)", css, flags=re.I):
        names = _font_names(fam)
        if names:
            font_counts[names[0]] += 1
    head_decl = rule_value(r"(?:^|[},\s])h1\b", r"font-family")
    body_decl = rule_value(r"(?:^|[},\s])(?:html|body)\b", r"font-family")
    head_font = (_font_names(head_decl) or [None])[0] if head_decl and "var(" not in head_decl else None
    body_font = (_font_names(body_decl) or [None])[0] if body_decl and "var(" not in body_decl else None
    common = [f for f, _ in font_counts.most_common(6)]
    body_font = body_font or (common[0] if common else "Inter")
    head_font = head_font or next((f for f in common if f != body_font), body_font)

    # logo candidates, most likely first
    logos: list[str] = []
    svg = re.search(r"<svg[^>]*(?:logo|brand)[^>]*>[\s\S]{0,40000}?</svg>", html, flags=re.I)
    for src in scan.logo_imgs:
        logos.append(urllib.parse.urljoin(final, src))
    for rel, href in sorted(scan.icons, key=lambda x: ("apple" not in x[0], ".svg" not in x[1])):
        logos.append(urllib.parse.urljoin(final, href))
    if scan.meta.get("og:image"):
        logos.append(urllib.parse.urljoin(final, scan.meta["og:image"]))
    logos = list(dict.fromkeys(l for l in logos if l.startswith("http")))[:8]

    name = scan.meta.get("og:site_name") or re.split(r"\s[|\-:·]\s", scan.title.strip())[0].strip() or urllib.parse.urlsplit(final).hostname or "Brand"
    draft = {
        "name": name[:60],
        "palette": {"bg": bg, "surface": surface, "ink": ink, "muted": muted, "accent": accent, "accent2": accent2},
        "fonts": {"display": head_font, "body": body_font, "mono": "JetBrains Mono"},
        "radius": 12,
        "motion": "smooth",
        "style": "",
        "endCard": {"enabled": True, "headline": name[:60], "cta": "", "url": urllib.parse.urlsplit(final).hostname or ""},
    }
    return {
        "draft": draft,
        "logoUrl": logos[0] if logos else None,
        "inlineSvgLogo": svg.group(0) if svg else None,
        "candidates": {
            "colors": [{"hex": c, "count": n} for c, n in counts.most_common(16)],
            "variables": dict(list(variables.items())[:40]),
            "themeColor": theme,
            "fonts": common,
            "logos": logos,
        },
        "source": {"url": final, "title": scan.title.strip()[:200]},
    }
