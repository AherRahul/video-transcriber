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
//   - fx: entrances and exits with the films' timings, each one also asking for its sound effect; the
//     camera (fx.focus, fx.unfocus); the flow kit (fx.link, fx.flow, fx.travel, fx.circle, fx.grow,
//     fx.change, fx.cut); charts (fx.chart, built by chart.ts); code walkthroughs (fx.code, fx.line,
//     fx.lineOff, on blocks highlighted by code.ts).
//
// Every effect is a tween on the scene's paused timeline (or computed from time in the player), so the
// export, which seeks frame by frame, matches the preview exactly.

import { gsap } from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { SplitText } from "gsap/SplitText";

import { buildChart, type ChartSpec } from "./chart";
import { codeLines, codeStart } from "./code";
import { center, layoutBox, restBox, svgEl, svgToCam, union, type Box } from "./geometry";

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
  /** a thumbnail is a picture of its own: no logo card, title, part tag or web address (the grain stays) */
  setBare: (on: boolean) => void;
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
    setBare(on: boolean) {
      for (const el of Array.from(root.children) as HTMLElement[]) {
        if (!el.classList.contains("c-grain")) el.style.visibility = on ? "hidden" : "";
      }
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
type TipPath = SVGPathElement & { __tip?: SVGPathElement; __cut?: Element[] };
const tipOf = (el: Element): SVGPathElement | undefined => (el as unknown as TipPath).__tip;
/** The pen X that fx.cut drew across a line (fx.exit takes it away with the line, like the tip). */
const cutMarksOf = (el: Element): Element[] => (el as unknown as TipPath).__cut ?? [];

/**
 * Arrowheads. A path with class "p-arrow head" gets its tip from the player: on the path's real end and
 * pointing along it, so a head can never sit apart from its line or point the wrong way (hand-drawn heads
 * did both). fx.draw shows the tip as the line arrives; fx.exit takes it away with the line.
 */
export function arrowTips(root: ParentNode) {
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

/** What fx needs from the scene beyond its timeline. */
export type FxScene = {
  /** the camera: the wrapper around the scene's markup that fx.focus moves (links and circles draw in it) */
  cam: HTMLElement;
  /** the stage in design units */
  width: number;
  height: number;
  /** the box fx.focus fills with its target: the paper's content box, or the safe area (x0, y0, x1, y1) */
  content: [number, number, number, number];
  /** told about every entrance made through fx (its kind, elements and start), for the timing report */
  entrance?: (kind: string, els: Element[], at: number) => void;
  /** the smallest text the layout report accepts on this stage (fx.chart sizes its labels from it) */
  minText?: number;
};

/** fx.focus target: an element, several (the box around them all) or a box in stage px. */
type Target = Element | Element[] | Box;
type Ease = (p: number) => number;
type Move<T> = { at: number; dur: number; to: T; ease: string };

/** Packet colours by name; anything else is used as it is (any CSS colour). */
const PACKET_COLORS: Record<string, string> = {
  pen: "var(--c-pen, var(--accent2))",
  ink: "var(--ink)",
  pass: "var(--c-pass, var(--accent))",
  fail: "var(--c-fail, var(--accent2))",
  sky: "var(--c-sky, var(--surface))",
  lemon: "var(--c-lemon, var(--accent))",
  mint: "var(--c-mint, var(--surface))",
  pink: "var(--c-pink, var(--surface))",
  peach: "var(--c-peach, var(--surface))",
};

const mix = <T extends Record<string, number>>(a: T, b: T, t: number): T => {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof T)[]) (out as Record<keyof T, number>)[k] = a[k] + (b[k] - a[k]) * t;
  return out;
};

/**
 * A run of moves of one thing (the camera, a code block's band), each starting from wherever the one before
 * left it. Scripts may add them in any order, so they are sorted by time. A move that starts before the one
 * before it has finished cuts that one short exactly where it had got to (on its own curve, just ended early),
 * so nothing jumps, and every tween is a fromTo with explicit values: seeking backwards gives the same frames
 * as playing forwards.
 */
function chainMoves<T extends Record<string, number>>(moves: Move<T>[], start: T, add: (from: T, to: T, at: number, dur: number, ease: string | Ease) => void) {
  const sorted = moves.map((m, i) => ({ ...m, i })).sort((a, b) => a.at - b.at || a.i - b.i);
  let from = start;
  for (let k = 0; k < sorted.length; k++) {
    const m = sorted[k];
    const next = sorted[k + 1];
    let to = m.to;
    let dur = m.dur;
    let ease: string | Ease = m.ease;
    if (next && m.dur > 0 && next.at < m.at + m.dur) {
      const f = Math.max(0, (next.at - m.at) / m.dur);
      if (f <= 1e-6) continue; // replaced before it began
      const E = gsap.parseEase(m.ease) as Ease;
      const ef = E(f);
      to = mix(from, m.to, ef);
      dur = m.dur * f;
      ease = Math.abs(ef) > 1e-6 ? (p: number) => E(p * f) / ef : (p: number) => p;
    }
    add(from, to, m.at, dur, ease);
    from = to;
  }
}

/** The two facing edges of a and b (with a little air), picked from where b sits relative to a. */
function linkEnds(a: Box, b: Box) {
  const ca = center(a);
  const cb = center(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const side = Math.abs(dx) / Math.max(1, (a.w + b.w) / 2) >= Math.abs(dy) / Math.max(1, (a.h + b.h) / 2);
  // a card's hard shadow takes 10 px on its right and bottom: a line leaving or reaching those edges keeps clear of it
  const near = 14;
  const far = 24;
  // When the boxes don't line up, each end sits on its side toward the other box (kept to the side's
  // middle part), not at its centre: two links into the same side from above and below then land
  // apart, where both used to meet in one point and their heads crossed.
  const toward = (start: number, size: number, want: number) => Math.min(start + size * 0.72, Math.max(start + size * 0.28, want));
  if (side) {
    const lo = Math.max(a.y, b.y);
    const hi = Math.min(a.y + a.h, b.y + b.h);
    const y0 = hi - lo > 20 ? (lo + hi) / 2 : toward(a.y, a.h, cb.y);
    const y1 = hi - lo > 20 ? (lo + hi) / 2 : toward(b.y, b.h, ca.y);
    return dx >= 0
      ? { side, p0: { x: a.x + a.w + far, y: y0 }, p1: { x: b.x - near, y: y1 } }
      : { side, p0: { x: a.x - near, y: y0 }, p1: { x: b.x + b.w + far, y: y1 } };
  }
  const lo = Math.max(a.x, b.x);
  const hi = Math.min(a.x + a.w, b.x + b.w);
  const x0 = hi - lo > 20 ? (lo + hi) / 2 : toward(a.x, a.w, cb.x);
  const x1 = hi - lo > 20 ? (lo + hi) / 2 : toward(b.x, b.w, ca.x);
  return dy >= 0
    ? { side, p0: { x: x0, y: a.y + a.h + far }, p1: { x: x1, y: b.y - near } }
    : { side, p0: { x: x0, y: a.y - near }, p1: { x: x1, y: b.y + b.h + far } };
}

const r1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** A hand-drawn pen loop around a box: a slightly wobbly, slightly turned ellipse that runs on past its start. */
function circlePath(b: Box, seed: number): string {
  const r = stream(seed);
  const c = center(b);
  // an ellipse through the box's corners is the box's half size times root two; then a little air
  const rx = (b.w / 2) * Math.SQRT2 + 12;
  const ry = (b.h / 2) * Math.SQRT2 + 12;
  const tilt = (r() - 0.5) * 0.12;
  const start = -Math.PI * 0.62 + (r() - 0.5) * 0.3;
  const sweep = Math.PI * 2 + 0.42 + r() * 0.18;
  const n = 11;
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const a = start + (sweep * k) / n;
    const f = 1 + (r() - 0.5) * 0.06 + 0.04 * (k / n); // a wobble, and a slow spiral so the end runs clear of the start
    const ex = rx * f * Math.cos(a);
    const ey = ry * f * Math.sin(a);
    pts.push({ x: c.x + ex * Math.cos(tilt) - ey * Math.sin(tilt), y: c.y + ex * Math.sin(tilt) + ey * Math.cos(tilt) });
  }
  // through the points as a smooth curve (Catmull-Rom as cubic Beziers)
  let d = `M ${r1(pts[0].x)} ${r1(pts[0].y)}`;
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)];
    const p1 = pts[k];
    const p2 = pts[k + 1];
    const p3 = pts[Math.min(pts.length - 1, k + 2)];
    d += ` C ${r1(p1.x + (p2.x - p0.x) / 6)} ${r1(p1.y + (p2.y - p0.y) / 6)}, ${r1(p2.x - (p3.x - p1.x) / 6)} ${r1(p2.y - (p3.y - p1.y) / 6)}, ${r1(p2.x)} ${r1(p2.y)}`;
  }
  return d;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The progress at which an ease reaches y (0-1), found by halving: eases here only ever climb. */
function invEase(E: Ease, y: number): number {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (E(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function makeFx(tl: gsap.core.Timeline, sceneId: string, sfx: SfxEvent[], scene: FxScene) {
  const { cam, width: W, height: H } = scene;
  const sound = (name: string, at: number, gain = 1) => {
    if (Number.isFinite(at) && at >= 0) sfx.push({ sceneId, t: Math.round(at * 1000) / 1000, name, gain });
  };
  const list = (els: Element | Element[] | null | undefined) => (Array.isArray(els) ? els : els ? [els] : []).filter(Boolean) as HTMLElement[];
  /** an entrance, for the timing report (it checks each one against the cue its time came from) */
  const mark = (kind: string, els: Element[], at: number) => scene.entrance?.(kind, els, at);
  const idOf = (el: Element) => el.getAttribute("data-id") || el.tagName.toLowerCase();
  /** a left-to-right reveal through a mask (keeps any torn clip-path the element already has) */
  // A left-to-right wipe (pen notes written on, labels torn on). A mask normally covers only the element's
  // own box, and a handwritten font's tails (the g, y and p of Caveat) hang below it, so they were cut off
  // on every page. The wipe now repeats above and below the box (no-clip, repeat-y), and once the words are
  // all there the mask is dropped, so nothing of the letters is ever trimmed at rest.
  const reveal = (el: HTMLElement, at: number, dur: number, soft: number) => {
    const state = { p: 0 };
    const apply = () => {
      if (state.p >= 1) {
        for (const k of ["-webkit-mask-image", "mask-image", "mask-clip", "mask-repeat", "-webkit-mask-repeat"]) el.style.removeProperty(k);
        return;
      }
      const front = state.p * (100 + soft);
      const m = `linear-gradient(90deg, #000 ${(front - soft).toFixed(2)}%, transparent ${front.toFixed(2)}%)`;
      el.style.setProperty("-webkit-mask-image", m);
      el.style.setProperty("mask-image", m);
      el.style.setProperty("-webkit-mask-repeat", "repeat-y");
      el.style.setProperty("mask-repeat", "repeat-y");
      el.style.setProperty("mask-clip", "no-clip");
    };
    tl.fromTo(state, { p: 0 }, { p: 1, duration: dur, ease: "power1.inOut", onUpdate: apply, onStart: apply, immediateRender: true }, at);
    apply();
    tl.set(el, { autoAlpha: 1 }, at);
    tl.set(el, { autoAlpha: 0 }, 0);
  };
  /** a pen line drawn on; an arrow's tip (class "head") lands as the line arrives */
  const drawPath = (el: Element, at: number, seconds: number) => {
    tl.fromTo(el, { drawSVG: "0%" }, { drawSVG: "100%", duration: seconds, ease: "power1.inOut" }, at);
    const tip = tipOf(el);
    if (tip) {
      // hidden now as well as on the timeline: a set at time 0 doesn't run when the first seek lands
      // exactly on 0, and the tip showed for a frame before its line was drawn
      gsap.set(tip, { autoAlpha: 0 });
      tl.set(tip, { autoAlpha: 0 }, 0);
      tl.set(tip, { autoAlpha: 1 }, at + seconds * 0.92);
    }
  };

  // the player's own drawings (fx.link arrows, fx.circle loops): one SVG over the whole page, inside the
  // camera so they zoom with what they point at, made the first time one is needed
  let drawings: SVGSVGElement | null = null;
  const overlay = () => {
    if (!drawings) {
      drawings = svgEl("svg", { class: "p-links", viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
      drawings.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:visible;pointer-events:none;`;
      cam.appendChild(drawings);
    }
    return drawings;
  };
  const made = new Set<string>();
  const freshId = (base: string) => {
    let id = base;
    for (let k = 2; made.has(id) || (cam.getRootNode() as ParentNode).querySelector(`[data-id="${CSS.escape(id)}"]`); k++) id = `${base}-${k}`;
    made.add(id);
    return id;
  };
  let circles = 0;

  // fx.cut and fx.flow: each cut line's gap (its edges as fractions of the line's length, and when it opens)
  // and every packet run on each path, so a cut made after a flow can re-time the packets it stops
  type Gap = { at: number; a: number; b: number; len: number; unit: number };
  type Run = { dot: SVGCircleElement; path: SVGPathElement; t0: number; seconds: number; fade: number; rev: boolean; r: number; tweens: gsap.core.Tween[] };
  const gaps = new Map<Element, Gap>();
  const runs = new Map<Element, Run[]>();
  let cuts = 0;
  /**
   * One packet's trip and its fade at the end: along the whole path, or, on a cut line when it would reach
   * the gap after the gap has opened, only up to the gap's near edge, where it stops and fades. Up to that
   * edge it moves exactly as it would have (the same curve, ended early), so a packet that crossed before
   * the cut is untouched and nothing jumps.
   */
  const travelRun = (run: Run) => {
    const { dot, path: p, t0, seconds, fade, rev } = run;
    // tl.to and tl.fromTo return the timeline: the tween each one just added is tl.recent()
    const keep = () => run.tweens.push(tl.recent() as gsap.core.Tween);
    const gap = gaps.get(p);
    if (gap) {
      const E = gsap.parseEase("sine.inOut") as Ease;
      const room = (run.r + 2 * gap.unit) / gap.len; // it stops just short of the broken end
      const stop = rev ? Math.min(1, gap.b + room) : Math.max(0, gap.a - room);
      const f = Math.max(1e-4, invEase(E, rev ? 1 - stop : stop)); // the trip's progress at the edge
      const tStop = t0 + seconds * f;
      if (tStop >= gap.at) {
        const Ef = E(f) || 1;
        tl.to(dot, { motionPath: { path: p, start: rev ? 1 : 0, end: stop }, duration: seconds * f, ease: (x: number) => E(x * f) / Ef, immediateRender: false }, t0);
        keep();
        tl.fromTo(dot, { autoAlpha: 1 }, { autoAlpha: 0, duration: 0.25, ease: "power1.in", immediateRender: false }, tStop + 0.12);
        keep();
        return;
      }
    }
    // the whole trip, exactly as the flow kit has always made it
    tl.to(dot, { motionPath: { path: p, start: rev ? 1 : 0, end: rev ? 0 : 1 }, duration: seconds, ease: "sine.inOut", immediateRender: false }, t0);
    keep();
    tl.fromTo(dot, { autoAlpha: 1 }, { autoAlpha: 0, duration: fade, ease: "none", immediateRender: false }, t0 + seconds - fade);
    keep();
  };

  // camera moves and code bands are collected and turned into tweens once the script has run (finish)
  type CamState = { x: number; y: number; scale: number };
  const camMoves: Move<CamState>[] = [];
  const bandOps = new Map<HTMLElement, { at: number; lines: [number, number] | null }[]>();

  const targetBox = (target: Target): Box | null => {
    if (target && !(target instanceof Element) && !Array.isArray(target) && typeof (target as Box).w === "number") return target as Box;
    return union(list(target as Element | Element[]).map((el) => restBox(el, cam, W)));
  };

  return {
    sound,
    pop(els: Element | Element[], at: number) {
      mark("pop", list(els), at);
      for (const el of list(els)) {
        tl.fromTo(el, { scale: 0.5, autoAlpha: 0 }, { scale: 1.08, autoAlpha: 1, duration: 0.23, ease: "power2.out" }, at);
        tl.to(el, { scale: 1, duration: 0.12, ease: "power1.inOut" }, at + 0.23);
      }
      sound("pop", at, 0.8);
    },
    unfold(els: Element | Element[], at: number) {
      mark("unfold", list(els), at);
      for (const el of list(els)) {
        tl.fromTo(el, { rotationX: -86, transformPerspective: 1400, transformOrigin: "50% 0%", autoAlpha: 0 }, { rotationX: 0, autoAlpha: 1, duration: 0.6, ease: "power2.out" }, at);
        const kids = Array.from(el.children);
        if (kids.length) tl.fromTo(kids, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12 }, at + 0.5);
      }
    },
    tearOn(els: Element | Element[], at: number) {
      mark("tearOn", list(els), at);
      for (const el of list(els)) reveal(el, at, 0.45, 6);
    },
    write(els: Element | Element[], at: number) {
      mark("write", list(els), at);
      for (const el of list(els)) {
        const chars = (el.textContent || "").length;
        reveal(el, at, Math.min(1.1, 0.35 + 0.018 * chars), 2);
      }
      sound("pencil", at, 0.7);
    },
    marker(els: Element | Element[], at: number) {
      mark("marker", list(els), at);
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
      mark("draw", list(els), at);
      for (const el of list(els)) drawPath(el, at, seconds);
    },
    stamp(els: Element | Element[], at: number) {
      mark("stamp", list(els), at);
      for (const el of list(els)) {
        const base = Number(gsap.getProperty(el, "rotation")) || 0;
        tl.fromTo(el, { scale: 1.8, rotation: base - 9, autoAlpha: 0 }, { scale: 0.93, rotation: base + 1.5, autoAlpha: 1, duration: 0.176, ease: "power2.in" }, at);
        tl.to(el, { scale: 1.03, duration: 0.126, ease: "power2.out" }, at + 0.176);
        tl.to(el, { scale: 1, rotation: base, duration: 0.118, ease: "power2.out" }, at + 0.302);
      }
      sound("stamp", at + 0.15);
    },
    rise(els: Element | Element[], at: number) {
      mark("rise", list(els), at);
      tl.fromTo(list(els), { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.4, ease: "power2.out", stagger: 0.08 }, at);
    },
    slide(els: Element | Element[], at: number) {
      mark("slide", list(els), at);
      tl.fromTo(list(els), { x: -34, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.4, ease: "power2.out", stagger: 0.08 }, at);
    },
    type(els: Element | Element[], at: number) {
      mark("type", list(els), at);
      for (const el of list(els)) {
        const split = SplitText.create(el, { type: "chars" });
        tl.fromTo(split.chars, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01, stagger: 0.035 }, at);
      }
      sound("type", at, 0.8);
    },
    count(el: Element, from: number, to: number, at: number, seconds = 1, decimals = 0) {
      mark("count", list(el), at);
      const box = { v: from };
      const show = () => {
        (el as HTMLElement).textContent = box.v.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      };
      show();
      tl.fromTo(box, { v: from }, { v: to, duration: seconds, ease: "power1.out", onUpdate: show, immediateRender: false }, at);
    },
    exit(els: Element | Element[], at: number) {
      // a line leaves with its tip and any X that fx.cut drew across it
      const all = list(els).flatMap((el): Element[] => { const tip = tipOf(el); return [...(tip ? [el, tip] : [el]), ...cutMarksOf(el)]; });
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

    // ── the camera ──

    /** Zooms and pans the page so the target fills the content box with a comfortable margin. The target is
     *  an element, several (the box around them) or a box in stage px; zoom is the most it may scale. */
    focus(target: Target, at: number, opts: { zoom?: number; seconds?: number } = {}) {
      const box = targetBox(target);
      if (!box || !(box.w > 0) || !(box.h > 0)) return;
      const [x0, y0, x1, y1] = scene.content;
      const cw = x1 - x0;
      const ch = y1 - y0;
      const room = 0.84; // the target takes at most this much of the content box
      const most = Math.max(1, Number(opts.zoom) || 2.2);
      let scale = Math.max(1, Math.min(most, (cw * room) / box.w, (ch * room) / box.h));
      const c = center(box);
      // The page's top content never goes up into the header (the logo card, the torn label and the
      // title stay clear): centring a lower row used to push the rows above it under all three. So the
      // camera keeps the page's top at the content box's top or lower, and if the target then reaches
      // past the content box's bottom, the zoom shrinks until it fits.
      const page = union(Array.from(cam.querySelectorAll("[data-id]")).map((el) => restBox(el, cam, W)));
      const top = page ? Math.max(page.y, 0) : y0;
      let x = 0;
      let y = 0;
      for (;;) {
        // the target's centre to the content box's centre, but never so far that the page's edge shows
        x = Math.min(0, Math.max(W - scale * W, x0 + cw / 2 - scale * c.x));
        y = Math.min(0, Math.max(H - scale * H, Math.max(y0 + ch / 2 - scale * c.y, y0 - scale * top)));
        if (scale <= 1 || scale * (box.y + box.h) + y <= y1) break;
        scale = Math.max(1, scale - 0.05);
      }
      if (scale <= 1.001) {
        x = 0;
        y = 0;
      }
      camMoves.push({ at, dur: Math.max(0, Number(opts.seconds ?? 0.8)), to: { x, y, scale }, ease: "power2.inOut" });
      mark("focus", target instanceof Element || Array.isArray(target) ? list(target) : [], at);
    },
    /** Back to the whole page. */
    unfocus(at: number, seconds = 0.8) {
      camMoves.push({ at, dur: Math.max(0, seconds), to: { x: 0, y: 0, scale: 1 }, ease: "power2.inOut" });
    },

    // ── the flow kit ──

    /** Packets (dots) travelling along an SVG path, one after another; they appear at its start and fade at
     *  its end. size is the dot's radius in stage px; color a name (pen, ink, pass, sky, ...) or any CSS colour. */
    flow(path: Element, at: number, opts: { count?: number; every?: number; seconds?: number; size?: number; color?: string; reverse?: boolean } = {}) {
      const p = path as SVGPathElement;
      if (!(p instanceof SVGElement) || !p.ownerSVGElement || !p.parentNode) return [] as SVGCircleElement[];
      mark("flow", [p], at);
      const count = Math.max(1, Math.min(40, Math.round(Number(opts.count ?? 3)) || 1));
      const every = Math.max(0, Number(opts.every ?? 0.3) || 0);
      const seconds = Math.max(0.1, Number(opts.seconds ?? 1.1) || 1.1);
      const size = Math.max(1, Number(opts.size ?? 9) || 9);
      const color = PACKET_COLORS[String(opts.color ?? "pen")] ?? String(opts.color);
      const rev = !!opts.reverse;
      const geo = svgToCam(p, cam, W);
      const unit = geo ? 1 / geo.scale : 1; // one stage px in the path's own units
      const fade = Math.min(0.15, seconds / 4);
      const dots: SVGCircleElement[] = [];
      for (let k = 0; k < count; k++) {
        const dot = svgEl("circle", { class: "p-packet", cx: 0, cy: 0, r: (size * unit).toFixed(2) });
        dot.style.fill = color;
        dot.style.stroke = "var(--ink)";
        dot.style.strokeWidth = (2.5 * unit).toFixed(2);
        dots.push(dot);
      }
      (tipOf(p) ?? p).after(...dots); // over the line and its tip
      dots.forEach((dot, k) => {
        const t0 = at + k * every;
        tl.fromTo(dot, { autoAlpha: 0 }, { autoAlpha: 1, duration: fade, ease: "none" }, t0);
        // the trip (stopped at the gap if the line is cut), kept so a later fx.cut can re-time it
        const run: Run = { dot, path: p, t0, seconds, fade, rev, r: size * unit, tweens: [] };
        travelRun(run);
        if (!runs.has(p)) runs.set(p, []);
        runs.get(p)!.push(run);
      });
      return dots;
    },
    /** Moves any element along an SVG path (its centre follows the path; start the path where it is). */
    travel(els: Element | Element[], path: Element, at: number, seconds = 1) {
      const p = path as SVGPathElement;
      const raw = MotionPathPlugin.stringToRawPath(p.getAttribute?.("d") || "") as unknown as number[][];
      if (!raw.length || !raw[0].length) return;
      for (const el of list(els)) {
        let m: DOMMatrix | null = null;
        const svgShape = el instanceof SVGElement && !(el instanceof SVGSVGElement && !(el.parentNode instanceof SVGElement));
        if (svgShape) {
          // an SVG shape: from the path's units into its parent's, about the shape's own centre
          const pc = (el.parentNode as SVGGraphicsElement).getScreenCTM?.();
          const qc = p.getScreenCTM?.();
          if (pc && qc) {
            const bb = (el as unknown as SVGGraphicsElement).getBBox();
            m = new DOMMatrix().translateSelf(-(bb.x + bb.width / 2), -(bb.y + bb.height / 2)).multiplySelf(DOMMatrix.fromMatrix(pc).inverse().multiplySelf(DOMMatrix.fromMatrix(qc)));
          }
        } else {
          // an element on the page: the path in page px, about the element's own (untransformed) centre
          const geo = svgToCam(p, cam, W);
          if (geo) {
            const c = center(layoutBox(el, cam, W));
            m = new DOMMatrix().translateSelf(-c.x, -c.y).multiplySelf(geo.m);
          }
        }
        if (!m) continue;
        const mm = m;
        const moved = raw.map((seg) => {
          const out = Array.from(seg);
          for (let i = 0; i + 1 < out.length; i += 2) {
            const x = out[i];
            const y = out[i + 1];
            out[i] = mm.a * x + mm.c * y + mm.e;
            out[i + 1] = mm.b * x + mm.d * y + mm.f;
          }
          return out;
        });
        const d = MotionPathPlugin.rawPathToString(moved as unknown as Parameters<typeof MotionPathPlugin.rawPathToString>[0]);
        tl.to(el, { motionPath: { path: d }, duration: seconds, ease: "power1.inOut", immediateRender: false }, at);
      }
    },
    /** A red-pen arrow from one element to another, between their facing edges as a gentle curve. Returns the
     *  path (fx.flow can run packets on it). bend: how far it bows (0 straight, negative the other way). */
    link(fromEl: Element, toEl: Element, at: number, opts: { bend?: number; seconds?: number } = {}) {
      const ends = linkEnds(restBox(fromEl, cam, W), restBox(toEl, cam, W));
      const { p0, p1 } = ends;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      let nx = dy / len;
      let ny = -dx / len;
      // side by side it bows upward, one above the other it bows to the right
      if (ends.side ? ny > 0 : nx < 0) {
        nx = -nx;
        ny = -ny;
      }
      const off = (Number.isFinite(Number(opts.bend)) ? Number(opts.bend) : 0.12) * len;
      const c1 = { x: p0.x + dx / 3 + nx * off, y: p0.y + dy / 3 + ny * off };
      const c2 = { x: p0.x + (2 * dx) / 3 + nx * off, y: p0.y + (2 * dy) / 3 + ny * off };
      const path = svgEl("path", {
        class: "p-arrow head",
        d: `M ${r1(p0.x)} ${r1(p0.y)} C ${r1(c1.x)} ${r1(c1.y)}, ${r1(c2.x)} ${r1(c2.y)}, ${r1(p1.x)} ${r1(p1.y)}`,
        "data-id": freshId(`link-${idOf(fromEl)}-${idOf(toEl)}`),
      });
      overlay().appendChild(path);
      arrowTips(overlay());
      drawPath(path, at, Math.max(0.05, Number(opts.seconds ?? 0.5) || 0.5));
      mark("link", [path], at);
      return path;
    },
    /**
     * Breaks a connection (a line from fx.link, or any SVG path) the standard way: at `where` along it (0-1
     * of its length, the middle by default) a gap opens in the line and a bold red-pen X is drawn across the
     * gap, with a snap (the slap sound). The arrowhead stays at the line's end. Packets (fx.flow) that would
     * reach the gap after it opens stop at its near edge and fade, whether their flow was asked for before
     * or after the cut. Returns the X (data-id cut-<line>); fx.exit on the line takes the X away with it.
     * opts.size: the X's width in stage px (seven times the line's width by default, 28 to 64).
     */
    cut(path: Element, at: number, opts: { where?: number; size?: number } = {}) {
      const p = path as SVGPathElement;
      if (!(p instanceof SVGGeometryElement) || !p.ownerSVGElement) return null;
      let len = 0;
      try {
        len = p.getTotalLength();
      } catch {
        return null;
      }
      if (!(len > 4)) return null;
      const svg = p.ownerSVGElement;
      const geo = svgToCam(p, cam, W);
      const unit = geo ? 1 / geo.scale : 1; // one stage px in the path's own units
      const stroke = parseFloat(getComputedStyle(p).strokeWidth) || 5 * unit;
      const size = Math.max(28, Math.min(64, Number(opts.size) || (stroke / unit) * 7)); // the X's width, stage px
      const armPx = Math.max(7, (stroke / unit) * 1.5); // the X's pen width, stage px
      const asked = Number(opts.where ?? 0.5);
      const where = Math.max(0.08, Math.min(0.92, Number.isFinite(asked) ? asked : 0.5)); // kept off the very ends
      const along = (d: number) => p.getPointAtLength(Math.max(0, Math.min(len, where * len + d)));
      const back = along(-1);
      const ahead = along(1);
      const angle = Math.atan2(ahead.y - back.y, ahead.x - back.x);
      // The gap: as long as the upright X reaches along the line (half its width on a level line, more on a
      // slanted one, where an arm lies along it), its pen and some air on each side; never over 45% of the line.
      const reach = (size / 2) * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle))) + armPx / 2 + 10;
      const half = Math.min(reach, (len / unit) * 0.225) * unit;
      const mid = Math.max(half, Math.min(len - half, where * len));
      const c = p.getPointAtLength(mid);
      const deg = (angle * 180) / Math.PI;
      // A mask over the line: all of it shows except a slot across it at the cut, which opens from nothing.
      // A tween on the slot's width is seek-safe, and it leaves the line's own dashes (fx.draw) alone.
      const bb = p.getBBox();
      const pad = stroke * 3 + 40 * unit;
      const area = { x: r1(bb.x - pad), y: r1(bb.y - pad), width: r1(bb.width + 2 * pad), height: r1(bb.height + 2 * pad) };
      const maskId = `mo-cut-${++cuts}`;
      const defs = svg.querySelector(":scope > defs") ?? svg.insertBefore(svgEl("defs"), svg.firstChild);
      const mask = svgEl("mask", { id: maskId, maskUnits: "userSpaceOnUse", ...area });
      const slotH = stroke * 3 + 12 * unit;
      const slotTurn = svgEl("g", { transform: `translate(${r1(c.x)} ${r1(c.y)}) rotate(${r1(deg)})` });
      const slot = svgEl("rect", { x: 0, y: r1(-slotH / 2), width: 0, height: r1(slotH), fill: "#000" });
      slotTurn.appendChild(slot);
      mask.append(svgEl("rect", { ...area, fill: "#fff" }), slotTurn);
      defs.appendChild(mask);
      p.setAttribute("mask", `url(#${maskId})`);
      tl.fromTo(slot, { attr: { x: 0, width: 0 } }, { attr: { x: -half, width: half * 2 }, duration: 0.2, ease: "power3.out" }, at);
      // the X: two pen strokes across the gap, the second a touch off true like a hand's, over everything
      const s = (size / 2) * unit;
      const own = p.getAttribute("transform");
      const x = svgEl("g", { class: "p-cut", "data-id": freshId(`cut-${idOf(p)}`), ...(own ? { transform: own } : {}) });
      const arms = [
        svgEl("path", { d: `M ${r1(c.x - s)} ${r1(c.y - s)} L ${r1(c.x + s)} ${r1(c.y + s)}` }),
        svgEl("path", { d: `M ${r1(c.x + s * 0.96)} ${r1(c.y - s * 1.04)} L ${r1(c.x - s * 0.98)} ${r1(c.y + s * 0.97)}` }),
      ];
      for (const arm of arms) {
        arm.style.fill = "none";
        arm.style.stroke = "var(--c-pen, var(--accent2))";
        arm.style.strokeWidth = `${(armPx * unit).toFixed(2)}px`;
        arm.style.strokeLinecap = "round";
        x.appendChild(arm);
      }
      svg.appendChild(x);
      arms.forEach((arm, k) => {
        const t = at + 0.05 + k * 0.14;
        // hidden until drawn (a round cap at 0% would leave a dot): hidden as it is made (a tl.set at 0 never
        // runs when the first frame asked for is exactly 0); the set at t records that, so seeking back hides it
        gsap.set(arm, { autoAlpha: 0 });
        tl.set(arm, { autoAlpha: 1 }, t);
        tl.fromTo(arm, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.12, ease: "power2.out" }, t);
      });
      (p as unknown as TipPath).__cut = [...cutMarksOf(p), x];
      sound("slap", at, 0.9);
      mark("cut", [x], at);
      // packets that would reach the gap once it is open stop there: flows asked for earlier are re-timed now,
      // later ones see the gap when they are made
      gaps.set(p, { at, a: (mid - half) / len, b: (mid + half) / len, len, unit });
      for (const run of runs.get(p) ?? []) {
        for (const tw of run.tweens) tw.kill();
        run.tweens = [];
        travelRun(run);
      }
      return x;
    },
    /** A red-pen loop drawn around an element (a little irregular, the same in every render). */
    circle(els: Element | Element[], at: number, seconds = 0.5) {
      const paths: SVGPathElement[] = [];
      for (const el of list(els)) {
        const path = svgEl("path", {
          class: "p-arrow",
          d: circlePath(restBox(el, cam, W), seedOf(`${sceneId}:${idOf(el)}:${++circles}`)),
          "data-id": freshId(`circle-${idOf(el)}`),
        });
        overlay().appendChild(path);
        drawPath(path, at, seconds);
        paths.push(path);
      }
      mark("circle", paths, at);
      return paths.length === 1 ? paths[0] : paths;
    },
    /** A bar or a queue's fill growing from its start edge: the left (axis "x") or the bottom (axis "y"). */
    grow(els: Element | Element[], at: number, seconds = 0.6, axis: "x" | "y" = "x") {
      for (const el of list(els)) {
        if (axis === "y") tl.fromTo(el, { scaleY: 0, transformOrigin: "50% 100%" }, { scaleY: 1, duration: seconds, ease: "power2.out" }, at);
        else tl.fromTo(el, { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, duration: seconds, ease: "power2.out" }, at);
      }
    },
    /** Sets an element's text at that moment (a variable's value, a counter) with a small pop. */
    change(els: Element | Element[], text: string | number, at: number) {
      for (const el of list(els)) {
        tl.set(el, { text: { value: escText(String(text)) } }, at);
        // two plain tweens (each starts from where the element is), so seeking back never leaves it enlarged
        tl.to(el, { scale: 1.16, duration: 0.09, ease: "power2.out" }, at);
        tl.to(el, { scale: 1, duration: 0.22, ease: "power2.out" }, at + 0.09);
      }
    },

    // ── charts ──

    /** A real chart inside an empty element the scene's CSS has placed and sized (see chart.ts): axes,
     *  ticks, both axis titles with their units, gridlines, series drawn on and named, bars growing with
     *  their values, marks and the "illustrative numbers" note. Returns {svg, x(v), y(v), series, bars,
     *  marks}: x and y turn values into stage px, series are the lines (for fx.flow and fx.circle). */
    chart(el: Element, spec: ChartSpec, at: number, opts: { seconds?: number } = {}) {
      return buildChart({ tl, cam, stageW: W, minText: scene.minText ?? 22, sound, mark, freshId }, el, spec, at, opts);
    },

    // ── code walkthroughs ──

    /** Types a highlighted code block on, one line after another (a left-to-right wipe per line). */
    code(els: Element | Element[], at: number, perLine = 0.12) {
      mark("code", list(els), at);
      const step = Math.max(0.02, Number(perLine) || 0.12);
      for (const el of list(els)) {
        const lines = codeLines(el);
        if (!lines.length) {
          reveal(el, at, 0.6, 2); // not a highlighted block: wiped on whole
          continue;
        }
        lines.forEach((ln, k) => {
          const t = at + k * step;
          const chars = (ln.textContent || "").replace(/\n$/, "").length;
          // the wipe moves a character at a time (steps), so the line reads as typed
          tl.fromTo(ln, { clipPath: "inset(-8px 100% -8px 0px)" }, { clipPath: "inset(-8px 0% -8px 0px)", duration: step, ease: `steps(${Math.max(1, Math.min(chars + 2, 60))})` }, t);
          tl.set(ln, { clipPath: "none" }, t + step);
        });
      }
      sound("type", at, 0.6);
    },
    /** Moves the marker band behind line n (or lines [from, to], as numbered) of a code block: the first call
     *  fades it in, later calls glide it. */
    line(el: Element, n: number | [number, number], at: number) {
      const pre = list(el)[0];
      if (!pre) return;
      mark("line", [pre], at);
      const [a, b] = Array.isArray(n) ? [Number(n[0]), Number(n[1] ?? n[0])] : [Number(n), Number(n)];
      if (!bandOps.has(pre)) bandOps.set(pre, []);
      bandOps.get(pre)!.push({ at, lines: [Math.min(a, b), Math.max(a, b)] });
    },
    /** Hides the band. */
    lineOff(el: Element, at: number) {
      const pre = list(el)[0];
      if (!pre) return;
      if (!bandOps.has(pre)) bandOps.set(pre, []);
      bandOps.get(pre)!.push({ at, lines: null });
    },

    /** Called by the player once the scene's script has run: turns the camera moves and the code bands
     *  (which scripts may add in any order) into tweens. */
    finish() {
      const page = cam.parentElement;
      if (camMoves.length && page) {
        // The page's paper moves onto the camera, so a zoom takes the graph paper with it (it never shows
        // past its edge: the camera never zooms out or pans beyond the page). Painted once, not on both:
        // two layers of paper would blend twice along the tear's ragged edge.
        const cs = getComputedStyle(page);
        for (const p of ["background-color", "background-image", "background-size", "background-position", "background-repeat", "background-origin", "background-clip"]) {
          cam.style.setProperty(p, cs.getPropertyValue(p));
        }
        page.style.setProperty("background", "none");
      }
      chainMoves(camMoves, { x: 0, y: 0, scale: 1 }, (from, to, at, dur, ease) => {
        // force3D off: the zoomed page is painted at its real size every frame, never a stretched bitmap
        // (a GPU layer for the preview was tried and measured: on integrated graphics it stuttered more)
        tl.fromTo(cam, { ...from }, { ...to, duration: dur, ease, immediateRender: false, force3D: false }, at);
      });
      camMoves.length = 0;
      for (const [pre, ops] of bandOps) {
        const lines = codeLines(pre);
        if (!lines.length) continue;
        let band = pre.querySelector(":scope > .p-code-band") as HTMLElement | null;
        if (!band) {
          band = document.createElement("span");
          band.className = "p-code-band";
          pre.insertBefore(band, pre.firstChild);
        }
        const first = codeStart(pre);
        const place = (a: number, b: number) => {
          const top = lines[Math.max(0, Math.min(lines.length - 1, a - first))];
          const bottom = lines[Math.max(0, Math.min(lines.length - 1, b - first))];
          const y = top.offsetTop - 3;
          return { y, h: Math.max(8, bottom.offsetTop + bottom.offsetHeight + 3 - y) };
        };
        // shown or hidden depends on the order in time, not the order of the calls
        const moves: Move<{ y: number; h: number; a: number }>[] = [];
        let shown = false;
        let at0 = { y: 0, h: 0 };
        for (const op of ops.map((o, i) => ({ ...o, i })).sort((x, z) => x.at - z.at || x.i - z.i)) {
          if (!op.lines) {
            if (shown) moves.push({ at: op.at, dur: 0.25, to: { ...at0, a: 0 }, ease: "power1.in" });
            shown = false;
            continue;
          }
          const g = place(op.lines[0], op.lines[1]);
          if (!shown) {
            moves.push({ at: op.at, dur: 0, to: { ...g, a: 0 }, ease: "none" });
            moves.push({ at: op.at, dur: 0.25, to: { ...g, a: 1 }, ease: "power1.out" });
          } else moves.push({ at: op.at, dur: 0.4, to: { ...g, a: 1 }, ease: "power2.inOut" });
          shown = true;
          at0 = g;
        }
        const target = band;
        chainMoves(moves, { y: 0, h: 0, a: 0 }, (from, to, at, dur, ease) => {
          tl.fromTo(target, { y: from.y, height: from.h, autoAlpha: from.a }, { y: to.y, height: to.h, autoAlpha: to.a, duration: dur, ease, immediateRender: false }, at);
        });
      }
      bandOps.clear();
    },
  };
}
