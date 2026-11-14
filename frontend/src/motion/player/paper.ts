// The paper look: the AlgoInsight daily films, rebuilt for the Motion player.
//
// Everything here follows the film style guide (paper-grid, PaperLockup, torn tag, part tag, card, sticky,
// ink stamp, pen note, recording window) in the films' design units, 1600 x 900:
//   - the frame (drawn over every page, never by scenes): the logo card and tagline top-left, the film's
//     title and part tag top-right, the web address bottom-right, film grain;
//   - the page's torn label (each scene's `label`), placed by the player at x 340, y 64, shrunk to fit;
//   - the component classes scenes use (p-card, p-sticky, p-stamp, ...);
//   - the page changes: `tear` (the old page ripped away along a ragged edge) and `turn` (a book's page);
//   - the end screen;
//   - fx: entrances and exits with the films' timings, each one also asking for its sound effect.
//
// Every effect is a tween on the scene's paused timeline (or computed from time in the player), so the
// export, which seeks frame by frame, matches the preview exactly.

import { gsap } from "gsap";
import { SplitText } from "gsap/SplitText";

export type SfxEvent = { sceneId: string; t: number; name: string; gain: number };

/** A steady pseudo-random stream (the films' own), so torn edges are the same in every frame and render. */
export function stream(seed: number) {
  let s = Math.max(1, Math.floor(seed) % 2147483646);
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export const seedOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 2147483647, 7);

/** A ragged clip-path for a box of w x h px: each edge wanders inward a few pixels, a tooth every 6-13 px.
 * `ends` makes the left and right ends deeper, like a strip torn off a roll. */
export function tornClip(w: number, h: number, seed: number, ends = false): string {
  const r = stream(seed);
  const amp = Math.max(1.5, Math.min(4.5, Math.min(w, h) * 0.05));
  const pts: string[] = [];
  const side = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number, depth: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let d = 0; d < len; d += 6 + r() * 7) {
      const t = d / len;
      const j = depth * (0.25 + r() * 0.75);
      pts.push(`${(x0 + (x1 - x0) * t + nx * j).toFixed(1)}px ${(y0 + (y1 - y0) * t + ny * j).toFixed(1)}px`);
    }
  };
  const endDepth = ends ? amp * 2.6 : amp;
  side(0, 0, w, 0, 0, 1, amp);
  side(w, 0, w, h, -1, 0, endDepth);
  side(w, h, 0, h, 0, -1, amp);
  side(0, h, 0, 0, 1, 0, endDepth);
  return `polygon(${pts.join(", ")})`;
}

// ── component classes (inside every paper scene's shadow root) ──

export const PAPER_CSS = `
.p-head { margin: 0; font-family: var(--font-display); font-weight: 800; font-size: 96px; line-height: 1; letter-spacing: -2px; color: var(--ink); }
.p-head.sm { font-size: 80px; letter-spacing: -1.6px; }
.p-marked { position: relative; display: inline-block; z-index: 0; }
.p-marked > .p-band { position: absolute; left: -12px; right: -12px; top: 18%; bottom: 4%; border-radius: 6px; background: var(--c-marker, var(--accent)); z-index: -1; transform-origin: left center; }
.p-card { background: #fff; border: 4px solid var(--ink); border-radius: 18px; box-shadow: 10px 10px 0 var(--ink); padding: 18px 22px; color: var(--ink); font-family: var(--font-display); }
.p-card.lemon, .p-sticky.lemon { background: var(--c-lemon); }
.p-card.sky, .p-sticky.sky { background: var(--c-sky); }
.p-card.mint, .p-sticky.mint { background: var(--c-mint); }
.p-card.pink, .p-sticky.pink { background: var(--c-pink); }
.p-card.peach, .p-sticky.peach { background: var(--c-peach); }
.p-card-title { margin: 0; font: 800 26px/1.2 var(--font-display); color: var(--ink); }
.p-card-text { margin: 6px 0 0; font: 500 26px/1.25 var(--font-display); color: var(--c-ink-2); }
.p-sticky { background: var(--c-lemon); border: 4px solid var(--ink); border-radius: 18px; box-shadow: 10px 10px 0 var(--ink); padding: 18px 22px; transform: rotate(-1.5deg); font-family: var(--font-display); }
.p-sticky.tilt-r { transform: rotate(1.5deg); }
.p-sticky-title { margin: 0; font: 800 40px/1.25 var(--font-display); color: var(--ink); }
.p-sticky-sub { margin: 6px 0 0; font: 500 26px/1.2 var(--font-display); color: var(--c-ink-2); }
.p-tag { display: inline-flex; align-items: center; height: 62px; padding: 0 20px; background: var(--ink); color: var(--c-marker, var(--accent)); font: 800 26px/1.22 var(--font-display); white-space: nowrap; transform: rotate(-1.5deg); text-transform: uppercase; }
.p-tag.blue { background: #2563eb; color: #fff; } .p-tag.green { background: #059669; color: #fff; } .p-tag.red { background: #dc2626; color: #fff; } .p-tag.pen { background: var(--c-pen); color: #fff; }
.p-stamp { display: inline-flex; align-items: center; height: 68px; padding: 0 16px; border: 5px solid currentColor; border-radius: 10px; font: 800 40px/1 var(--font-display); letter-spacing: 2px; transform: rotate(-10deg); color: var(--c-pen); white-space: nowrap; }
.p-stamp.right { color: var(--c-stamp-ok); }
.p-note { margin: 0; font-family: var(--font-hand); font-weight: 700; font-size: 48px; line-height: 1.1; color: var(--c-pen); transform: rotate(-4deg); white-space: nowrap; }
.p-arrow { stroke: var(--c-pen); stroke-width: 5; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.p-badge { display: flex; align-items: center; justify-content: center; width: 88px; height: 88px; border-radius: 50%; background: #fff; border: 4px solid var(--ink); box-shadow: 6px 6px 0 var(--ink); font: 800 34px/1 var(--font-display); color: var(--ink); }
.p-badge svg { width: 46px; height: 46px; stroke: var(--ink); fill: none; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.p-window { display: flex; flex-direction: column; background: var(--c-window); border: 5px solid var(--ink); border-radius: 20px; box-shadow: 14px 14px 0 var(--ink); overflow: hidden; }
.p-bar { flex: none; height: 48px; display: flex; align-items: center; gap: 14px; padding: 0 16px; background: #fff; border-bottom: 4px solid var(--ink); }
.p-lights { display: inline-flex; gap: 8px; }
.p-lights i { width: 16px; height: 16px; border-radius: 50%; border: 2.5px solid var(--ink); background: #fca5a5; }
.p-lights i:nth-child(2) { background: #fde68a; } .p-lights i:nth-child(3) { background: #86efac; }
.p-addr { font: 700 19px/1 var(--font-mono); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.p-credit { margin-left: auto; font: 600 16px/1 var(--font-display); color: var(--c-ink-2); white-space: nowrap; }
.p-body { position: relative; flex: 1; padding: 18px 22px; color: #e2e8f0; font: 500 20px/1.5 var(--font-mono); overflow: hidden; }
.p-placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 40px; color: #94a3b8; font: 700 26px/1.4 var(--font-display); border: 3px dashed #334155; border-radius: 12px; margin: 18px; }
.p-num { font: 800 120px/1 var(--font-display); letter-spacing: -3px; color: var(--ink); }
.p-mono { font-family: var(--font-mono); }
.p-chrome-label { position: absolute; left: 340px; top: 64px; height: 62px; max-width: 820px; display: inline-flex; align-items: center; padding: 0 20px; background: var(--ink); color: var(--c-marker, var(--accent)); font: 800 26px/1.22 var(--font-display); text-transform: uppercase; white-space: nowrap; overflow: hidden; transform: rotate(-1.5deg); transform-origin: left center; z-index: 50; }
`;

// ── the frame (over every page) ──

const FRAME_CSS = `
#chrome { position: absolute; inset: 0; pointer-events: none; z-index: 5; font-family: var(--font-display); }
#chrome .c-logo { position: absolute; left: 34px; top: 28px; width: 226px; height: 52px; transform: rotate(-2deg); transform-origin: 113px 26px; }
#chrome .c-logo::before { content: ""; position: absolute; left: 6px; top: 6px; width: 226px; height: 52px; border-radius: 13px; background: #141414; }
#chrome .c-card { position: absolute; inset: 0; display: flex; align-items: center; gap: 9px; padding-left: 5px; background: #fff; border: 4px solid #141414; border-radius: 13px; box-sizing: border-box; }
#chrome .c-card .mo-icon { width: 40px; height: 40px; display: inline-flex; flex: none; }
#chrome .c-card .mo-icon img, #chrome .c-card .mo-icon svg { width: 100%; height: 100%; display: block; border-radius: 9px; }
#chrome .c-word { font: 800 28px/1 var(--font-display); letter-spacing: -0.4px; color: #141414; white-space: nowrap; }
#chrome .c-tagline { position: absolute; left: 28px; top: 102px; font: 800 11px/1 var(--font-display); letter-spacing: 2px; color: #475569; white-space: nowrap; }
#chrome .c-title { position: absolute; right: 48px; top: 38px; max-width: 720px; font: 700 22px/1.2 var(--font-display); color: #334155; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right;
  text-shadow: 0 0 3px #F1F6FD, 0 0 3px #F1F6FD, 0 0 3px #F1F6FD; }
#chrome .c-part { position: absolute; right: 48px; top: 86px; height: 44px; display: inline-flex; align-items: center; padding: 0 16px; border-radius: 20px; background: rgba(20, 20, 20, 0.06); color: #475569; font: 800 18px/1 var(--font-display); letter-spacing: 1.5px; text-transform: uppercase; white-space: pre; }
#chrome .c-url { position: absolute; right: 36px; bottom: 26px; font: 800 20px/1 var(--font-display); color: rgba(51, 65, 85, 0.66); letter-spacing: 0.3px;
  text-shadow: 0 0 3px #F1F6FD, 0 0 3px #F1F6FD; } /* quiet slate on the paper: white words vanished into it */
#chrome .c-grain { position: absolute; inset: 0; background-size: 512px 512px; opacity: 0.18; }
`;

export type Chrome = {
  root: HTMLDivElement;
  title: HTMLDivElement;
  part: HTMLDivElement;
  setPart: (text: string) => void;
  setVisible: (on: boolean) => void;
};

/** The frame over every page. showLogo false (a Udemy film: no platform of ours on screen) drops the logo
 *  card and its tagline; an empty url drops the web address. */
export function buildChrome(stage: HTMLElement, opts: { title: string; wordmark: string; tagline: string; iconUrl: string | null; url: string; grainUrl: string; showLogo?: boolean }): Chrome {
  const logo = opts.showLogo !== false;
  stage.querySelector("#chrome")?.remove();
  stage.querySelector("#chrome-css")?.remove();
  const style = document.createElement("style");
  style.id = "chrome-css";
  style.textContent = FRAME_CSS;
  stage.appendChild(style);
  const root = document.createElement("div");
  root.id = "chrome";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  root.innerHTML = `
    ${logo ? `<div class="c-logo"><div class="c-card">${iconTag(opts.iconUrl)}<span class="c-word">${esc(opts.wordmark)}</span></div></div>` : ""}
    ${logo && opts.tagline ? `<div class="c-tagline">${esc(opts.tagline)}</div>` : ""}
    <div class="c-title">${esc(opts.title)}</div>
    <div class="c-part" style="display:none"></div>
    ${opts.url ? `<div class="c-url">${esc(opts.url)}</div>` : ""}
    <div class="c-grain" style="background-image:url('${esc(opts.grainUrl)}')"></div>`;
  stage.appendChild(root);
  const word = root.querySelector(".c-word") as HTMLSpanElement | null;
  // the wordmark stays inside its card: 28 px down to 18 px
  const room = 226 - 8 - 54;
  for (let size = 28; word && size >= 18 && word.scrollWidth > room; size -= 1) word.style.fontSize = `${size}px`;
  const title = root.querySelector(".c-title") as HTMLDivElement;
  // shrink-only title: one line, 22 px down to 15 px, then an ellipsis
  for (let size = 22; size >= 15 && title.scrollWidth > 720; size -= 1) title.style.fontSize = `${size}px`;
  const part = root.querySelector(".c-part") as HTMLDivElement;
  let shown = "";
  return {
    root,
    title,
    part,
    setPart(text: string) {
      const t = (text || "").replace(/\s*·\s*/g, "  ·  ").trim();
      if (t === shown) return;
      shown = t;
      part.textContent = t;
      part.style.display = t ? "inline-flex" : "none";
    },
    setVisible(on: boolean) {
      root.style.display = on ? "block" : "none";
    },
  };
}

/** The page's torn label, placed and shrunk to fit; returns the element (data-id "frame-label"). */
export function buildLabel(root: HTMLElement, text: string, seed: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "p-chrome-label";
  el.dataset.id = "frame-label";
  el.textContent = text;
  root.appendChild(el);
  for (let size = 26; size >= 18 && el.scrollWidth > 820; size -= 1) el.style.fontSize = `${size}px`;
  if (el.scrollWidth > 820) {
    el.style.width = "820px";
    el.style.textOverflow = "ellipsis";
  }
  el.style.clipPath = tornClip(Math.min(820, el.offsetWidth), el.offsetHeight, seed, true);
  return el;
}

/** Ragged edges on every .p-tag and .p-torn in a scene (after layout, so they follow each element's size). */
type TipPath = SVGPathElement & { __tip?: SVGPathElement };
const tipOf = (el: Element): SVGPathElement | undefined => (el as unknown as TipPath).__tip;

/**
 * Arrowheads. A path with class "p-arrow head" gets its tip from the player: on the path's real end and
 * pointing along it, so a head can never sit apart from its line or point the wrong way (hand-drawn heads
 * did both). fx.draw shows the tip as the line arrives; fx.exit takes it away with the line.
 */
export function arrowTips(root: HTMLElement) {
  for (const path of Array.from(root.querySelectorAll<SVGPathElement>("path.p-arrow.head"))) {
    if ((path as TipPath).__tip) continue;
    let len = 0;
    try {
      len = path.getTotalLength();
    } catch {
      continue;
    }
    if (!(len > 2)) continue;
    const end = path.getPointAtLength(len);
    const back = path.getPointAtLength(Math.max(0, len - Math.min(12, len / 4)));
    const deg = (Math.atan2(end.y - back.y, end.x - back.x) * 180) / Math.PI;
    const tip = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tip.setAttribute("class", "p-arrow p-arrow-tip");
    tip.setAttribute("d", "M -16 -11 L 0 0 L -16 11");
    const own = path.getAttribute("transform");
    tip.setAttribute("transform", `${own ? own + " " : ""}translate(${end.x.toFixed(2)} ${end.y.toFixed(2)}) rotate(${deg.toFixed(2)})`);
    path.after(tip);
    (path as TipPath).__tip = tip;
  }
}

export function tearEdges(root: HTMLElement, sceneId: string) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".p-tag, .p-torn"))) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w > 4 && h > 4) el.style.clipPath = tornClip(w, h, seedOf(sceneId + ":" + (el.dataset.id || el.className)), el.classList.contains("p-tag"));
  }
}

// ── page changes ──

const W = 1600;
const H = 900;

/** The films' tear: a ragged line from above the top to below the bottom, the top leading. */
const TEAR: [number, number][] = (() => {
  const r = stream(11);
  const lean = (y: number) => (450 - y) * 0.09;
  const pts: [number, number][] = [[lean(-30), -30]];
  for (let y = -16; y < 916; y += 12 + Math.round(r() * 16)) {
    const jag = (r() - 0.5) * 16 + (r() < 0.12 ? (r() - 0.5) * 32 : 0);
    pts.push([lean(y) + jag, y]);
  }
  pts.push([lean(930), 930]);
  return pts;
})();
const widths = (seed: number, lo: number, hi: number) => {
  const r = stream(seed);
  return TEAR.map(() => lo + r() * (hi - lo));
};
const RIM = widths(5, 3, 10);
const GAP = widths(7, 1, 6);
const FLAP = widths(3, 48, 80);
const TEAR_FROM = -80;
const TEAR_TO = 1800;
const shifted = (dx: number | number[]) => TEAR.map(([x, y], i) => [x + (Array.isArray(dx) ? dx[i] : dx), y] as [number, number]);
const pointsOf = (pts: [number, number][]) => pts.map(([x, y]) => `${x.toFixed(1)},${y}`).join(" ");
const band = (inner: [number, number][], outer: [number, number][]) => pointsOf([...inner, ...[...outer].reverse()]);
export const tearEase = (() => {
  // cubic-bezier(.6,.04,.4,1), the films' tear curve
  const bez = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bez(mid, 0.6, 0.4) < x) lo = mid;
      else hi = mid;
    }
    return bez((lo + hi) / 2, 0.04, 1);
  };
})();

/** The outgoing page's visible part with the tear's front at `base` (everything right of the tear). */
export function tearClip(p: number): string {
  const base = TEAR_FROM + (TEAR_TO - TEAR_FROM) * p;
  const pts = shifted(base).map(([x, y]) => `${((x / W) * 100).toFixed(2)}% ${((y / H) * 100).toFixed(2)}%`);
  return `polygon(${[...pts, "125% 110%", "125% -10%"].join(", ")})`;
}

/** The torn edge, the strip lifting off and its shadow, drawn around x = 0; slid along with the front. */
export function tearEdgeSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:4;display:none";
  const strip = shifted(GAP.map((g) => -g));
  svg.innerHTML = `
    <defs>
      <linearGradient id="mo-tear-back" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#D3DBE6"/><stop offset="0.7" stop-color="#F3F6FA"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>
      <filter id="mo-tear-blur" x="-50%" y="-5%" width="200%" height="110%"><feGaussianBlur stdDeviation="9"/></filter>
    </defs>
    <polyline points="${pointsOf(shifted(GAP.map((g, i) => -g - FLAP[i] * 0.55)))}" fill="none" stroke="#000" stroke-opacity="0.28" stroke-width="46" filter="url(#mo-tear-blur)"/>
    <polygon points="${band(strip, shifted(GAP.map((g, i) => -g - FLAP[i])))}" fill="url(#mo-tear-back)"/>
    <polygon points="${band(strip, shifted(GAP.map((g, i) => -g - 2 - RIM[i] * 0.4)))}" fill="#FFFFFF"/>
    <polygon points="${band(shifted(0), shifted(RIM))}" fill="#FFFFFF" fill-opacity="0.96"/>`;
  return svg;
}

export function tearEdgeTransform(p: number): string {
  const base = TEAR_FROM + (TEAR_TO - TEAR_FROM) * p;
  return `translateX(${((base / W) * 100).toFixed(3)}%)`;
}

// ── the end screen ──

const END_CSS = `
.es { position: absolute; inset: 0; overflow: hidden; color: #fff; font-family: var(--font-display);
  background: radial-gradient(900px 600px at 15% 15%, rgba(79,70,229,0.16), transparent 60%), radial-gradient(800px 600px at 85% 85%, rgba(147,51,234,0.12), transparent 60%), #0b1020; }
.es-frame { position: absolute; left: 12px; top: 12px; right: 12px; bottom: 12px; border: 2px solid #3E4C78; border-radius: 26px; }
.es-brand { position: absolute; left: 0; right: 0; top: 48px; display: flex; justify-content: center; align-items: center; gap: 12px; }
.es-brand .mo-icon { width: 52px; height: 52px; display: inline-flex; }
.es-brand .mo-icon img, .es-brand .mo-icon svg { width: 100%; height: 100%; display: block; border-radius: 12px; }
.es-brand span { font: 800 32px/1 var(--font-display); letter-spacing: -0.5px; }
.es-tag { position: absolute; left: 0; right: 0; top: 122px; text-align: center; font: 800 14px/1 var(--font-display); letter-spacing: 4px; color: #94a3b8; }
.es-thanks { position: absolute; left: 0; right: 0; top: 165px; text-align: center; font: 800 56px/1.1 var(--font-display); letter-spacing: -1px; }
.es-head { position: absolute; top: 246px; display: flex; align-items: center; gap: 12px; font: 700 22px/1 var(--font-display); }
.es-head svg { width: 22px; height: 22px; stroke: #818cf8; fill: none; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.es-box { position: absolute; top: 287px; width: 576px; height: 323px; border: 2.5px dashed #3E4C78; border-radius: 18px; background: rgba(255,255,255,0.02); }
.es-box .es-play { position: absolute; left: 50%; top: 50%; width: 84px; height: 84px; margin: -42px 0 0 -42px; border-radius: 50%; background: rgba(255,255,255,0.08); }
.es-box .es-play::after { content: ""; position: absolute; left: 33px; top: 25px; border-left: 30px solid rgba(255,255,255,0.32); border-top: 17px solid transparent; border-bottom: 17px solid transparent; }
.es-helped { position: absolute; left: 112px; top: 674px; font: 800 15px/1 var(--font-display); letter-spacing: 4px; color: #94a3b8; }
.es-btns { position: absolute; left: 112px; top: 708px; display: flex; gap: 12px; }
.es-btn { height: 50px; display: inline-flex; align-items: center; gap: 10px; padding: 0 20px; border-radius: 25px; background: #1e2433; font: 700 20px/1 var(--font-display); }
.es-btn svg { width: 22px; height: 22px; stroke: #fff; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.es-btn.sub { background: #ff0033; }
.es-sub { position: absolute; left: 722px; top: 654px; width: 156px; height: 156px; border-radius: 50%; border: 5px solid #ff0033; padding: 5px; }
.es-sub > div { width: 100%; height: 100%; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #9333ea); display: flex; align-items: center; justify-content: center; }
.es-sub svg { width: 70px; height: 70px; stroke: #fff; fill: none; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
.es-sublabel { position: absolute; left: 0; right: 0; top: 826px; text-align: center; font: 800 18px/1 var(--font-display); letter-spacing: 4px; color: #cbd5e1; }
.es-keep { position: absolute; right: 112px; top: 674px; text-align: right; }
.es-keep .k1 { font: 800 15px/1 var(--font-display); letter-spacing: 4px; color: #94a3b8; }
.es-keep .k2 { margin-top: 12px; font: 800 40px/1 var(--font-display); letter-spacing: -0.5px; }
.es-keep .k3 { margin-top: 10px; font: 600 20px/1.2 var(--font-display); color: #cbd5e1; }
`;

export function endScreen(opts: { wordmark: string; tagline: string; iconUrl: string | null; url: string; props: Record<string, unknown> }): { css: string; markup: string } {
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const p = opts.props || {};
  const code = `<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/>`;
  const markup = `
  <div class="es" data-id="end-screen">
    <div class="es-frame"></div>
    <div class="es-brand" data-id="es-brand">${iconTag(opts.iconUrl)}<span>${esc(opts.wordmark)}</span></div>
    ${opts.tagline ? `<div class="es-tag" data-id="es-tagline">${esc(opts.tagline)}</div>` : ""}
    <div class="es-thanks" data-id="es-thanks">${esc(p.thanks || "Thanks for watching")}</div>
    <div class="es-head" style="left:112px" data-id="es-next"><svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>${esc(p.watchNext || "Watch next")}</div>
    <div class="es-head" style="left:912px" data-id="es-more"><svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="17" y2="6"/><line x1="3" y1="12" x2="13" y2="12"/><line x1="3" y1="18" x2="13" y2="18"/><polygon points="17 10 22 14 17 18"/></svg>${esc(p.more || "More from the series")}</div>
    <div class="es-box" style="left:112px" data-id="es-box-1"><div class="es-play"></div></div>
    <div class="es-box" style="left:912px" data-id="es-box-2"><div class="es-play"></div></div>
    <div class="es-helped" data-id="es-helped">${esc(p.helped || "IF THIS HELPED")}</div>
    <div class="es-btns" data-id="es-buttons">
      <span class="es-btn"><svg viewBox="0 0 24 24"><path d="M7 10v11H3V10h4zM7 10l4-8a3 3 0 0 1 3 3v4h6a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.6 21H7"/></svg>Like</span>
      <span class="es-btn"><svg viewBox="0 0 24 24"><path d="M4 17v-1a7 7 0 0 1 7-7h9"/><polyline points="15 4 20 9 15 14"/></svg>Share</span>
      <span class="es-btn sub"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>Subscribe</span>
    </div>
    <div class="es-sub" data-id="es-subscribe"><div><svg viewBox="0 0 24 24">${code}</svg></div></div>
    <div class="es-sublabel" data-id="es-sublabel">SUBSCRIBE</div>
    <div class="es-keep" data-id="es-keep"><div class="k1">${esc(p.keep || "KEEP LEARNING")}</div><div class="k2">${esc(opts.url)}</div><div class="k3">${esc(p.subline || "The full course, with practice and mock interviews")}</div></div>
  </div>`;
  return { css: END_CSS, markup };
}

/** The brand icon drawn (the AlgoInsight </> tile), used when the kit's icon image is missing or fails. */
export const ICON_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="mo-ico" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#9333ea"/></linearGradient></defs><rect width="40" height="40" rx="9" fill="url(#mo-ico)"/><g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M25 26l5-6-5-6"/><path d="M15 14l-5 6 5 6"/><path d="M22 11l-4 18"/></g></svg>`;

/** An <img> for the kit's icon that swaps itself for the drawn icon if it can't load. */
export function iconTag(url: string | null): string {
  if (!url) return `<span class="mo-icon">${ICON_SVG}</span>`;
  const src = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  // the drawn icon waits in data-fallback; a broken image swaps itself for it
  return `<span class="mo-icon" data-fallback='${ICON_SVG}'><img src="${src}" alt="" onerror="this.parentNode.innerHTML = this.parentNode.dataset.fallback"></span>`;
}

// ── the end screen in the paper look ──

const PAPER_END_CSS = `
.pe { position: absolute; inset: 0; font-family: var(--font-display); color: var(--ink); }
.mo-icon { display: inline-flex; flex: none; }
.mo-icon img, .mo-icon svg { width: 100%; height: 100%; display: block; border-radius: 22%; }
.pe-logo { position: absolute; left: 640px; top: 36px; width: 320px; height: 74px; transform: rotate(-2deg); }
.pe-logo::before { content: ""; position: absolute; left: 7px; top: 7px; width: 320px; height: 74px; border-radius: 16px; background: var(--ink); }
.pe-logo-card { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 12px; background: #fff; border: 4px solid var(--ink); border-radius: 16px; }
.pe-logo-card .mo-icon { width: 52px; height: 52px; }
.pe-logo-card span.word { font: 800 38px/1 var(--font-display); letter-spacing: -0.6px; white-space: nowrap; }
.pe-tagline { position: absolute; left: 0; right: 0; top: 134px; text-align: center; font: 800 14px/1 var(--font-display); letter-spacing: 4px; color: var(--c-ink-2); }
.pe-thanks { position: absolute; left: 0; right: 0; top: 162px; text-align: center; margin: 0; font: 800 66px/1.05 var(--font-display); letter-spacing: -1.6px; }
.pe-thanks .p-marked { margin-left: 14px; } /* the band reaches 12px left: keep a gap after the previous word */
.pe-tag { position: absolute; top: 232px; height: 50px; font-size: 22px; }
.pe-box { position: absolute; top: 300px; width: 576px; height: 312px; background: #fff; border: 4px solid var(--ink); border-radius: 18px; box-shadow: 10px 10px 0 var(--ink); }
.pe-box::after { content: ""; position: absolute; inset: 14px; border: 3px dashed var(--c-faint); border-radius: 10px; }
.pe-play { position: absolute; left: 50%; top: 50%; width: 84px; height: 84px; margin: -42px 0 0 -42px; border-radius: 50%; background: var(--c-lemon); border: 4px solid var(--ink); box-shadow: 5px 5px 0 var(--ink); z-index: 1; }
.pe-play::after { content: ""; position: absolute; left: 31px; top: 22px; border-left: 28px solid var(--ink); border-top: 16px solid transparent; border-bottom: 16px solid transparent; }
.pe-helped { position: absolute; left: 112px; top: 672px; font: 800 15px/1 var(--font-display); letter-spacing: 4px; color: var(--c-ink-2); }
.pe-btns { position: absolute; left: 112px; top: 702px; display: flex; gap: 14px; }
.pe-btn { height: 50px; display: inline-flex; align-items: center; gap: 10px; padding: 0 20px; border-radius: 25px; background: #fff; border: 3px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); font: 700 20px/1 var(--font-display); color: var(--ink); }
.pe-btn svg { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.pe-btn.sub { background: var(--c-pen); color: #fff; }
.pe-sub { position: absolute; left: 722px; top: 648px; width: 156px; height: 156px; border-radius: 50%; background: #fff; border: 5px solid var(--ink); box-shadow: 8px 8px 0 var(--ink); display: flex; align-items: center; justify-content: center; }
.pe-sub .mo-icon { width: 92px; height: 92px; }
.pe-ring { position: absolute; left: 700px; top: 626px; width: 200px; height: 200px; overflow: visible; }
.pe-ring path { fill: none; stroke: var(--c-pen); stroke-width: 5; stroke-linecap: round; }
.pe-sublabel { position: absolute; left: 0; right: 0; top: 834px; text-align: center; font: 800 18px/1 var(--font-display); letter-spacing: 4px; }
.pe-keep { position: absolute; right: 112px; top: 672px; text-align: right; }
.pe-keep .k1 { font: 800 15px/1 var(--font-display); letter-spacing: 4px; color: var(--c-ink-2); }
.pe-keep .k2 { display: inline-block; margin-top: 14px; font: 800 46px/1 var(--font-display); letter-spacing: -0.8px; }
.pe-keep .k3 { margin: 12px 0 0; font-size: 32px; transform: rotate(-2deg); transform-origin: right center; white-space: nowrap; }
`;

export function paperEndScreen(opts: { wordmark: string; tagline: string; iconUrl: string | null; url: string; props: Record<string, unknown> }): { css: string; markup: string; script: string } {
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const p = opts.props || {};
  const thanks = String(p.thanks || "Thanks for watching");
  // the last word gets the marker stroke
  const cut = thanks.lastIndexOf(" ");
  const thanksHtml = cut > 0 ? `${esc(thanks.slice(0, cut))} <span class="p-marked" data-id="pe-mark">${esc(thanks.slice(cut + 1))}</span>` : `<span class="p-marked" data-id="pe-mark">${esc(thanks)}</span>`;
  const markup = `
  <div class="pe" data-id="end-screen">
    <div class="pe-logo" data-id="pe-logo"><div class="pe-logo-card">${iconTag(opts.iconUrl)}<span class="word">${esc(opts.wordmark)}</span></div></div>
    ${opts.tagline ? `<div class="pe-tagline" data-id="pe-tagline">${esc(opts.tagline)}</div>` : ""}
    <h2 class="pe-thanks" data-id="pe-thanks">${thanksHtml}</h2>
    <div class="p-tag pe-tag" style="left:112px" data-id="pe-next">${esc(p.watchNext || "Watch next")}</div>
    <div class="p-tag pe-tag" style="left:912px" data-id="pe-more">${esc(p.more || "More from the series")}</div>
    <div class="pe-box" style="left:112px" data-id="pe-box-1"><div class="pe-play"></div></div>
    <div class="pe-box" style="left:912px" data-id="pe-box-2"><div class="pe-play"></div></div>
    <div class="pe-helped" data-id="pe-helped">${esc(p.helped || "IF THIS HELPED")}</div>
    <div class="pe-btns" data-id="pe-buttons">
      <span class="pe-btn"><svg viewBox="0 0 24 24"><path d="M7 10v11H3V10h4zM7 10l4-8a3 3 0 0 1 3 3v4h6a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.6 21H7"/></svg>Like</span>
      <span class="pe-btn"><svg viewBox="0 0 24 24"><path d="M4 17v-1a7 7 0 0 1 7-7h9"/><polyline points="15 4 20 9 15 14"/></svg>Share</span>
      <span class="pe-btn sub"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>Subscribe</span>
    </div>
    <div class="pe-sub" data-id="pe-subscribe">${iconTag(opts.iconUrl)}</div>
    <svg class="pe-ring" viewBox="0 0 200 200" data-id="pe-ring"><path d="M100 8 C 158 6, 196 46, 192 100 C 188 156, 146 194, 96 192 C 44 190, 6 152, 9 98 C 12 48, 52 12, 108 14" /></svg>
    <div class="pe-sublabel" data-id="pe-sublabel">${esc(p.subscribe || "SUBSCRIBE")}</div>
    <div class="pe-keep" data-id="pe-keep">
      <div class="k1">${esc(p.keep || "KEEP LEARNING")}</div>
      ${opts.url ? `<span class="k2 p-marked" data-id="pe-url">${esc(opts.url)}</span>` : ""}
      <p class="p-note k3" data-id="pe-note">${esc(p.subline || "the full course, with practice and mock interviews")}</p>
    </div>
  </div>`;
  const script = `
    const T = cue(0);
    fx.pop($('pe-logo'), T);
    const tagline = root.querySelector('[data-id="pe-tagline"]');
    if (tagline) fx.rise(tagline, T + 0.2);
    fx.rise($('pe-thanks'), T + 0.35);
    fx.marker($('pe-mark'), T + 0.8);
    fx.tearOn([$('pe-next'), $('pe-more')], T + 1.0);
    fx.pop([$('pe-box-1'), $('pe-box-2')], T + 1.15);
    fx.rise([$('pe-helped'), $('pe-buttons')], T + 1.5);
    fx.pop($('pe-subscribe'), T + 1.6);
    fx.draw($('pe-ring').querySelector('path'), T + 1.9, 0.6);
    fx.rise($('pe-keep'), T + 1.7);
    if (root.querySelector('[data-id="pe-url"]')) fx.marker($('pe-url'), T + 2.1);
    fx.write($('pe-note'), T + 2.3);`;
  return { css: PAPER_END_CSS, markup, script };
}

// ── fx: entrances and exits with their sounds ──

export type Fx = ReturnType<typeof makeFx>;

export function makeFx(tl: gsap.core.Timeline, sceneId: string, sfx: SfxEvent[]) {
  const sound = (name: string, at: number, gain = 1) => {
    if (Number.isFinite(at) && at >= 0) sfx.push({ sceneId, t: Math.round(at * 1000) / 1000, name, gain });
  };
  const list = (els: Element | Element[] | null | undefined) => (Array.isArray(els) ? els : els ? [els] : []).filter(Boolean) as HTMLElement[];
  /** a left-to-right reveal through a mask (keeps any torn clip-path the element already has) */
  const reveal = (el: HTMLElement, at: number, dur: number, soft: number) => {
    const state = { p: 0 };
    const apply = () => {
      const front = state.p * (100 + soft);
      const m = `linear-gradient(90deg, #000 ${(front - soft).toFixed(2)}%, transparent ${front.toFixed(2)}%)`;
      el.style.setProperty("-webkit-mask-image", m);
      el.style.setProperty("mask-image", m);
    };
    tl.fromTo(state, { p: 0 }, { p: 1, duration: dur, ease: "power1.inOut", onUpdate: apply, onStart: apply, immediateRender: true }, at);
    apply();
    tl.set(el, { autoAlpha: 1 }, at);
    tl.set(el, { autoAlpha: 0 }, 0);
  };
  return {
    sound,
    pop(els: Element | Element[], at: number) {
      for (const el of list(els)) {
        tl.fromTo(el, { scale: 0.5, autoAlpha: 0 }, { scale: 1.08, autoAlpha: 1, duration: 0.23, ease: "power2.out" }, at);
        tl.to(el, { scale: 1, duration: 0.12, ease: "power1.inOut" }, at + 0.23);
      }
      sound("pop", at, 0.8);
    },
    unfold(els: Element | Element[], at: number) {
      for (const el of list(els)) {
        tl.fromTo(el, { rotationX: -86, transformPerspective: 1400, transformOrigin: "50% 0%", autoAlpha: 0 }, { rotationX: 0, autoAlpha: 1, duration: 0.6, ease: "power2.out" }, at);
        const kids = Array.from(el.children);
        if (kids.length) tl.fromTo(kids, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12 }, at + 0.5);
      }
    },
    tearOn(els: Element | Element[], at: number) {
      for (const el of list(els)) reveal(el, at, 0.45, 6);
    },
    write(els: Element | Element[], at: number) {
      for (const el of list(els)) {
        const chars = (el.textContent || "").length;
        reveal(el, at, Math.min(1.1, 0.35 + 0.018 * chars), 2);
      }
      sound("pencil", at, 0.7);
    },
    marker(els: Element | Element[], at: number) {
      for (const el of list(els)) {
        let bandEl = el.querySelector(":scope > .p-band") as HTMLElement | null;
        if (!bandEl) {
          bandEl = document.createElement("span");
          bandEl.className = "p-band";
          el.insertBefore(bandEl, el.firstChild);
        }
        tl.fromTo(bandEl, { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power2.out" }, at);
      }
    },
    draw(els: Element | Element[], at: number, seconds = 0.45) {
      for (const el of list(els)) {
        tl.fromTo(el, { drawSVG: "0%" }, { drawSVG: "100%", duration: seconds, ease: "power1.inOut" }, at);
        // an arrow's tip (class "head") lands as the line reaches it
        const tip = tipOf(el);
        if (tip) {
          tl.set(tip, { autoAlpha: 0 }, 0);
          tl.set(tip, { autoAlpha: 1 }, at + seconds * 0.92);
        }
      }
    },
    stamp(els: Element | Element[], at: number) {
      for (const el of list(els)) {
        const base = Number(gsap.getProperty(el, "rotation")) || 0;
        tl.fromTo(el, { scale: 1.8, rotation: base - 9, autoAlpha: 0 }, { scale: 0.93, rotation: base + 1.5, autoAlpha: 1, duration: 0.176, ease: "power2.in" }, at);
        tl.to(el, { scale: 1.03, duration: 0.126, ease: "power2.out" }, at + 0.176);
        tl.to(el, { scale: 1, rotation: base, duration: 0.118, ease: "power2.out" }, at + 0.302);
      }
      sound("stamp", at + 0.15);
    },
    rise(els: Element | Element[], at: number) {
      tl.fromTo(list(els), { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.4, ease: "power2.out", stagger: 0.08 }, at);
    },
    slide(els: Element | Element[], at: number) {
      tl.fromTo(list(els), { x: -34, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.4, ease: "power2.out", stagger: 0.08 }, at);
    },
    type(els: Element | Element[], at: number) {
      for (const el of list(els)) {
        const split = SplitText.create(el, { type: "chars" });
        tl.fromTo(split.chars, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01, stagger: 0.035 }, at);
      }
      sound("type", at, 0.8);
    },
    count(el: Element, from: number, to: number, at: number, seconds = 1, decimals = 0) {
      const box = { v: from };
      const show = () => {
        (el as HTMLElement).textContent = box.v.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      };
      show();
      tl.fromTo(box, { v: from }, { v: to, duration: seconds, ease: "power1.out", onUpdate: show, immediateRender: false }, at);
    },
    exit(els: Element | Element[], at: number) {
      const all = list(els).flatMap((el): Element[] => { const tip = tipOf(el); return tip ? [el, tip] : [el]; });
      tl.to(all, { autoAlpha: 0, duration: 0.32, ease: "power1.in" }, at);
    },
    crumple(els: Element | Element[], at: number) {
      for (const el of list(els)) {
        tl.to(el, { scaleX: 0.82, scaleY: 0.9, y: 10, rotation: "+=25", borderRadius: "30%", duration: 0.22, ease: "power2.out" }, at);
        tl.to(el, { scaleX: 0.4, scaleY: 0.46, x: 50, y: -40, rotation: "+=90", borderRadius: "50%", duration: 0.3, ease: "power2.in" }, at + 0.22);
        tl.to(el, { scaleX: 0.07, scaleY: 0.08, x: 140, y: -160, rotation: "+=120", duration: 0.23, ease: "power2.in" }, at + 0.52);
        tl.set(el, { autoAlpha: 0 }, at + 0.75);
      }
      sound("crumple", at);
    },
  };
}
