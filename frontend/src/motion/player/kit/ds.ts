// Coding visuals: arrays with pointers, linked lists, stacks, queues, hash maps, trees, graphs, grids (a DP
// table) and call stacks, and the terminal player (fx.term, for a p-term window built in code.ts).
//
// Each one is built inside an empty element the scene places with its CSS (left and top, and a width and
// height, or the visual takes the room it needs): <div class="ds" data-id="arr"></div>, then in the script
//   const a = fx.array($('arr'), [1, 3, 4, 7, 9, 12], { at: cue(1) });
//   a.pointer('i', 0, cue(2)); a.pointer('j', 5, cue(2)); a.move('i', 1, cue(3)); a.mark(1, cue(3));
// Every method puts its change on the scene's paused timeline at the time it is given (tweens and sets, never
// callbacks), so seeking to any frame from either direction gives the same picture. Call a visual's methods in
// time order: each one starts from where the one before it left things.
//
// Looks: the paper look's ink by default (thick ink edges, the paper tints, the display and mono fonts);
// opts.sketch: true draws the parts in the Excalidraw look (sketch.ts) with the hand font.
//
// The layout report: each part gets a stable data-id (the visual's own id plus the part: "arr-c3" for the
// fourth cell), so comments and fx.focus or fx.circle can point at it. The parts sit close together on
// purpose, so the report doesn't call them crowded, and their numbers don't count toward the words on screen
// (like code on a code card); every label is at least the stage's smallest readable size.

import { playTerm, type TermOpts } from "../code";
import { svgEl } from "../geometry";
import { iconMarkup } from "./icons";
import * as sketchKit from "./sketch";
import type { KitCtx, KitModule } from "./types";

type Value = string | number;
type Ref = string | number;
type SketchShape = "box" | "circle" | "ellipse" | "diamond";
type SketchFn = (el: HTMLElement, ctx: KitCtx, shape: SketchShape, opts?: { fill?: string; fillStyle?: string; roughness?: number; stroke?: string; strokeWidth?: number }) => SVGSVGElement;

/** The Excalidraw outline (sketch.ts), when that module has it. */
const sketchify = (): SketchFn | null => {
  const f = (sketchKit as unknown as Record<string, unknown>).sketchify;
  return typeof f === "function" ? (f as SketchFn) : null;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Options every visual takes. */
type Base = {
  /** when it appears (its parts pop in one after another); left out, it is there from the scene's start */
  at?: number;
  /** the Excalidraw look */
  sketch?: boolean;
};

type Pos = { x: number; y: number };

/** Strong colours, for pointers, highlighted edges and arrows. */
const STRONG_VARS: Record<string, [string, string]> = {
  pen: ["--c-pen", "#e03131"],
  ink: ["--ink", "#141414"],
  blue: ["", "#2563eb"],
  green: ["", "#059669"],
  pass: ["--c-pass", "#16a34a"],
  fail: ["--c-fail", "#dc2626"],
  orange: ["", "#ea580c"],
  slate: ["--c-ink-2", "#475569"],
};

/**
 * What every visual is built with: its element, its parts (made with stable data-ids), and the model of where
 * each part is and what colour it has right now, so the next change starts from there.
 */
class Board {
  readonly ctx: KitCtx;
  readonly host: HTMLElement;
  readonly id: string;
  readonly kind: string;
  readonly sketch: boolean;
  /** the smallest readable text on this stage */
  readonly m: number;
  readonly tones: Record<string, string>;
  readonly ink: string;
  readonly slate: string;
  private used = new Set<string>();
  private offsets = new Map<Element, Pos>();
  private fills = new Map<Element, string>();
  private colors = new Map<Element, string>();
  private layer: SVGSVGElement | null = null;
  private topLayer: SVGSVGElement | null = null;

  constructor(ctx: KitCtx, host: Element, kind: string, opts: Base) {
    if (!(host instanceof HTMLElement)) throw new Error(`fx.${kind} needs an empty element the scene places: <div data-id="${kind}-1"></div>`);
    this.ctx = ctx;
    this.host = host;
    this.kind = kind;
    this.id = host.getAttribute("data-id") || kind;
    this.sketch = !!opts.sketch;
    this.m = ctx.minText;
    host.textContent = "";
    host.classList.add("p-ds", `p-ds-${kind}`);
    if (this.sketch) host.classList.add("p-ds-sketch");
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const cs = getComputedStyle(host);
    const v = (name: string, fallback: string) => (name ? cs.getPropertyValue(name).trim() : "") || fallback;
    this.ink = v("--ink", "#141414");
    this.slate = v("--c-ink-2", "#475569");
    this.tones = {
      none: this.sketch ? "rgba(255, 255, 255, 0)" : "#ffffff",
      white: "#ffffff",
      lemon: v("--c-lemon", "#fef08a"),
      mint: v("--c-mint", "#bbf7d0"),
      pink: v("--c-pink", "#fbcfe8"),
      sky: v("--c-sky", "#bfdbfe"),
      peach: v("--c-peach", "#fed7aa"),
      dim: "#e2e8f0",
      ink: this.ink,
    };
    for (const k of Object.keys(STRONG_VARS)) this.strongs[k] = v(STRONG_VARS[k][0], STRONG_VARS[k][1]);
  }

  readonly strongs: Record<string, string> = {};

  get tl() {
    return this.ctx.tl;
  }

  /** A part's data-id: the visual's id and the part's name, unique in the visual. */
  partId(part: string): string {
    let id = `${this.id}-${part}`;
    for (let k = 2; this.used.has(id); k++) id = `${this.id}-${part}-${k}`;
    this.used.add(id);
    return id;
  }

  /** A part: an absolutely placed box (in the visual's own px) with a data-id. */
  part(cls: string, name: string, x: number, y: number, w: number, h: number, parent: HTMLElement = this.host): HTMLElement {
    const el = document.createElement("div");
    el.className = cls;
    el.setAttribute("data-id", this.partId(name));
    el.style.cssText = `left:${r1(x)}px;top:${r1(y)}px;width:${r1(w)}px;height:${r1(h)}px;`;
    parent.appendChild(el);
    return el;
  }

  /** A box with a value in it (a cell, a node, a frame): the value in its own span (a sketch outline or an
   *  arrow can sit beside it in the box), the fill set to plain. */
  cell(cls: string, name: string, x: number, y: number, w: number, h: number, value: Value | null, shape: SketchShape = "box", parent?: HTMLElement): HTMLElement {
    const el = this.part(`p-ds-box ${cls}`, name, x, y, w, h, parent);
    el.style.backgroundColor = this.tones.none;
    this.fills.set(el, this.tones.none);
    this.colors.set(el, this.ink);
    if (value != null) this.valueSpan(el, value, w, h);
    this.outline(el, shape);
    return el;
  }

  valueSpan(el: HTMLElement, value: Value, w: number, h: number, mono = false): HTMLElement {
    const span = document.createElement("span");
    span.className = mono ? "p-ds-v p-ds-mono" : "p-ds-v";
    span.textContent = String(value);
    el.appendChild(span);
    this.fit(span, w - 10, Math.min(h * 0.5, Math.max(this.m + 8, h * 0.44)));
    return span;
  }

  /** The largest font size (from `size` down to the smallest readable one) at which the text fits `w`. */
  fit(span: HTMLElement, w: number, size: number) {
    let fs = Math.max(this.m, Math.round(size));
    span.style.fontSize = `${fs}px`;
    while (fs > this.m && span.scrollWidth > w) {
      fs -= 2;
      span.style.fontSize = `${fs}px`;
    }
  }

  /** The width of some text in a part's font (measured on the page; the fonts have loaded by now). */
  measure(text: string, cls: string, size: number): number {
    const span = document.createElement("span");
    span.className = cls;
    span.style.cssText = `position:absolute;left:0;top:0;right:auto;width:auto;visibility:hidden;white-space:nowrap;font-size:${size}px;`;
    span.textContent = text;
    this.host.appendChild(span);
    // layout px (offsetWidth), not screen px: the preview shows the stage scaled
    const w = span.offsetWidth + 1;
    span.remove();
    return w;
  }

  /** The Excalidraw outline round a part (sketch look only). */
  outline(el: HTMLElement, shape: SketchShape) {
    if (!this.sketch) return;
    const f = sketchify();
    if (!f) return;
    try {
      f(el, this.ctx, shape, { strokeWidth: 2.4 });
      el.classList.add("p-ds-sk");
    } catch (err) {
      this.ctx.errors.push(`Scene ${this.ctx.sceneId}: fx.${this.kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The visual's own SVG layer (edges, arrows), under its parts. */
  svg(): SVGSVGElement {
    if (!this.layer) {
      const w = this.host.offsetWidth;
      const h = this.host.offsetHeight;
      this.layer = svgEl("svg", { class: "p-ds-svg", width: w, height: h, viewBox: `0 0 ${w} ${h}`, "aria-hidden": "true" });
      this.host.insertBefore(this.layer, this.host.firstChild);
    }
    return this.layer;
  }

  /** A drawing layer over the visual's parts (a grid's arrows), kept last so it stays on top. */
  over(): SVGSVGElement {
    if (!this.topLayer) {
      const w = this.host.offsetWidth;
      const h = this.host.offsetHeight;
      this.topLayer = svgEl("svg", { class: "p-ds-svg p-ds-over", width: w, height: h, viewBox: `0 0 ${w} ${h}`, "aria-hidden": "true" });
    }
    this.host.appendChild(this.topLayer);
    return this.topLayer;
  }

  /** Makes the element at least this big (when the scene's CSS gave it less), and returns its size. */
  room(w: number, h: number): { w: number; h: number } {
    if (this.host.offsetWidth < w) this.host.style.width = `${Math.ceil(w)}px`;
    if (this.host.offsetHeight < h) this.host.style.height = `${Math.ceil(h)}px`;
    return { w: this.host.offsetWidth, h: this.host.offsetHeight };
  }

  need(at: number | undefined, what: string): number {
    const t = Number(at);
    if (!Number.isFinite(t)) throw new Error(`fx.${this.kind}: ${what} needs a time, like cue(2)`);
    return Math.max(0, t);
  }

  // ── changes on the timeline ──

  /** Parts popping in, one after another (left out: there from the start). */
  appear(els: Element[], at: number | undefined, stagger = 0.05, sound = true) {
    if (at == null || !els.length) return;
    const t0 = this.need(at, "appearing");
    this.ctx.mark("pop", els, t0);
    // HTML parts pop; SVG parts (edges, arrows) fade, since scaling an SVG group grows it from the SVG's corner
    els.forEach((el, k) =>
      el instanceof SVGElement
        ? this.tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: "power1.out" }, t0 + k * stagger)
        : this.tl.fromTo(el, { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.28, ease: "back.out(2)" }, t0 + k * stagger),
    );
    if (sound) this.ctx.sound("pop", t0, 0.6);
  }

  /** A part that arrives later: hidden until then, then it pops in (or drops in from above with dy). */
  arrive(el: Element, at: number, from: { y?: number; x?: number } = {}) {
    this.ctx.mark("pop", [el], at);
    const o = this.offsets.get(el) ?? { x: 0, y: 0 };
    this.tl.fromTo(
      el,
      { autoAlpha: 0, scale: from.x || from.y ? 1 : 0.6, x: o.x + (from.x ?? 0), y: o.y + (from.y ?? 0) },
      { autoAlpha: 1, scale: 1, x: o.x, y: o.y, duration: 0.32, ease: from.x || from.y ? "power2.out" : "back.out(2)" },
      at,
    );
  }

  /** A part that leaves: it fades as it moves a little (dy, dx). */
  leave(el: Element, at: number, by: { x?: number; y?: number } = {}) {
    const o = this.offsets.get(el) ?? { x: 0, y: 0 };
    this.tl.fromTo(el, { autoAlpha: 1, x: o.x, y: o.y }, { autoAlpha: 0, x: o.x + (by.x ?? 0), y: o.y + (by.y ?? 0), duration: 0.32, ease: "power1.in", immediateRender: false }, at);
    this.offsets.set(el, { x: o.x + (by.x ?? 0), y: o.y + (by.y ?? 0) });
  }

  /** Moves a part by (dx, dy) from where it was placed; lift makes it hop over its neighbours on the way. */
  moveTo(el: Element, dx: number, dy: number, at: number, seconds = 0.4, lift = 0) {
    const cur = this.offsets.get(el) ?? { x: 0, y: 0 };
    if (cur.x === dx && cur.y === dy && !lift) return;
    this.tl.fromTo(el, { x: cur.x }, { x: dx, duration: seconds, ease: "power2.inOut", immediateRender: false }, at);
    if (lift) {
      this.tl.fromTo(el, { y: cur.y }, { y: cur.y - lift, duration: seconds / 2, ease: "power1.out", immediateRender: false }, at);
      this.tl.fromTo(el, { y: cur.y - lift }, { y: dy, duration: seconds / 2, ease: "power1.in", immediateRender: false }, at + seconds / 2);
    } else if (cur.y !== dy) this.tl.fromTo(el, { y: cur.y }, { y: dy, duration: seconds, ease: "power2.inOut", immediateRender: false }, at);
    this.offsets.set(el, { x: dx, y: dy });
  }

  offset(el: Element): Pos {
    return this.offsets.get(el) ?? { x: 0, y: 0 };
  }

  fillOf(tone: string | null | undefined): string {
    if (!tone || tone === "none" || tone === "off") return this.tones.none;
    return this.tones[tone] ?? this.strongs[tone] ?? tone;
  }

  strong(tone: string | null | undefined, fallback = "pen"): string {
    const t = tone || fallback;
    return this.strongs[t] ?? this.tones[t] ?? t;
  }

  /** A part's fill (and its words' colour) changes: lemon, mint, pink, sky, peach, dim, ink or none. */
  tone(el: Element, tone: string | null | undefined, at: number, seconds = 0.25) {
    const to = this.fillOf(tone);
    const from = this.fills.get(el) ?? this.tones.none;
    const ink = tone === "ink" ? "#ffffff" : tone === "dim" ? "#94a3b8" : this.ink;
    const inkFrom = this.colors.get(el) ?? this.ink;
    if (from !== to) this.tl.fromTo(el, { backgroundColor: from }, { backgroundColor: to, duration: seconds, ease: "power1.out", immediateRender: false }, at);
    if (inkFrom !== ink) this.tl.fromTo(el, { color: inkFrom }, { color: ink, duration: seconds, ease: "power1.out", immediateRender: false }, at);
    this.fills.set(el, to);
    this.colors.set(el, ink);
  }

  /** A value changes, with a small pop. */
  text(el: Element, value: Value, at: number) {
    const span = (el.querySelector(":scope > .p-ds-v") as HTMLElement | null) ?? (el as HTMLElement);
    this.tl.set(span, { text: { value: esc(String(value)) } }, at);
    this.tl.fromTo(span, { scale: 1 }, { scale: 1.16, duration: 0.09, ease: "power2.out", immediateRender: false }, at);
    this.tl.fromTo(span, { scale: 1.16 }, { scale: 1, duration: 0.22, ease: "power2.out", immediateRender: false }, at + 0.09);
  }

  /** A stroke (an edge, an arrow) changes colour and weight. */
  stroke(el: SVGElement, color: string, width: number, at: number, from?: { color: string; width: number }) {
    const f = from ?? { color: el.getAttribute("data-stroke") || this.ink, width: Number(el.getAttribute("data-width")) || 4 };
    this.tl.fromTo(el, { stroke: f.color, strokeWidth: f.width }, { stroke: color, strokeWidth: width, duration: 0.3, ease: "power1.out", immediateRender: false }, at);
    el.setAttribute("data-stroke", color);
    el.setAttribute("data-width", String(width));
  }

  /** An arrow in the visual's SVG layer (or a given one), from (x1, y1) to (x2, y2), with its tip. */
  arrow(x1: number, y1: number, x2: number, y2: number, opts: { color?: string; width?: number; dashed?: boolean; open?: boolean; parent?: SVGElement; head?: boolean } = {}): SVGGElement {
    const g = svgEl("g", { class: "p-ds-arrow" });
    const color = opts.color ?? this.ink;
    const width = opts.width ?? 4;
    const line = svgEl("line", { x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2) });
    line.setAttribute("style", `stroke:${color};stroke-width:${width}px;stroke-linecap:round;${opts.dashed ? "stroke-dasharray:10 9;" : ""}`);
    line.setAttribute("data-stroke", color);
    line.setAttribute("data-width", String(width));
    g.appendChild(line);
    if (opts.head !== false) {
      const deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      const s = 5 + width * 2.2;
      const tip = svgEl("path", { d: `M ${-s} ${-s * 0.66} L 0 0 L ${-s} ${s * 0.66}${opts.open ? "" : " Z"}`, transform: `translate(${r1(x2)} ${r1(y2)}) rotate(${r1(deg)})` });
      tip.setAttribute("style", `stroke:${color};stroke-width:${width}px;stroke-linejoin:round;stroke-linecap:round;fill:${opts.open ? "none" : color};`);
      tip.setAttribute("class", "p-ds-tip");
      g.appendChild(tip);
    }
    (opts.parent ?? this.svg()).appendChild(g);
    return g;
  }

  /** An arrow drawing on: its line grows, its tip lands as the line arrives. */
  drawArrow(g: SVGGElement, at: number, seconds = 0.35) {
    const line = g.querySelector("line");
    const tip = g.querySelector(".p-ds-tip");
    if (line) this.tl.fromTo(line, { drawSVG: "0%" }, { drawSVG: "100%", duration: seconds, ease: "power1.inOut" }, at);
    if (tip) this.tl.fromTo(tip, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.05 }, at + seconds * 0.9);
  }

  /** A small SVG arrow inside a part (it moves with the part): from (x1, y1) to (x2, y2) in the part's px. */
  partArrow(el: HTMLElement, x1: number, y1: number, x2: number, y2: number, opts: { color?: string; width?: number } = {}): SVGSVGElement {
    const pad = 14;
    const x0 = Math.min(x1, x2) - pad;
    const y0 = Math.min(y1, y2) - pad;
    const w = Math.abs(x2 - x1) + 2 * pad;
    const h = Math.abs(y2 - y1) + 2 * pad;
    const svg = svgEl("svg", { class: "p-ds-link", width: r1(w), height: r1(h), viewBox: `0 0 ${r1(w)} ${r1(h)}`, "aria-hidden": "true" });
    svg.style.cssText = `position:absolute;left:${r1(x0)}px;top:${r1(y0)}px;overflow:visible;pointer-events:none;`;
    el.appendChild(svg);
    this.arrow(x1 - x0, y1 - y0, x2 - x0, y2 - y0, { ...opts, parent: svg });
    return svg;
  }

  /** A named pointer (i, j, lo, hi, cur, top): its name over a small arrow pointing down (or up, below). */
  pointer(name: string, tone: string | undefined, below = false): { el: HTMLElement; w: number; h: number } {
    const size = this.m + 4;
    const w = Math.max(size * 1.6, this.measure(name, "p-ds-ptr-name", size) + 12);
    const h = size + 34;
    const el = this.part("p-ds-ptr", `ptr-${name.replace(/[^\w-]/g, "") || "p"}`, 0, 0, w, h);
    const color = this.strong(tone, "pen");
    el.style.color = color;
    const label = document.createElement("span");
    label.className = "p-ds-ptr-name";
    label.textContent = name;
    label.style.fontSize = `${size}px`;
    label.style.top = below ? "28px" : "0px";
    el.appendChild(label);
    if (below) this.partArrow(el, w / 2, 26, w / 2, 2, { color, width: 4 });
    else this.partArrow(el, w / 2, size + 6, w / 2, h - 2, { color, width: 4 });
    return { el, w, h };
  }
}

/** A named pointer kept on a row of slots (an array's cells, a list's nodes): which slot and which level. */
type Ptr = { el: HTMLElement; slot: number; level: number; w: number; h: number; baseX: number; baseY: number };

/** Pointers over (or under) a row of slots: each new or moved pointer takes the lowest level no other pointer
 *  holds at that slot, so i and j on one cell stand one above the other. */
class Pointers {
  private all = new Map<string, Ptr>();
  constructor(
    private b: Board,
    private slotX: (slot: number) => number,
    private rowY: number,
    private below: boolean,
    private levelH: number,
  ) {}

  private levelFor(name: string, slot: number): number {
    const taken = new Set([...this.all.entries()].filter(([n, p]) => n !== name && p.slot === slot).map(([, p]) => p.level));
    let level = 0;
    while (taken.has(level)) level++;
    return level;
  }

  private y(level: number, h: number): number {
    return this.below ? this.rowY + level * this.levelH : this.rowY - h - level * this.levelH;
  }

  place(name: string, slot: number, at: number, tone?: string): HTMLElement {
    const t = this.b.need(at, `pointer "${name}"`);
    const old = this.all.get(name);
    if (old) {
      this.move(name, slot, t);
      return old.el;
    }
    const { el, w, h } = this.b.pointer(name, tone, this.below);
    const level = this.levelFor(name, slot);
    const x = this.slotX(slot) - w / 2;
    const y = this.y(level, h);
    el.style.left = `${r1(x)}px`;
    el.style.top = `${r1(y)}px`;
    this.all.set(name, { el, slot, level, w, h, baseX: x, baseY: y });
    this.b.arrive(el, t, { y: this.below ? 14 : -14 });
    return el;
  }

  move(name: string, slot: number, at: number, seconds = 0.35) {
    const p = this.all.get(name);
    if (!p) throw new Error(`fx.${this.b.kind}: no pointer "${name}" yet (give it one with pointer("${name}", index, at))`);
    const t = this.b.need(at, `moving "${name}"`);
    const level = this.levelFor(name, slot);
    p.slot = slot;
    p.level = level;
    this.b.ctx.mark("move", [p.el], t);
    this.b.moveTo(p.el, this.slotX(slot) - p.w / 2 - p.baseX, this.y(level, p.h) - p.baseY, t, seconds);
  }

  hide(name: string, at: number) {
    const p = this.all.get(name);
    if (!p) return;
    this.b.leave(p.el, this.b.need(at, `hiding "${name}"`));
    this.all.delete(name);
  }

  get(name: string): HTMLElement | null {
    return this.all.get(name)?.el ?? null;
  }
}

// ── arrays ──

type ArrayOpts = Base & {
  /** a cell's side in px (84 on the paper stage, smaller when the element's width needs it) */
  cell?: number;
  gap?: number;
  /** the index under each cell: from 0 (true), from another number, or none (false) */
  index?: boolean | number;
  /** how many levels of pointers fit over the cells (2) */
  pointers?: number;
  /** pointers under the cells instead (they go under the indices) */
  below?: boolean;
};

function makeArray(ctx: KitCtx, host: Element, values: Value[], opts: ArrayOpts = {}) {
  const b = new Board(ctx, host, "array", opts);
  if (!Array.isArray(values) || !values.length) throw new Error("fx.array needs a list of values, like [1, 3, 4, 7]");
  const n = values.length;
  const m = b.m;
  const gap = opts.gap ?? 10;
  const avail = b.host.offsetWidth;
  let cell = opts.cell ?? Math.round(m * 3.8);
  if (avail > 0) cell = Math.min(cell, Math.floor((avail - gap * (n - 1)) / n));
  if (cell < m * 2.2) throw new Error(`fx.array: ${n} cells don't fit in ${avail} px (each needs at least ${Math.ceil(m * 2.2)} px): make the element wider or show fewer values`);
  const levelH = m + 30;
  const levels = Math.max(0, opts.pointers ?? 2);
  const ptrRoom = opts.below ? 0 : levels * levelH + 10;
  const indexFrom = opts.index === false ? null : typeof opts.index === "number" ? opts.index : 0;
  const idxH = indexFrom == null ? 0 : m + 14;
  const total = n * cell + (n - 1) * gap;
  const size = b.room(total, ptrRoom + cell + idxH + (opts.below ? levels * levelH + 10 : 0));
  const ox = Math.max(0, (size.w - total) / 2);
  const top = ptrRoom;
  const slotLeft = (k: number) => ox + k * (cell + gap);
  const slots: HTMLElement[] = values.map((v, k) => b.cell("p-ds-cell", `c${k}`, slotLeft(k), top, cell, cell, v));
  const cells = [...slots];
  const idx: HTMLElement[] = [];
  if (indexFrom != null) {
    values.forEach((_, k) => {
      const el = b.part("p-ds-idx", `i${k}`, slotLeft(k), top + cell + 6, cell, m + 4);
      el.textContent = String(indexFrom + k);
      el.style.fontSize = `${m}px`;
      idx.push(el);
    });
  }
  b.appear(
    cells.flatMap((c, k) => (idx[k] ? [c, idx[k]] : [c])),
    opts.at,
    0.035,
  );
  const ptrs = new Pointers(b, (k) => slotLeft(k) + cell / 2, opts.below ? top + cell + idxH + 4 : top - 6, !!opts.below, levelH);
  let win: HTMLElement | null = null;
  let winSpan: [number, number] = [0, 0];
  const at0 = (i: number) => {
    if (!(i >= 0 && i < n)) throw new Error(`fx.array: no index ${i} (the array has ${n} cells, 0 to ${n - 1})`);
    return slots[i];
  };
  return {
    el: b.host,
    /** the cells in their first order (a swap moves them; cell(i) is the one at index i now) */
    cells,
    indices: idx,
    cell: (i: number) => at0(i),
    pointer: (name: string, i: number, at: number, tone?: string) => ptrs.place(name, i, at, tone),
    move: (name: string, i: number, at: number, seconds?: number) => ptrs.move(name, i, at, seconds),
    hide: (name: string, at: number) => ptrs.hide(name, at),
    ptr: (name: string) => ptrs.get(name),
    mark: (i: number, at: number, tone = "lemon") => b.tone(at0(i), tone, b.need(at, "mark")),
    unmark: (i: number, at: number) => b.tone(at0(i), "none", b.need(at, "unmark")),
    range(i: number, j: number, at: number, tone = "lemon") {
      const t = b.need(at, "range");
      for (let k = Math.min(i, j); k <= Math.max(i, j); k++) b.tone(at0(k), tone, t);
    },
    /** the cells from i to j greyed out (the half a binary search drops) */
    dim(i: number, j: number, at: number) {
      const t = b.need(at, "dim");
      for (let k = Math.min(i, j); k <= Math.max(i, j); k++) b.tone(at0(k), "dim", t);
    },
    set: (i: number, value: Value, at: number) => b.text(at0(i), value, b.need(at, "set")),
    swap(i: number, j: number, at: number, seconds = 0.55) {
      const t = b.need(at, "swap");
      const a = at0(i);
      const c = at0(j);
      const d = slotLeft(j) - slotLeft(i);
      b.ctx.mark("swap", [a, c], t);
      // one hops over, the other slides along the row under it (ducking down would run over the indices)
      b.moveTo(a, b.offset(a).x + d, 0, t, seconds, cell * 0.95);
      b.moveTo(c, b.offset(c).x - d, 0, t, seconds);
      slots[i] = c;
      slots[j] = a;
      b.ctx.sound("whoosh", t, 0.5);
    },
    /** an outline round the cells from i to j (a sliding window); later calls slide and stretch it */
    window(i: number, j: number, at: number, tone = "pen") {
      const t = b.need(at, "window");
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      at0(lo);
      at0(hi);
      const x = slotLeft(lo) - 9;
      const w = slotLeft(hi) + cell - slotLeft(lo) + 18;
      if (!win) {
        win = b.part("p-ds-win", "window", x, top - 9, w, cell + 18);
        win.style.borderColor = b.strong(tone, "pen");
        b.arrive(win, t);
      } else {
        const fromW = slotLeft(winSpan[1]) + cell - slotLeft(winSpan[0]) + 18;
        b.ctx.mark("move", [win], t);
        b.moveTo(win, x - (parseFloat(win.style.left) || 0), 0, t, 0.35);
        if (fromW !== w) b.tl.fromTo(win, { width: fromW }, { width: w, duration: 0.35, ease: "power2.inOut", immediateRender: false }, t);
      }
      winSpan = [lo, hi];
      return win;
    },
  };
}

// ── linked lists ──

type ListOpts = Base & {
  /** a node's height in px (66 on the paper stage) */
  size?: number;
  /** the null at the end (true) */
  nil?: boolean;
  /** how many levels of pointers fit over the nodes (2) */
  pointers?: number;
};

function makeList(ctx: KitCtx, host: Element, values: Value[], opts: ListOpts = {}) {
  const b = new Board(ctx, host, "list", opts);
  const m = b.m;
  let h = opts.size ?? Math.round(m * 3);
  const vals = (values ?? []).map(String);
  const nextW = Math.round(h * 0.42);
  const valW = () => Math.max(h, ...vals.map((v) => b.measure(v, "p-ds-v", m + 10) + 26));
  let vw = valW();
  let gap = Math.round(h * 0.85);
  const avail = b.host.offsetWidth;
  const count = vals.length + (opts.nil === false ? 0 : 1);
  const stepOf = () => vw + nextW + gap;
  if (avail > 0 && count * stepOf() - gap > avail) {
    // squeeze the gaps, then the nodes, to fit the element's width
    gap = Math.max(34, Math.floor((avail - count * (vw + nextW)) / Math.max(1, count - 1)));
    if (count * stepOf() - gap > avail) throw new Error(`fx.list: ${vals.length} nodes don't fit in ${avail} px: make the element wider or show fewer`);
  }
  const levelH = m + 30;
  const levels = Math.max(0, opts.pointers ?? 2);
  const top = levels * levelH + 10;
  const nw = vw + nextW;
  const total = count * stepOf() - gap;
  b.room(total, top + h + 8);
  // left-aligned: the room to the right is for nodes inserted later
  const ox = 0;
  const slotLeft = (k: number) => ox + k * stepOf();
  const node = (v: string, k: number, name: string) => {
    const el = b.cell("p-ds-node", name, slotLeft(k), top, nw, h, null);
    const val = document.createElement("div");
    val.className = "p-ds-node-val";
    val.style.width = `${vw}px`;
    el.appendChild(val);
    const span = b.valueSpan(val, v, vw, h);
    span.classList.add("p-ds-v");
    const nx = document.createElement("div");
    nx.className = "p-ds-node-next";
    nx.style.width = `${nextW}px`;
    el.appendChild(nx);
    // the next pointer, from the dot in the node's next part to the next node (it moves with the node)
    const fwd = b.partArrow(el, vw + nextW / 2, h / 2, nw + gap - 6, h / 2, { width: 4 });
    // the same pointer turned back (fx.list's reverse), from the node's left edge to the node before it
    const back = b.partArrow(el, -4, h / 2, -gap + 8, h / 2, { width: 4, color: b.strong("pen") });
    back.style.visibility = "hidden";
    back.style.opacity = "0";
    (el as HTMLElement & { __fwd?: SVGSVGElement; __back?: SVGSVGElement }).__fwd = fwd;
    (el as HTMLElement & { __fwd?: SVGSVGElement; __back?: SVGSVGElement }).__back = back;
    return el;
  };
  const order: HTMLElement[] = vals.map((v, k) => node(v, k, `n${k}`));
  const nodes = [...order];
  let nil: HTMLElement | null = null;
  if (opts.nil !== false) {
    nil = b.part("p-ds-nil", "null", slotLeft(order.length), top, nw * 0.8, h);
    nil.textContent = "null";
    nil.style.fontSize = `${m + 2}px`;
  }
  // the last node's pointer goes to the null; without one, the last node has no arrow
  const fwdOf = (el: HTMLElement) => (el as HTMLElement & { __fwd?: SVGSVGElement }).__fwd!;
  const backOf = (el: HTMLElement) => (el as HTMLElement & { __back?: SVGSVGElement }).__back!;
  if (!nil && order.length) fwdOf(order[order.length - 1]).style.visibility = "hidden";
  b.appear([...order, ...(nil ? [nil] : [])], opts.at, 0.08);
  const ptrs = new Pointers(b, (k) => slotLeft(k) + vw / 2, top - 6, false, levelH);
  const at0 = (i: number) => {
    if (!(i >= 0 && i < order.length)) throw new Error(`fx.list: no node ${i} (the list has ${order.length}, 0 to ${order.length - 1})`);
    return order[i];
  };
  /** every node from slot `from` on (and the null) slides by `by` slots */
  const shift = (from: number, by: number, t: number) => {
    const d = by * stepOf();
    for (let k = from; k < order.length; k++) b.moveTo(order[k], b.offset(order[k]).x + d, 0, t, 0.35);
    if (nil) b.moveTo(nil, b.offset(nil).x + d, 0, t, 0.35);
  };
  let added = 0;
  return {
    el: b.host,
    nodes,
    node: (i: number) => at0(i),
    nil,
    pointer: (name: string, i: number, at: number, tone?: string) => ptrs.place(name, i, at, tone),
    move: (name: string, i: number, at: number, seconds?: number) => ptrs.move(name, i, at, seconds),
    hide: (name: string, at: number) => ptrs.hide(name, at),
    ptr: (name: string) => ptrs.get(name),
    mark: (i: number, at: number, tone = "lemon") => b.tone(at0(i), tone, b.need(at, "mark")),
    unmark: (i: number, at: number) => b.tone(at0(i), "none", b.need(at, "unmark")),
    set: (i: number, value: Value, at: number) => b.text(at0(i).querySelector(".p-ds-node-val") as HTMLElement, value, b.need(at, "set")),
    /** a new node at position i: the nodes from i on slide right, the new one pops in */
    insert(i: number, value: Value, at: number) {
      const t = b.need(at, "insert");
      if (!(i >= 0 && i <= order.length)) throw new Error(`fx.list: insert at 0 to ${order.length}`);
      if (avail > 0 && slotLeft(order.length + (nil ? 1 : 0)) + (nil ? nw * 0.8 : nw) > b.host.offsetWidth + 1)
        throw new Error("fx.list: no room for another node: make the element wider");
      shift(i, 1, t);
      const el = node(String(value), i, `new${added++}`);
      order.splice(i, 0, el);
      nodes.push(el);
      b.arrive(el, t + 0.3, { y: -h * 0.8 });
      return el;
    },
    /** node i drops out; the nodes after it slide left */
    remove(i: number, at: number) {
      const t = b.need(at, "remove");
      const el = at0(i);
      b.leave(el, t, { y: h * 0.7 });
      order.splice(i, 1);
      shift(i, -1, t + 0.3);
    },
    /** node i's next pointer turns round to point at the node before it (the step of reversing a list) */
    reverse(i: number, at: number) {
      const t = b.need(at, "reverse");
      const el = at0(i);
      b.ctx.mark("reverse", [el], t);
      b.tl.fromTo(fwdOf(el), { autoAlpha: 1 }, { autoAlpha: 0, duration: 0.2, immediateRender: false }, t);
      b.tl.fromTo(backOf(el), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 }, t + 0.15);
      b.ctx.sound("whoosh", t, 0.4);
    },
  };
}

// ── stacks and queues ──

type LaneOpts = Base & {
  /** an item's height (stack) or width (queue), in px */
  size?: number;
  /** the most items it holds (sets the room it takes) */
  max?: number;
  /** the side labels: "top" for a stack, "front" and "rear" for a queue (false: none) */
  labels?: boolean;
};

function makeStack(ctx: KitCtx, host: Element, values: Value[] = [], opts: LaneOpts = {}) {
  const b = new Board(ctx, host, "stack", opts);
  const m = b.m;
  const h = opts.size ?? Math.round(m * 2.8);
  const gap = 8;
  const max = Math.max(values.length + 2, opts.max ?? 5);
  const labelW = opts.labels === false ? 0 : Math.round(b.measure("top", "p-ds-ptr-name", m + 4) + 70);
  const w = Math.max(160, (b.host.offsetWidth || 260 + labelW) - labelW);
  const size = b.room(w + labelW, max * (h + gap) + 12);
  const slotTop = (k: number) => size.h - 6 - (k + 1) * (h + gap) + gap;
  const items: HTMLElement[] = [];
  let made = 0;
  const box = (v: Value, k: number) => b.cell("p-ds-item", `s${made++}`, 0, slotTop(k), w, h, v);
  values.forEach((v, k) => items.push(box(v, k)));
  const base = b.part("p-ds-base", "base", -10, size.h - 6, w + 20, 6);
  b.appear([base, ...items], opts.at, 0.06);
  let label: HTMLElement | null = null;
  const labelAt = (k: number) => slotTop(Math.max(0, k)) + h / 2 - (m + 4) / 2 - 4;
  if (labelW) {
    label = b.part("p-ds-side", "top", w + 14, labelAt(items.length - 1), labelW - 14, m + 12);
    label.style.color = b.strong("pen");
    label.innerHTML = `<span class="p-ds-side-arrow">&larr;</span> top`;
    label.style.fontSize = `${m + 4}px`;
    if (!items.length) label.style.visibility = "hidden";
    else b.appear([label], opts.at == null ? undefined : opts.at + items.length * 0.06, 0, false);
  }
  const moveLabel = (t: number) => {
    if (!label) return;
    if (!items.length) {
      b.tl.fromTo(label, { autoAlpha: 1 }, { autoAlpha: 0, duration: 0.2, immediateRender: false }, t);
      return;
    }
    if (label.style.visibility === "hidden") {
      label.style.visibility = "";
      b.tl.fromTo(label, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, t);
    }
    b.moveTo(label, 0, labelAt(items.length - 1) - (parseFloat(label.style.top) || 0), t, 0.3);
  };
  const top = () => {
    if (!items.length) throw new Error("fx.stack: the stack is empty");
    return items[items.length - 1];
  };
  return {
    el: b.host,
    items,
    top,
    label,
    push(value: Value, at: number) {
      const t = b.need(at, "push");
      if (items.length >= max) throw new Error(`fx.stack: it holds ${max} items (opts.max)`);
      const el = box(value, items.length);
      items.push(el);
      b.arrive(el, t, { y: -h * 1.2 });
      moveLabel(t);
      b.ctx.sound("pop", t, 0.5);
      return el;
    },
    pop(at: number) {
      const t = b.need(at, "pop");
      const el = top();
      b.leave(el, t, { y: -h * 1.1 });
      items.pop();
      moveLabel(t + 0.1);
      return el;
    },
    peek: (at: number, tone = "lemon") => b.tone(top(), tone, b.need(at, "peek")),
    mark: (i: number, at: number, tone = "lemon") => b.tone(items[i] ?? top(), tone, b.need(at, "mark")),
  };
}

function makeQueue(ctx: KitCtx, host: Element, values: Value[] = [], opts: LaneOpts = {}) {
  const b = new Board(ctx, host, "queue", opts);
  const m = b.m;
  const gap = 10;
  const h = Math.round(m * 3.2);
  const max = Math.max(values.length + 2, opts.max ?? 6);
  const avail = b.host.offsetWidth;
  let w = opts.size ?? Math.max(h, ...values.map((v) => b.measure(String(v), "p-ds-v", m + 10) + 26));
  if (avail > 0) w = Math.min(w, Math.floor((avail - gap * (max - 1)) / max));
  if (w < m * 2.2) throw new Error(`fx.queue: ${max} items don't fit in ${avail} px: make it wider or lower opts.max`);
  const labelH = opts.labels === false ? 0 : m + 40;
  const size = b.room(max * (w + gap) - gap, h + labelH + 8);
  const left = (k: number) => k * (w + gap);
  const items: HTMLElement[] = [];
  let made = 0;
  const box = (v: Value, k: number) => b.cell("p-ds-item", `q${made++}`, left(k), 0, w, h, v);
  values.forEach((v, k) => items.push(box(v, k)));
  const frame = b.part("p-ds-lane", "lane", -8, -8, size.w + 16, h + 16);
  b.host.insertBefore(frame, b.host.firstChild);
  b.appear([frame, ...items], opts.at, 0.06);
  const ptrs = labelH ? new Pointers(b, (k) => left(k) + w / 2, h + 10, true, m + 34) : null;
  if (ptrs && items.length && opts.at != null) {
    ptrs.place("front", 0, opts.at + 0.2);
    ptrs.place("rear", items.length - 1, opts.at + 0.2);
  } else if (ptrs && items.length) {
    ptrs.place("front", 0, 0);
    ptrs.place("rear", items.length - 1, 0);
  }
  const front = () => {
    if (!items.length) throw new Error("fx.queue: the queue is empty");
    return items[0];
  };
  return {
    el: b.host,
    items,
    front,
    rear: () => items[items.length - 1] ?? front(),
    enqueue(value: Value, at: number) {
      const t = b.need(at, "enqueue");
      if (items.length >= max) throw new Error(`fx.queue: it holds ${max} items (opts.max)`);
      const el = box(value, items.length);
      items.push(el);
      b.arrive(el, t, { x: w * 0.8 });
      if (ptrs) items.length === 1 ? (ptrs.place("front", 0, t), ptrs.place("rear", 0, t)) : ptrs.place("rear", items.length - 1, t);
      b.ctx.sound("pop", t, 0.5);
      return el;
    },
    dequeue(at: number) {
      const t = b.need(at, "dequeue");
      const el = front();
      b.leave(el, t, { x: -w * 0.8 });
      items.shift();
      items.forEach((it) => b.moveTo(it, b.offset(it).x - (w + gap), 0, t + 0.15, 0.35));
      if (ptrs) {
        if (items.length) ptrs.place("rear", items.length - 1, t + 0.15);
        else {
          ptrs.hide("front", t);
          ptrs.hide("rear", t);
        }
      }
      return el;
    },
    mark: (i: number, at: number, tone = "lemon") => b.tone(items[i] ?? front(), tone, b.need(at, "mark")),
  };
}

// ── hash maps ──

type MapOpts = Base & { /** a row's height in px */ size?: number };

function makeHashmap(ctx: KitCtx, host: Element, buckets: number | Value[], opts: MapOpts = {}) {
  const b = new Board(ctx, host, "hashmap", opts);
  const m = b.m;
  const labels = (Array.isArray(buckets) ? buckets : Array.from({ length: Math.max(1, Math.floor(Number(buckets) || 0)) }, (_, k) => k)).map(String);
  if (!labels.length) throw new Error("fx.hashmap needs the number of buckets, like 8, or their labels");
  const rh = opts.size ?? Math.round(m * 2.9);
  const gap = 10;
  const bw = Math.max(Math.round(m * 3), ...labels.map((l) => b.measure(l, "p-ds-v p-ds-mono", m + 4) + 22));
  const ag = 40;
  const size = b.room(Math.max(b.host.offsetWidth, bw + 4 * (ag + 160)), labels.length * (rh + gap) - gap);
  const rowTop = (r: number) => r * (rh + gap);
  const bucketEls = labels.map((l, r) => {
    const el = b.cell("p-ds-bucket", `b${r}`, 0, rowTop(r), bw, rh, l);
    el.querySelector(".p-ds-v")?.classList.add("p-ds-mono");
    return el;
  });
  b.appear(bucketEls, opts.at, 0.04);
  type Entry = { key: string; el: HTMLElement; w: number };
  const chains: Entry[][] = labels.map(() => []);
  const where = new Map<string, number>();
  const nh = rh - 12;
  let made = 0;
  const chainLeft = (r: number, k: number) => bw + ag + chains[r].slice(0, k).reduce((s, e) => s + e.w + ag, 0);
  const bucketOf = (r: number) => {
    if (!(r >= 0 && r < labels.length)) throw new Error(`fx.hashmap: no bucket ${r} (0 to ${labels.length - 1})`);
    return r;
  };
  const find = (key: Value) => {
    const r = where.get(String(key));
    if (r == null) return null;
    const k = chains[r].findIndex((e) => e.key === String(key));
    return k < 0 ? null : { r, k };
  };
  return {
    el: b.host,
    buckets: bucketEls,
    /** an entry at the end of bucket r's chain ("key" or "key: value"); returns its element */
    put(key: Value, bucket: number, at: number, value?: Value) {
      const t = b.need(at, "put");
      const r = bucketOf(bucket);
      const text = value == null ? String(key) : `${key}: ${value}`;
      const w = Math.round(b.measure(text, "p-ds-v p-ds-mono", m + 4) + 28);
      const x = chainLeft(r, chains[r].length);
      if (x + w > size.w + 1) throw new Error(`fx.hashmap: bucket ${r}'s chain has no room for "${text}": make the element wider`);
      const el = b.cell("p-ds-entry", `e${made++}`, x, rowTop(r) + 6, w, nh, null);
      b.valueSpan(el, text, w, nh, true);
      // the arrow in from the bucket or the entry before (it moves with the entry)
      b.partArrow(el, -ag + 4, nh / 2, -6, nh / 2, { width: 4 });
      chains[r].push({ key: String(key), el, w });
      where.set(String(key), r);
      b.arrive(el, t, { x: -20 });
      b.ctx.sound("pop", t, 0.5);
      return el;
    },
    /** looks a key up: its bucket lights up, then each entry along the chain until the key (mint), or the
     *  bucket goes pink when it isn't there. Returns when it ends. */
    get(key: Value, at: number, bucket?: number) {
      const t = b.need(at, "get");
      const hit = find(key);
      const r = hit ? hit.r : bucketOf(Number(bucket ?? 0));
      b.tone(bucketEls[r], "sky", t);
      const chain = chains[r];
      const stop = hit ? hit.k : chain.length - 1;
      let tt = t + 0.35;
      for (let k = 0; k <= stop; k++) {
        b.tone(chain[k].el, hit && k === stop ? "mint" : "sky", tt);
        tt += 0.35;
      }
      if (!hit) b.tone(bucketEls[r], "pink", tt);
      else b.ctx.sound("ding", tt - 0.35, 0.4);
      return tt;
    },
    remove(key: Value, at: number) {
      const t = b.need(at, "remove");
      const hit = find(key);
      if (!hit) throw new Error(`fx.hashmap: no key "${key}" to remove`);
      const [gone] = chains[hit.r].splice(hit.k, 1);
      b.leave(gone.el, t, { y: rh * 0.5 });
      for (let k = hit.k; k < chains[hit.r].length; k++) {
        const e = chains[hit.r][k];
        b.moveTo(e.el, b.offset(e.el).x - (gone.w + ag), 0, t + 0.25, 0.35);
      }
      where.delete(String(key));
    },
    entry: (key: Value) => {
      const hit = find(key);
      return hit ? chains[hit.r][hit.k].el : null;
    },
    mark(key: Value, at: number, tone = "lemon") {
      const hit = find(key);
      b.tone(hit ? chains[hit.r][hit.k].el : bucketEls[bucketOf(Number(key))], tone, b.need(at, "mark"));
    },
  };
}

// ── trees ──

type TreeInput = Value | null | TreeInput[] | { v?: Value; value?: Value; val?: Value; left?: TreeInput; right?: TreeInput; children?: TreeInput[] };
type TNode = { label: string; kids: (TNode | null)[]; binary: boolean; depth: number; x: number; y: number; cx: number; cy: number; parent: TNode | null; el: HTMLElement | null; edge: SVGGElement | null; hidden: boolean; order: number };

type TreeOpts = Base & {
  /** a node's radius in px (33 on the paper stage) */
  r?: number;
  /** values whose nodes wait to be shown (show(value, at): a node inserted later) */
  hidden?: Value[];
};

/** A tree from a level-order list (the LeetCode way: [8, 3, 10, 1, 6, null, 14], children taken in turn for
 *  the nodes that exist) or from nested objects ({v, left, right} or {v, children: [...]}). */
function parseTree(input: TreeInput): TNode | null {
  const mk = (label: Value, binary: boolean, parent: TNode | null, depth: number): TNode => ({ label: String(label), kids: [], binary, depth, x: 0, y: 0, cx: 0, cy: 0, parent, el: null, edge: null, hidden: false, order: 0 });
  if (Array.isArray(input)) {
    const vals = input as (Value | null)[];
    if (!vals.length || vals[0] == null) return null;
    const root = mk(vals[0] as Value, true, null, 0);
    root.kids = [null, null];
    const queue: TNode[] = [root];
    let i = 1;
    while (queue.length && i < vals.length) {
      const p = queue.shift()!;
      for (const side of [0, 1]) {
        if (i >= vals.length) break;
        const v = vals[i++];
        if (v == null) continue;
        const c = mk(v, true, p, p.depth + 1);
        c.kids = [null, null];
        p.kids[side] = c;
        queue.push(c);
      }
    }
    return root;
  }
  const walk = (o: TreeInput, parent: TNode | null, depth: number): TNode | null => {
    if (o == null) return null;
    if (typeof o !== "object") return mk(o as Value, false, parent, depth);
    const ob = o as { v?: Value; value?: Value; val?: Value; left?: TreeInput; right?: TreeInput; children?: TreeInput[] };
    const label = ob.v ?? ob.value ?? ob.val ?? "";
    if (Array.isArray(ob.children)) {
      const n = mk(label, false, parent, depth);
      n.kids = ob.children.map((c) => walk(c, n, depth + 1)).filter((c): c is TNode => !!c);
      return n;
    }
    const n = mk(label, true, parent, depth);
    n.kids = [walk(ob.left ?? null, n, depth + 1), walk(ob.right ?? null, n, depth + 1)];
    return n;
  };
  return walk(input, null, 0);
}

function makeTree(ctx: KitCtx, host: Element, data: TreeInput, opts: TreeOpts = {}) {
  const b = new Board(ctx, host, "tree", opts);
  const m = b.m;
  const root = parseTree(data);
  if (!root) throw new Error("fx.tree needs a tree: a level-order list like [8, 3, 10, 1, 6, null, 14], or {v, left, right}");
  const all: TNode[] = [];
  const visit = (n: TNode | null) => {
    if (!n) return;
    n.order = all.length;
    all.push(n);
    n.kids.forEach(visit);
  };
  visit(root);
  // x: a binary tree by its in-order position (a search tree reads left to right in order); any other tree
  // by its leaves, each parent over the middle of its children
  let col = 0;
  const place = (n: TNode | null) => {
    if (!n) return;
    if (n.binary) {
      place(n.kids[0]);
      n.x = col++;
      place(n.kids[1]);
    } else if (!n.kids.length) n.x = col++;
    else {
      n.kids.forEach((k) => place(k));
      const ks = n.kids.filter(Boolean) as TNode[];
      n.x = (ks[0].x + ks[ks.length - 1].x) / 2;
    }
  };
  place(root);
  const cols = Math.max(1, col);
  const depth = Math.max(...all.map((n) => n.depth));
  let r = opts.r ?? Math.round(m * 1.5);
  const minStepX = 2 * r + 14;
  const w0 = b.host.offsetWidth || (cols - 1) * (2 * r + 28) + 2 * r + 8;
  const h0 = b.host.offsetHeight || depth * (2 * r + 50) + 2 * r + 8;
  let stepX = cols > 1 ? Math.min(2 * r + 40, (w0 - 2 * r - 8) / (cols - 1)) : 0;
  if (cols > 1 && stepX < minStepX) {
    r = Math.max(Math.round(m * 1.05), Math.floor(((w0 - 8) / (cols - 1) - 14) / 2));
    stepX = (w0 - 2 * r - 8) / (cols - 1);
    if (stepX < 2 * r + 6) throw new Error(`fx.tree: ${cols} nodes across don't fit in ${w0} px: make the element wider`);
  }
  const stepY = depth ? Math.min(2 * r + 70, (h0 - 2 * r - 8) / depth) : 0;
  const size = b.room(w0, h0);
  const spanW = (cols - 1) * stepX;
  const ox = (size.w - spanW) / 2;
  for (const n of all) {
    n.cx = ox + n.x * stepX;
    n.cy = r + 4 + n.depth * stepY;
  }
  const hidden = new Set((opts.hidden ?? []).map(String));
  // edges first (under the nodes), each trimmed to the circles' edges
  for (const n of all) {
    if (!n.parent) continue;
    const p = n.parent;
    const dx = n.cx - p.cx;
    const dy = n.cy - p.cy;
    const len = Math.hypot(dx, dy) || 1;
    n.edge = b.arrow(p.cx + (dx / len) * r, p.cy + (dy / len) * r, n.cx - (dx / len) * r, n.cy - (dy / len) * r, { head: false, width: 4 });
  }
  for (const n of all) {
    n.el = b.cell("p-ds-tnode", `n${n.order}`, n.cx - r, n.cy - r, 2 * r, 2 * r, n.label, "circle");
    if (hidden.has(n.label)) n.hidden = true;
  }
  const shown = all.filter((n) => !n.hidden);
  b.appear(
    shown.flatMap((n) => [n.el!, ...(n.edge ? [n.edge] : [])]),
    opts.at,
    0.06,
  );
  for (const n of all.filter((x) => x.hidden)) {
    gsapHide(b, n.el!);
    if (n.edge) gsapHide(b, n.edge);
  }
  const node = (ref: Ref): TNode => {
    const n = all.find((x) => x.label === String(ref));
    if (!n) throw new Error(`fx.tree: no node "${ref}" (nodes: ${all.map((x) => x.label).join(", ")})`);
    return n;
  };
  const edgeOf = (a: Ref, c: Ref): SVGGElement => {
    const x = node(a);
    const y = node(c);
    const child = y.parent === x ? y : x.parent === y ? x : null;
    if (!child?.edge) throw new Error(`fx.tree: "${a}" and "${c}" aren't joined by an edge`);
    return child.edge;
  };
  const lineOf = (g: SVGGElement) => g.querySelector("line") as SVGLineElement;
  const ptrs = new Map<string, { el: HTMLElement; baseX: number; baseY: number; w: number; h: number }>();
  const ptrPos = (n: TNode, w: number, h: number) => ({ x: n.cx - r - w - 4, y: n.cy - h / 2 });
  return {
    el: b.host,
    nodes: all.map((n) => n.el!),
    node: (ref: Ref) => node(ref).el!,
    edge: (a: Ref, c: Ref, at: number, tone = "pen") => b.stroke(lineOf(edgeOf(a, c)), b.strong(tone), 6, b.need(at, "edge")),
    visit: (ref: Ref, at: number, tone = "sky") => {
      const t = b.need(at, "visit");
      b.ctx.mark("visit", [node(ref).el!], t);
      b.tone(node(ref).el!, tone, t);
    },
    done: (ref: Ref, at: number) => b.tone(node(ref).el!, "mint", b.need(at, "done")),
    mark: (ref: Ref, at: number, tone = "lemon") => b.tone(node(ref).el!, tone, b.need(at, "mark")),
    /** visits the nodes in turn, lighting the edge between each two; returns when it ends */
    path(refs: Ref[], at: number, o: { step?: number; tone?: string; edge?: string } = {}) {
      let t = b.need(at, "path");
      const step = o.step ?? 0.5;
      refs.forEach((ref, k) => {
        if (k > 0) b.stroke(lineOf(edgeOf(refs[k - 1], ref)), b.strong(o.edge ?? "pen"), 6, t);
        b.tone(node(ref).el!, o.tone ?? "sky", t);
        b.ctx.mark("visit", [node(ref).el!], t);
        t += step;
      });
      return t;
    },
    /** a node given in opts.hidden pops in, its edge drawing on */
    show(ref: Ref, at: number) {
      const t = b.need(at, "show");
      const n = node(ref);
      if (n.edge) b.tl.fromTo(n.edge, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, immediateRender: false }, t);
      b.tl.fromTo(n.el!, { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(2)", immediateRender: false }, t + 0.15);
      b.ctx.mark("pop", [n.el!], t);
      b.ctx.sound("pop", t, 0.5);
    },
    remove(ref: Ref, at: number) {
      const t = b.need(at, "remove");
      const n = node(ref);
      b.leave(n.el!, t);
      if (n.edge) b.tl.fromTo(n.edge, { autoAlpha: 1 }, { autoAlpha: 0, duration: 0.3, immediateRender: false }, t);
    },
    set: (ref: Ref, value: Value, at: number) => b.text(node(ref).el!, value, b.need(at, "set")),
    /** a pointer's name beside a node (cur, root, p); later calls move it to another node */
    pointer(name: string, ref: Ref, at: number, tone?: string) {
      const t = b.need(at, `pointer "${name}"`);
      const n = node(ref);
      const old = ptrs.get(name);
      if (old) {
        const p = ptrPos(n, old.w, old.h);
        b.ctx.mark("move", [old.el], t);
        b.moveTo(old.el, p.x - old.baseX, p.y - old.baseY, t, 0.35);
        return old.el;
      }
      const size = m + 4;
      const w = b.measure(name, "p-ds-ptr-name", size) + 40;
      const h = size + 8;
      const p = ptrPos(n, w, h);
      const el = b.part("p-ds-side", `ptr-${name.replace(/[^\w-]/g, "") || "p"}`, p.x, p.y, w, h);
      el.style.color = b.strong(tone, "pen");
      el.style.fontSize = `${size}px`;
      el.style.textAlign = "right";
      el.innerHTML = `${esc(name)} <span class="p-ds-side-arrow">&rarr;</span>`;
      ptrs.set(name, { el, baseX: p.x, baseY: p.y, w, h });
      b.arrive(el, t, { x: -14 });
      return el;
    },
  };
}

/** Hidden from the start (a part that shows later). */
function gsapHide(b: Board, el: Element) {
  b.tl.set(el, { autoAlpha: 0 }, 0);
  (el as HTMLElement).style.visibility = "hidden";
  (el as HTMLElement).style.opacity = "0";
}

// ── graphs ──

type GNodeIn = { id: Value; label?: Value; x: number; y: number };
type GEdgeIn = [Value, Value, Value?] | { from: Value; to: Value; w?: Value; weight?: Value };
type GraphSpec = { nodes: GNodeIn[]; edges?: GEdgeIn[] };
type GraphOpts = Base & {
  /** a node's radius in px (34 on the paper stage) */
  r?: number;
  /** every edge has a direction (an arrowhead at its end) */
  directed?: boolean;
};

function makeGraph(ctx: KitCtx, host: Element, spec: GraphSpec, opts: GraphOpts = {}) {
  const b = new Board(ctx, host, "graph", opts);
  const m = b.m;
  if (!spec || !Array.isArray(spec.nodes) || !spec.nodes.length) throw new Error("fx.graph needs {nodes: [{id, x, y}], edges: [[a, b], ...]}");
  const r = opts.r ?? Math.round(m * 1.55);
  const size = b.room(b.host.offsetWidth || 600, b.host.offsetHeight || 400);
  const frac = spec.nodes.every((n) => Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1);
  const X = (v: number) => (frac ? r + 4 + v * (size.w - 2 * r - 8) : v);
  const Y = (v: number) => (frac ? r + 4 + v * (size.h - 2 * r - 8) : v);
  type GN = { id: string; label: string; cx: number; cy: number; el: HTMLElement; badge: HTMLElement | null };
  type GE = { a: string; b: string; g: SVGGElement; w: HTMLElement | null };
  const nodes = new Map<string, GN>();
  const edges: GE[] = [];
  const pos = new Map(spec.nodes.map((n) => [String(n.id), { cx: X(Number(n.x)), cy: Y(Number(n.y)) }]));
  for (const e of spec.edges ?? []) {
    const [a, c, w] = Array.isArray(e) ? [e[0], e[1], e[2]] : [e.from, e.to, e.w ?? e.weight];
    const pa = pos.get(String(a));
    const pc = pos.get(String(c));
    if (!pa || !pc) throw new Error(`fx.graph: an edge joins "${a}" and "${c}", but there is no such node`);
    const dx = pc.cx - pa.cx;
    const dy = pc.cy - pa.cy;
    const len = Math.hypot(dx, dy) || 1;
    const g = b.arrow(pa.cx + (dx / len) * r, pa.cy + (dy / len) * r, pc.cx - (dx / len) * (r + (opts.directed ? 3 : 0)), pc.cy - (dy / len) * (r + (opts.directed ? 3 : 0)), { head: !!opts.directed, width: 4 });
    let wl: HTMLElement | null = null;
    if (w != null && String(w) !== "") {
      // the weight beside the edge's middle, on its upper (or left) side
      const nx = -dy / len;
      const ny = dx / len;
      const side = ny > 0 || (ny === 0 && nx < 0) ? -1 : 1;
      const size2 = m + 2;
      const ww = b.measure(String(w), "p-ds-w", size2) + 14;
      const hh = size2 + 8;
      const mx = (pa.cx + pc.cx) / 2 + side * nx * 22;
      const my = (pa.cy + pc.cy) / 2 + side * ny * 22;
      wl = b.part("p-ds-w", `w-${a}-${c}`, mx - ww / 2, my - hh / 2, ww, hh);
      wl.textContent = String(w);
      wl.style.fontSize = `${size2}px`;
    }
    edges.push({ a: String(a), b: String(c), g, w: wl });
  }
  for (const n of spec.nodes) {
    const p = pos.get(String(n.id))!;
    const el = b.cell("p-ds-gnode", `n-${String(n.id).replace(/[^\w-]/g, "")}`, p.cx - r, p.cy - r, 2 * r, 2 * r, n.label ?? n.id, "circle");
    nodes.set(String(n.id), { id: String(n.id), label: String(n.label ?? n.id), cx: p.cx, cy: p.cy, el, badge: null });
  }
  b.appear([...[...nodes.values()].map((n) => n.el), ...edges.flatMap((e) => [e.g, ...(e.w ? [e.w] : [])])], opts.at, 0.04);
  const node = (id: Ref) => {
    const n = nodes.get(String(id));
    if (!n) throw new Error(`fx.graph: no node "${id}" (nodes: ${[...nodes.keys()].join(", ")})`);
    return n;
  };
  const edge = (a: Ref, c: Ref) => {
    const e = edges.find((x) => (x.a === String(a) && x.b === String(c)) || (!opts.directed && x.a === String(c) && x.b === String(a)));
    if (!e) throw new Error(`fx.graph: no edge from "${a}" to "${c}"`);
    return e;
  };
  const strokeEdge = (e: GE, color: string, at: number) => {
    for (const part of Array.from(e.g.children) as SVGElement[]) {
      const tag = part.tagName.toLowerCase();
      if (tag === "line") b.stroke(part, color, 6, at);
      else b.tl.fromTo(part, { stroke: part.getAttribute("data-stroke") || b.ink, fill: part.getAttribute("data-stroke") || b.ink }, { stroke: color, fill: color, duration: 0.3, immediateRender: false }, at);
      if (tag !== "line") part.setAttribute("data-stroke", color);
    }
  };
  const ptrs = new Map<string, { el: HTMLElement; baseX: number; baseY: number; w: number; h: number }>();
  return {
    el: b.host,
    node: (id: Ref) => node(id).el,
    edgeEl: (a: Ref, c: Ref) => edge(a, c).g,
    visit: (id: Ref, at: number, tone = "sky") => {
      const t = b.need(at, "visit");
      b.ctx.mark("visit", [node(id).el], t);
      b.tone(node(id).el, tone, t);
    },
    done: (id: Ref, at: number) => b.tone(node(id).el, "mint", b.need(at, "done")),
    /** the nodes waiting their turn (a BFS queue, a DFS stack), in peach */
    frontier(ids: Ref[], at: number) {
      const t = b.need(at, "frontier");
      for (const id of ids) b.tone(node(id).el, "peach", t);
    },
    mark: (id: Ref, at: number, tone = "lemon") => b.tone(node(id).el, tone, b.need(at, "mark")),
    edge: (a: Ref, c: Ref, at: number, tone = "pen") => strokeEdge(edge(a, c), b.strong(tone), b.need(at, "edge")),
    path(ids: Ref[], at: number, o: { step?: number; tone?: string; edge?: string } = {}) {
      let t = b.need(at, "path");
      ids.forEach((id, k) => {
        if (k > 0) strokeEdge(edge(ids[k - 1], id), b.strong(o.edge ?? "pen"), t);
        b.tone(node(id).el, o.tone ?? "sky", t);
        b.ctx.mark("visit", [node(id).el], t);
        t += o.step ?? 0.5;
      });
      return t;
    },
    /** a small tag above a node's right (a distance, a level, a colour): shown at `at`, changed by later calls */
    label(id: Ref, text: Value, at: number, tone = "ink") {
      const t = b.need(at, "label");
      const n = node(id);
      if (n.badge) {
        b.text(n.badge, text, t);
        return n.badge;
      }
      const size = m + 2;
      const w = Math.max(size * 2.2, b.measure(String(text), "p-ds-badge", size) + 18);
      const h = size + 10;
      const el = b.part("p-ds-badge", `d-${n.id.replace(/[^\w-]/g, "")}`, n.cx + r * 0.55, n.cy - r - h + 6, w, h);
      el.style.fontSize = `${size}px`;
      el.style.borderColor = b.strong(tone, "ink");
      const span = document.createElement("span");
      span.className = "p-ds-v";
      span.textContent = String(text);
      el.appendChild(span);
      n.badge = el;
      b.arrive(el, t);
      return el;
    },
    weight(a: Ref, c: Ref, value: Value, at: number) {
      const e = edge(a, c);
      if (!e.w) throw new Error(`fx.graph: the edge "${a}"-"${c}" has no weight to change`);
      b.text(e.w, value, b.need(at, "weight"));
    },
    pointer(name: string, id: Ref, at: number, tone?: string) {
      const t = b.need(at, `pointer "${name}"`);
      const n = node(id);
      const old = ptrs.get(name);
      const size = m + 4;
      const w = old?.w ?? b.measure(name, "p-ds-ptr-name", size) + 40;
      const h = size + 8;
      const x = n.cx - r - w - 4;
      const y = n.cy - h / 2;
      if (old) {
        b.ctx.mark("move", [old.el], t);
        b.moveTo(old.el, x - old.baseX, y - old.baseY, t, 0.35);
        return old.el;
      }
      const el = b.part("p-ds-side", `ptr-${name.replace(/[^\w-]/g, "") || "p"}`, x, y, w, h);
      el.style.color = b.strong(tone, "pen");
      el.style.fontSize = `${size}px`;
      el.style.textAlign = "right";
      el.innerHTML = `${esc(name)} <span class="p-ds-side-arrow">&rarr;</span>`;
      ptrs.set(name, { el, baseX: x, baseY: y, w, h });
      b.arrive(el, t, { x: -14 });
      return el;
    },
  };
}

// ── grids (a matrix, a DP table) ──

type GridSpec = { rows?: number; cols?: number; values?: (Value | null)[][]; rowLabels?: Value[]; colLabels?: Value[] };
type GridOpts = Base & { /** a cell's side in px (70 on the paper stage, smaller to fit the element) */ cell?: number };

function makeGrid(ctx: KitCtx, host: Element, spec: GridSpec | (Value | null)[][], opts: GridOpts = {}) {
  const b = new Board(ctx, host, "grid", opts);
  const m = b.m;
  const s: GridSpec = Array.isArray(spec) ? { values: spec } : spec ?? {};
  const rows = s.values?.length ?? Math.floor(Number(s.rows) || 0);
  const cols = s.values ? Math.max(...s.values.map((r) => r.length)) : Math.floor(Number(s.cols) || 0);
  if (!(rows > 0 && cols > 0)) throw new Error("fx.grid needs {rows, cols} or values: [[...], [...]]");
  const rl = (s.rowLabels ?? []).map(String);
  const cl = (s.colLabels ?? []).map(String);
  const labSize = m + 2;
  const rlw = rl.length ? Math.max(...rl.map((l) => b.measure(l, "p-ds-head", labSize))) + 18 : 0;
  const clh = cl.length ? labSize + 16 : 0;
  const availW = b.host.offsetWidth;
  const availH = b.host.offsetHeight;
  let c = opts.cell ?? Math.round(m * 3.2);
  if (availW > 0) c = Math.min(c, Math.floor((availW - rlw) / cols));
  if (availH > 0) c = Math.min(c, Math.floor((availH - clh) / rows));
  if (c < m * 1.9) throw new Error(`fx.grid: ${rows} x ${cols} cells don't fit (each needs at least ${Math.ceil(m * 1.9)} px): make the element bigger`);
  // neighbouring cells share their 3 px edge (one ink line between two cells, not two)
  const E = 3;
  const step = c - E;
  const size = b.room(rlw + cols * step + E, clh + rows * step + E);
  // the labels and the cells centred together in the element
  const lx = Math.max(0, (size.w - rlw - cols * step - E) / 2);
  const ox = lx + rlw;
  const oy = clh;
  const cells: HTMLElement[][] = [];
  for (let i = 0; i < rows; i++) {
    cells.push([]);
    for (let j = 0; j < cols; j++) {
      const v = s.values?.[i]?.[j];
      cells[i].push(b.cell("p-ds-gcell", `r${i}c${j}`, ox + j * step, oy + i * step, c, c, v == null ? "" : v));
    }
  }
  const heads: HTMLElement[] = [];
  cl.forEach((l, j) => {
    const el = b.part("p-ds-head", `col${j}`, ox + j * step, 0, c, labSize + 8);
    el.textContent = l;
    el.style.fontSize = `${labSize}px`;
    heads.push(el);
  });
  rl.forEach((l, i) => {
    const el = b.part("p-ds-head p-ds-rowhead", `row${i}`, lx, oy + i * step + (c - labSize - 8) / 2, rlw - 12, labSize + 8);
    el.textContent = l;
    el.style.fontSize = `${labSize}px`;
    heads.push(el);
  });
  b.appear([...heads, ...cells.flat()], opts.at, 0.012);
  const cell = (i: number, j: number) => {
    const el = cells[i]?.[j];
    if (!el) throw new Error(`fx.grid: no cell [${i}, ${j}] (rows 0 to ${rows - 1}, columns 0 to ${cols - 1})`);
    return el;
  };
  let arrows = 0;
  return {
    el: b.host,
    cells,
    cell,
    /** a value written into cell [i, j], with a pop (and a tone) */
    fill(i: number, j: number, value: Value, at: number, tone?: string) {
      const t = b.need(at, "fill");
      b.ctx.mark("fill", [cell(i, j)], t);
      b.text(cell(i, j), value, t);
      if (tone) b.tone(cell(i, j), tone, t);
    },
    mark: (i: number, j: number, at: number, tone = "lemon") => b.tone(cell(i, j), tone, b.need(at, "mark")),
    unmark: (i: number, j: number, at: number) => b.tone(cell(i, j), "none", b.need(at, "unmark")),
    row(i: number, at: number, tone = "lemon") {
      const t = b.need(at, "row");
      for (let j = 0; j < cols; j++) b.tone(cell(i, j), tone, t);
    },
    col(j: number, at: number, tone = "lemon") {
      const t = b.need(at, "col");
      for (let i = 0; i < rows; i++) b.tone(cell(i, j), tone, t);
    },
    /** an arrow from cell `from` to cell `to` ([row, column]): where a DP value comes from. Returns it, for
     *  fx.exit. */
    arrow(from: [number, number], to: [number, number], at: number, tone = "pen") {
      const t = b.need(at, "arrow");
      cell(from[0], from[1]);
      cell(to[0], to[1]);
      const x1 = ox + from[1] * step + c / 2;
      const y1 = oy + from[0] * step + c / 2;
      const x2 = ox + to[1] * step + c / 2;
      const y2 = oy + to[0] * step + c / 2;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const trim = c * 0.3;
      const g = b.arrow(x1 + ((x2 - x1) / len) * trim, y1 + ((y2 - y1) / len) * trim, x2 - ((x2 - x1) / len) * trim, y2 - ((y2 - y1) / len) * trim, { color: b.strong(tone), width: 4, parent: b.over() });
      g.setAttribute("data-id", b.partId(`arrow${arrows++}`));
      b.ctx.mark("draw", [g], t);
      b.drawArrow(g, t);
      return g;
    },
  };
}

// ── call stacks ──

type CallOpts = Base & { /** a frame's width in px (the element's width) */ width?: number };

function makeCallstack(ctx: KitCtx, host: Element, opts: CallOpts = {}) {
  const b = new Board(ctx, host, "callstack", opts);
  const m = b.m;
  const w = opts.width ?? (b.host.offsetWidth || 320);
  const size = b.room(w, b.host.offsetHeight || 520);
  const headH = m + 26;
  const rowH = m + 14;
  const gap = 10;
  type Frame = { el: HTMLElement; h: number; rows: Map<string, HTMLElement>; ret: HTMLElement | null };
  const frames: Frame[] = [];
  let made = 0;
  const used = () => frames.reduce((s, f) => s + f.h + gap, 0);
  const label = b.part("p-ds-head p-ds-stacklabel", "label", 0, size.h - m - 8, w, m + 8);
  label.textContent = "call stack";
  label.style.fontSize = `${m}px`;
  b.appear([label], opts.at, 0, false);
  const bottom = size.h - m - 14;
  const rowFor = (f: Frame, name: string, value: Value, k: number) => {
    const row = document.createElement("div");
    row.className = "p-ds-var";
    row.style.top = `${headH + k * rowH}px`;
    row.style.height = `${rowH}px`;
    row.style.fontSize = `${m + 2}px`;
    row.innerHTML = `<span class="p-ds-var-k"></span> = <span class="p-ds-v"></span>`;
    (row.firstChild as HTMLElement).textContent = name;
    (row.lastChild as HTMLElement).textContent = String(value);
    f.el.appendChild(row);
    f.rows.set(name, row);
    return row;
  };
  const topFrame = () => {
    if (!frames.length) throw new Error("fx.callstack: no frame on the stack");
    return frames[frames.length - 1];
  };
  const api = {
    el: b.host,
    frames: () => frames.map((f) => f.el),
    /** a call: a frame with its name ("fib(3)") and its variables ({n: 3}) lands on top; returns a handle */
    push(name: string, at: number, vars: Record<string, Value> = {}) {
      const t = b.need(at, "push");
      const keys = Object.keys(vars);
      const h = headH + Math.max(1, keys.length + 1) * rowH;
      const y = bottom - used() - h;
      if (y < 0) throw new Error("fx.callstack: no room for another frame: make the element taller");
      const el = b.cell("p-ds-frame", `f${made++}`, 0, y, w, h, null);
      const head = document.createElement("div");
      head.className = "p-ds-frame-head p-ds-mono";
      head.style.height = `${headH}px`;
      head.style.fontSize = `${m + 4}px`;
      head.textContent = name;
      el.appendChild(head);
      const f: Frame = { el, h, rows: new Map(), ret: null };
      keys.forEach((k, i) => rowFor(f, k, vars[k], i));
      if (frames.length) b.tone(topFrame().el, "none", t);
      frames.push(f);
      b.arrive(el, t, { y: -40 });
      b.tone(el, "lemon", t);
      b.ctx.sound("pop", t, 0.45);
      const handle = {
        el,
        /** a variable's value changes (or a new one shows) */
        set(key: string, value: Value, at2: number) {
          const t2 = b.need(at2, "set");
          const row = f.rows.get(key);
          if (row) {
            b.text(row, value, t2);
            return;
          }
          if (f.rows.size + 1 > Math.max(1, keys.length + 1)) throw new Error(`fx.callstack: frame "${name}" has no room for "${key}": give it in push()'s variables`);
          const nr = rowFor(f, key, value, f.rows.size);
          b.arrive(nr, t2);
        },
        pop: (at2: number, returns?: Value) => api.pop(at2, returns),
      };
      return handle;
    },
    /** the top frame returns (shown for a moment with its value) and leaves; the one under it is on top again */
    pop(at: number, returns?: Value) {
      const t = b.need(at, "pop");
      const f = topFrame();
      let leaveAt = t;
      if (returns != null) {
        const ret = document.createElement("div");
        ret.className = "p-ds-ret p-ds-mono";
        ret.style.fontSize = `${m + 2}px`;
        ret.style.top = `${headH + f.rows.size * rowH}px`;
        ret.style.height = `${rowH}px`;
        ret.innerHTML = `returns <span class="p-ds-v"></span>`;
        (ret.lastChild as HTMLElement).textContent = String(returns);
        f.el.appendChild(ret);
        f.ret = ret;
        b.arrive(ret, t);
        leaveAt = t + 0.7;
      }
      frames.pop();
      b.leave(f.el, leaveAt, { y: -50 });
      if (frames.length) b.tone(topFrame().el, "lemon", leaveAt + 0.1);
      return f.el;
    },
  };
  return api;
}

// ── the module ──

export const DS_CSS = `
.p-ds { position: relative; font-family: var(--font-display); color: var(--ink); }
.p-ds > div, .p-ds-box { position: absolute; box-sizing: border-box; }
.p-ds-svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.p-ds-svg line, .p-ds-link line { stroke: var(--ink); stroke-linecap: round; }
.p-ds-box { display: flex; align-items: center; justify-content: center; border: 4px solid var(--ink); border-radius: 12px; box-shadow: 6px 6px 0 var(--ink); }
.p-ds-v { position: relative; display: inline-block; font-weight: 800; line-height: 1; white-space: nowrap; }
.p-ds-mono, .p-ds-mono .p-ds-v { font-family: var(--font-mono); font-weight: 700; }
.p-ds-idx { display: flex; justify-content: center; font: 600 22px/1 var(--font-mono); color: var(--c-ink-2, #475569); }
.p-ds-ptr { overflow: visible; }
.p-ds-ptr-name { position: absolute; left: 0; right: 0; text-align: center; font-family: var(--font-display); font-weight: 800; line-height: 1; white-space: nowrap; }
.p-ds-side { display: flex; align-items: center; justify-content: flex-end; gap: 6px; font-weight: 800; line-height: 1; white-space: nowrap; }
.p-ds-side-arrow { font-weight: 800; }
.p-ds-stack .p-ds-side { justify-content: flex-start; }
.p-ds-win { border: 5px solid var(--c-pen, #e03131); border-radius: 18px; }
.p-ds-node { display: flex; align-items: stretch; justify-content: flex-start; padding: 0; overflow: visible; }
.p-ds-node-val { display: flex; align-items: center; justify-content: center; flex: none; }
.p-ds-node-next { flex: none; border-left: 4px solid var(--ink); position: relative; }
.p-ds-node-next::after { content: ""; position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: var(--ink); }
.p-ds-nil { display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); font-weight: 700; color: var(--c-ink-2, #475569); }
.p-ds-link { overflow: visible; }
.p-ds-base { background: var(--ink); border-radius: 3px; }
.p-ds-lane { border: 4px dashed #94a3b8; border-radius: 16px; }
.p-ds-bucket { border-radius: 10px; }
.p-ds-entry { border-radius: 10px; box-shadow: 4px 4px 0 var(--ink); }
.p-ds-tnode, .p-ds-gnode { border-radius: 50%; box-shadow: 5px 5px 0 var(--ink); }
.p-ds-w { display: flex; align-items: center; justify-content: center; font: 700 24px/1 var(--font-mono); color: var(--ink); background: var(--bg, #f1f6fd); border-radius: 8px; }
.p-ds-badge { display: flex; align-items: center; justify-content: center; background: #fff; border: 3px solid var(--ink); border-radius: 10px; font-family: var(--font-mono); font-weight: 700; }
.p-ds-gcell { border-width: 3px; border-radius: 0; box-shadow: none; margin: 0; }
.p-ds-grid .p-ds-gcell { outline: none; }
.p-ds-head { display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); font-weight: 700; color: var(--c-ink-2, #475569); white-space: nowrap; }
.p-ds-rowhead { justify-content: flex-end; }
.p-ds-stacklabel { justify-content: flex-start; text-transform: uppercase; letter-spacing: 1.5px; font-family: var(--font-display); font-weight: 800; }
.p-ds-frame { display: block; padding: 0; border-radius: 12px; overflow: hidden; }
.p-ds-frame-head { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; padding: 0 16px; border-bottom: 3px solid var(--ink); font-weight: 800; }
.p-ds-var, .p-ds-ret { position: absolute; left: 16px; right: 12px; display: flex; align-items: center; gap: 0.4ch; font-family: var(--font-mono); font-weight: 500; white-space: nowrap; }
.p-ds-var .p-ds-v, .p-ds-ret .p-ds-v { font-family: var(--font-mono); font-weight: 800; }
.p-ds-ret { color: var(--c-pass, #16a34a); font-weight: 700; }
.p-ds-sketch, .p-ds-sketch .p-ds-v, .p-ds-sketch .p-ds-ptr-name, .p-ds-sketch .p-ds-side, .p-ds-sketch .p-ds-head, .p-ds-sketch .p-ds-frame-head { font-family: var(--font-sketch, Virgil, var(--font-hand)); font-weight: 400; }
.p-ds-sketch .p-ds-box { box-shadow: none; border-width: 3px; }
.p-ds-sketch .p-ds-sk { border-color: transparent; }
.p-ds-sketch .p-ds-sk > svg { pointer-events: none; }
`;

/** What the scene's fx gains. */
function make(ctx: KitCtx) {
  return {
    array: (el: Element, values: Value[], opts?: ArrayOpts) => makeArray(ctx, el, values, opts),
    list: (el: Element, values: Value[], opts?: ListOpts) => makeList(ctx, el, values, opts),
    stack: (el: Element, values?: Value[], opts?: LaneOpts) => makeStack(ctx, el, values ?? [], opts),
    queue: (el: Element, values?: Value[], opts?: LaneOpts) => makeQueue(ctx, el, values ?? [], opts),
    hashmap: (el: Element, buckets: number | Value[], opts?: MapOpts) => makeHashmap(ctx, el, buckets, opts),
    tree: (el: Element, data: TreeInput, opts?: TreeOpts) => makeTree(ctx, el, data, opts),
    graph: (el: Element, spec: GraphSpec, opts?: GraphOpts) => makeGraph(ctx, el, spec, opts),
    grid: (el: Element, spec: GridSpec | (Value | null)[][], opts?: GridOpts) => makeGrid(ctx, el, spec, opts),
    callstack: (el: Element, opts?: CallOpts) => makeCallstack(ctx, el, opts),
    /** plays a p-term window's session: each command typed on, then its output (see code.ts) */
    term: (el: Element, at: number | number[], opts?: TermOpts) => playTerm({ tl: ctx.tl, sound: ctx.sound, mark: ctx.mark }, el, at, opts),
  };
}

/** An icon's inline SVG for a part built at fx time (sequence actors), or "" when there is none. */
export function dsIcon(ctx: KitCtx, name: string | undefined, cls = "p-ds-icon"): string {
  return name ? iconMarkup(ctx.assets, name, cls) ?? "" : "";
}

export const ds: KitModule = { name: "ds", css: DS_CSS, make };

// shared with sequence.ts: the board and its helpers
export { Board, esc as escText, r1 };
export type { Value };
