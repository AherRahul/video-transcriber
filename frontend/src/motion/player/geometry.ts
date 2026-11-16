// Where things sit on the page, measured the way the camera, links, circles, travel and carries need it.
//
// Every box is in stage px (the design units: 1600 x 900 in the paper look), whatever the preview's zoom
// and whatever the scene's camera is doing: a measurement is taken against the camera element's own box,
// so both the preview's fit-to-window scale and the camera's zoom divide out.
//
// Scenes are measured while they are built: laid out but invisible (visibility:hidden), with every
// entrance already in its starting state (fx.pop starts at half size, fx.rise 16 px low, fx.stamp big and
// turned). Those starting transforms are GSAP's, written inline, so the "rest" box takes them off for the
// moment it measures and puts them back; a transform from the scene's stylesheet (a sticky's tilt, a
// translate(-50%, -50%) centring) stays, because that is where the element really rests.

export type Box = { x: number; y: number; w: number; h: number };

type Styled = Element & ElementCSSInlineStyle;
type Saved = { el: Styled; prop: string; value: string; priority: string }[];

const TRANSFORM_PROPS = ["transform", "translate", "rotate", "scale"];
const SVG_NS = "http://www.w3.org/2000/svg";

/** True for SVG shapes and groups inside an <svg> (the outer <svg> itself is a CSS box like any element). */
function isSvgChild(el: Element): el is SVGGraphicsElement {
  return el instanceof SVGElement && !(el instanceof SVGSVGElement && !(el.parentNode instanceof SVGElement));
}

/** GSAP keeps its per-element state on `_gsap`: only elements it has touched carry an entrance transform. */
const touched = (el: Element) => !!(el as unknown as { _gsap?: unknown })._gsap;

function clearProps(el: Styled, props: string[], saved: Saved, value = "") {
  const st = el.style;
  if (!st) return;
  for (const prop of props) {
    const old = st.getPropertyValue(prop);
    if (!old && !value) continue;
    saved.push({ el, prop, value: old, priority: st.getPropertyPriority(prop) });
    if (value) st.setProperty(prop, value, "important");
    else st.removeProperty(prop);
  }
}

function restore(saved: Saved) {
  for (let i = saved.length - 1; i >= 0; i--) {
    const s = saved[i];
    if (s.value) s.el.style.setProperty(s.prop, s.value, s.priority);
    else s.el.style.removeProperty(s.prop);
  }
}

/** Takes GSAP's inline transforms off the element's HTML ancestors (up to the camera) for one measurement. */
function clearAncestors(el: Element, cam: Element, saved: Saved) {
  for (let n = el.parentElement; n && n !== cam; n = n.parentElement) {
    if (!isSvgChild(n) && touched(n)) clearProps(n as Styled, TRANSFORM_PROPS, saved);
  }
}

/** The on-screen rect of an SVG shape's own geometry, without its own transform (where GSAP puts an
 *  entrance), through its parent's transform chain (the scene's layout groups and the <svg>'s viewBox). */
function svgShapeRect(el: SVGGraphicsElement, keepOwn: boolean): DOMRect {
  let bb: DOMRect;
  try {
    bb = el.getBBox();
  } catch {
    return el.getBoundingClientRect();
  }
  const via = keepOwn ? el : (el.parentNode as SVGGraphicsElement);
  const m = via && typeof via.getScreenCTM === "function" ? via.getScreenCTM() : null;
  if (!m) return el.getBoundingClientRect();
  const pts = [
    new DOMPoint(bb.x, bb.y),
    new DOMPoint(bb.x + bb.width, bb.y),
    new DOMPoint(bb.x, bb.y + bb.height),
    new DOMPoint(bb.x + bb.width, bb.y + bb.height),
  ].map((p) => p.matrixTransform(m));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return new DOMRect(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
}

/** A screen rect as a box in the camera's (the page's) coordinates. */
export function toCam(r: { left: number; top: number; width: number; height: number }, cam: Element, stageW: number): Box {
  const c = cam.getBoundingClientRect();
  const k = c.width / stageW || 1; // the preview's scale times the camera's zoom
  return { x: (r.left - c.left) / k, y: (r.top - c.top) / k, w: r.width / k, h: r.height / k };
}

/** Where an element rests on the page: its box with GSAP's entrance transforms (its own and its
 *  ancestors') taken off, stylesheet transforms kept. For the camera, links and circles. */
export function restBox(el: Element, cam: Element, stageW: number): Box {
  const saved: Saved = [];
  try {
    clearAncestors(el, cam, saved);
    if (isSvgChild(el)) return toCam(svgShapeRect(el, !touched(el)), cam, stageW);
    if (touched(el)) clearProps(el as Styled, TRANSFORM_PROPS, saved);
    return toCam(el.getBoundingClientRect(), cam, stageW);
  } finally {
    restore(saved);
  }
}

/** True when the element is a drawn box of its own (a card, a sticky, a pill): a fill, a border or a shadow. */
export function hasSurface(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const cs = getComputedStyle(el);
  const alpha = (c: string) => {
    if (!c || c === "transparent") return 0;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  };
  const border = ["Top", "Right", "Bottom", "Left"].some((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0.5 && cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== "none");
  return alpha(cs.backgroundColor) > 0.15 || cs.backgroundImage !== "none" || border || (cs.boxShadow !== "none" && cs.boxShadow !== "");
}

/** The element's corner radius in px (its top-left one; "50%" on a round badge is half its short side). */
export function radiusOf(el: Element, b: Box): number {
  if (!(el instanceof HTMLElement)) return 0;
  const raw = getComputedStyle(el).borderTopLeftRadius || "0";
  const first = raw.split(" ")[0];
  const r = first.endsWith("%") ? (parseFloat(first) / 100) * Math.min(b.w, b.h) : parseFloat(first);
  return Math.max(0, Math.min(Number.isFinite(r) ? r : 0, Math.min(b.w, b.h) / 2));
}

let measurer: CanvasRenderingContext2D | null | undefined;

/**
 * The band a line of text's ink takes, from the line's box (its top and height in any unit): a text line's
 * box holds the font's whole ascent and descent, far taller than the glyphs (a 140 px number's box is about
 * 170 px tall, its digits about 100), and a pen loop or an arrow is judged against the ink.
 */
export function inkBand(node: Node, top: number, height: number): [number, number] {
  const el = node.parentElement;
  let text = (node.textContent || "").trim();
  if (!el || !text) return [top, top + height];
  if (measurer === undefined) measurer = document.createElement("canvas").getContext("2d");
  if (!measurer) return [top, top + height];
  const cs = getComputedStyle(el);
  if (cs.textTransform === "uppercase") text = text.toUpperCase();
  measurer.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = measurer.measureText(text);
  const fa = m.fontBoundingBoxAscent;
  const fd = m.fontBoundingBoxDescent;
  if (!(fa + fd > 0) || !Number.isFinite(m.actualBoundingBoxAscent) || !Number.isFinite(m.actualBoundingBoxDescent)) return [top, top + height];
  const k = height / (fa + fd); // the line box's px per font px (a scaled element)
  const a = top + Math.max(0, fa - m.actualBoundingBoxAscent) * k;
  const z = top + Math.min(fa + fd, fa + m.actualBoundingBoxDescent) * k;
  return z > a ? [a, z] : [top, top + height];
}

/**
 * A box grown to take in the element's outer shadows (a card's hard shadow is 10 px of ink to its right and
 * below). Shadow lengths are CSS px, which are stage px on the page.
 */
export function withShadow(el: Element, b: Box): Box {
  if (!(el instanceof HTMLElement)) return b;
  const shadow = getComputedStyle(el).boxShadow;
  if (!shadow || shadow === "none") return b;
  let x0 = b.x;
  let y0 = b.y;
  let x1 = b.x + b.w;
  let y1 = b.y + b.h;
  // one shadow per comma that is not inside a colour's brackets
  for (const one of shadow.split(/,(?![^(]*\))/)) {
    if (/\binset\b/.test(one)) continue;
    const px = (one.replace(/rgba?\([^)]*\)|#[0-9a-f]+|[a-z-]+\([^)]*\)/gi, "").match(/-?\d*\.?\d+px/g) || []).map(parseFloat);
    if (px.length < 2) continue;
    const [dx, dy, blur = 0, spread = 0] = px;
    const reach = Math.max(0, blur) + spread;
    x0 = Math.min(x0, b.x + dx - reach);
    y0 = Math.min(y0, b.y + dy - reach);
    x1 = Math.max(x1, b.x + b.w + dx + reach);
    y1 = Math.max(y1, b.y + b.h + dy + reach);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Where an element's ink rests: the whole box for a card or anything drawn (a fill, a border, a shadow, an
 * image), and for plain words only the lines the words take, as tall as their glyphs (a block of text is
 * often far wider than its words, and a pen loop or an arrow is judged against what is on the paper).
 * Boxes in stage px, at rest.
 */
export function restInk(el: Element, cam: Element, stageW: number): Box[] {
  if (!(el instanceof HTMLElement) || hasSurface(el) || el.tagName === "IMG" || el.tagName === "svg" || el.tagName === "CANVAS" || el.tagName === "VIDEO") {
    return [restBox(el, cam, stageW)];
  }
  const saved: Saved = [];
  try {
    clearAncestors(el, cam, saved);
    if (touched(el)) clearProps(el as Styled, TRANSFORM_PROPS, saved);
    const out: Box[] = [];
    const range = document.createRange();
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!(n.textContent || "").trim()) continue;
      if (n.parentElement && n.parentElement !== el && n.parentElement.closest("svg")) continue;
      range.selectNodeContents(n);
      for (const q of Array.from(range.getClientRects())) {
        if (q.width < 0.5 || q.height < 0.5) continue;
        const [a, z] = inkBand(n, q.top, q.height); // the glyphs, not the font's whole line box
        out.push(toCam({ left: q.left, top: a, width: q.width, height: z - a }, cam, stageW));
      }
    }
    return out.length ? out : [toCam(el.getBoundingClientRect(), cam, stageW)];
  } finally {
    restore(saved);
  }
}

/** The element's layout box with no transform of its own at all (not even the stylesheet's): the box its
 *  x/y translation moves. For fx.travel and the carried copy's placement. */
export function layoutBox(el: Element, cam: Element, stageW: number): Box {
  const saved: Saved = [];
  try {
    clearAncestors(el, cam, saved);
    if (isSvgChild(el)) return toCam(svgShapeRect(el, false), cam, stageW);
    clearProps(el as Styled, TRANSFORM_PROPS, saved, "none");
    return toCam(el.getBoundingClientRect(), cam, stageW);
  } finally {
    restore(saved);
  }
}

/** The matrix from an SVG element's user units to the camera's coordinates (stage px), and its scale. */
export function svgToCam(el: SVGGraphicsElement, cam: Element, stageW: number): { m: DOMMatrix; scale: number } | null {
  const ctm = el.getScreenCTM();
  if (!ctm) return null;
  const c = cam.getBoundingClientRect();
  const k = c.width / stageW || 1;
  const m = new DOMMatrix().scaleSelf(1 / k).translateSelf(-c.left, -c.top).multiplySelf(DOMMatrix.fromMatrix(ctm));
  return { m, scale: Math.hypot(m.a, m.b) || 1 };
}

/** One box around several. */
export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** A new SVG element (the player's own drawings: link arrows, circles, packets). */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
