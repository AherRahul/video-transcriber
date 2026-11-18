// The Excalidraw sketch look (kit/sketch.ts): hand-drawn boxes, circles, ellipses and diamonds with
// Excalidraw's palette and hachure fills, hand-drawn arrows and loops, and the hand fonts (Virgil, Excalifont).
//
// Markup: an element with class s-box, s-circle, s-ellipse or s-diamond gets its strokes drawn behind its
// content (data-fill blue|yellow|green|red|violet|orange|grey|white|pink|teal, data-fillstyle
// hachure|solid|cross-hatch|zigzag|dots|none, data-rough 0-3, data-stroke ink|red|green|blue|orange|violet|grey,
// data-dashed, data-round for a box's rounded corners). The strokes come from rough.js, seeded from the
// element's data-id, so every frame and every export draws exactly the same lines.
//
// fx.sketchIn draws a shape on (outline, then fill, then its words); fx.sketchLink and fx.sketchCircle are
// fx.link and fx.circle (their routing, their clearances, fx.flow and fx.cut on what they return) drawn by
// hand. sketchify() is the same drawing for other kit modules (the coding visuals use it for their cells).
//
// The strokes live in an SVG marked data-kit="sketch", which the layout report's chart and pen checks skip;
// a sketched element gets a transparent 1 px border so the report and fx.link treat it as a drawn box.

import { gsap } from "gsap";
import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";

import { svgEl } from "../geometry";
import type { KitAssets, KitCtx, KitModule } from "./types";

export type SketchShape = "box" | "circle" | "ellipse" | "diamond";
export type SketchOpts = { fill?: string; fillStyle?: string; roughness?: number; stroke?: string; strokeWidth?: number; round?: number; dashed?: boolean };

/** Excalidraw's background colours (the light row of its palette), by the names scenes use. */
export const SKETCH_FILLS: Record<string, string> = {
  blue: "#a5d8ff",
  yellow: "#ffec99",
  green: "#b2f2bb",
  red: "#ffc9c9",
  violet: "#d0bfff",
  orange: "#ffd8a8",
  grey: "#e9ecef",
  white: "#ffffff",
  pink: "#fcc2d7",
  teal: "#96f2d7",
};

/** Excalidraw's stroke colours. */
export const SKETCH_STROKES: Record<string, string> = {
  ink: "#1e1e1e",
  red: "#e03131",
  green: "#2f9e44",
  blue: "#1971c2",
  orange: "#f08c00",
  violet: "#6741d9",
  grey: "#868e96",
};

const SHAPE_CLASSES: [string, SketchShape][] = [
  ["s-box", "box"],
  ["s-circle", "circle"],
  ["s-ellipse", "ellipse"],
  ["s-diamond", "diamond"],
];

/** A named colour from a table, a colour written out (#hex, rgb(), var()), or the fallback. */
export function colourOf(v: string | undefined | null, table: Record<string, string>, fallback: string): string;
export function colourOf(v: string | undefined | null, table: Record<string, string>, fallback?: string): string | undefined;
export function colourOf(v: string | undefined | null, table: Record<string, string>, fallback?: string): string | undefined {
  const s = (v ?? "").trim();
  if (!s) return fallback;
  if (s in table) return table[s];
  if (/^(#|rgb|hsl|var\()/i.test(s) || s === "transparent") return s;
  return fallback;
}

/** rough.js wants a positive integer seed: 0 means a new random drawing on every call. */
export const roughSeed = (n: number) => (Math.abs(Math.floor(n)) % 2147483645) + 1;

const gen = rough.generator();

export type RoughParts = { lines: SVGPathElement[]; fills: SVGPathElement[] };

/** A rough drawable as SVG paths in `parent`, each tagged by its role: s-fill for a fill (a hachure's lines or a
 *  solid area), s-line for a stroke. */
export function roughPaths(drawable: Drawable, parent: SVGElement): RoughParts {
  const o = drawable.options;
  const out: RoughParts = { lines: [], fills: [] };
  for (const set of drawable.sets) {
    const d = gen.opsToPath(set, 2);
    if (!d) continue;
    const p = svgEl("path", { d });
    if (set.type === "path") {
      p.setAttribute("class", "s-line");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", o.stroke);
      p.setAttribute("stroke-width", String(o.strokeWidth));
      if (o.strokeLineDash?.length) p.setAttribute("stroke-dasharray", o.strokeLineDash.join(" "));
      out.lines.push(p);
    } else if (set.type === "fillSketch") {
      p.setAttribute("class", "s-fill s-hatch");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", o.fill ?? "none");
      p.setAttribute("stroke-width", String(o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight));
      out.fills.push(p);
    } else {
      p.setAttribute("class", "s-fill s-solid");
      p.setAttribute("fill", o.fill ?? "none");
      p.setAttribute("stroke", "none");
      out.fills.push(p);
    }
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    parent.appendChild(p);
  }
  return out;
}

/** A rounded rectangle as a path (Excalidraw's own, with quadratic corners). */
export function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y}, ${x + w} ${y + r} L ${x + w} ${y + h - r} Q ${x + w} ${y + h}, ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h}, ${x} ${y + h - r} L ${x} ${y + r} Q ${x} ${y}, ${x + r} ${y}`;
}

type Sketched = HTMLElement & { __sketch?: { svg: SVGSVGElement; dashed: boolean } & RoughParts };

/** The sketch drawing an element carries (sketchify made it), if any. */
export const sketchOf = (el: Element) => (el as Sketched).__sketch ?? null;

/** A stable key for an element without a data-id: its tag, place and size (the same in every build). */
function keyOf(el: HTMLElement): string {
  return el.getAttribute("data-id") || `${el.tagName}:${el.offsetLeft}:${el.offsetTop}:${el.offsetWidth}:${el.offsetHeight}`;
}

/**
 * Draws an element as an Excalidraw shape: rough strokes (and a fill) in an SVG behind its content, the size
 * of its border box, seeded from its data-id. Drawing it again replaces the first drawing. Returns the SVG.
 * Used by the s-box / s-circle / s-ellipse / s-diamond markup and by other kit modules (array cells, nodes).
 */
export function sketchify(
  el: HTMLElement,
  ctx: KitCtx,
  shape: "box" | "circle" | "ellipse" | "diamond",
  opts?: { fill?: string; fillStyle?: string; roughness?: number; stroke?: string; strokeWidth?: number },
): SVGSVGElement {
  const o = (opts ?? {}) as SketchOpts;
  sketchOf(el)?.svg.remove();
  const cs = getComputedStyle(el);
  if (cs.position === "static") el.style.position = "relative";
  el.style.isolation = "isolate";
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  const w = Math.max(4, el.offsetWidth || el.getBoundingClientRect().width);
  const h = Math.max(4, el.offsetHeight || el.getBoundingClientRect().height);
  const sw = Number.isFinite(o.strokeWidth) ? Number(o.strokeWidth) : 2.6;
  const pad = Math.ceil(sw * 2 + 10); // room for the strokes' overshoot
  const svg = svgEl("svg", {
    class: "s-ink",
    "data-kit": "sketch",
    "aria-hidden": "true",
    width: w + 2 * pad,
    height: h + 2 * pad,
    viewBox: `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`,
  });
  svg.style.cssText = `position:absolute;left:${-pad - bl}px;top:${-pad - bt}px;z-index:-1;pointer-events:none;overflow:visible;`;
  const roughness = Number.isFinite(o.roughness) ? Math.max(0, Math.min(3, Number(o.roughness))) : 1;
  const fillStyle = (o.fillStyle || "hachure").toLowerCase();
  const fill = fillStyle === "none" ? undefined : colourOf(o.fill, SKETCH_FILLS);
  const dashed = !!o.dashed;
  const ro: Options = {
    seed: roughSeed(ctx.seed(`sketch:${keyOf(el)}`)),
    roughness,
    bowing: 1,
    stroke: colourOf(o.stroke, SKETCH_STROKES, SKETCH_STROKES.ink),
    strokeWidth: sw,
    fill: fill && fill !== "transparent" ? fill : undefined,
    fillStyle: fillStyle === "none" ? "hachure" : fillStyle,
    fillWeight: sw / 2,
    hachureGap: sw * 3.4,
    hachureAngle: -41,
    preserveVertices: roughness < 2,
    disableMultiStroke: dashed,
    strokeLineDash: dashed ? [12, 10 + sw] : undefined,
  };
  const i = sw / 2; // the stroke's middle sits half its width in, so its outside is the element's edge
  let drawable: Drawable;
  if (shape === "circle") drawable = gen.circle(w / 2, h / 2, Math.min(w, h) - sw, { ...ro, curveFitting: 1 });
  else if (shape === "ellipse") drawable = gen.ellipse(w / 2, h / 2, w - sw, h - sw, { ...ro, curveFitting: 1 });
  else if (shape === "diamond")
    drawable = gen.polygon(
      [
        [w / 2, i],
        [w - i, h / 2],
        [w / 2, h - i],
        [i, h / 2],
      ],
      ro,
    );
  else if (o.round) drawable = gen.path(roundedRect(i, i, w - sw, h - sw, Number(o.round)), { ...ro, preserveVertices: true });
  else drawable = gen.rectangle(i, i, w - sw, h - sw, ro);
  const parts = roughPaths(drawable, svg);
  el.insertBefore(svg, el.firstChild);
  (el as Sketched).__sketch = { svg, dashed, ...parts };
  el.classList.add("s-drawn");
  return svg;
}

/** What an element's data-* attributes ask of its sketch. */
function optsOf(el: HTMLElement): SketchOpts {
  const d = el.dataset;
  const round = d.round === undefined ? undefined : d.round === "" || d.round === "yes" || d.round === "true" ? 16 : Number(d.round) || 16;
  return {
    fill: d.fill,
    fillStyle: d.fillstyle,
    roughness: d.rough === undefined ? undefined : Number(d.rough),
    stroke: d.stroke,
    strokeWidth: d.strokewidth === undefined ? undefined : Number(d.strokewidth),
    round,
    dashed: d.dashed !== undefined,
  };
}

function shapeOfClass(el: Element): SketchShape | null {
  for (const [cls, shape] of SHAPE_CLASSES) if (el.classList.contains(cls)) return shape;
  return null;
}

// ── the hand fonts, registered in the document once (a shadow root's @font-face is ignored) ──

const FONT_FILES: { family: string; file: string; range?: string; weight?: string }[] = [
  { family: "Virgil", file: "Virgil-Regular.woff2" },
  {
    family: "Excalifont",
    file: "Excalifont-Latin.woff2",
    range:
      "U+20-7e,U+a0-a3,U+a5-a6,U+a8-ab,U+ad-b1,U+b4,U+b6-b8,U+ba-ff,U+131,U+152-153,U+2bc,U+2c6,U+2da,U+2dc,U+304,U+308,U+2013-2014,U+2018-201a,U+201c-201e,U+2020,U+2022,U+2024-2026,U+2030,U+2039-203a,U+20ac,U+2122,U+2212",
  },
  { family: "Excalifont", file: "Excalifont-LatinExt.woff2", range: "U+100-130,U+132-137,U+139-149,U+14c-151,U+154-17e,U+192,U+1fc-1ff,U+218-21b,U+237,U+1e80-1e85,U+1ef2-1ef3,U+2113" },
  { family: "Cascadia", file: "CascadiaCode-Regular.woff2" },
  { family: "Nunito", file: "Nunito-Latin.woff2", weight: "500" },
  { family: "Lilita One", file: "LilitaOne-Latin.woff2" },
  { family: "Comic Shanns", file: "ComicShanns-Latin.woff2" },
  { family: "Liberation Sans", file: "LiberationSans-Regular.woff2" },
];

let fontsLoading: Promise<string[]> | null = null;

/** Registers the Excalidraw fonts (once) and waits until the hand fonts are ready. */
export function loadSketchFonts(assets: KitAssets): Promise<string[]> {
  if (!fontsLoading) {
    fontsLoading = (async () => {
      const faces = FONT_FILES.map((f) => {
        const face = new FontFace(f.family, `url("${assets.kitBase}fonts/${f.file}") format("woff2")`, {
          ...(f.range ? { unicodeRange: f.range } : {}),
          ...(f.weight ? { weight: f.weight } : {}),
          display: "block",
        });
        document.fonts.add(face);
        return face;
      });
      // the Latin faces now; the rest load when a drawing asks for them
      const wanted = faces.filter((_, k) => !FONT_FILES[k].range || FONT_FILES[k].file.endsWith("Latin.woff2"));
      const failed = (await Promise.all(wanted.map((f) => f.load().then(() => null, () => f.family)))).filter(Boolean) as string[];
      return failed.length ? [`The sketch font${failed.length > 1 ? "s" : ""} ${[...new Set(failed)].join(", ")} didn't load: drawings would use a fallback font.`] : [];
    })();
  }
  return fontsLoading;
}

/** True when a scene's source uses the sketch look or an Excalidraw drawing (then the fonts load). */
export const usesSketch = (src: string) => /\bs-(?:box|circle|ellipse|diamond|text)\b|fx\.sketch|font-sketch|x-draw|\.excalidraw/.test(src);

// ── the module ──

type PendingMark = { ghost: SVGPathElement; at: number; seconds: number; stroke: string; width: number; head: boolean; dashed: boolean; loop: boolean; exits: number[] };

const list = (els: unknown): HTMLElement[] => (Array.isArray(els) ? els : els ? [els] : []).filter((e): e is HTMLElement => e instanceof Element) as HTMLElement[];

type FxFn = (...args: unknown[]) => unknown;

export const sketch: KitModule = {
  name: "sketch",
  css: `
.scene-root {
  --font-sketch: "Virgil", "Excalifont", var(--font-hand, cursive), cursive;
  --font-sketch-new: "Excalifont", "Virgil", var(--font-hand, cursive), cursive;
  --s-ink: #1e1e1e; --s-red: #e03131; --s-green: #2f9e44; --s-blue: #1971c2; --s-orange: #f08c00; --s-violet: #6741d9; --s-grey: #868e96;
  --s-fill-blue: #a5d8ff; --s-fill-yellow: #ffec99; --s-fill-green: #b2f2bb; --s-fill-red: #ffc9c9; --s-fill-violet: #d0bfff;
  --s-fill-orange: #ffd8a8; --s-fill-grey: #e9ecef; --s-fill-pink: #fcc2d7; --s-fill-teal: #96f2d7;
}
.s-box, .s-circle, .s-ellipse, .s-diamond {
  position: relative; isolation: isolate; box-sizing: border-box; border: 1px solid transparent;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center;
  font-family: var(--font-sketch); font-size: 30px; line-height: 1.2; color: var(--s-ink); padding: 18px 26px;
}
.s-circle { aspect-ratio: 1; border-radius: 50%; padding: 18px; }
.s-ellipse { border-radius: 50%; padding: 20px 38px; }
.s-diamond { padding: 30px 52px; }
.s-text { font-family: var(--font-sketch); color: var(--s-ink); }
.s-ink { overflow: visible; }
.s-ghost { stroke: transparent !important; fill: transparent !important; }
`,
  async load(bundle, assets) {
    const srcs = bundle.scenes.map((s) => s.source || "").join("\n");
    return usesSketch(srcs) ? loadSketchFonts(assets) : [];
  },
  prepare(ctx) {
    for (const el of Array.from(ctx.cam.querySelectorAll<HTMLElement>(".s-box, .s-circle, .s-ellipse, .s-diamond"))) {
      if (sketchOf(el)) continue;
      sketchify(el, ctx, shapeOfClass(el) ?? "box", optsOf(el));
    }
  },
  make(ctx) {
    const { tl } = ctx;
    const fx = ctx.fx as Record<string, FxFn>;
    const marks: PendingMark[] = [];
    const byGhost = new Map<Element, PendingMark>();

    /** draws a set of paths on: strokes along their length (dashed ones fade, a dash pattern can't be drawn), fills after */
    const drawOn = (parts: RoughParts, at: number, seconds: number, dashed: boolean) => {
      const d1 = seconds * 0.62;
      for (const p of parts.lines) {
        if (dashed) tl.fromTo(p, { opacity: 0 }, { opacity: 1, duration: d1, ease: "power1.out" }, at);
        else tl.fromTo(p, { drawSVG: "0%" }, { drawSVG: "100%", duration: d1, ease: "power1.inOut" }, at);
      }
      for (const p of parts.fills) {
        if (p.classList.contains("s-hatch")) tl.fromTo(p, { drawSVG: "0%" }, { drawSVG: "100%", duration: Math.max(0.2, seconds * 0.45), ease: "none" }, at + d1 * 0.7);
        else tl.fromTo(p, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power1.out" }, at + d1 * 0.7);
      }
    };

    // The hand-drawn versions of fx.link arrows and fx.circle loops are drawn once the script has run, from the
    // routes as they finally stand (a reply link moves the first link of its pair aside).
    const flush = () => {
      for (const m of marks) {
        const svg = m.ghost.ownerSVGElement;
        if (!svg) continue;
        let len = 0;
        try {
          len = m.ghost.getTotalLength();
        } catch {
          continue;
        }
        if (!(len > 2)) continue;
        const pt = (s: number) => {
          const q = m.ghost.getPointAtLength(Math.max(0, Math.min(len, s)));
          return [q.x, q.y] as [number, number];
        };
        const d = m.ghost.getAttribute("d") || "";
        const straight = !m.loop && !/[CcQqSsTtAa]/.test(d);
        const g = svgEl("g", { class: m.loop ? "s-loop" : "s-link", "data-kit": "sketch", "data-for": m.ghost.getAttribute("data-id") || "" });
        const seed = roughSeed(ctx.seed(`mark:${m.ghost.getAttribute("data-id") || len.toFixed(1)}`));
        const ro: Options = {
          seed,
          roughness: m.loop ? 1.3 : 1.1,
          bowing: 1,
          stroke: m.stroke,
          strokeWidth: m.width,
          preserveVertices: true,
          disableMultiStroke: m.dashed,
          strokeLineDash: m.dashed ? [12, 10 + m.width] : undefined,
        };
        const steps = Math.max(8, Math.min(60, Math.round(len / 18)));
        const body = straight ? gen.line(...pt(0), ...pt(len), ro) : gen.curve(Array.from({ length: steps + 1 }, (_, k) => pt((len * k) / steps)), ro);
        const lines = roughPaths(body, g);
        const head: RoughParts = { lines: [], fills: [] };
        if (m.head) {
          const [ex, ey] = pt(len);
          const [bx, by] = pt(len - Math.min(16, len * 0.3));
          const ang = Math.atan2(ey - by, ex - bx);
          const size = Math.min(24, len * 0.35);
          for (const [k, turn] of [
            [1, 0.5],
            [2, -0.5],
          ] as const) {
            const arm = gen.line(ex, ey, ex - size * Math.cos(ang + turn), ey - size * Math.sin(ang + turn), { ...ro, seed: seed + k, roughness: 0.8, strokeLineDash: undefined, disableMultiStroke: false });
            const p = roughPaths(arm, g);
            head.lines.push(...p.lines);
          }
        }
        svg.appendChild(g);
        const mask = m.ghost.getAttribute("mask"); // fx.cut's gap shows in the drawn line too
        if (mask) g.setAttribute("mask", mask);
        drawOn(lines, m.at, m.seconds, m.dashed);
        for (const p of head.lines) {
          gsap.set(p, { autoAlpha: 0 });
          tl.set(p, { autoAlpha: 0 }, 0);
          tl.set(p, { autoAlpha: 1 }, m.at + m.seconds * 0.9);
          tl.fromTo(p, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.12, ease: "power2.out" }, m.at + m.seconds * 0.9);
        }
        for (const t of m.exits) tl.to(g, { autoAlpha: 0, duration: 0.32, ease: "power1.in" }, t);
      }
    };

    // fx.finish and fx.exit pass through the hand-drawn marks (wrapped in place, so other modules' wrappers chain)
    const finish = fx.finish;
    fx.finish = function (this: unknown, ...a: unknown[]) {
      flush();
      return finish.apply(this, a);
    };
    const exit = fx.exit;
    fx.exit = function (this: unknown, els: unknown, at: unknown, ...rest: unknown[]) {
      for (const el of list(els)) byGhost.get(el)?.exits.push(Number(at));
      return exit.call(this, els, at, ...rest);
    };

    const ghostOf = (path: SVGPathElement) => {
      path.classList.add("s-ghost");
      const tip = (path as unknown as { __tip?: SVGPathElement }).__tip;
      tip?.classList.add("s-ghost");
    };

    return {
      /** Draws an element as an Excalidraw shape now (one made by the script, or to change its look). */
      sketch(el: HTMLElement, opts: SketchOpts & { shape?: SketchShape } = {}) {
        return sketchify(el, ctx, opts.shape ?? shapeOfClass(el) ?? "box", { ...optsOf(el), ...opts });
      },
      /** Draws sketched shapes on: the outline along its length, then the fill, then the words inside. */
      sketchIn(els: Element | Element[], at: number, seconds = 0.8) {
        const all = list(els);
        for (const el of all) {
          if (!sketchOf(el)) sketchify(el, ctx, shapeOfClass(el) ?? "box", optsOf(el));
          const s = sketchOf(el)!;
          gsap.set(el, { autoAlpha: 0 });
          tl.set(el, { autoAlpha: 0 }, 0);
          tl.set(el, { autoAlpha: 1 }, at);
          drawOn(s, at, seconds, s.dashed);
          const kids = Array.from(el.children).filter((c) => c !== s.svg);
          if (kids.length) tl.fromTo(kids, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: "power1.out" }, at + seconds * 0.55);
        }
        ctx.mark("sketchIn", all, at);
        ctx.sound("pencil", at, 0.6);
      },
      /**
       * A hand-drawn arrow between two elements: fx.link's route (facing sides, straight unless something is
       * in the way, a reply beside the request), drawn in rough strokes with an Excalidraw arrowhead. Returns
       * fx.link's path, which fx.flow, fx.cut and fx.exit use. opts: bend, seconds (0.5), color (a stroke name),
       * head (true), dashed.
       */
      sketchLink(a: Element, b: Element, at: number, opts: { bend?: number; seconds?: number; color?: string; head?: boolean; dashed?: boolean; width?: number } = {}) {
        const seconds = Math.max(0.05, Number(opts.seconds ?? 0.5) || 0.5);
        const ghost = fx.link(a, b, at, { bend: opts.bend, seconds }) as SVGPathElement;
        ghostOf(ghost);
        const m: PendingMark = {
          ghost,
          at,
          seconds,
          stroke: colourOf(opts.color, SKETCH_STROKES, SKETCH_STROKES.ink),
          width: Number(opts.width) || 2.6,
          head: opts.head !== false,
          dashed: !!opts.dashed,
          loop: false,
          exits: [],
        };
        marks.push(m);
        byGhost.set(ghost, m);
        ctx.sound("pencil", at, 0.5);
        return ghost;
      },
      /** A hand-drawn loop round an element (fx.circle's loop and clearances, drawn rough). opts.color: red by default. */
      sketchCircle(els: Element | Element[], at: number, seconds = 0.6, opts: { color?: string; width?: number } = {}) {
        const made = fx.circle(els, at, seconds) as SVGPathElement | SVGPathElement[];
        for (const ghost of Array.isArray(made) ? made : [made]) {
          ghostOf(ghost);
          const m: PendingMark = { ghost, at, seconds, stroke: colourOf(opts.color, SKETCH_STROKES, SKETCH_STROKES.red), width: Number(opts.width) || 3.2, head: false, dashed: false, loop: true, exits: [] };
          marks.push(m);
          byGhost.set(ghost, m);
        }
        return made;
      },
    };
  },
};
