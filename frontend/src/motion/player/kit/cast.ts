// The cast (kit/cast.ts): the tech videos' recurring people, drawn by our own rig (kit/toon.ts): one slim figure
// in an open jacket, jeans and sneakers for everyone, bright skin, big expressive faces. cast.json says who they
// are (each one's hair, accessories and colours), the poses and faces they share, and the older names that still
// work (an Open Peeps scene's "Calm" is "smile").
//
//   <div class="p-person" data-person="meera" data-pose="point" data-face="talk" data-id="meera"></div>
//
// The element's width sets the size (its height follows the figure). data-crop="bust" shows the head and upper
// body in a card, data-crop="head" a round head (an avatar); data-flip turns the person to face left.
//   fx.face(el, "surprised", at)        a new face at a time (eyes, brows and mouth together)
//   fx.pose(el, "point", at, seconds)   the arms move to a pose (0.45 s by default), the hands change half-way
//   fx.nod(el, at, deg)                 a small nod of the head
//   fx.talk(el, from, to)               the mouth moves as if speaking, from one time to another
// A person blinks by themselves every few seconds (never in a thumbnail; data-still stops it), seeded, so every
// export is the same.

import type { Bundle } from "../../types";
import { CROPS, FACES, POSES, personMarkup, setArms, setHead, type ToonSpec } from "./toon";
import type { KitAssets, KitCtx, KitModule } from "./types";

type Person = { label: string; desc: string; spec: ToonSpec };
type Manifest = {
  poses: string[];
  faces: string[];
  aliases: { poses: Record<string, string>; faces: Record<string, string> };
  people: Record<string, Person>;
};

let fetched: Promise<Manifest> | null = null;

/** what the script set on each person, and when (a blink or a talk comes back to the face of its moment) */
const faceLog = new WeakMap<HTMLElement, { at: number; face: string }[]>();
const poseNow = new WeakMap<HTMLElement, string>();

const manifestOf = (ctx: KitCtx) => ctx.assets.store.get("cast") as Manifest | undefined;
const faceName = (m: Manifest, name: string) => (FACES[name] ? name : m.aliases.faces[name] ?? "");
const poseName = (m: Manifest, name: string) => (POSES[name] ? name : m.aliases.poses[name] ?? "");

/** Shows one layer of a kind (eyes, brows, mouth) at a time on the timeline. */
function showLayer(ctx: KitCtx, svg: Element, kind: "eyes" | "brows" | "mouth", name: string, at: number) {
  for (const g of Array.from(svg.querySelectorAll<SVGGElement>(`[data-${kind}]`))) {
    ctx.tl.set(g, { visibility: g.getAttribute(`data-${kind}`) === name ? "visible" : "hidden" }, at);
  }
}

function showFace(ctx: KitCtx, svg: Element, face: string, at: number) {
  const f = FACES[face];
  showLayer(ctx, svg, "eyes", f.eyes, at);
  showLayer(ctx, svg, "brows", face, at);
  showLayer(ctx, svg, "mouth", f.mouth, at);
}

/** The face a person shows at a scene time, by what the script set (the element's own face before that). */
function faceAt(el: HTMLElement, t: number): string {
  const log = [{ at: -1, face: el.dataset.face || "smile" }, ...(faceLog.get(el) ?? [])].sort((a, b) => a.at - b.at);
  return log.filter((c) => c.at <= t).pop()!.face;
}

export const cast: KitModule = {
  name: "cast",
  css: `
.p-person { position: relative; width: 300px; overflow: visible; }
.p-person > svg.t-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.p-person[data-flip] > svg.t-svg { transform: scaleX(-1); }
.p-person[data-crop="head"] { overflow: hidden; border-radius: 50%; border: 4px solid var(--ink, #141414); background: var(--c-sky, #cfe4ff); }
.p-person[data-crop="bust"] { overflow: hidden; border-radius: 24px; border: 4px solid var(--ink, #141414); background: var(--c-sky, #cfe4ff); box-shadow: 8px 8px 0 var(--ink, #141414); }
.p-say { position: absolute; background: #fff; border: 4px solid var(--ink, #141414); border-radius: 22px; padding: 14px 20px; font: 600 28px/1.25 var(--font-display, system-ui); color: var(--ink, #141414); box-shadow: 6px 6px 0 var(--ink, #141414); }
.p-say::after { content: ""; position: absolute; left: 34px; bottom: -22px; width: 30px; height: 30px; background: #fff; border-right: 4px solid var(--ink, #141414); border-bottom: 4px solid var(--ink, #141414); transform: skewX(-25deg) rotate(45deg); }
.p-say.left::after { left: auto; right: 34px; transform: skewX(25deg) rotate(45deg); }
`,

  async load(bundle: Bundle, assets: KitAssets) {
    const sources = bundle.scenes.map((s) => s.source || "").join("\n");
    if (!/data-person|fx\.(person|face|pose|talk)\b/.test(sources) || assets.store.has("cast")) return [];
    fetched ??= fetch(`${assets.kitBase}cast/cast.json`).then((r) => {
      if (!r.ok) throw new Error(`cast.json: ${r.status}`);
      return r.json() as Promise<Manifest>;
    });
    try {
      assets.store.set("cast", await fetched);
      return [];
    } catch (err) {
      fetched = null;
      return [`The cast didn't load (${err instanceof Error ? err.message : err}).`];
    }
  },

  prepare(ctx: KitCtx) {
    const m = manifestOf(ctx);
    for (const el of Array.from(ctx.cam.querySelectorAll<HTMLElement>("[data-person]"))) {
      if (el.querySelector(":scope > svg.t-svg")) continue; // a carried copy, already drawn
      el.classList.add("p-person");
      const id = (el.dataset.person || "").trim();
      const p = m?.people[id];
      if (!m || !p) {
        ctx.errors.push(`Scene ${ctx.sceneId}: no person "${id}" in the cast (the project state lists them)`);
        continue;
      }
      const pose = poseName(m, el.dataset.pose || "rest");
      const face = faceName(m, el.dataset.face || "smile");
      if (!pose) ctx.errors.push(`Scene ${ctx.sceneId}: ${p.label} has no pose "${el.dataset.pose}" (poses: ${m.poses.join(", ")})`);
      if (!face) ctx.errors.push(`Scene ${ctx.sceneId}: ${p.label} has no face "${el.dataset.face}" (faces: ${m.faces.join(", ")})`);
      el.dataset.pose = pose || "rest";
      el.dataset.face = face || "smile";
      const crop = CROPS[el.dataset.crop || ""] ? el.dataset.crop! : "full";
      const [, , w, h] = CROPS[crop];
      el.style.aspectRatio = `${w} / ${h}`;
      el.insertAdjacentHTML("beforeend", personMarkup(p.spec, el.dataset.face, crop));
      const svg = el.querySelector(":scope > svg.t-svg")!;
      setArms(svg, POSES[el.dataset.pose], POSES[el.dataset.pose]);
      poseNow.set(el, el.dataset.pose);
      if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", p.label);
    }
  },

  make(ctx: KitCtx) {
    const list = (els: Element | Element[]) => (Array.isArray(els) ? els : [els]).filter(Boolean) as HTMLElement[];
    const svgOf = (el: HTMLElement) => el.querySelector(":scope > svg.t-svg");
    const label = (el: HTMLElement) => manifestOf(ctx)?.people[el.dataset.person || ""]?.label ?? "this person";
    return {
      /** A new face at a time: fx.face($('meera'), 'surprised', cue(2)). */
      face(els: Element | Element[], name: string, at: number) {
        const m = manifestOf(ctx);
        for (const el of list(els)) {
          const svg = svgOf(el);
          const face = m ? faceName(m, name) : "";
          if (!svg || !face) {
            ctx.errors.push(`Scene ${ctx.sceneId}: ${label(el)} has no face "${name}" (faces: ${m?.faces.join(", ") ?? "none"})`);
            continue;
          }
          showFace(ctx, svg, face, at);
          const log = faceLog.get(el) ?? [];
          log.push({ at, face });
          faceLog.set(el, log);
        }
      },
      /** The arms move to a pose, smoothly (0.45 s by default); the hands change half-way. */
      pose(els: Element | Element[], name: string, at: number, seconds = 0.45) {
        const m = manifestOf(ctx);
        for (const el of list(els)) {
          const svg = svgOf(el);
          const to = m ? poseName(m, name) : "";
          if (!svg || !to) {
            ctx.errors.push(`Scene ${ctx.sceneId}: ${label(el)} has no pose "${name}" (poses: ${m?.poses.join(", ") ?? "none"})`);
            continue;
          }
          const from = POSES[poseNow.get(el) || "rest"];
          const target = POSES[to];
          const a = { ls: from.l[0], le: from.l[1], rs: from.r[0], re: from.r[1] };
          ctx.tl.fromTo(
            a,
            { ls: from.l[0], le: from.l[1], rs: from.r[0], re: from.r[1] },
            {
              ls: target.l[0], le: target.l[1], rs: target.r[0], re: target.r[1],
              duration: seconds, ease: "power2.inOut", immediateRender: false,
              onUpdate: () => setArms(svg, { l: [a.ls, a.le], r: [a.rs, a.re] }),
            },
            at,
          );
          for (const h of Array.from(svg.querySelectorAll<SVGGElement>("[data-hand]"))) {
            const left = (h.closest(".t-arm") as SVGGElement | null)?.dataset.side === "l";
            ctx.tl.set(h, { visibility: h.dataset.hand === (left ? target.lh : target.rh) ? "inherit" : "hidden" }, at + seconds / 2);
          }
          ctx.mark("pose", [el], at);
          poseNow.set(el, to);
        }
      },
      /** A small nod (or a tilt of deg degrees, 5 by default), 0.5 s. */
      nod(els: Element | Element[], at: number, deg = 5) {
        for (const el of list(els)) {
          const svg = svgOf(el);
          if (!svg) continue;
          const h = { d: 0 };
          const apply = () => setHead(svg, h.d);
          ctx.tl.fromTo(h, { d: 0 }, { d: deg, duration: 0.18, ease: "power1.out", immediateRender: false, onUpdate: apply }, at);
          ctx.tl.fromTo(h, { d: deg }, { d: 0, duration: 0.32, ease: "power1.inOut", immediateRender: false, onUpdate: apply }, at + 0.18);
        }
      },
      /** The mouth opens and closes as if speaking, from one time to another (about six times a second). */
      talk(els: Element | Element[], from: number, to: number) {
        for (const el of list(els)) {
          const svg = svgOf(el);
          if (!svg || !(to > from)) continue;
          let s = ctx.seed(`talk:${el.dataset.id || ""}:${from}`) % 2147483646 || 1;
          const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
          let open = true;
          for (let t = from; t < to; t += 0.11 + rnd() * 0.09) {
            const rest = FACES[faceAt(el, t)].mouth;
            showLayer(ctx, svg, "mouth", open ? "talk" : rest === "talk" ? "smile" : rest, t);
            open = !open;
          }
          showLayer(ctx, svg, "mouth", FACES[faceAt(el, to)].mouth, to);
        }
      },
    };
  },

  /** The blinks, once the script has set every face: the eyes close for 0.13 s every three to five and a half
   *  seconds (seeded), never next to a face change, never with eyes already shut or smiling, never in a thumbnail. */
  finish(ctx: KitCtx) {
    if (!manifestOf(ctx) || ctx.sceneId === "thumbnail") return;
    for (const el of Array.from(ctx.cam.querySelectorAll<HTMLElement>(".p-person"))) {
      const svg = el.querySelector(":scope > svg.t-svg");
      if (!svg || el.hasAttribute("data-still")) continue;
      const changes = (faceLog.get(el) ?? []).map((c) => c.at);
      let s = ctx.seed(el.dataset.id || el.dataset.person || "p") % 2147483646 || 1;
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let t = 1.2 + rnd() * 2; t < ctx.duration - 0.3; t += 3 + rnd() * 2.5) {
        const eyes = FACES[faceAt(el, t)].eyes;
        if (eyes === "happy" || eyes === "closed" || changes.some((c) => c > t - 0.3 && c < t + 0.4)) continue;
        showLayer(ctx, svg, "eyes", "closed", t);
        showLayer(ctx, svg, "eyes", eyes, t + 0.13);
      }
    }
  },
};
