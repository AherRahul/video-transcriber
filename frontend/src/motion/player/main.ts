// Entry point of motion-player.html, the page that draws a Motion video.
//
//   ?mode=preview  inside the editor's sandboxed iframe: scaled to fit, driven by postMessage
//                  (load, seek, comment mode, safe-area guides), reports clicks for comments.
//   ?mode=render   in headless Edge/Chrome for frame checks and the MP4 export: the stage at 1:1,
//                  driven through window.MotionPlayer by Playwright.

import type { Bundle, FromPlayer, ToPlayer } from "../types";
import { Runtime, safeInsets } from "./runtime";

const mode = new URLSearchParams(location.search).get("mode") === "render" ? "render" : "preview";
document.documentElement.dataset.mode = mode;

const stage = document.getElementById("stage") as HTMLDivElement;
const runtime = new Runtime(stage);

declare global {
  interface Window {
    MotionPlayer: {
      ready: boolean;
      load: (b: Bundle) => Promise<{ duration: number; errors: string[]; version: number }>;
      seek: (t: number) => void;
      seekScene: (id: string, local: number) => void;
      /** seekScene for the export: whether the frame may differ from the one this page showed before (false
       *  only when the page is exactly as it was, so the export reuses that frame); fresh starts a new run */
      seekFrame: (id: string, local: number, fresh: boolean) => boolean | Promise<boolean>;
      /** resolves once the page shows the moment last seeked to (a b-roll clip has found its frame) */
      settle: () => Promise<void>;
      diagnose: Runtime["diagnose"];
      sfx: Runtime["sfx"];
      /** the audit's timing report for one scene: {gaps, late} (see Runtime.timing) */
      timing: Runtime["timing"];
    };
  }
}

// the page's state at the frame before, for seekFrame (one run of frames per page at a time)
let lastFrame: string | null = null;

window.MotionPlayer = {
  ready: true,
  load: (b) => runtime.load(b),
  seek: (t) => runtime.seek(t),
  seekScene: (id, local) => runtime.seekScene(id, local),
  seekFrame: (id, local, fresh) => {
    runtime.seekScene(id, local);
    const compare = () => {
      const state = runtime.frameState();
      const same = !fresh && state !== null && state === lastFrame;
      lastFrame = state;
      return !same;
    };
    // a page with a b-roll clip answers once the clip shows the right frame
    const wait = runtime.settled();
    return wait ? wait.then(compare) : compare();
  },
  settle: () => runtime.settled() ?? Promise.resolve(),
  diagnose: (id, local) => runtime.diagnose(id, local),
  sfx: () => runtime.sfx(),
  timing: (id) => runtime.timing(id),
};

if (mode === "preview") startPreview();

function startPreview() {
  const guides = document.getElementById("guides") as HTMLDivElement;
  const hover = document.getElementById("hover") as HTMLDivElement;
  let scale = 1;
  let commentMode = false;
  let showGuides = false;

  const post = (msg: FromPlayer) => window.parent.postMessage(msg, "*");

  // fit the stage into the frame
  const fit = () => {
    const b = runtime.bundle;
    const w = b?.width ?? 1080;
    const h = b?.height ?? 1920;
    scale = Math.min(window.innerWidth / w, window.innerHeight / h);
    const ox = (window.innerWidth - w * scale) / 2;
    const oy = (window.innerHeight - h * scale) / 2;
    stage.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    guides.style.transform = stage.style.transform;
    if (b) {
      const s = safeInsets(b.aspect, w, h);
      Object.assign(guides.style, { width: `${w}px`, height: `${h}px` });
      const inner = guides.firstElementChild as HTMLDivElement;
      Object.assign(inner.style, { top: `${s.top}px`, right: `${s.right}px`, bottom: `${s.bottom}px`, left: `${s.left}px` });
    }
  };
  window.addEventListener("resize", fit);

  // the element under the pointer, for comments
  const target = (e: MouseEvent) => runtime.pick(e.composedPath());
  stage.addEventListener("mousemove", (e) => {
    if (!commentMode) return;
    const hit = target(e);
    const el = hit?.elementId ? (e.composedPath().find((n) => n instanceof Element && n.getAttribute("data-id") === hit.elementId) as Element | undefined) : undefined;
    if (!el) {
      hover.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(hover.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    hover.dataset.label = hit!.elementId!;
  });
  stage.addEventListener("mouseleave", () => (hover.style.display = "none"));
  stage.addEventListener("click", (e) => {
    if (!commentMode) return;
    const hit = target(e);
    if (hit) post({ type: "pick", sceneId: hit.sceneId, elementId: hit.elementId, label: hit.label, x: e.clientX, y: e.clientY });
  });

  // keys pressed inside the frame go to the editor (space to play, arrows to step)
  window.addEventListener("keydown", (e) => {
    if ([" ", "ArrowLeft", "ArrowRight", "Home", "End", ",", "."].includes(e.key)) {
      e.preventDefault();
      post({ type: "key", key: e.key });
    }
  });

  let loading = Promise.resolve();
  window.addEventListener("message", (e: MessageEvent<ToPlayer>) => {
    if (e.source !== window.parent || !e.data || typeof e.data !== "object") return;
    const msg = e.data;
    if (msg.type === "load") {
      // loads run one after another, so a quick second edit never races the first
      loading = loading.then(async () => {
        const res = await runtime.load(msg.bundle);
        fit();
        post({ type: "loaded", version: res.version, duration: res.duration, errors: res.errors, sfx: runtime.sfx() });
      });
    } else if (msg.type === "seek") {
      runtime.seek(msg.t);
    } else if (msg.type === "comment") {
      commentMode = msg.on;
      document.documentElement.classList.toggle("commenting", commentMode);
      if (!commentMode) hover.style.display = "none";
    } else if (msg.type === "guides") {
      showGuides = msg.on;
      guides.style.display = showGuides ? "block" : "none";
    } else if (msg.type === "highlight") {
      const b = runtime.built.find((x) => x.scene.id === msg.sceneId);
      const el = msg.elementId ? b?.root.querySelector(`[data-id="${CSS.escape(msg.elementId)}"]`) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        Object.assign(hover.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        hover.dataset.label = msg.elementId!;
      } else hover.style.display = "none";
    }
  });
  fit();
  post({ type: "ready" });
}
