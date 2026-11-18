// The user's own Excalidraw drawings (kit/excalidraw.ts): a .excalidraw file from the video's assets drawn
// on the page as Excalidraw draws it, then drawn in stroke by stroke on the narration's cues.
//
// Markup: <div class="x-draw" data-id="arch" data-src="asset://architecture.excalidraw"></div>, sized by the
// scene's CSS (without a height it takes the drawing's own proportions). The drawing is scaled to fit.
//
// Each element is drawn with rough.js and its own seed, roughness, stroke width and style, fill and colours,
// following Excalidraw's renderer (packages/excalidraw/scene/Shape.ts): rectangles (rounded too), ellipses,
// diamonds, lines and arrows (straight, curved, elbow; every arrowhead), freehand strokes (perfect-freehand,
// with Excalidraw's settings), text (its fonts and metrics, alignment, labels inside boxes and on arrows),
// embedded images and frames. The SVG is marked data-kit="excalidraw" (the chart check skips it) and
// data-kit-uncounted (its words are the user's own layout, not counted toward the words on screen).
//
// fx.drawIn(el, at, opts) draws the elements in, in drawing order by default (opts.order "x" or "y"), arrows
// after what they join and labels right after their box; fx.drawPart(el, key, at) draws one part on its own
// cue (an element id, a group id, a frame, or the words it shows); fx.drawingPart(el, key) finds a part
// without drawing it (for fx.focus or fx.circle). Parts no call draws stay on the page from the start.

import { gsap } from "gsap";
import { getStroke } from "perfect-freehand";
import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";

import { svgEl } from "../geometry";
import { loadSketchFonts, roughPaths, roughSeed, roundedRect, type RoughParts } from "./sketch";
import type { KitCtx, KitModule } from "./types";

type Pt = [number, number];

/** The parts of an Excalidraw element this renderer reads (the file format's own names). */
type XEl = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  groupIds?: string[];
  frameId?: string | null;
  roundness?: { type: number; value?: number } | null;
  seed?: number;
  isDeleted?: boolean;
  points?: Pt[];
  pressures?: number[];
  simulatePressure?: boolean;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  elbowed?: boolean;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  text?: string;
  originalText?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  lineHeight?: number;
  containerId?: string | null;
  fileId?: string | null;
  scale?: [number, number];
  crop?: { x: number; y: number; width: number; height: number; naturalWidth: number; naturalHeight: number } | null;
  name?: string | null;
};

type XDoc = { elements: XEl[]; files?: Record<string, { dataURL?: string; mimeType?: string }> };

type Part = {
  id: string;
  e: XEl;
  /** the outer group: placed, turned, and shown or hidden as it is drawn in */
  g: SVGGElement;
  kind: "stroke" | "text" | "image" | "free" | "frame";
  lines: SVGPathElement[];
  fills: SVGPathElement[];
  heads: SVGPathElement[];
  dashed: boolean;
  /** text: the clip that writes it on, and its full width */
  clip?: SVGRectElement;
  clipW?: number;
  /** a freehand stroke: the mask line that draws it on */
  mask?: SVGPathElement;
  box: [number, number, number, number];
  /** the words it shows: its own (text) or its bound label's (a box, an arrow) */
  text: string;
  labels: Part[];
};

type Plan = { kind: "in"; at: number; opts: DrawInOpts } | { kind: "part"; at: number; parts: Part[]; seconds?: number };
type DrawInOpts = { order?: "z" | "x" | "y"; seconds?: number; each?: number; only?: string[]; except?: string[] };
type Drawing = { name: string; el: HTMLElement; svg: SVGSVGElement; parts: Part[]; plans: Plan[] };

const gen = rough.generator();

/** Excalidraw's font families (FONT_FAMILY) with their metrics (FONT_METADATA), for placing each line of text. */
const FAMILIES: Record<number, { css: string; m: { em: number; asc: number; desc: number; lh: number } }> = {
  1: { css: '"Virgil", "Excalifont", cursive', m: { em: 1000, asc: 886, desc: -374, lh: 1.25 } },
  2: { css: 'Helvetica, Arial, "Liberation Sans", sans-serif', m: { em: 2048, asc: 1577, desc: -471, lh: 1.15 } },
  3: { css: '"Cascadia", "Cascadia Code", Consolas, monospace', m: { em: 2048, asc: 1900, desc: -480, lh: 1.2 } },
  5: { css: '"Excalifont", "Virgil", cursive', m: { em: 1000, asc: 886, desc: -374, lh: 1.25 } },
  6: { css: '"Nunito", Arial, sans-serif', m: { em: 1000, asc: 1011, desc: -353, lh: 1.35 } },
  7: { css: '"Lilita One", Arial, sans-serif', m: { em: 1000, asc: 923, desc: -220, lh: 1.15 } },
  8: { css: '"Comic Shanns", "Cascadia", monospace', m: { em: 1000, asc: 750, desc: -250, lh: 1.25 } },
  9: { css: '"Liberation Sans", Arial, sans-serif', m: { em: 2048, asc: 1854, desc: -434, lh: 1.15 } },
};

const transparent = (c?: string | null) => !c || c === "transparent" || /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(c);

/** Excalidraw's adjustRoughness: a small shape is drawn less rough, or it would be a scribble. */
function roughnessOf(e: XEl): number {
  const r = Number(e.roughness ?? 1);
  const max = Math.max(Math.abs(e.width), Math.abs(e.height));
  const min = Math.min(Math.abs(e.width), Math.abs(e.height));
  if ((min >= 20 && max >= 50) || min >= 15 || e.elbowed) return r;
  return Math.min(r / (max < 10 ? 3 : 2), 2.5);
}

const isLoop = (pts: Pt[]) => pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= 8;

/** Excalidraw's generateRoughOptions. */
function roughOptions(e: XEl, continuous = false): Options {
  const sw = Number(e.strokeWidth) || 1;
  const solid = (e.strokeStyle ?? "solid") === "solid";
  const seed = Number.isInteger(e.seed) && (e.seed as number) > 0 && (e.seed as number) < 2 ** 31 ? (e.seed as number) : roughSeed(hash(e.id));
  const o: Options = {
    seed,
    strokeLineDash: e.strokeStyle === "dashed" ? [8, 8 + sw] : e.strokeStyle === "dotted" ? [1.5, 6 + sw] : undefined,
    disableMultiStroke: !solid,
    strokeWidth: solid ? sw : sw + 0.5,
    fillWeight: sw / 2,
    hachureGap: sw * 4,
    roughness: roughnessOf(e),
    stroke: e.strokeColor || "#1e1e1e",
    preserveVertices: continuous || Number(e.roughness ?? 1) < 2,
  };
  if (["rectangle", "diamond", "ellipse", "iframe", "embeddable"].includes(e.type)) {
    o.fillStyle = e.fillStyle || "hachure";
    o.fill = transparent(e.backgroundColor) ? undefined : e.backgroundColor;
    if (e.type === "ellipse") o.curveFitting = 1;
  } else if ((e.type === "line" || e.type === "freedraw") && isLoop(e.points ?? [])) {
    o.fillStyle = e.fillStyle || "hachure";
    o.fill = transparent(e.backgroundColor) ? undefined : e.backgroundColor;
  }
  return o;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Excalidraw's getCornerRadius. */
function cornerRadius(x: number, e: XEl): number {
  const t = e.roundness?.type;
  if (t === 1 || t === 2) return x * 0.25;
  if (t === 3) {
    const fixed = e.roundness?.value ?? 32;
    return x <= fixed / 0.25 ? x * 0.25 : fixed;
  }
  return 0;
}

/** The arrowhead's points (Excalidraw's getArrowheadPoints): the tip, then the head's other corners. */
function headPoints(e: XEl, kind: string, tip: Pt, from: Pt, position: "start" | "end"): number[] | null {
  const pts = e.points ?? [];
  const [x2, y2] = tip;
  const [x1, y1] = from;
  const dist = Math.hypot(x2 - x1, y2 - y1);
  if (!(dist > 0)) return null;
  const nx = (x2 - x1) / dist;
  const ny = (y2 - y1) / dist;
  const size = kind === "arrow" ? 25 : kind.startsWith("diamond") ? 12 : kind.startsWith("crowfoot") ? 20 : 15;
  const [cx, cy] = position === "end" ? pts[pts.length - 1] : pts[0];
  const [px, py] = pts.length > 1 ? (position === "end" ? pts[pts.length - 2] : pts[1]) : [0, 0];
  const segment = Math.hypot(cx - px, cy - py);
  const min = Math.min(size, segment * (kind.startsWith("diamond") ? 0.25 : 0.5));
  const xs = x2 - nx * min;
  const ys = y2 - ny * min;
  if (kind === "dot" || kind.startsWith("circle")) return [x2, y2, Math.hypot(ys - y2, xs - x2) + (Number(e.strokeWidth) || 1) - 2];
  const deg = kind === "bar" ? 90 : kind === "arrow" ? 20 : 25;
  const rot = (p: Pt, c: Pt, a: number): Pt => [(p[0] - c[0]) * Math.cos(a) - (p[1] - c[1]) * Math.sin(a) + c[0], (p[0] - c[0]) * Math.sin(a) + (p[1] - c[1]) * Math.cos(a) + c[1]];
  const [x3, y3] = rot([xs, ys], [x2, y2], (-deg * Math.PI) / 180);
  const [x4, y4] = rot([xs, ys], [x2, y2], (deg * Math.PI) / 180);
  if (kind.startsWith("diamond")) {
    const [ox, oy] =
      position === "start"
        ? rot([x2 + min * 2, y2], [x2, y2], Math.atan2((pts[1]?.[1] ?? 0) - y2, (pts[1]?.[0] ?? 0) - x2))
        : rot([x2 - min * 2, y2], [x2, y2], Math.atan2(y2 - (pts[pts.length - 2]?.[1] ?? 0), x2 - (pts[pts.length - 2]?.[0] ?? 0)));
    return [x2, y2, x3, y3, ox, oy, x4, y4];
  }
  return [x2, y2, x3, y3, x4, y4];
}

/** The point a curve's end leaves from (the last Bezier's second control point), for the head's direction. */
function curveEndDir(body: Drawable, end: "start" | "end", fallback: Pt): Pt {
  const ops = body.sets[0]?.ops ?? [];
  if (end === "end") {
    for (let k = ops.length - 1; k >= 0; k--) if (ops[k].op === "bcurveTo") return [ops[k].data[2], ops[k].data[3]];
  } else {
    for (const op of ops) if (op.op === "bcurveTo") return [op.data[0], op.data[1]];
  }
  return fallback;
}

/** perfect-freehand's outline as a path (Excalidraw's getSvgPathFromStroke). */
function strokePath(points: number[][]): string {
  if (!points.length) return "";
  const med = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const out: (string | number[])[] = ["M", points[0], "Q"];
  points.forEach((p, i) => {
    if (i === points.length - 1) out.push(p, med(p, points[0]), "L", points[0], "Z");
    else out.push(p, med(p, points[i + 1]));
  });
  return out.map((x) => (typeof x === "string" ? x : `${x[0].toFixed(2)},${x[1].toFixed(2)}`)).join(" ");
}

/** An element's box in drawing units, turned with it (the box of its turned corners). */
function boxOf(e: XEl): [number, number, number, number] {
  const pts = e.points ?? [];
  let lx = 0;
  let ly = 0;
  let w = Math.abs(e.width || 0);
  let h = Math.abs(e.height || 0);
  if (["line", "arrow", "freedraw"].includes(e.type) && pts.length) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    lx = Math.min(...xs);
    ly = Math.min(...ys);
    w = Math.max(...xs) - lx;
    h = Math.max(...ys) - ly;
  }
  const x0 = e.x + lx;
  const y0 = e.y + ly;
  const a = Number(e.angle) || 0;
  if (!a) return [x0, y0, w, h];
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const corners: Pt[] = [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ].map(([x, y]) => [(x - cx) * Math.cos(a) - (y - cy) * Math.sin(a) + cx, (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a) + cy]);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/** Draws one element in its own group (local units, placed and turned as Excalidraw places it). */
function drawElement(e: XEl, doc: XDoc, svg: SVGSVGElement, defs: SVGDefsElement, uid: string): Part | null {
  const outer = svgEl("g", { class: "x-el", "data-x-id": e.id, "data-x-type": e.type });
  const inner = svgEl("g", {});
  if (Number.isFinite(e.opacity) && (e.opacity as number) < 100) inner.setAttribute("opacity", String(Math.max(0, (e.opacity as number) / 100)));
  outer.appendChild(inner);
  const w = e.width || 0;
  const h = e.height || 0;
  const pts = (e.points ?? []).filter((p) => Array.isArray(p) && p.length >= 2) as Pt[];
  // the turn's centre, in local units (a line's is the middle of its points' box)
  let cx = w / 2;
  let cy = h / 2;
  if (["line", "arrow", "freedraw"].includes(e.type) && pts.length) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  const a = Number(e.angle) || 0;
  outer.setAttribute("transform", `translate(${e.x} ${e.y})` + (a ? ` rotate(${((a * 180) / Math.PI).toFixed(3)} ${cx} ${cy})` : ""));
  const part: Part = { id: e.id, e, g: outer, kind: "stroke", lines: [], fills: [], heads: [], dashed: (e.strokeStyle ?? "solid") !== "solid", box: boxOf(e), text: "", labels: [] };
  const add = (d: Drawable, into: "body" | "head" = "body") => {
    const p = roughPaths(d, inner);
    if (into === "head") part.heads.push(...p.lines, ...p.fills);
    else {
      part.lines.push(...p.lines);
      part.fills.push(...p.fills);
    }
  };

  if (e.type === "rectangle" || e.type === "iframe" || e.type === "embeddable") {
    if (e.roundness) add(gen.path(roundedRect(0, 0, w, h, cornerRadius(Math.min(w, h), e)), roughOptions(e, true)));
    else add(gen.rectangle(0, 0, w, h, roughOptions(e)));
  } else if (e.type === "ellipse") {
    add(gen.ellipse(w / 2, h / 2, w, h, roughOptions(e)));
  } else if (e.type === "diamond") {
    const [tx, ty, rx, ry, bx, by, lx, ly] = [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2];
    if (e.roundness) {
      const vr = cornerRadius(Math.abs(tx - lx), e);
      const hr = cornerRadius(Math.abs(ry - ty), e);
      add(
        gen.path(
          `M ${tx + vr} ${ty + hr} L ${rx - vr} ${ry - hr} C ${rx} ${ry}, ${rx} ${ry}, ${rx - vr} ${ry + hr} L ${bx + vr} ${by - hr} C ${bx} ${by}, ${bx} ${by}, ${bx - vr} ${by - hr} L ${lx + vr} ${ly + hr} C ${lx} ${ly}, ${lx} ${ly}, ${lx + vr} ${ly - hr} L ${tx - vr} ${ty + hr} C ${tx} ${ty}, ${tx} ${ty}, ${tx + vr} ${ty + hr}`,
          roughOptions(e, true),
        ),
      );
    } else
      add(
        gen.polygon(
          [
            [tx, ty],
            [rx, ry],
            [bx, by],
            [lx, ly],
          ],
          roughOptions(e),
        ),
      );
  } else if (e.type === "line" || e.type === "arrow") {
    if (pts.length < 2) return null;
    const o = roughOptions(e);
    const curved = !!e.roundness && !e.elbowed;
    const body = curved ? gen.curve(pts, o) : isLoop(pts) && o.fill ? gen.polygon(pts, o) : gen.linearPath(pts, o);
    add(body);
    if (e.type === "arrow") {
      for (const [position, kind] of [
        ["start", e.startArrowhead],
        ["end", e.endArrowhead],
      ] as const) {
        if (!kind) continue;
        const tip = position === "end" ? pts[pts.length - 1] : pts[0];
        const near = position === "end" ? pts[pts.length - 2] : pts[1];
        const from = curved ? curveEndDir(body, position, near) : near;
        const hp = headPoints(e, kind, tip, from, position);
        if (!hp) continue;
        // a head is drawn solid even on a dashed line (as Excalidraw does)
        const ho: Options = { ...o, strokeLineDash: undefined, disableMultiStroke: false, fill: undefined };
        const ink = e.strokeColor || "#1e1e1e";
        const bg = transparent(e.backgroundColor) ? undefined : e.backgroundColor;
        if (kind === "arrow") {
          add(gen.line(hp[2], hp[3], hp[0], hp[1], ho), "head");
          add(gen.line(hp[4], hp[5], hp[0], hp[1], ho), "head");
        } else if (kind === "bar") {
          add(gen.line(hp[2], hp[3], hp[4], hp[5], ho), "head");
        } else if (kind === "dot" || kind.startsWith("circle")) {
          const fill = kind === "dot" || kind === "circle" ? ink : bg;
          add(gen.circle(hp[0], hp[1], hp[2], { ...ho, fill, fillStyle: "solid" }), "head");
        } else if (kind.startsWith("triangle")) {
          add(
            gen.polygon(
              [
                [hp[0], hp[1]],
                [hp[2], hp[3]],
                [hp[4], hp[5]],
              ],
              { ...ho, fill: kind === "triangle" ? ink : bg, fillStyle: "solid" },
            ),
            "head",
          );
        } else if (kind.startsWith("diamond")) {
          add(
            gen.polygon(
              [
                [hp[0], hp[1]],
                [hp[2], hp[3]],
                [hp[4], hp[5]],
                [hp[6], hp[7]],
              ],
              { ...ho, fill: kind === "diamond" ? ink : bg, fillStyle: "solid" },
            ),
            "head",
          );
        } else {
          add(gen.line(hp[2], hp[3], hp[0], hp[1], ho), "head");
          add(gen.line(hp[4], hp[5], hp[0], hp[1], ho), "head");
        }
      }
    }
  } else if (e.type === "freedraw") {
    if (!pts.length) return null;
    const sw = Number(e.strokeWidth) || 1;
    const input = e.simulatePressure ? pts : pts.map((p, i) => [p[0], p[1], e.pressures?.[i] ?? 0.5]);
    const outline = getStroke(input, { simulatePressure: !!e.simulatePressure, size: sw * 4.25, thinning: 0.6, smoothing: 0.5, streamline: 0.5, easing: (t: number) => Math.sin((t * Math.PI) / 2), last: true });
    const path = svgEl("path", { d: strokePath(outline), fill: e.strokeColor || "#1e1e1e", class: "s-fill s-solid" });
    // drawn on along the pen's own line: a wide mask stroke over the outline
    const maskId = `${uid}-m${hash(e.id).toString(36)}`;
    const mask = svgEl("mask", { id: maskId, maskUnits: "userSpaceOnUse", x: -10000, y: -10000, width: 20000, height: 20000 });
    const line = svgEl("path", {
      d: "M " + pts.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" L "),
      fill: "none",
      stroke: "#fff",
      "stroke-width": String(sw * 4.25 * 2.2 + 4),
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    mask.appendChild(line);
    defs.appendChild(mask);
    inner.appendChild(path);
    part.kind = "free";
    part.fills.push(path);
    part.mask = line;
    path.setAttribute("mask", `url(#${maskId})`);
  } else if (e.type === "text") {
    const fam = FAMILIES[Number(e.fontFamily)] ?? FAMILIES[5];
    const size = Number(e.fontSize) || 20;
    const lh = (Number(e.lineHeight) || fam.m.lh) * size;
    const em = size / fam.m.em;
    const offset = em * fam.m.asc + (lh - em * fam.m.asc + em * fam.m.desc) / 2;
    const align = e.textAlign === "center" ? "middle" : e.textAlign === "right" ? "end" : "start";
    const x = align === "middle" ? w / 2 : align === "end" ? w : 0;
    const words = svgEl("g", {});
    const lines = String(e.text ?? "").replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((ln, i) => {
      const t = svgEl("text", { x, y: (i * lh + offset).toFixed(2), "font-family": fam.css, "font-size": String(size), fill: e.strokeColor || "#1e1e1e", "text-anchor": align, "dominant-baseline": "alphabetic", direction: "ltr" });
      t.style.whiteSpace = "pre";
      t.textContent = ln;
      words.appendChild(t);
    });
    // written on left to right through a clip that widens
    const clipId = `${uid}-c${hash(e.id).toString(36)}`;
    const clip = svgEl("clipPath", { id: clipId });
    const pad = size;
    const rect = svgEl("rect", { x: -pad, y: -pad, width: w + pad * 3, height: Math.max(h, lines.length * lh) + pad * 2 });
    clip.appendChild(rect);
    defs.appendChild(clip);
    words.setAttribute("clip-path", `url(#${clipId})`);
    inner.appendChild(words);
    part.kind = "text";
    part.clip = rect;
    part.clipW = w + pad * 3;
    part.text = (e.originalText || e.text || "").trim();
  } else if (e.type === "image") {
    const file = e.fileId ? doc.files?.[e.fileId] : undefined;
    if (file?.dataURL) {
      const [sx, sy] = Array.isArray(e.scale) ? e.scale : [1, 1];
      const holder = svgEl("g", sx < 0 || sy < 0 ? { transform: `translate(${w / 2} ${h / 2}) scale(${sx < 0 ? -1 : 1} ${sy < 0 ? -1 : 1}) translate(${-w / 2} ${-h / 2})` } : {});
      if (e.crop) {
        const c = e.crop;
        const nest = svgEl("svg", { x: 0, y: 0, width: w, height: h, viewBox: `${c.x} ${c.y} ${c.width} ${c.height}`, preserveAspectRatio: "none" });
        nest.appendChild(svgEl("image", { href: file.dataURL, width: c.naturalWidth, height: c.naturalHeight, preserveAspectRatio: "none" }));
        holder.appendChild(nest);
      } else holder.appendChild(svgEl("image", { href: file.dataURL, x: 0, y: 0, width: w, height: h, preserveAspectRatio: "none" }));
      inner.appendChild(holder);
    } else {
      // the picture isn't in the file: a dashed placeholder of its size
      add(gen.rectangle(0, 0, w, h, { seed: roughSeed(hash(e.id)), roughness: 0, stroke: "#adb5bd", strokeWidth: 2, strokeLineDash: [8, 8] }));
    }
    part.kind = "image";
  } else if (e.type === "frame" || e.type === "magicframe") {
    add(gen.path(roundedRect(0, 0, w, h, 8), { seed: roughSeed(hash(e.id)), roughness: 0, stroke: "#bbb", strokeWidth: 2, preserveVertices: true }));
    const name = svgEl("text", { x: 0, y: -6, "font-family": "Helvetica, Arial, sans-serif", "font-size": "14", fill: "#999999" });
    name.textContent = e.name || "Frame";
    inner.appendChild(name);
    part.kind = "frame";
    part.text = e.name || "";
  } else return null;
  svg.appendChild(outer);
  return part;
}

/** The asset name a data-src points at: asset://name, the resolved asset URL, or a bare file name. */
function nameOf(src: string, assetBase: string): string {
  if (src.startsWith("asset://")) return src.slice(8);
  if (src.startsWith(assetBase)) return decodeURIComponent(src.slice(assetBase.length).split("?")[0]);
  return decodeURIComponent(src.split("/").pop()?.split("?")[0] ?? src);
}

/** The .excalidraw files a scene's source asks for. */
export const drawingRefs = (src: string) => [...new Set([...src.matchAll(/asset:\/\/([A-Za-z0-9._-]+\.excalidraw)/g)].map((m) => m[1]))];

type HostEl = HTMLElement & { __drawing?: Drawing };

/** Draws a drawing into its x-draw element. */
function render(host: HTMLElement, name: string, doc: XDoc, ctx: KitCtx): Drawing {
  (host as HostEl).__drawing?.svg.remove();
  const live = (doc.elements ?? []).filter((e) => e && !e.isDeleted && typeof e.id === "string");
  const uid = `x${(ctx.seed(`drawing:${host.getAttribute("data-id") || name}`) >>> 0).toString(36)}`;
  const svg = svgEl("svg", { class: "x-svg", "data-kit": "excalidraw", "data-kit-uncounted": "", "aria-hidden": "true", preserveAspectRatio: "xMidYMid meet" });
  const defs = svgEl("defs", {});
  svg.appendChild(defs);
  const parts: Part[] = [];
  for (const e of live) {
    const p = drawElement(e, doc, svg, defs, uid);
    if (p) parts.push(p);
  }
  // a box's (or an arrow's) label belongs with it: drawn right after it, found by its words
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const p of parts) {
    const c = p.e.type === "text" && p.e.containerId ? byId.get(p.e.containerId) : undefined;
    if (c) {
      c.labels.push(p);
      c.text = [c.text, p.text].filter(Boolean).join(" ");
    }
  }
  // the view: every element's box with some air, scaled to fit the element (keeping the drawing's proportions)
  const boxes = parts.map((p) => p.box);
  const stroke = Math.max(2, ...live.map((e) => Number(e.strokeWidth) || 1));
  const pad = 10 + stroke * 2;
  const x0 = Math.min(...boxes.map((b) => b[0]), 0) - pad;
  const y0 = Math.min(...boxes.map((b) => b[1]), 0) - pad;
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]), 1) + pad;
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]), 1) + pad;
  const vb = boxes.length ? [Math.min(...boxes.map((b) => b[0])) - pad, Math.min(...boxes.map((b) => b[1])) - pad] : [x0, y0];
  const vw = (boxes.length ? Math.max(...boxes.map((b) => b[0] + b[2])) + pad : x1) - vb[0];
  const vh = (boxes.length ? Math.max(...boxes.map((b) => b[1] + b[3])) + pad : y1) - vb[1];
  svg.setAttribute("viewBox", `${vb[0].toFixed(1)} ${vb[1].toFixed(1)} ${Math.max(1, vw).toFixed(1)} ${Math.max(1, vh).toFixed(1)}`);
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  if (host.clientHeight < 4 && host.clientWidth > 4) host.style.height = `${((host.clientWidth * vh) / Math.max(1, vw)).toFixed(1)}px`;
  host.appendChild(svg);
  const d: Drawing = { name, el: host, svg, parts, plans: [] };
  (host as HostEl).__drawing = d;
  return d;
}

const drawingOf = (el: Element | null | undefined): Drawing | null => (el ? ((el as HostEl).__drawing ?? (el.closest?.(".x-draw") as HostEl | null)?.__drawing ?? null) : null);

/** The parts a key names: an element id, a group id, a frame (id or name), or words (exact first, then contained). */
function findParts(d: Drawing, key: string): Part[] {
  const k = key.trim();
  const withLabels = (ps: Part[]) => [...new Set(ps.flatMap((p) => [p, ...p.labels]))];
  const id = d.parts.find((p) => p.id === k);
  if (id) return withLabels([id]);
  const grouped = d.parts.filter((p) => (p.e.groupIds ?? []).includes(k));
  if (grouped.length) return withLabels(grouped);
  const frame = d.parts.find((p) => (p.e.type === "frame" || p.e.type === "magicframe") && (p.id === k || (p.e.name ?? "").toLowerCase() === k.toLowerCase()));
  if (frame) return withLabels([frame, ...d.parts.filter((p) => p.e.frameId === frame.id)]);
  const low = k.toLowerCase();
  // a label's words name its box: the box and the label together
  const named = (test: (t: string) => boolean) => {
    const hits = d.parts.filter((p) => p.text && test(p.text.toLowerCase()));
    const owners = hits.map((p) => (p.e.type === "text" && p.e.containerId ? d.parts.find((c) => c.id === p.e.containerId) ?? p : p));
    return withLabels([...new Set(owners)]);
  };
  const exact = named((t) => t === low);
  return exact.length ? exact : named((t) => t.includes(low));
}

/** Draws one part in: strokes along their length (dashed ones fade), then fills and heads; words written on. */
function animate(tl: gsap.core.Timeline, p: Part, t: number, dur: number) {
  gsap.set(p.g, { autoAlpha: 0 });
  tl.set(p.g, { autoAlpha: 0 }, 0);
  tl.set(p.g, { autoAlpha: 1 }, t);
  if (p.kind === "text" && p.clip) {
    tl.fromTo(p.clip, { attr: { width: 0 } }, { attr: { width: p.clipW ?? 0 }, duration: dur, ease: "none" }, t);
    return;
  }
  if (p.kind === "image" && !p.lines.length) {
    tl.fromTo(p.g, { opacity: 0 }, { opacity: 1, duration: Math.min(0.4, dur), ease: "power1.out", immediateRender: false }, t);
    return;
  }
  if (p.kind === "free" && p.mask) {
    tl.fromTo(p.mask, { drawSVG: "0%" }, { drawSVG: "100%", duration: dur, ease: "power1.inOut" }, t);
    return;
  }
  const d1 = dur * 0.72;
  for (const line of p.lines) {
    if (p.dashed) tl.fromTo(line, { opacity: 0 }, { opacity: 1, duration: d1, ease: "power1.out" }, t);
    else tl.fromTo(line, { drawSVG: "0%" }, { drawSVG: "100%", duration: d1, ease: "power1.inOut" }, t);
  }
  for (const f of p.fills) {
    if (f.classList.contains("s-hatch")) tl.fromTo(f, { drawSVG: "0%" }, { drawSVG: "100%", duration: Math.max(0.15, dur * 0.5), ease: "none" }, t + d1 * 0.65);
    else tl.fromTo(f, { opacity: 0 }, { opacity: 1, duration: 0.22, ease: "power1.out" }, t + d1 * 0.65);
  }
  for (const head of p.heads) {
    gsap.set(head, { autoAlpha: 0 });
    tl.set(head, { autoAlpha: 0 }, 0);
    tl.set(head, { autoAlpha: 1 }, t + d1);
    if (head.getAttribute("fill") === "none") tl.fromTo(head, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.12, ease: "power2.out" }, t + d1);
  }
}

/** The order fx.drawIn draws in: the drawing's own (z), left to right (x) or top to bottom (y); arrows after
 *  what they join, labels right after their box. Returns groups: a part with its labels. */
function orderOf(parts: Part[], all: Part[], order: "z" | "x" | "y"): Part[][] {
  const index = new Map(all.map((p, k) => [p.id, k]));
  const firsts = parts.filter((p) => !(p.e.type === "text" && p.e.containerId && parts.some((c) => c.id === p.e.containerId)));
  const key = (p: Part): number => {
    if (order === "x") return p.box[0] * 1e-3 + (index.get(p.id) ?? 0) * 1e-9;
    if (order === "y") return p.box[1] * 1e-3 + (index.get(p.id) ?? 0) * 1e-9;
    let k = index.get(p.id) ?? 0;
    if (p.e.type === "arrow") for (const b of [p.e.startBinding?.elementId, p.e.endBinding?.elementId]) if (b && index.has(b)) k = Math.max(k, (index.get(b) ?? 0) + 0.5);
    return k;
  };
  return firsts.sort((a, b) => key(a) - key(b)).map((p) => [p, ...p.labels.filter((l) => parts.includes(l))]);
}

export const excalidraw: KitModule = {
  name: "excalidraw",
  css: `
.x-draw { position: relative; display: block; }
.x-draw > .x-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
`,
  async load(bundle, assets) {
    const names = [...new Set(bundle.scenes.flatMap((s) => drawingRefs(s.source || "")))];
    if (!names.length) return [];
    const errors: string[] = [...(await loadSketchFonts(assets))];
    await Promise.all(
      names.map(async (name) => {
        if (assets.store.has(`doc:${name}`)) return;
        try {
          const res = await fetch(assets.assetBase + encodeURIComponent(name));
          if (!res.ok) throw new Error(res.status === 404 ? "it isn't in this video's assets (upload it)" : `${res.status} ${res.statusText}`);
          const doc = (await res.json()) as XDoc;
          if (!doc || !Array.isArray(doc.elements)) throw new Error("it has no elements (save it again from Excalidraw)");
          assets.store.set(`doc:${name}`, doc);
        } catch (err) {
          errors.push(`The drawing ${name} didn't load: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    return errors;
  },
  prepare(ctx) {
    for (const host of Array.from(ctx.cam.querySelectorAll<HTMLElement>(".x-draw"))) {
      const src = host.getAttribute("data-src") || "";
      if (!src) {
        ctx.errors.push(`Scene ${ctx.sceneId}: an x-draw element needs data-src="asset://name.excalidraw"`);
        continue;
      }
      const name = nameOf(src, ctx.assets.assetBase);
      const doc = ctx.assets.store.get(`doc:${name}`) as XDoc | undefined;
      if (!doc) {
        ctx.errors.push(`Scene ${ctx.sceneId}: no drawing ${name} (upload the .excalidraw file to this video)`);
        continue;
      }
      render(host, name, doc, ctx);
    }
  },
  make(ctx) {
    const { tl } = ctx;
    const fx = ctx.fx as Record<string, (...a: unknown[]) => unknown>;
    const drawings = new Set<Drawing>();
    const need = (el: Element, fn: string): Drawing => {
      const d = drawingOf(el);
      if (!d) throw new Error(`fx.${fn}: that element isn't an x-draw drawing (or its drawing didn't load)`);
      drawings.add(d);
      return d;
    };
    const keys = (key: string | string[]) => (Array.isArray(key) ? key : [key]).map(String).filter((k) => k.trim());
    const find = (d: Drawing, key: string | string[], fn: string) => {
      const out: Part[] = [];
      for (const k of keys(key)) {
        const hit = findParts(d, k);
        if (!hit.length) ctx.errors.push(`Scene ${ctx.sceneId}: fx.${fn}: no part "${k}" in ${d.name} (read_drawing lists its elements)`);
        out.push(...hit);
      }
      return [...new Set(out)];
    };

    // the drawing in happens once the script has run: fx.drawPart's parts first, fx.drawIn's for the rest
    const flush = () => {
      for (const d of drawings) {
        const claimed = new Set<Part>();
        for (const plan of d.plans) {
          if (plan.kind !== "part") continue;
          const groups = orderOf(plan.parts, d.parts, "z");
          const total = plan.seconds ?? Math.min(1.8, 0.45 + 0.3 * groups.length);
          const each = Math.min(0.7, Math.max(0.25, (total / Math.max(1, groups.length)) * 1.8));
          const step = groups.length > 1 ? (total - each) / (groups.length - 1) : 0;
          groups.forEach((g, k) => {
            g.forEach((p, j) => {
              if (claimed.has(p)) return;
              claimed.add(p);
              animate(tl, p, plan.at + k * step + (j ? each * 0.45 : 0), j ? each * 0.6 : each);
            });
          });
        }
        for (const plan of d.plans) {
          if (plan.kind !== "in") continue;
          const o = plan.opts;
          const only = o.only?.length ? new Set(o.only.flatMap((k) => findParts(d, k))) : null;
          const except = new Set((o.except ?? []).flatMap((k) => findParts(d, k)));
          const todo = d.parts.filter((p) => !claimed.has(p) && !except.has(p) && (!only || only.has(p)));
          const groups = orderOf(todo, d.parts, o.order ?? "z");
          if (!groups.length) continue;
          const total = Number(o.seconds) > 0 ? Number(o.seconds) : Math.min(8, Math.max(1.2, 0.4 * groups.length));
          const each = Number(o.each) > 0 ? Number(o.each) : Math.min(0.8, Math.max(0.25, (total / groups.length) * 2));
          const step = groups.length > 1 ? Math.max(0, total - each) / (groups.length - 1) : 0;
          groups.forEach((g, k) => {
            g.forEach((p, j) => {
              if (claimed.has(p)) return;
              claimed.add(p);
              animate(tl, p, plan.at + k * step + (j ? each * 0.45 : 0), j ? each * 0.6 : each);
            });
          });
        }
      }
    };
    const finish = fx.finish;
    fx.finish = function (this: unknown, ...a: unknown[]) {
      flush();
      return finish.apply(this, a);
    };

    return {
      /**
       * Draws a drawing in, element by element, from `at`: in its own order by default (opts.order "x" left to
       * right, "y" top to bottom), arrows after what they join, each label right after its box. opts.seconds is
       * the whole drawing-in (0.4 s an element, 1.2 to 8 s), opts.each one element's; opts.only and opts.except
       * take ids, group ids, frames or words. Parts fx.drawPart draws on their own cues are left to it.
       */
      drawIn(el: Element, at: number, opts: DrawInOpts = {}) {
        const d = need(el, "drawIn");
        d.plans.push({ kind: "in", at, opts });
        ctx.mark("drawIn", [el], at);
        ctx.sound("pencil", at, 0.6);
      },
      /** Draws one part on its own cue: an element id, a group id, a frame, or the words it shows (a box by its
       *  label). Returns the part's SVG groups, for fx.focus or fx.circle. opts.seconds: the part's drawing-in. */
      drawPart(el: Element, key: string | string[], at: number, opts: { seconds?: number } = {}) {
        const d = need(el, "drawPart");
        const parts = find(d, key, "drawPart");
        if (parts.length) d.plans.push({ kind: "part", at, parts, seconds: Number(opts.seconds) > 0 ? Number(opts.seconds) : undefined });
        const gs = parts.map((p) => p.g);
        ctx.mark("drawPart", gs, at);
        ctx.sound("pencil", at, 0.5);
        return gs;
      },
      /** A part's SVG groups without drawing anything (for fx.focus or fx.circle on a part drawn some other way). */
      drawingPart(el: Element, key: string | string[]) {
        const d = need(el, "drawingPart");
        return find(d, key, "drawingPart").map((p) => p.g);
      },
    };
  },
};

export type { RoughParts };
