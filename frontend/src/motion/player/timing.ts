// The timing report for the audit (window.MotionPlayer.timing): where a narrated page sits still while the
// voice goes on, and which entrances land a phrase late.

/** An entrance made through fx whose start came from cue(n, plus). nextCue is the next cue's time (the
 *  voice's end after the last cue): an entrance starting later than that lands during the next phrase. */
export type LateEntrance = { id: string; at: number; cue: number; plus: number; nextCue: number };

export type Timing = { gaps: [number, number][]; late: LateEntrance[] };

const round = (n: number) => Math.round(n * 100) / 100;

/** A child's start in the scene timeline's own seconds (children can sit in nested timelines). */
function startIn(tl: gsap.core.Timeline, child: gsap.core.Animation): number {
  let t = child.startTime();
  for (let p = child.parent; p && p !== tl; p = p.parent) t = p.startTime() + t / (p.timeScale() || 1);
  return t;
}

/**
 * Stretches inside [from, to] longer than `longest` seconds in which no tween or set on the timeline is
 * running (a set counts at its moment). Everything on the timeline counts: the page label's tear-on, the
 * camera, packets, exits.
 */
export function timelineGaps(tl: gsap.core.Timeline, from: number, to: number, longest = 6): [number, number][] {
  if (!(to - from > longest)) return [];
  const spans: [number, number][] = [];
  for (const child of tl.getChildren(true, true, false)) {
    const a = startIn(tl, child);
    const b = a + child.totalDuration();
    if (b >= from && a <= to) spans.push([Math.max(from, a), Math.min(to, b)]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const gaps: [number, number][] = [];
  let busyUntil = from;
  for (const [a, b] of spans) {
    if (a - busyUntil > longest) gaps.push([round(busyUntil), round(a)]);
    busyUntil = Math.max(busyUntil, b);
  }
  if (to - busyUntil > longest) gaps.push([round(busyUntil), round(to)]);
  return gaps;
}
