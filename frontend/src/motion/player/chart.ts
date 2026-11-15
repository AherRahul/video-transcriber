// Charts: fx.chart(el, spec, at, opts) draws a real chart inside an empty element that the scene's CSS has
// placed and sized (class "p-chart"). Claude used to hand-draw charts (an L-shaped path for the axes and a
// polyline for the data, nothing labelled), which read as empty; this makes the standard parts automatic:
//   - the axes in ink with tick marks and tick labels, both axis titles (the unit in brackets), light
//     horizontal gridlines;
//   - a line chart's series drawn on along their lines, with dots at the points and each series named at
//     its end in its own colour (a small legend when the names would collide);
//   - a bar chart's bars growing from the baseline with their value on top;
//   - marks: a dashed pen-red line at an x value with its label (an event: "feed breaks");
//   - a small "illustrative numbers" tag, for numbers that only show a shape.
//
// Layout: the element's content box is the chart. Every label is measured first (the fonts have loaded
// before scenes build), the margins come from those sizes, so no word leaves the element, and each label
// that floats (a series name, a mark, the note) is put where it crosses no line and no other label.
//
// The layout report: the worded labels (axis titles, series names, mark labels, the note, the legend)
// carry their own data-ids, so diagnose checks their size, overlaps and spacing; the numbers (tick labels,
// bar values) are the chart element's own text, which the word count skips (like code on a code card).
//
// Motion: every piece is a tween or a set on the scene's paused timeline (draw, fade, grow), never a
// callback, so seeking to any frame from either direction gives the same picture.

import { gsap } from "gsap";

import { restBox, svgEl, type Box } from "./geometry";

/** A tick: a value (labelled with the number), a category name, or a value with its own label. */
type Tick = number | string | [number, string];

export type ChartAxis = {
  label?: string;
  unit?: string;
  min?: number;
  max?: number;
  ticks?: Tick[];
  /** a category axis (a bar chart's x): the names, in order */
  categories?: string[];
};

export type ChartSeries = {
  name?: string;
  /** a name (ink, slate, pen, pass, fail, blue, green, orange, pink, sky, lemon, mint, peach) or any CSS colour */
  color?: string;
  /** a line's points [x, y]; x may be a category name on a category axis */
  points?: [number | string, number][];
  /** a bar series' values, aligned to the categories */
  values?: number[];
  /** a bar series: one colour per category (to pick out one bar) */
  colors?: string[];
  /** when this series draws on (default: just after the axes); its own cue for a later series */
  at?: number;
  /** how long it takes to draw on (a line 1.0 s, a bar 0.5 s) */
  seconds?: number;
};

export type ChartMark = { x: number | string; label?: string; at?: number };

export type ChartSpec = {
  type?: "line" | "bar";
  x?: ChartAxis;
  y?: ChartAxis;
  series: ChartSeries[];
  marks?: ChartMark[];
  /** 'illustrative' (or true) for the "illustrative numbers" tag; any other words are shown as they are */
  note?: string | boolean;
};

export type ChartHandle = {
  svg: SVGSVGElement;
  /** an x value (a number, or a category's name or index) to stage px */
  x: (v: number | string) => number;
  /** a y value to stage px */
  y: (v: number) => number;
  /** per series: the line's path (for fx.flow, fx.circle) or the group of its bars */
  series: SVGGraphicsElement[];
  /** per bar series: its bars, in category order (empty for a line chart) */
  bars: SVGRectElement[][];
  /** per mark: the group of its dashed line and label */
  marks: SVGGElement[];
};

/** What the chart needs from fx. */
export type ChartCtx = {
  tl: gsap.core.Timeline;
  cam: HTMLElement;
  stageW: number;
  /** the smallest text the layout report accepts on this stage (22 px on the 1600 x 900 paper page) */
  minText: number;
  sound: (name: string, at: number, gain?: number) => void;
  mark: (kind: string, els: Element[], at: number) => void;
  freshId: (base: string) => string;
};

// ── colours ──

/** Strokes (lines, legend keys, series names): strong colours only, so a line and its name read on the
 *  pale paper. A tint name gives its strong partner (a 'sky' line is blue). */
const STRONG: Record<string, string> = {
  ink: "var(--ink)",
  slate: "var(--c-ink-2, var(--muted))",
  pen: "var(--c-pen, var(--accent2))",
  red: "var(--c-fail, #dc2626)",
  pass: "var(--c-pass, #16a34a)",
  fail: "var(--c-fail, #dc2626)",
  blue: "#2563eb",
  sky: "#2563eb",
  green: "#059669",
  mint: "#059669",
  orange: "#ea580c",
  peach: "#ea580c",
  pink: "#db2777",
  lemon: "#a16207",
  yellow: "#a16207",
};
/** Bar fills: the paper tints (with an ink edge, like the cards); a strong name fills with its colour. */
const TINT: Record<string, string> = {
  sky: "var(--c-sky, #bfdbfe)",
  lemon: "var(--c-lemon, #fef08a)",
  mint: "var(--c-mint, #bbf7d0)",
  pink: "var(--c-pink, #fbcfe8)",
  peach: "var(--c-peach, #fed7aa)",
};
/** Series without a colour take these in order, never cycled into look-alikes. */
const LINE_ORDER = ["ink", "blue", "pen", "orange", "pink"];
const BAR_ORDER = ["sky", "peach", "mint", "lemon", "pink"];

const strokeOf = (c: string) => STRONG[c] ?? c;
const fillOf = (c: string) => TINT[c] ?? STRONG[c] ?? c;

// ── numbers ──

const r1 = (n: number) => (Math.round(n * 10) / 10).toString();
const clean = (v: number) => Number(v.toPrecision(12));

/**
 * A scale about a fixed point as a transform attribute, for growing a bar, a mark's line or a dot. Tweened
 * as an attribute string (GSAP moves each number in it), never as GSAP's own scale: its svgOrigin is worked
 * out again from the element's current transform whenever the tween starts, so the frame came out a hair
 * different depending on the order frames were asked for. The element is still drawn at full size, so
 * anything that measures it (fx.circle, fx.focus) sees all of it.
 */
const scaleAbout = (x: number, y: number, sx: number, sy: number) => `translate(${r1(x)} ${r1(y)}) scale(${sx} ${sy}) translate(${r1(-x)} ${r1(-y)})`;

/** One number style for an axis and the values on its bars: in full (1,250, at most two decimals) until the
 *  axis reaches ten thousand, then in K (12.5K) or, from a million, in M, for every number on it, so an
 *  axis never mixes 5,000 with 10K. */
function formatter(maxAbs: number): (v: number) => string {
  const short = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
  if (maxAbs >= 1e6) return (v) => (v === 0 ? "0" : short(v / 1e6) + "M");
  if (maxAbs >= 1e4) return (v) => (v === 0 ? "0" : short(v / 1e3) + "K");
  return (v) => v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** A round step that splits `span` into about `count` parts (1, 2, 2.5 or 5 times a power of ten). */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

type TickMark = { v: number; label: string };

/** A value axis: its domain and labelled ticks, from the spec or worked out from the data (a value axis
 *  starts at zero unless the data goes below it, and ends on a round number above the data). */
function valueAxis(axis: ChartAxis, data: number[], zero: boolean): { lo: number; hi: number; ticks: TickMark[]; fmt: (v: number) => string } {
  const finite = data.filter(Number.isFinite);
  let lo = Number.isFinite(axis.min) ? Number(axis.min) : Math.min(zero ? 0 : Infinity, ...finite);
  let hi = Number.isFinite(axis.max) ? Number(axis.max) : Math.max(...finite);
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = lo + 1;
  if (hi <= lo) hi = lo + 1;
  const step = niceStep(hi - lo, 4);
  if (!Number.isFinite(axis.max)) hi = clean(Math.ceil(hi / step - 1e-9) * step);
  if (!Number.isFinite(axis.min)) lo = clean(Math.floor(lo / step + 1e-9) * step);
  const fmt = formatter(Math.max(Math.abs(lo), Math.abs(hi)));
  let ticks: TickMark[];
  if (Array.isArray(axis.ticks) && axis.ticks.length) {
    ticks = axis.ticks
      .map((t): TickMark | null => (Array.isArray(t) ? { v: Number(t[0]), label: String(t[1]) } : typeof t === "number" ? { v: t, label: fmt(t) } : null))
      .filter((t): t is TickMark => !!t && Number.isFinite(t.v) && t.v >= lo - 1e-9 && t.v <= hi + 1e-9);
  } else {
    ticks = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) ticks.push({ v: clean(v), label: fmt(clean(v)) });
  }
  return { lo, hi, ticks, fmt };
}

// ── boxes ──

const grow = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Does the segment cross the box (Liang-Barsky clipping)? */
function segHits(b: Box, x1: number, y1: number, x2: number, y2: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - b.x, b.x + b.w - x1, y1 - b.y, b.y + b.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}

/** A label: an SVG text measured once, then placed by its box's top-left corner. */
type Label = { el: SVGTextElement; w: number; h: number; dx: number; dy: number; box: Box | null };

export function buildChart(ctx: ChartCtx, host: Element, spec: ChartSpec, at: number, opts: { seconds?: number } = {}): ChartHandle {
  const { tl } = ctx;
  if (!(host instanceof HTMLElement)) throw new Error("fx.chart needs an element: <div class=\"p-chart\" data-id=\"chart-1\"></div>, sized by the scene's CSS");
  if (!spec || !Array.isArray(spec.series) || !spec.series.length) throw new Error("fx.chart: spec.series needs at least one series");
  const id = host.getAttribute("data-id") || "chart";
  const bar = spec.type === "bar";
  const cs = getComputedStyle(host);
  const px = (v: string) => parseFloat(v) || 0;
  const W = Math.floor(host.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight));
  const H = Math.floor(host.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom));
  if (!(W >= 240 && H >= 160)) throw new Error(`fx.chart: give "${id}" a width and height in the scene's CSS (at least 240 x 160 px; it is ${W} x ${H})`);
  const start = Number.isFinite(at) ? at : 0;
  const lineSeconds = Math.max(0.2, Number(opts.seconds ?? 1) || 1);

  // the type sizes, from the stage's smallest readable text (22 px on the paper page)
  const m = ctx.minText;
  const SIZE = { tick: m + 2, title: m + 4, name: m + 4, mark: m + 2, value: m + 2, note: m };
  const AIR = 24; // between two worded labels (the layout report calls under 18 px "too close")
  const LINE = 6; // a series line
  const DOT = 7; // a point's dot (radius)
  const TICK = 10; // a tick mark's length
  const XLAB = TICK + 8; // from the x axis down to its labels (the same with or without tick marks, so charts side by side line up)
  // the page behind the chart: labels inside the plot get a halo of it, so gridlines never cut through words
  const bg = cs.backgroundColor;
  const halo = bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? bg : "var(--bg, #fff)";

  const svg = svgEl("svg", { class: "p-chart-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  svg.style.cssText = "display:block;overflow:visible;";
  host.appendChild(svg);
  const layer = (name: string) => svg.appendChild(svgEl("g", { class: `p-chart-${name}` }));
  const gGrid = layer("grid");
  const gMarks = layer("marks");
  const gAxes = layer("axes");
  const gData = layer("data");
  const gText = layer("labels");

  const label = (s: string, size: number, weight: number, fill: string, opt: { family?: string; halo?: boolean; dataId?: string; parent?: SVGElement; cls?: string } = {}): Label => {
    const el = svgEl("text", { x: 0, y: 0 });
    if (opt.cls) el.setAttribute("class", opt.cls);
    el.textContent = s;
    el.style.font = `${weight} ${size}px ${opt.family ?? "var(--font-display)"}`;
    el.style.fill = fill;
    if (opt.halo) {
      el.style.paintOrder = "stroke";
      el.style.stroke = halo;
      el.style.strokeWidth = "6px";
      el.style.strokeLinejoin = "round";
    }
    if (opt.dataId) el.setAttribute("data-id", ctx.freshId(opt.dataId));
    (opt.parent ?? gText).appendChild(el);
    const bb = el.getBBox();
    return { el, w: bb.width, h: bb.height, dx: -bb.x, dy: -bb.y, box: null };
  };
  const put = (lab: Label, x: number, y: number) => {
    lab.el.setAttribute("x", r1(x + lab.dx));
    lab.el.setAttribute("y", r1(y + lab.dy));
    lab.box = { x, y, w: lab.w, h: lab.h };
  };
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "series";

  // ── the data, normalised ──

  const xa = spec.x ?? {};
  const ya = spec.y ?? {};
  const allTicksText = Array.isArray(xa.ticks) && xa.ticks.length > 0 && xa.ticks.every((t) => typeof t === "string");
  const anyNamedX = spec.series.some((s) => (s.points ?? []).some((p) => typeof p?.[0] === "string"));
  let cats: string[] | null = Array.isArray(xa.categories) && xa.categories.length ? xa.categories.map(String) : allTicksText ? (xa.ticks as string[]).map(String) : null;
  if (!cats && (bar || anyNamedX)) {
    // categories from the points' own names, in the order they first appear; a bar chart without names numbers its bars
    const seen: string[] = [];
    for (const s of spec.series) for (const p of s.points ?? []) if (typeof p?.[0] === "string" && !seen.includes(p[0])) seen.push(p[0]);
    const n = Math.max(0, ...spec.series.map((s) => s.values?.length ?? 0));
    cats = seen.length ? seen : Array.from({ length: n }, (_, i) => String(i + 1));
  }
  const catIndex = (v: number | string) => (typeof v === "string" ? (cats ?? []).indexOf(v) : Number(v));

  type Series = { spec: ChartSeries; i: number; pts: [number, number][]; color: string; name: string; at: number; seconds: number; own: boolean };
  const series: Series[] = spec.series.map((s, i) => {
    let pts: [number, number][] = [];
    if (bar && Array.isArray(s.values)) pts = s.values.map((v, k) => [k, Number(v)]);
    else pts = (s.points ?? []).map((p) => [cats ? catIndex(p[0]) : Number(p[0]), Number(p[1])]);
    pts = pts.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && (!cats || a >= 0)); // an unknown category is -1
    const own = Number.isFinite(s.at);
    return {
      spec: s,
      i,
      pts,
      color: String(s.color || (bar ? BAR_ORDER : LINE_ORDER)[i % 5]),
      name: String(s.name ?? "").trim(),
      own,
      // series without their own time follow the axes, one after another a quarter second apart
      at: own ? Number(s.at) : start + (bar ? 0.6 + i * 0.3 : 0.7 + i * 0.25),
      seconds: Math.max(0.1, Number(s.seconds ?? (bar ? 0.5 : lineSeconds)) || (bar ? 0.5 : lineSeconds)),
    };
  });

  const ys = series.flatMap((s) => s.pts.map((p) => p[1]));
  // bars below zero carry their value under them: unless the scene set y.min, the axis reaches a little
  // further down, so those values sit inside the plot and clear of the category names
  const lowest = Math.min(0, ...ys);
  const headroom = bar && lowest < 0 && !Number.isFinite(ya.min) ? [lowest - 0.18 * (Math.max(0, ...ys) - lowest)] : [];
  const yAxis = valueAxis(ya, [...ys, ...headroom], true);
  // a value axis that runs through zero: a bar chart's ink baseline sits at zero (the bars grow up and down
  // from it); a line chart keeps its axis at the bottom and gets a stronger gridline at zero
  const zeroIn = yAxis.lo < 0 && yAxis.hi > 0;
  const xNum = cats ? null : valueAxis(xa, series.flatMap((s) => s.pts.map((p) => p[0])), false);
  if (xNum) {
    // a value x axis runs from the first point to the last (not from zero, not on to a round number)
    const xs = series.flatMap((s) => s.pts.map((p) => p[0]));
    if (xs.length && !Number.isFinite(xa.min)) xNum.lo = Math.min(...xs);
    if (xs.length && !Number.isFinite(xa.max)) xNum.hi = Math.max(xNum.lo + 1e-9, ...xs);
    xNum.ticks = xNum.ticks.filter((t) => t.v >= xNum.lo - 1e-9 && t.v <= xNum.hi + 1e-9);
  }
  const xTicks: TickMark[] = cats ? cats.map((c, k) => ({ v: k, label: c })) : xNum!.ticks;

  // ── the labels, measured ──

  const tickFill = "var(--c-ink-2, var(--muted))";
  const titleText = (a: ChartAxis) => {
    const l = String(a.label ?? "").trim();
    const u = String(a.unit ?? "").trim();
    return u ? (l ? `${l} (${u})` : `(${u})`) : l;
  };
  // the axis titles and the note are the chart's frame (class p-chart-title, p-chart-note-text): the layout
  // report checks them but leaves them out of the words on screen, like the tick labels
  const yTitle = titleText(ya) ? label(titleText(ya), SIZE.title, 800, "var(--ink)", { dataId: `${id}-y-title`, cls: "p-chart-title" }) : null;
  const xTitle = titleText(xa) ? label(titleText(xa), SIZE.title, 800, "var(--ink)", { dataId: `${id}-x-title`, cls: "p-chart-title" }) : null;
  // tick labels: the chart's own text (no data-id), in slate
  const yTickLabels = yAxis.ticks.map((t) => label(t.label, SIZE.tick, 500, tickFill));
  let xTickSize = SIZE.tick;
  let xTickLabels = xTicks.map((t) => label(t.label, xTickSize, 500, tickFill));
  const noteText = spec.note === true || spec.note === "illustrative" ? "illustrative numbers" : typeof spec.note === "string" ? spec.note.trim() : "";
  // the note: a small dashed tag (its words carry the data-id; the frame around them follows the words)
  const noteGroup = noteText ? (gText.appendChild(svgEl("g", { class: "p-chart-note" })) as SVGGElement) : null;
  const noteRect = noteGroup ? (noteGroup.appendChild(svgEl("rect", { rx: 8 })) as SVGRectElement) : null;
  const noteLabel = noteGroup ? label(noteText, SIZE.note, 700, tickFill, { dataId: `${id}-note`, parent: noteGroup, cls: "p-chart-note-text" }) : null;
  const NOTE_PAD = { x: 12, y: 5 };
  const noteW = noteLabel ? noteLabel.w + NOTE_PAD.x * 2 : 0;
  const noteH = noteLabel ? noteLabel.h + NOTE_PAD.y * 2 : 0;
  // the band above the plot is as tall as the tallest kind of label in it could be, whichever are there,
  // so two charts side by side start their plots at the same height
  const sampleH = (size: number, weight: number) => {
    const l = label("Ag", size, weight, "none");
    l.el.remove();
    return l.h;
  };
  const BAND = Math.max(sampleH(SIZE.title, 800), sampleH(SIZE.mark, 800), sampleH(SIZE.note, 700) + NOTE_PAD.y * 2);
  // marks at an x the axis has (a known category, or a number)
  const markSpecs = (spec.marks ?? []).filter((mk) => mk && (cats ? catIndex(mk.x) >= 0 : Number.isFinite(Number(mk.x)) && typeof mk.x !== "string"));
  const markLabels = markSpecs.map((mk, k) => (mk.label ? label(String(mk.label), SIZE.mark, 800, "var(--c-pen, var(--accent2))", { halo: true, dataId: `${id}-mark-${k + 1}` }) : null));
  const named = series.filter((s) => s.name);
  const nameLabels = new Map<Series, Label>();
  for (const s of named) {
    if (!bar) nameLabels.set(s, label(s.name, SIZE.name, 800, strokeOf(s.color), { halo: true, dataId: `${id}-${slug(s.name)}-name` }));
  }

  // category labels that don't fit their slots drop to the smallest size; then only every other one shows
  const plotGuess = W * 0.8;
  const widest = Math.max(0, ...xTickLabels.map((l) => l.w));
  if (cats && widest + 14 > plotGuess / Math.max(1, cats.length) && xTickSize > m) {
    for (const l of xTickLabels) l.el.remove();
    xTickSize = m;
    xTickLabels = xTicks.map((t) => label(t.label, xTickSize, 500, tickFill));
  }

  // ── the geometry: margins from the measured labels, then the plot ──

  const yTickW = Math.max(0, ...yTickLabels.map((l) => l.w));
  const tickH = Math.max(0, ...yTickLabels.map((l) => l.h), ...xTickLabels.map((l) => l.h));
  // the legend (when the series' names would collide at their ends, and always for several bar series)
  type LegendItem = { s: Series; lab: Label; key: SVGElement; w: number };
  let legend: LegendItem[] | null = null;
  // in the drawing from the start, so its words can be measured; taken out again if no legend is needed
  const legendGroup = gText.appendChild(svgEl("g", { class: "p-chart-legend" })) as SVGGElement;
  const buildLegend = () => {
    if (legend) return legend;
    legend = named.map((s) => {
      const lab = label(s.name, SIZE.mark, 700, "var(--ink)", { parent: legendGroup });
      const key = bar
        ? svgEl("rect", { width: 22, height: 22, rx: 4 })
        : svgEl("line", { x1: 0, x2: 28, y1: 0, y2: 0 });
      if (bar) {
        key.style.fill = fillOf(s.color);
        key.style.stroke = "var(--ink)";
        key.style.strokeWidth = "3px";
      } else {
        key.style.stroke = strokeOf(s.color);
        key.style.strokeWidth = `${LINE}px`;
        key.style.strokeLinecap = "round";
      }
      legendGroup.appendChild(key);
      return { s, lab, key, w: (bar ? 22 : 28) + 10 + lab.w };
    });
    return legend;
  };
  const legendWidth = () => (legend ? legend.reduce((a, it) => a + it.w, 0) + AIR * (legend.length - 1) : 0);

  type Geo = { px0: number; px1: number; py0: number; py1: number; band: number; legendRow: number; sx: (v: number) => number; sy: (v: number) => number; slot: number };
  const geometry = (withLegend: boolean, extraTop: number): Geo => {
    // the band above the plot: the y title on the left, mark labels at their x, the note and the legend
    const band = yTitle || noteLabel || markLabels.some(Boolean) || withLegend ? BAND : 0;
    // a legend that won't fit beside the y title gets a row of its own under it
    const legendRow = withLegend && legend && (yTitle?.w ?? 0) + AIR + legendWidth() > W ? BAND + 10 : 0;
    // the top tick's label is centred on the plot's top edge: half of it, and some air, under the band
    const top = Math.max(band > 0 ? band + legendRow + Math.max(16, tickH / 2 + 10) : 0, tickH / 2 + 2) + extraTop;
    const bottom = XLAB + (xTickLabels.length ? tickH : 0) + (xTitle ? 12 + xTitle.h : 0) + 2;
    const left = yTickW + 8 + TICK + 2;
    // the right edge: room for names at the right end (unless a legend names them) and for the last tick label
    let right = DOT + 4;
    if (xTickLabels.length && !cats) right = Math.max(right, xTickLabels[xTickLabels.length - 1].w / 2 + 2);
    if (!withLegend && !bar && xNum) {
      for (const s of named) {
        const last = s.pts[s.pts.length - 1];
        if (last && last[0] >= xNum.hi - (xNum.hi - xNum.lo) * 0.02) right = Math.max(right, DOT + 12 + nameLabels.get(s)!.w + 2);
      }
    }
    const px0 = left;
    const px1 = W - right;
    const py0 = top;
    const py1 = H - bottom;
    if (px1 - px0 < 80 || py1 - py0 < 60) throw new Error(`fx.chart: "${id}" is too small for its labels; make it larger in the scene's CSS`);
    const n = cats ? Math.max(1, cats.length) : 1;
    const slot = (px1 - px0) / n;
    // a line's points stay clear of the y axis (an inset of a dot and a bit); bars sit in their slots
    const inset = cats ? 0 : DOT + 9;
    const sx = cats ? (v: number) => px0 + slot * (v + 0.5) : (v: number) => px0 + inset + ((v - xNum!.lo) / (xNum!.hi - xNum!.lo || 1)) * (px1 - px0 - inset);
    const sy = (v: number) => py1 - ((v - yAxis.lo) / (yAxis.hi - yAxis.lo || 1)) * (py1 - py0);
    return { px0, px1, py0, py1, band, legendRow, sx, sy, slot };
  };

  // ── the bars' places (a bar chart may need more room on top for its tallest value) ──

  type BarPlace = { s: Series; k: number; x: number; w: number; y0: number; y1: number; value: number };
  const valueLabels = new Map<string, Label>();
  const valueOf = (s: Series, k: number) => {
    const key = `${s.i}:${k}`;
    if (!valueLabels.has(key)) {
      const v = s.pts.find((p) => p[0] === k)?.[1];
      valueLabels.set(key, label(yAxis.fmt(Number(v)), SIZE.value, 800, "var(--ink)", { halo: true }));
    }
    return valueLabels.get(key)!;
  };
  const barPlaces = (g: Geo): BarPlace[] => {
    const out: BarPlace[] = [];
    const nS = series.length;
    const group = Math.min(g.slot * 0.68, nS * 96);
    const bw = Math.max(6, (group - (nS - 1) * 6) / nS);
    const zero = g.sy(Math.max(yAxis.lo, Math.min(0, yAxis.hi)));
    for (const s of series) {
      for (const [k, v] of s.pts) {
        const x = g.sx(k) - group / 2 + s.i * (bw + 6);
        out.push({ s, k, x, w: bw, y0: zero, y1: g.sy(Math.max(yAxis.lo, Math.min(yAxis.hi, v))), value: v });
      }
    }
    return out;
  };

  // ── placing the floating labels ──

  type Seg = [number, number, number, number];
  const lineSegs = (g: Geo): Seg[] => {
    const segs: Seg[] = [];
    if (bar) return segs;
    for (const s of series) {
      for (let k = 1; k < s.pts.length; k++) segs.push([g.sx(s.pts[k - 1][0]), g.sy(s.pts[k - 1][1]), g.sx(s.pts[k][0]), g.sy(s.pts[k][1])]);
      if (s.pts.length === 1) segs.push([g.sx(s.pts[0][0]), g.sy(s.pts[0][1]), g.sx(s.pts[0][0]), g.sy(s.pts[0][1])]);
    }
    return segs;
  };
  const markX = (g: Geo, mk: ChartMark) => g.sx(cats ? catIndex(mk.x) : Number(mk.x));
  /** Where the x axis's ink line runs: along the plot's bottom, or along zero in a bar chart through zero. */
  const baseY = (g: Geo) => (bar && zeroIn ? g.sy(0) : g.py1);

  type Placed = { ok: boolean; geo: Geo; taken: Box[]; markTops: number[] };
  const place = (withLegend: boolean, extraTop: number): Placed => {
    if (withLegend) buildLegend();
    const g = geometry(withLegend, extraTop);
    const taken: Box[] = [];
    // the series' lines and the two axes: no floating label may cross them
    const segs = [...lineSegs(g), [g.px0, g.py0 - 6, g.px0, g.py1] as Seg, [g.px0, baseY(g), g.px1 + 4, baseY(g)] as Seg];
    const markLines: Seg[] = [];
    // the tick labels' places (all of them, before any is thinned out)
    yAxis.ticks.forEach((t, k) => {
      const l = yTickLabels[k];
      taken.push({ x: g.px0 - TICK - 8 - l.w, y: g.sy(t.v) - l.h / 2, w: l.w, h: l.h });
    });
    xTicks.forEach((t, k) => {
      const l = xTickLabels[k];
      taken.push({ x: g.sx(t.v) - l.w / 2, y: g.py1 + XLAB, w: l.w, h: l.h });
    });
    const inside = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H;
    const clearOfLines = (b: Box, extra: Seg[] = []) => {
      const e = grow(b, LINE / 2 + 5);
      return ![...segs, ...extra].some((sg) => segHits(e, sg[0], sg[1], sg[2], sg[3]));
    };
    const free = (b: Box, lines = true) => inside(b) && !taken.some((t) => hit(grow(b, AIR / 2), grow(t, AIR / 2))) && (!lines || clearOfLines(b, markLines));
    const bandY = (h: number) => (g.band - h) / 2;
    // the y title, top left above the axis
    if (yTitle) {
      put(yTitle, 0, bandY(yTitle.h));
      taken.push(yTitle.box!);
    }
    // the x title, centred under the plot (under the whole chart when it is wider than the plot)
    if (xTitle) {
      const cx = xTitle.w <= g.px1 - g.px0 ? (g.px0 + g.px1) / 2 : W / 2;
      put(xTitle, Math.max(0, Math.min(W - xTitle.w, cx - xTitle.w / 2)), H - xTitle.h - 1);
      taken.push(xTitle.box!);
    }
    // the bars' values count as taken (a floating label must not sit on them)
    if (bar) {
      for (const bp of barPlaces(g)) {
        const lab = valueOf(bp.s, bp.k);
        const up = bp.value >= 0;
        taken.push({ x: bp.x + bp.w / 2 - lab.w / 2, y: up ? bp.y1 - 8 - lab.h : bp.y1 + 8, w: lab.w, h: lab.h });
        taken.push({ x: bp.x, y: Math.min(bp.y0, bp.y1), w: bp.w, h: Math.abs(bp.y1 - bp.y0) });
      }
    }
    // the legend, right-aligned in the band (or in its own row under the title)
    if (withLegend && legend) {
      const lw = legendWidth();
      const lh = Math.max(...legend.map((it) => it.lab.h));
      const y = g.legendRow ? g.band + 6 : bandY(lh);
      taken.push({ x: W - lw, y, w: lw, h: lh });
    }
    // mark labels: in the band centred on their line, else beside it, else just inside the plot's top
    const markTops: number[] = [];
    markSpecs.forEach((mk, k) => {
      const lab = markLabels[k];
      const x = markX(g, mk);
      if (!lab) {
        markTops.push(g.py0);
        markLines.push([x, g.py0, x, g.py1]);
        return;
      }
      const yb = bandY(lab.h);
      const tries: [number, number, boolean][] = [
        [x - lab.w / 2, yb, true],
        [x - 6, yb, true],
        [x - lab.w + 6, yb, true],
        [x + 10, g.py0 + 4, false],
        [x - lab.w - 10, g.py0 + 4, false],
      ];
      const pick = tries.find(([bx, by]) => free({ x: bx, y: by, w: lab.w, h: lab.h }, true)) ?? tries[0];
      put(lab, pick[0], pick[1]);
      taken.push(lab.box!);
      const top = pick[2] ? lab.box!.y + lab.h + 4 : g.py0;
      markTops.push(top);
      markLines.push([x, top, x, g.py1]);
    });
    // series names (a line chart without a legend): at the end of the line, where they cross nothing
    let ok = true;
    if (!withLegend && !bar) {
      const order = [...named].sort((a, b) => (b.pts[b.pts.length - 1]?.[0] ?? 0) - (a.pts[a.pts.length - 1]?.[0] ?? 0));
      for (const s of order) {
        const lab = nameLabels.get(s)!;
        const last = s.pts[s.pts.length - 1];
        if (!last) continue;
        const ex = g.sx(last[0]);
        const ey = g.sy(last[1]);
        const { w, h } = lab;
        const tries: [number, number][] = [
          [ex + DOT + 12, ey - h / 2],
          [ex + DOT + 12, ey - h / 2 - 10],
          [ex + DOT + 12, ey - h / 2 + 10],
          [ex - w - 10, ey - h - 12],
          [ex + 10, ey - h - 12],
          [ex - w - 10, ey + 12],
          [ex + 10, ey + 12],
          [ex - w / 2, ey - DOT - 14 - h],
          [ex - w / 2, ey + DOT + 14],
          [ex - DOT - 12 - w, ey - h / 2],
        ];
        const pick = tries.find(([bx, by]) => free({ x: bx, y: by, w, h }));
        if (!pick) {
          ok = false;
          break;
        }
        put(lab, pick[0], pick[1]);
        taken.push(lab.box!);
      }
    }
    // the note: top right, after the y title, then the bottom corners, then the plot's top right corner
    if (noteLabel && noteRect) {
      const nb = (x: number, y: number): Box => ({ x, y, w: noteW, h: noteH });
      const bottomY = H - noteH - 1;
      const tries: Box[] = [
        nb(W - noteW, bandY(noteH)),
        nb((yTitle?.w ?? 0) + AIR + 8, bandY(noteH)),
        nb(W - noteW, bottomY),
        nb(0, bottomY),
        nb(g.px1 - noteW - 8, g.py0 + 8),
      ];
      const pick = tries.find((b) => free(b)) ?? tries[0];
      noteRect.setAttribute("x", r1(pick.x + 1));
      noteRect.setAttribute("y", r1(pick.y + 1));
      noteRect.setAttribute("width", r1(pick.w - 2));
      noteRect.setAttribute("height", r1(pick.h - 2));
      put(noteLabel, pick.x + NOTE_PAD.x, pick.y + NOTE_PAD.y);
      noteLabel.box = pick;
      taken.push(pick);
    }
    return { ok, geo: g, taken, markTops };
  };

  // first without a legend; with one when a name finds no free place (or for several bar series); a bar
  // chart's tallest value may ask for more room on top
  let withLegend = bar ? named.length > 1 : false;
  let extraTop = 0;
  let placed = place(withLegend, extraTop);
  if (!placed.ok) {
    withLegend = true;
    placed = place(true, extraTop);
  }
  if (bar) {
    const need = (g: Geo) => Math.max(0, ...barPlaces(g).filter((bp) => bp.value >= 0).map((bp) => g.band + 12 - (bp.y1 - 8 - valueOf(bp.s, bp.k).h)));
    for (let k = 0; k < 3 && need(placed.geo) > 0.5; k++) {
      extraTop += need(placed.geo);
      placed = place(withLegend, extraTop);
    }
  }
  const g = placed.geo;
  for (const lab of nameLabels.values()) if (withLegend) lab.el.remove();

  // ── drawing ──

  const ink = "var(--ink)";
  // Hidden until `t`, then shown at once. Hidden as it is made (a tl.set at 0 never runs when the first
  // frame asked for is exactly 0, and a zero-length fromTo renders as already finished); the set at `t`
  // records that hidden state when it first runs, so seeking back before `t` hides it again.
  const showAt = (el: Element, t: number) => {
    gsap.set(el, { autoAlpha: 0 });
    tl.set(el, { autoAlpha: 1 }, t);
  };
  const styleLine = (el: SVGElement, stroke: string, width: number, cap = "round") => {
    el.style.fill = "none";
    el.style.stroke = stroke;
    el.style.strokeWidth = `${width}px`;
    el.style.strokeLinecap = cap;
    el.style.strokeLinejoin = "round";
  };
  // gridlines at the y ticks off the x axis: pale slate, under everything (a line chart's zero, when the
  // values run through it, a little stronger)
  const axisY = baseY(g);
  const grids: SVGElement[] = [];
  for (const t of yAxis.ticks) {
    const y = g.sy(t.v);
    if (Math.abs(y - axisY) < 1) continue;
    const ln = svgEl("path", { d: `M ${r1(g.px0)} ${r1(y)} L ${r1(g.px1)} ${r1(y)}` });
    const zero = zeroIn && Math.abs(t.v) < 1e-9;
    styleLine(ln, "var(--c-ink-2, var(--muted))", zero ? 3 : 2, "butt");
    ln.style.opacity = zero ? "0.6" : "0.22";
    gGrid.appendChild(ln);
    grids.push(ln);
  }
  // the axes: up from the corner and along from it, in ink (a bar chart through zero: along zero)
  const yAxisPath = svgEl("path", { d: `M ${r1(g.px0)} ${r1(g.py1)} L ${r1(g.px0)} ${r1(g.py0 - 6)}`, class: "p-chart-axis" });
  const xAxisPath = svgEl("path", { d: `M ${r1(g.px0)} ${r1(axisY)} L ${r1(g.px1 + 4)} ${r1(axisY)}`, class: "p-chart-axis" });
  for (const a of [yAxisPath, xAxisPath]) {
    styleLine(a, ink, 4, "square");
    gAxes.appendChild(a);
  }
  // tick marks and their labels
  const yTickMarks: SVGElement[] = [];
  yAxis.ticks.forEach((t, k) => {
    const y = g.sy(t.v);
    const tk = svgEl("path", { d: `M ${r1(g.px0 - TICK)} ${r1(y)} L ${r1(g.px0)} ${r1(y)}` });
    styleLine(tk, ink, 3, "butt");
    gAxes.appendChild(tk);
    yTickMarks.push(tk);
    const lab = yTickLabels[k];
    put(lab, g.px0 - TICK - 8 - lab.w, y - lab.h / 2);
  });
  const xTickMarks: SVGElement[] = [];
  // tick labels that would run into each other: only every other one shows (the marks stay)
  let every = 1;
  const xs = xTicks.map((t) => g.sx(t.v));
  for (let tries = 0; tries < 4; tries++) {
    let clash = false;
    for (let k = every; k < xs.length; k += every) {
      if (xs[k] - xs[k - every] < (xTickLabels[k].w + xTickLabels[k - every].w) / 2 + 14) clash = true;
    }
    if (!clash) break;
    every++;
  }
  xTicks.forEach((_, k) => {
    const x = xs[k];
    if (!(cats && bar)) {
      const tk = svgEl("path", { d: `M ${r1(x)} ${r1(g.py1)} L ${r1(x)} ${r1(g.py1 + TICK)}` });
      styleLine(tk, ink, 3, "butt");
      gAxes.appendChild(tk);
      xTickMarks.push(tk);
    }
    const lab = xTickLabels[k];
    if (k % every) {
      lab.el.remove();
      return;
    }
    const top = g.py1 + XLAB;
    put(lab, Math.max(0, Math.min(W - lab.w, x - lab.w / 2)), top);
  });

  // the series
  const seriesEls: SVGGraphicsElement[] = [];
  const barEls: SVGRectElement[][] = [];
  type Anim = () => void;
  const anims: Anim[] = [];
  const ends: number[] = [];
  if (bar) {
    const places = barPlaces(g);
    for (const s of series) {
      const grp = svgEl("g", { class: "p-chart-bars", "data-id": ctx.freshId(`${id}-${slug(s.name || `series-${s.i + 1}`)}`) });
      gData.appendChild(grp);
      seriesEls.push(grp);
      const rects: SVGRectElement[] = [];
      const mine = places.filter((bp) => bp.s === s);
      mine.forEach((bp, n) => {
        const top = Math.min(bp.y0, bp.y1);
        const hgt = Math.abs(bp.y1 - bp.y0);
        const c = s.spec.colors?.[bp.k] ?? s.color;
        const rect = svgEl("rect", { x: r1(bp.x), y: r1(top), width: r1(bp.w), height: r1(hgt), rx: 4 });
        rect.style.fill = fillOf(String(c));
        rect.style.stroke = ink;
        rect.style.strokeWidth = "3px";
        rect.style.strokeLinejoin = "round";
        rect.style.setProperty("vector-effect", "non-scaling-stroke"); // its ink edge keeps its width as it grows
        grp.appendChild(rect);
        rects.push(rect);
        const lab = valueOf(s, bp.k);
        const up = bp.value >= 0;
        put(lab, bp.x + bp.w / 2 - lab.w / 2, up ? bp.y1 - 8 - lab.h : bp.y1 + 8);
        const t0 = s.at + n * 0.08;
        anims.push(() => {
          // a bar grows from the baseline (scaled about its foot; see scaleAbout)
          const cx = bp.x + bp.w / 2;
          showAt(rect, t0);
          tl.fromTo(rect, { attr: { transform: scaleAbout(cx, bp.y0, 1, 0.001) } }, { attr: { transform: scaleAbout(cx, bp.y0, 1, 1) }, duration: s.seconds, ease: "power2.out" }, t0);
          // its value lands as it arrives
          tl.fromTo(lab.el, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.25, ease: "power2.out" }, t0 + s.seconds * 0.7);
        });
      });
      barEls.push(rects);
      ends.push(s.at + Math.max(0, mine.length - 1) * 0.08 + s.seconds);
      if (s.own) ctx.mark("chart", [grp], s.at);
      ctx.sound("pop", s.at, 0.5);
    }
  } else {
    for (const s of series) {
      if (!s.pts.length) {
        ends.push(s.at);
        continue;
      }
      const pts = s.pts.map(([a, b]) => [g.sx(a), g.sy(b)] as [number, number]);
      const d = pts.map(([x, y], k) => `${k ? "L" : "M"} ${r1(x)} ${r1(y)}`).join(" ");
      const path = svgEl("path", { d: pts.length > 1 ? d : `${d} L ${r1(pts[0][0] + 0.01)} ${r1(pts[0][1])}`, class: "p-chart-line", "data-id": ctx.freshId(`${id}-${slug(s.name || `series-${s.i + 1}`)}`) });
      styleLine(path, strokeOf(s.color), LINE);
      gData.appendChild(path);
      seriesEls.push(path);
      // dots at the points (only the last one when there are very many), popping as the line reaches them
      const lens: number[] = [0];
      for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const total = lens[lens.length - 1] || 1;
      const dots: [SVGCircleElement, number, number, number][] = []; // the dot, how far along the line, its centre
      pts.forEach(([x, y], k) => {
        if (pts.length > 24 && k < pts.length - 1) return;
        const dot = svgEl("circle", { cx: r1(x), cy: r1(y), r: DOT });
        dot.style.fill = strokeOf(s.color);
        dot.style.stroke = halo;
        dot.style.strokeWidth = "3px";
        gData.appendChild(dot);
        dots.push([dot, lens[k] / total, x, y]);
      });
      const lab = nameLabels.get(s);
      anims.push(() => {
        // hidden until it starts (a round cap would leave a dot at the start), then drawn at an even pace
        showAt(path, s.at);
        tl.fromTo(path, { drawSVG: "0%" }, { drawSVG: "100%", duration: s.seconds, ease: "none" }, s.at);
        for (const [dot, f, x, y] of dots) {
          tl.fromTo(dot, { attr: { transform: scaleAbout(x, y, 0.001, 0.001) } }, { attr: { transform: scaleAbout(x, y, 1, 1) }, duration: 0.22, ease: "back.out(2.2)" }, s.at + s.seconds * f);
        }
        if (lab && !withLegend) tl.fromTo(lab.el, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.3, ease: "power2.out" }, s.at + s.seconds);
      });
      ends.push(s.at + s.seconds + 0.3);
      if (s.own) ctx.mark("chart", [path], s.at);
      ctx.sound("pencil", s.at, 0.45);
    }
  }

  // the legend, in the band (or its own row)
  if (!(withLegend && legend)) legendGroup.remove();
  else {
    const items = legend as LegendItem[];
    legendGroup.setAttribute("data-id", ctx.freshId(`${id}-legend`));
    const lh = Math.max(...items.map((it) => it.lab.h));
    const y = g.legendRow ? g.band + 6 : (g.band - lh) / 2;
    let x = W - legendWidth();
    for (const it of items) {
      const cy = y + lh / 2;
      if (bar) {
        it.key.setAttribute("x", r1(x));
        it.key.setAttribute("y", r1(cy - 11));
      } else {
        it.key.setAttribute("x1", r1(x + 3));
        it.key.setAttribute("x2", r1(x + 25));
        it.key.setAttribute("y1", r1(cy));
        it.key.setAttribute("y2", r1(cy));
      }
      put(it.lab, x + (bar ? 22 : 28) + 10, y + (lh - it.lab.h) / 2);
      x += it.w + AIR;
    }
  }

  // the marks: a dashed pen-red line from under its label down to the axis
  const markEls: SVGGElement[] = [];
  // a mark without its own time comes after the series that draw with the chart (not the later ones)
  const defaultEnd = Math.max(start + 0.7, ...series.filter((s) => !s.own).map((s) => ends[s.i] ?? start + 0.7));
  markSpecs.forEach((mk, k) => {
    const x = markX(g, mk);
    const grp = svgEl("g", { class: "p-chart-mark" });
    gMarks.appendChild(grp);
    const top = placed.markTops[k] ?? g.py0;
    const ln = svgEl("line", { x1: r1(x), x2: r1(x), y1: r1(top), y2: r1(g.py1), "data-id": ctx.freshId(`${id}-mark-${k + 1}-line`) });
    styleLine(ln, "var(--c-pen, var(--accent2))", 3.5, "butt");
    ln.style.strokeDasharray = "10 8";
    ln.style.setProperty("vector-effect", "non-scaling-stroke"); // the dashes keep their size as it grows
    grp.appendChild(ln);
    const lab = markLabels[k];
    if (lab) grp.appendChild(lab.el); // the label moves into the mark's group (its place is already set)
    markEls.push(grp);
    const t0 = Number.isFinite(mk.at) ? Number(mk.at) : defaultEnd + 0.2;
    anims.push(() => {
      // the dashes run down from the top (scaled about its top end; see scaleAbout)
      showAt(ln, t0);
      tl.fromTo(ln, { attr: { transform: scaleAbout(x, top, 1, 0.001) } }, { attr: { transform: scaleAbout(x, top, 1, 1) }, duration: 0.4, ease: "power2.out" }, t0);
      if (lab) tl.fromTo(lab.el, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out" }, t0 + 0.1);
    });
    if (Number.isFinite(mk.at)) ctx.mark("chart", [grp], t0);
  });

  // ── the chart arrives: axes draw, ticks and gridlines follow, the titles and the note fade up ──

  const axesIn = 0.5;
  for (const a of [yAxisPath, xAxisPath]) {
    showAt(a, start);
    tl.fromTo(a, { drawSVG: "0%" }, { drawSVG: "100%", duration: axesIn, ease: "power1.inOut" }, start);
  }
  const yTickEls = yAxis.ticks.flatMap((_, k) => [yTickMarks[k], yTickLabels[k].el]);
  tl.fromTo(yTickEls, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: "power1.out", stagger: 0.03 }, start + 0.2);
  // left to right, so they arrive along the axis
  const xTickEls = ([...xTickMarks, ...xTickLabels.filter((l) => l.el.isConnected).map((l) => l.el)] as SVGGraphicsElement[]).sort((a, b) => a.getBBox().x - b.getBBox().x);
  if (xTickEls.length) tl.fromTo(xTickEls, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: "power1.out", stagger: 0.02 }, start + 0.25);
  if (grids.length) tl.fromTo(grids, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.45, ease: "power1.out", stagger: 0.05 }, start + 0.3);
  const titles = [yTitle?.el, xTitle?.el].filter(Boolean) as SVGElement[];
  if (titles.length) tl.fromTo(titles, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power2.out", stagger: 0.1 }, start + 0.15);
  if (noteGroup) tl.fromTo(noteGroup, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, ease: "power1.out" }, start + 0.5);
  if (withLegend && legend) tl.fromTo(legendGroup, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, ease: "power1.out" }, start + 0.5);
  for (const a of anims) a();
  if (noteRect) {
    noteRect.style.fill = halo;
    noteRect.style.stroke = "var(--c-ink-2, var(--muted))";
    noteRect.style.strokeWidth = "2px";
    noteRect.style.strokeDasharray = "6 5";
  }
  ctx.sound("pencil", start, 0.5);
  ctx.mark("chart", [host], start);

  // ── the handle: values to stage px, for fx.focus, fx.circle, fx.flow and anything placed by hand ──

  const sb = restBox(svg, ctx.cam, ctx.stageW);
  const k = sb.w / W || 1;
  return {
    svg,
    x: (v: number | string) => sb.x + g.sx(cats ? catIndex(v) : Number(v)) * k,
    y: (v: number) => sb.y + g.sy(Number(v)) * k,
    series: seriesEls,
    bars: barEls,
    marks: markEls,
  };
}
