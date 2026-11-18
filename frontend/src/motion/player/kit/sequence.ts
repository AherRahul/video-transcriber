// Sequence diagrams: fx.sequence(el, spec, opts) draws who calls whom, in order, inside an empty element the
// scene places (and sizes, or it takes 900 x 500):
//   const s = fx.sequence($('seq'), {
//     actors: [{ id: 'app', label: 'App', icon: 'smartphone' }, { id: 'api', label: 'API' }, { id: 'db', label: 'Database' }],
//     messages: [
//       { from: 'app', to: 'api', label: 'POST /orders', at: cue(1) },
//       { from: 'api', to: 'db', label: 'INSERT order', at: cue(2) },
//       { from: 'db', to: 'api', label: 'ok', kind: 'reply', at: cue(3) },
//       { from: 'api', to: 'app', label: '201 Created', kind: 'reply', at: cue(4) },
//     ],
//   }, { at: cue(0) });
// The actors' boxes stand across the top with their lifelines down the page; each message is an arrow
// between two lifelines that draws on at its own time (call: solid with a filled head; reply: dashed with an
// open head; async: solid with an open head; self: a loop back to the same lifeline), its words above it.
// A call opens an activation bar on the callee's lifeline, closed by the callee's next reply to the caller.
// Notes ({ after: 1, over: 'api', text: 'checks stock' }) sit on a row of their own.
//
// Everything is on the scene's paused timeline, so any frame seeks the same from either direction. It returns
// handles: actors (their boxes), messages (each one's group and label), notes, for fx.focus and fx.circle.

import { Board, dsIcon, r1 } from "./ds";
import type { KitCtx, KitModule } from "./types";

type Kind = "call" | "reply" | "async" | "self";
type Actor = { id: string; label?: string; icon?: string };
type Message = { from: string; to: string; label?: string; kind?: Kind; at?: number };
type Note = { after?: number; over: string | string[]; text: string; at?: number };
type Spec = { actors: Actor[]; messages: Message[]; notes?: Note[] };
type Opts = {
  /** when the actors and lifelines appear (left out: there from the start) */
  at?: number;
  /** a message without its own at comes this long after the one before it (0.7 s) */
  step?: number;
  /** the Excalidraw look */
  sketch?: boolean;
};

type Row = { kind: "msg"; k: number; m: Message } | { kind: "note"; k: number; n: Note };

function makeSequence(ctx: KitCtx, host: Element, spec: Spec, opts: Opts = {}) {
  const b = new Board(ctx, host, "sequence", opts);
  const m = b.m;
  if (!spec || !Array.isArray(spec.actors) || spec.actors.length < 1) throw new Error("fx.sequence needs {actors: [{id, label}], messages: [{from, to, label}]}");
  const actors = spec.actors.map((a) => ({ id: String(a.id), label: String(a.label ?? a.id), icon: a.icon }));
  const ids = new Set(actors.map((a) => a.id));
  const msgs = (spec.messages ?? []).map((x) => {
    if (!ids.has(String(x.from)) || !ids.has(String(x.to))) throw new Error(`fx.sequence: a message goes from "${x.from}" to "${x.to}", but the actors are ${[...ids].join(", ")}`);
    const kind: Kind = x.kind ?? (String(x.from) === String(x.to) ? "self" : "call");
    return { ...x, from: String(x.from), to: String(x.to), kind };
  });
  // the rows, top to bottom: each message, and each note after the message it follows
  const rows: Row[] = [];
  msgs.forEach((x, k) => rows.push({ kind: "msg", k, m: x }));
  for (const [k, n] of (spec.notes ?? []).entries()) {
    const after = Math.max(-1, Math.min(msgs.length - 1, Math.floor(Number(n.after ?? msgs.length - 1))));
    const pos = rows.findIndex((r) => r.kind === "msg" && r.k === after);
    rows.splice(pos + 1, 0, { kind: "note", k, n });
  }
  const size = b.room(b.host.offsetWidth || 900, b.host.offsetHeight || 500);
  const n = actors.length;
  const colW = size.w / n;
  const cx = (id: string) => (actors.findIndex((a) => a.id === id) + 0.5) * colW;
  const icons = actors.some((a) => a.icon);
  const headH = Math.round(m * 2.7) + (icons ? 46 : 0);
  // the actors' boxes
  const actorEls: Record<string, HTMLElement> = {};
  for (const a of actors) {
    const tw = b.measure(a.label, "p-ds-v", m + 4) + 36;
    const w = Math.min(colW - 16, Math.max(m * 6, tw));
    const el = b.cell("p-ds-actor", `a-${a.id.replace(/[^\w-]/g, "")}`, cx(a.id) - w / 2, 0, w, headH, null);
    const icon = dsIcon(ctx, a.icon, "p-ds-icon");
    if (icon) el.insertAdjacentHTML("beforeend", icon);
    const span = document.createElement("span");
    span.className = "p-ds-v";
    span.textContent = a.label;
    el.appendChild(span);
    b.fit(span, w - 14, m + 4);
    actorEls[a.id] = el;
  }
  const top = headH + 18;
  const bottom = size.h - 8;
  const rowH = rows.length ? Math.min(Math.round(m * 4), (bottom - top - 24) / rows.length) : 0;
  if (rows.length && rowH < m * 2.9) throw new Error(`fx.sequence: ${rows.length} rows don't fit in ${size.h} px: make the element taller or split the exchange`);
  const rowY = (i: number) => top + 24 + (i + 0.5) * rowH;
  // lifelines (dashed, under everything)
  const lifelines: Record<string, SVGGElement> = {};
  for (const a of actors) {
    const g = b.arrow(cx(a.id), headH + 4, cx(a.id), bottom, { head: false, width: 3, dashed: true, color: "#94a3b8" });
    lifelines[a.id] = g;
  }
  b.appear([...actors.map((a) => actorEls[a.id]), ...actors.map((a) => lifelines[a.id])], opts.at, 0.08);
  // when each message draws on: its own at, or `step` after the one before
  const step = opts.step ?? 0.7;
  const times: (number | null)[] = [];
  let last: number | null = opts.at != null ? Number(opts.at) + 0.2 : null;
  for (const x of msgs) {
    let t: number | null = x.at != null && Number.isFinite(Number(x.at)) ? Number(x.at) : last != null ? last + step : null;
    if (t != null) t = Math.max(0, t);
    times.push(t);
    if (t != null) last = t;
  }
  // activation bars: a call opens one on the callee, its next reply back to the caller closes it
  const BAR = 14;
  type Bar = { actor: string; from: number; to: number; el: HTMLElement | null };
  const bars: Bar[] = [];
  const rowOf = (k: number) => rows.findIndex((r) => r.kind === "msg" && r.k === k);
  msgs.forEach((x, k) => {
    if (x.kind !== "call") return;
    const close = msgs.findIndex((y, j) => j > k && y.kind === "reply" && y.from === x.to && y.to === x.from);
    bars.push({ actor: x.to, from: rowOf(k), to: close < 0 ? rowOf(k) + 0.6 : rowOf(close), el: null });
  });
  const activeAt = (actor: string, row: number) => bars.some((bar) => bar.actor === actor && row >= bar.from - 0.01 && row <= bar.to + 0.01);
  for (const [k, bar] of bars.entries()) {
    const y0 = rowY(bar.from);
    const y1 = rowY(bar.to);
    const el = b.part("p-ds-bar", `bar${k}`, cx(bar.actor) - BAR / 2, y0, BAR, Math.max(rowH * 0.5, y1 - y0));
    bar.el = el;
  }
  // the messages
  const handles: { group: SVGGElement; label: HTMLElement | null; at: number | null }[] = [];
  msgs.forEach((x, k) => {
    const row = rowOf(k);
    const y = rowY(row);
    const t = times[k];
    const labelSize = m + 2;
    let group: SVGGElement;
    let lx: number;
    let lw: number;
    if (x.kind === "self") {
      const x0 = cx(x.from) + (activeAt(x.from, row) ? BAR / 2 : 0);
      const loop = Math.min(70, colW * 0.3);
      const dy = rowH * 0.28;
      group = b.arrow(x0 + loop, y + dy, x0 + 6, y + dy, { width: 4 });
      const line = group.querySelector("line")!;
      // the loop: out, down and back in (a path in place of the straight line)
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${r1(x0 + 2)} ${r1(y - dy)} H ${r1(x0 + loop)} V ${r1(y + dy)} H ${r1(x0 + 6)}`);
      path.setAttribute("style", `${line.getAttribute("style")}fill:none;stroke-linejoin:round;`);
      path.setAttribute("data-stroke", line.getAttribute("data-stroke") || b.ink);
      line.replaceWith(path);
      lw = Math.min(colW * 0.9, b.measure(x.label ?? "", "p-ds-msg", labelSize) + 8);
      lx = x0 + loop + 10;
    } else {
      const a = cx(x.from);
      const c = cx(x.to);
      const dir = c > a ? 1 : -1;
      const x1 = a + dir * (activeAt(x.from, row) ? BAR / 2 : 0);
      const x2 = c - dir * (activeAt(x.to, row) ? BAR / 2 + 2 : 2);
      group = b.arrow(x1, y, x2, y, { width: 4, dashed: x.kind === "reply", open: x.kind !== "call" });
      lw = Math.min(Math.abs(c - a) - 12, b.measure(x.label ?? "", "p-ds-msg", labelSize) + 8);
      lx = (a + c) / 2 - lw / 2;
    }
    group.setAttribute("data-id", b.partId(`m${k}`));
    let label: HTMLElement | null = null;
    if (x.label) {
      // a call's words above its arrow; a loop's beside it, at its middle
      const ly = x.kind === "self" ? y - (labelSize + 8) / 2 : y - labelSize - 14;
      label = b.part("p-ds-msg", `m${k}-label`, lx, ly, lw, labelSize + 8);
      label.textContent = x.label;
      label.style.fontSize = `${labelSize}px`;
      if (x.kind === "self") label.style.textAlign = "left";
      b.fit(label, lw, labelSize);
    }
    handles.push({ group, label, at: t });
    if (t != null) {
      b.ctx.mark("message", label ? [label] : [], t);
      const shape = group.querySelector("line, path") as SVGGeometryElement;
      const tip = group.querySelector(".p-ds-tip");
      b.tl.fromTo(shape, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.4, ease: "power1.inOut" }, t);
      if (tip) b.tl.fromTo(tip, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.05 }, t + 0.36);
      if (label) b.tl.fromTo(label, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.25, ease: "power2.out" }, t + 0.1);
    }
  });
  // a bar grows down from its call as the call arrives
  for (const bar of bars) {
    const k = msgs.findIndex((_, j) => rowOf(j) === bar.from);
    const t = times[k];
    if (bar.el && t != null) b.tl.fromTo(bar.el, { scaleY: 0, transformOrigin: "50% 0%" }, { scaleY: 1, duration: 0.35, ease: "power2.out" }, t + 0.3);
  }
  // notes, on rows of their own
  const notes: HTMLElement[] = [];
  rows.forEach((r, i) => {
    if (r.kind !== "note") return;
    const over = (Array.isArray(r.n.over) ? r.n.over : [r.n.over]).map(String).filter((id) => ids.has(id));
    if (!over.length) throw new Error(`fx.sequence: a note is over "${r.n.over}", but the actors are ${[...ids].join(", ")}`);
    const xs = over.map(cx);
    const size2 = m + 2;
    const w = Math.max(b.measure(r.n.text, "p-ds-note", size2) + 28, Math.max(...xs) - Math.min(...xs) + colW * 0.5);
    const mid = (Math.max(...xs) + Math.min(...xs)) / 2;
    const el = b.part("p-ds-note", `note${r.k}`, mid - w / 2, rowY(i) - (size2 + 18) / 2, w, size2 + 18);
    el.textContent = r.n.text;
    el.style.fontSize = `${size2}px`;
    notes.push(el);
    const prev = rows.slice(0, i).reverse().find((x) => x.kind === "msg");
    const t = r.n.at != null ? Number(r.n.at) : prev && prev.kind === "msg" && times[prev.k] != null ? (times[prev.k] as number) + 0.5 : opts.at;
    if (t != null) b.arrive(el, Math.max(0, t));
  });
  return {
    el: b.host,
    actors: actorEls,
    lifelines,
    messages: handles.map((h) => ({ el: h.group, label: h.label })),
    /** message k's label (for fx.circle or fx.focus), or its arrow when it has no words */
    message: (k: number) => {
      const h = handles[k];
      if (!h) throw new Error(`fx.sequence: no message ${k} (0 to ${handles.length - 1})`);
      return h.label ?? h.group;
    },
    notes,
    /** an actor's box lights up (lemon by default) */
    mark: (id: string, at: number, tone = "lemon") => {
      const el = actorEls[String(id)];
      if (!el) throw new Error(`fx.sequence: no actor "${id}"`);
      b.tone(el, tone, b.need(at, "mark"));
    },
  };
}

export const SEQUENCE_CSS = `
.p-ds-actor { flex-direction: column; gap: 6px; padding: 6px 10px; }
.p-ds-actor .p-ds-icon { width: 40px; height: 40px; flex: none; stroke: var(--ink); }
.p-ds-bar { background: #fff; border: 3px solid var(--ink); border-radius: 3px; }
.p-ds-msg { display: block; text-align: center; font: 700 24px/1.2 var(--font-mono); color: var(--ink); white-space: nowrap; }
.p-ds-note { display: flex; align-items: center; justify-content: center; padding: 0 14px; background: var(--c-lemon, #fef08a); border: 3px solid var(--ink); border-radius: 6px; font-family: var(--font-display); font-weight: 700; white-space: nowrap; transform: rotate(-1deg); }
.p-ds-sketch .p-ds-msg, .p-ds-sketch .p-ds-note { font-family: var(--font-sketch, Virgil, var(--font-hand)); font-weight: 400; }
`;

export const sequence: KitModule = {
  name: "sequence",
  css: SEQUENCE_CSS,
  make: (ctx: KitCtx) => ({ sequence: (el: Element, spec: Spec, opts?: Opts) => makeSequence(ctx, el, spec, opts) }),
};
