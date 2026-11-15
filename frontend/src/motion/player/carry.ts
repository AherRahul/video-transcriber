// Carry across pages: an element with data-carry="key" on one page, and one with the same key on the next.
//
// During the next page's change (its first TRANSITION seconds, whatever the transition, a cut included) a
// copy of the NEW page's element travels from where the old one sits to where the new one rests, above both
// pages; then the new page's own element takes over. Both originals are hidden while the copy moves.
//
// The copy is taken while the new scene is built, before its script runs, so it is the element at rest (no
// entrance has touched it yet). Each scene's CSS lives in its own shadow root, so the copy lives in an
// overlay host of its own above the page hosts, whose shadow root holds the same CSS (BASE, PAPER, code and
// the scene's own: pseudo-elements like a card's ::after come from there), and every computed style of the
// element and its children is also written onto the copy, so it looks the same even where a rule depended
// on ancestors the copy doesn't have. Placing it is arithmetic on the scene's local time, driven from the
// player's show(), so every frame of the export matches the preview.

import { center, layoutBox, restBox, toCam, type Box } from "./geometry";

export type CarrySnap = {
  key: string;
  /** the new page's own element */
  el: HTMLElement;
  /** its copy at rest, with every computed style written on */
  copy: HTMLElement;
  /** its untransformed layout box and its box as drawn at rest (a sticky's tilt included), in stage px */
  layout: Box;
  rest: Box;
};

export type CarryItem = { snap: CarrySnap; old: HTMLElement; wrap: HTMLDivElement };
export type CarryLayer = { host: HTMLDivElement; items: CarryItem[] };

/** Styles never copied: the scene is built invisible, and nothing on the copy may animate on its own. */
const SKIP = /^(visibility|pointer-events|cursor|will-change|user-select|-webkit-user-select|transition|animation|view-transition)/;
/** Styles the copy's outer element gets from its wrapper instead (it is placed at the wrapper's origin). */
const OUTER = /^(position|left|top|right|bottom|inset|margin|z-index|float|translate|rotate|scale)(-|$)/;
/** SVG shapes keep their attributes; only their paint is copied (geometry stays in the attributes). */
const SVG_PAINT = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "color", "font-family", "font-size", "font-weight",
  "letter-spacing", "text-anchor", "dominant-baseline", "paint-order",
];

function copyStyles(from: Element, to: Element, outer: boolean) {
  const cs = getComputedStyle(from);
  const st = (to as HTMLElement).style;
  if (from instanceof HTMLElement || from instanceof SVGSVGElement) {
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (SKIP.test(p) || (outer && OUTER.test(p))) continue;
      st.setProperty(p, cs.getPropertyValue(p));
    }
  } else if (from instanceof SVGElement) {
    for (const p of SVG_PAINT) st.setProperty(p, cs.getPropertyValue(p));
  }
  const a = from.children;
  const b = to.children;
  for (let i = 0; i < a.length && i < b.length; i++) copyStyles(a[i], b[i], false);
}

/** Before a scene's script runs: each data-carry element's copy at rest and its boxes. HTML elements and
 *  whole <svg>s can be carried (a shape inside an <svg> can't leave it). */
export function snapCarries(cam: HTMLElement, stageW: number): Map<string, CarrySnap> {
  const out = new Map<string, CarrySnap>();
  for (const el of Array.from(cam.querySelectorAll<HTMLElement>("[data-carry]"))) {
    const key = (el.getAttribute("data-carry") || "").trim();
    if (!key || out.has(key)) continue;
    if (el instanceof SVGElement && el.parentNode instanceof SVGElement) continue;
    const copy = el.cloneNode(true) as HTMLElement;
    copyStyles(el, copy, true);
    out.set(key, { key, el, copy, layout: layoutBox(el, cam, stageW), rest: restBox(el, cam, stageW) });
  }
  return out;
}

/** The overlay for one page change: its own host above the pages (and the tear's edge), under the frame. */
export function carryLayer(stage: HTMLElement, css: string, width: number, height: number, pairs: { snap: CarrySnap; old: HTMLElement }[]): CarryLayer {
  const host = document.createElement("div");
  host.className = "mo-carry";
  host.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;z-index:4;pointer-events:none;display:none;`;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML =
    `<style>${css}</style>` +
    `<style>.scene-root, .scene-cam { background: none !important; } .mo-carry-wrap { position: absolute; left: 0; top: 0; transform-origin: 0 0; }</style>` +
    `<div class="scene-root"><div class="scene-cam"></div></div>`;
  const cam = shadow.querySelector(".scene-cam") as HTMLDivElement;
  const items = pairs.map(({ snap, old }) => {
    const wrap = document.createElement("div");
    wrap.className = "mo-carry-wrap";
    wrap.style.width = `${snap.layout.w}px`;
    wrap.style.height = `${snap.layout.h}px`;
    const copy = snap.copy;
    for (const [k, v] of [["position", "absolute"], ["left", "0px"], ["top", "0px"], ["margin", "0px"], ["visibility", "visible"]]) copy.style.setProperty(k, v);
    wrap.appendChild(copy);
    cam.appendChild(wrap);
    return { snap, old, wrap };
  });
  stage.appendChild(host);
  return { host, items };
}

/** An element's box as drawn right now, in stage px, measured against its page's host. */
export function drawnBox(el: Element, host: Element, stageW: number): Box {
  return toCam(el.getBoundingClientRect(), host, stageW);
}

/** A page's camera right now (its pan and zoom), from the camera's box against the page's host. */
export function cameraOf(cam: Element, host: Element, stageW: number): { x: number; y: number; s: number } {
  const c = cam.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  const k = h.width / stageW || 1;
  return { x: (c.left - h.left) / k, y: (c.top - h.top) / k, s: c.width / (h.width || 1) || 1 };
}

/**
 * Places a carried copy at eased progress e (0 at the old page's place, 1 at the new page's): its centre on
 * the straight line between the two places and its size from the old box's to the new one's (one scale for
 * both axes, so the words never stretch), lifted a little in the middle as if picked up off the paper.
 */
export function placeCarry(item: CarryItem, e: number, from: Box, cam: { x: number; y: number; s: number }) {
  const { rest, layout } = item.snap;
  // where the copy draws inside its wrapper (its own tilt or offset at rest)
  const vx = rest.x - layout.x + rest.w / 2;
  const vy = rest.y - layout.y + rest.h / 2;
  const goal = { x: cam.x + cam.s * (rest.x + rest.w / 2), y: cam.y + cam.s * (rest.y + rest.h / 2) };
  const start = center(from);
  const s0 = Math.sqrt(Math.max(1, from.w * from.h) / Math.max(1, rest.w * rest.h));
  const s = (s0 + (cam.s - s0) * e) * (1 + 0.05 * Math.sin(Math.PI * e));
  const cx = start.x + (goal.x - start.x) * e;
  const cy = start.y + (goal.y - start.y) * e;
  item.wrap.style.transform = `translate(${(cx - s * vx).toFixed(2)}px, ${(cy - s * vy).toFixed(2)}px) scale(${s.toFixed(4)})`;
}
