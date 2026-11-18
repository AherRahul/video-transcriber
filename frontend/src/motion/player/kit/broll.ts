// B-roll clips (kit/broll.ts): a video or photo from the video's assets on a page, kept at the scene time, with
// a slow pan and zoom for photos.
//
//   <video class="p-broll" data-id="street" data-src="asset://street.mp4"></video>   a clip (class "full" for a
//   <img class="p-broll" data-id="desk" src="asset://desk.jpg">                       full-bleed shot)
//   fx.broll(el, at, {from, speed, until, fade})   shows it at `at`; its clip time is from + (t - at) * speed,
//                                                  held at `until` (a scene time) or at the clip's last frame
//   fx.kenburns(el, at, seconds, {from: {scale, x, y}, to: {...}})   a slow pan and zoom
//
// Frames are a pure function of time here too: nothing plays by itself. After every seek the runtime calls
// sync(), which puts each clip at its time. The export (exact) waits until the clip has seeked and that frame is
// on screen, so every exported frame shows the right picture of the clip. The preview plays the clip natively
// while the page's clock runs at normal speed (setting the time on every animation frame would stutter), and
// seeks it when the user scrubs. Clips are always silent: the narration is the sound.
//
// The uploads and stock imports are converted for this (backend/motion/broll.py): a keyframe every 10 frames,
// so a seek decodes a few frames at most.

import type { KitCtx, KitModule } from "./types";

type Plan = { at: number; from: number; speed: number; until: number };

const plans = new WeakMap<HTMLVideoElement, Plan>();
/** the clips the preview has touched: where each was last put, so a page left behind stops playing */
const live = new Map<HTMLVideoElement, { local: number; wall: number; target: number | null }>();

const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

function planOf(v: HTMLVideoElement): Plan {
  return plans.get(v) ?? { at: num(v.dataset.at, 0), from: num(v.dataset.from, 0), speed: num(v.dataset.speed, 1) || 1, until: num(v.dataset.until, Infinity) };
}

/** Where a clip's last frame can be shown: a little before its end (the last frame lasts one frame). */
function lastShown(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.02) : Infinity;
}

/**
 * The clip's own time at scene time `local`: `from` until `at`, then running at `speed`, held at `until` and at
 * the clip's end. A millisecond is added so the seek lands inside the frame meant (a frame starts at k / fps,
 * and a time a hair before it would show the frame before).
 */
export function clipTime(plan: Plan, local: number, duration: number): number {
  const run = Math.max(0, Math.min(local, plan.until) - plan.at);
  const t = plan.from + run * plan.speed + 0.001;
  return Math.max(0, Math.min(t, lastShown(duration)));
}

const twoFrames = (done: () => void) => requestAnimationFrame(() => requestAnimationFrame(() => done()));

/** Seeks a paused clip and resolves once the frame is on screen (seeked, then the frame presented). */
function seekExact(v: HTMLVideoElement, want: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // a clip that never answers (a broken file) must not hold the export forever
    const timer = setTimeout(finish, 8000);
    const go = () => {
      const t = Math.min(want, lastShown(v.duration));
      if (Math.abs(v.currentTime - t) < 1e-4 && !v.seeking && v.readyState >= 2) {
        twoFrames(finish);
        return;
      }
      let seeked = false;
      let shown = false;
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (rvfc) {
        rvfc.call(v, () => {
          shown = true;
          if (seeked) twoFrames(finish);
        });
      }
      v.addEventListener(
        "seeked",
        () => {
          seeked = true;
          if (shown || !rvfc) twoFrames(finish);
          // no new frame reported (the same picture as before): go on after a moment
          else setTimeout(() => twoFrames(finish), 150);
        },
        { once: true },
      );
      v.currentTime = t;
    };
    if (v.readyState >= 1) go();
    else {
      v.addEventListener("loadedmetadata", go, { once: true });
      v.addEventListener("error", finish, { once: true });
    }
  });
}

const CSS = `
.p-broll { display: block; width: 100%; height: 100%; object-fit: cover; background: #111; }
.p-broll[data-fit="contain"] { object-fit: contain; }
.p-broll.full { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
/* a frame that clips the shot (a slow zoom stays inside it) */
.p-shot { position: relative; overflow: hidden; }
.p-shot > .p-broll { position: absolute; inset: 0; }
.p-window .p-body > .p-broll { position: absolute; inset: 0; }
.p-window .p-body:has(> .p-broll) { position: relative; overflow: hidden; }
/* a white paper print, turned a little, with a hand-written caption under the picture */
.p-polaroid { position: absolute; background: #fff; padding: 18px 18px 14px; border: 4px solid var(--ink, #141414); border-radius: 8px;
  box-shadow: 10px 10px 0 var(--ink, #141414); transform: rotate(-2.5deg); }
.p-polaroid .p-shot { width: 100%; aspect-ratio: 16 / 9; border: 2px solid var(--ink, #141414); }
.p-polaroid .p-caption { font-family: var(--font-hand, cursive); font-size: 40px; line-height: 1.1; color: var(--ink, #141414); text-align: center; margin-top: 10px; }
`;

export const broll: KitModule = {
  name: "broll",
  css: CSS,

  prepare(ctx: KitCtx) {
    for (const el of Array.from(ctx.cam.querySelectorAll<HTMLElement>(".p-broll"))) {
      // a full-bleed shot sits under the frame on purpose: the layout check leaves it out
      if (el.classList.contains("full")) el.setAttribute("data-bleed", "");
      const src = el.getAttribute("data-src") || "";
      if (el instanceof HTMLImageElement) {
        if (src && !el.getAttribute("src")) el.src = src;
        continue;
      }
      if (!(el instanceof HTMLVideoElement)) continue;
      el.removeAttribute("controls");
      el.removeAttribute("autoplay");
      el.autoplay = false;
      el.loop = false;
      el.muted = true;
      el.defaultMuted = true;
      el.setAttribute("muted", "");
      el.playsInline = true;
      el.setAttribute("playsinline", "");
      el.disablePictureInPicture = true;
      el.setAttribute("disableremoteplayback", "");
      // only what is needed: the first frame now, the rest as the clip is seeked or played
      el.preload = "metadata";
      if (src && !el.getAttribute("src")) el.src = src;
      if (!el.getAttribute("src") && !el.querySelector("source")) ctx.errors.push(`Scene ${ctx.sceneId}: a p-broll clip has no data-src (asset://name.mp4)`);
    }
  },

  make(ctx: KitCtx) {
    const list = (els: Element | Element[] | null | undefined) => (Array.isArray(els) ? els : els ? [els] : []).filter(Boolean) as HTMLElement[];
    return {
      /** Shows a clip (or photo) at `at` and runs the clip on the scene's clock from `from` seconds into it. */
      broll(els: Element | Element[], at = 0, opts: { from?: number; speed?: number; until?: number; fade?: number } = {}) {
        const items = list(els);
        const speed = Number(opts.speed) > 0 ? Number(opts.speed) : 1;
        const until = Number.isFinite(Number(opts.until)) ? Number(opts.until) : Infinity;
        ctx.mark("broll", items, at);
        for (const el of items) {
          if (el instanceof HTMLVideoElement) plans.set(el, { at, from: Math.max(0, Number(opts.from) || 0), speed, until });
          const fade = Number.isFinite(Number(opts.fade)) ? Math.max(0, Number(opts.fade)) : 0.3;
          if (fade > 0) ctx.tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: fade, ease: "power1.out", immediateRender: true }, at);
          // a cut in (fade 0): fully there at `at` itself, hidden before it (from the start, nothing to hide)
          else if (at > 0) ctx.tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.001, immediateRender: true }, Math.max(0, at - 0.001));
        }
        // the timeline knows the shot is moving while it plays (the audit's still-stretch check sees it)
        const run = Number.isFinite(until) ? Math.max(0.1, until - at) : 6;
        ctx.tl.fromTo({ p: 0 }, { p: 0 }, { p: 1, duration: run, ease: "none" }, at);
      },

      /** A slow pan and zoom of a photo or a clip (inside a frame that clips it: p-shot, p-window, full). */
      kenburns(
        els: Element | Element[],
        at: number,
        seconds = 6,
        opts: { from?: { scale?: number; x?: number; y?: number }; to?: { scale?: number; x?: number; y?: number } } = {},
      ) {
        const a = { scale: 1, x: 0, y: 0, ...(opts.from ?? {}) };
        const b = { scale: 1.1, x: 0, y: 0, ...(opts.to ?? {}) };
        for (const el of list(els)) {
          ctx.tl.fromTo(el, { scale: a.scale, x: a.x, y: a.y, transformOrigin: "50% 50%" }, { scale: b.scale, x: b.x, y: b.y, duration: Math.max(0.1, seconds), ease: "none", immediateRender: true }, at);
        }
      },
    };
  },

  async ready(root: ParentNode) {
    const vids = Array.from(root.querySelectorAll<HTMLVideoElement>("video.p-broll"));
    await Promise.all(
      vids.map(
        (v) =>
          new Promise<void>((resolve) => {
            if (!v.getAttribute("src") && !v.querySelector("source")) return resolve();
            // the first frame shown: the clip at its start time (preload is metadata only)
            const show = () => {
              const t = clipTime(planOf(v), 0, v.duration);
              if (v.readyState >= 2 && Math.abs(v.currentTime - t) < 0.02) return resolve();
              v.addEventListener("seeked", () => resolve(), { once: true });
              v.currentTime = t;
            };
            v.addEventListener("error", () => resolve(), { once: true });
            if (v.readyState >= 1) show();
            else v.addEventListener("loadedmetadata", show, { once: true });
          }),
      ),
    );
  },

  sync(root: ParentNode, local: number, exact: boolean) {
    const now = performance.now();
    // a page the preview has left: its clips stop playing
    for (const [v, st] of live) {
      if (!v.isConnected || (!root.contains(v) && now - st.wall > 250)) {
        if (!v.paused) v.pause();
        live.delete(v);
      }
    }
    const vids = Array.from(root.querySelectorAll<HTMLVideoElement>("video.p-broll"));
    if (!vids.length) return null;
    const waits: Promise<void>[] = [];
    for (const v of vids) {
      const plan = planOf(v);
      const target = clipTime(plan, local, v.duration);
      const st = live.get(v);
      if (exact) {
        // the export: paused, at exactly this frame, and the capture waits for it
        if (!v.paused) v.pause();
        const same = st && st.target !== null && Math.abs(st.target - target) < 1e-6 && v.readyState >= 2 && !v.seeking;
        if (!same) waits.push(seekExact(v, target));
      } else {
        const dl = st ? local - st.local : -1;
        const dw = st ? (now - st.wall) / 1000 : 0;
        // the page's clock is running at about real time (playing), not being scrubbed
        const advancing = dl > 0 && dl < 0.5 && Math.abs(dl - dw) < 0.2;
        const running = local >= plan.at && local < plan.until && target < lastShown(v.duration) - 0.03;
        if (advancing && running) {
          if (v.playbackRate !== plan.speed) v.playbackRate = plan.speed;
          if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
          if (v.paused) void v.play().catch(() => undefined);
        } else {
          if (!v.paused) v.pause();
          if (!v.seeking && Math.abs(v.currentTime - target) > 0.02 && v.readyState >= 1) v.currentTime = target;
        }
      }
      live.set(v, { local, wall: now, target });
    }
    return waits.length ? Promise.all(waits).then(() => undefined) : null;
  },
};
