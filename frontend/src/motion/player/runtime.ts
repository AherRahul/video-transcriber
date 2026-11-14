// The Motion player: turns a bundle (brand + scenes as code) into a stage that can show any moment.
//
// Every frame is a pure function of time: scenes are built once, each with a paused GSAP timeline, and
// `seek(t)` sets every timeline to the right moment. The preview calls it every animation frame; the
// export calls it once per output frame. Nothing here plays on its own, so the MP4 matches the preview.
//
// Narration: each scene carries its cue times (estimated before the voice exists, measured after), and
// scene code pins animations to them with cue(n), so generating the voice re-times every scene for free.
//
// The scene contract (what Claude writes) is described in backend/motion/prompts.py; keep them in sync.

import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { SplitText } from "gsap/SplitText";
import { TextPlugin } from "gsap/TextPlugin";

import type { Brand, Bundle, BundleScene, PropValue } from "../types";
import {
  PAPER_CSS,
  arrowTips,
  buildChrome,
  buildLabel,
  endScreen,
  makeFx,
  paperEndScreen,
  seedOf,
  tearClip,
  tearEase,
  tearEdges,
  tearEdgeSvg,
  tearEdgeTransform,
  type Chrome,
  type SfxEvent,
} from "./paper";

gsap.registerPlugin(SplitText, DrawSVGPlugin, MotionPathPlugin, MorphSVGPlugin, CustomEase, TextPlugin);
gsap.ticker.lagSmoothing(0);

/** How long a page change takes, as in the films (650 ms). The narration starts after it. */
export const TRANSITION_SECONDS = 0.65;

const SYSTEM_FONTS = new Set(
  [
    "system-ui", "segoe ui", "arial", "helvetica", "helvetica neue", "georgia", "times new roman", "courier new",
    "verdana", "tahoma", "trebuchet ms", "consolas", "calibri", "cambria", "impact", "comic sans ms",
    "sans-serif", "serif", "monospace", "ui-monospace", "-apple-system",
  ],
);

/** Safe area per aspect, as fractions: top, right, bottom, left. 9:16 leaves room for platform buttons. */
export function safeInsets(aspect: string, w: number, h: number) {
  const f = aspect === "9:16" ? [0.08, 0.06, 0.14, 0.06] : aspect === "16:9" ? [0.05, 0.05, 0.05, 0.05] : [0.06, 0.06, 0.06, 0.06];
  return { top: Math.round(f[0] * h), right: Math.round(f[1] * w), bottom: Math.round(f[2] * h), left: Math.round(f[3] * w) };
}

/** The paper look's fixed zones (design units) and its content box. */
const PAPER_ZONES: { name: string; r: [number, number, number, number] }[] = [
  { name: "logo", r: [0, 0, 320, 130] },
  { name: "label", r: [330, 40, 1170, 140] },
  { name: "title", r: [1100, 0, 1600, 140] },
  { name: "narrator corner", r: [0, 748, 236, 900] },
];
const PAPER_CONTENT: [number, number, number, number] = [140, 150, 1460, 849];
const CROWD = 18; // two blocks of words closer than this (stage px) look like they touch
/** The brand as the frame reads it: the video's settings say whether the logo card and web address show. */
type FrameBrand = { showLogo?: boolean; showUrl?: boolean };

export function motionPresets(kind: string) {
  return kind === "smooth"
    ? { ease: "power2.out", easeIn: "power1.in", dur: 0.8, stagger: 0.12, pop: "back.out(1.2)" }
    : { ease: "power3.out", easeIn: "power2.in", dur: 0.45, stagger: 0.06, pop: "back.out(1.7)" };
}

const BASE_CSS = `
:host { all: initial; }
.scene-root {
  position: absolute; left: 0; top: 0; width: var(--stage-w); height: var(--stage-h); overflow: hidden;
  background: var(--bg-layer); color: var(--ink); font-family: var(--font-body); font-size: 48px; line-height: 1.2;
  -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; box-sizing: border-box;
}
.scene-root *, .scene-root *::before, .scene-root *::after { box-sizing: border-box; }
h1, h2, h3, h4, h5, h6, p, figure, blockquote, ul, ol { margin: 0; padding: 0; }
img, svg, video { display: block; }
.safe { position: absolute; top: var(--safe-top); right: var(--safe-right); bottom: var(--safe-bottom); left: var(--safe-left); }
.display { font-family: var(--font-display); font-weight: 800; letter-spacing: -0.02em; line-height: 1.02; }
.mono { font-family: var(--font-mono); }
.motion-planned {
  position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 28px;
  padding: 0 12%; color: var(--muted);
}
.motion-planned .pl-tag { font: 600 26px/1 var(--font-body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent2, var(--accent)); }
.motion-planned .pl-name { font: 800 72px/1.05 var(--font-display); color: var(--ink); }
.motion-planned .pl-idea { font: 400 34px/1.3 var(--font-body); max-width: 90%; }
.motion-planned .pl-say { font: 500 26px/1.4 var(--font-body); max-width: 90%; opacity: 0.85; border-left: 4px solid var(--accent2, var(--accent)); padding-left: 16px; }
.motion-error {
  position: absolute; left: 4%; right: 4%; bottom: 4%; padding: 24px 28px; border-radius: 16px; z-index: 99;
  background: #2b0b0b; color: #ffb4a8; border: 3px solid #ff6b5b; font: 500 26px/1.35 ui-monospace, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
}
.mo-shade { position: absolute; inset: 0; pointer-events: none; z-index: 999; opacity: 0; }
`;

type Built = {
  scene: BundleScene;
  host: HTMLDivElement;
  root: HTMLDivElement;
  shade: HTMLDivElement;
  tl: gsap.core.Timeline;
  errors: string[];
  sfx: SfxEvent[];
};

export type Diagnosis = {
  sceneId: string;
  t: number;
  errors: string[];
  visible: { id: string; text: string }[];
  offStage: string[];
  outsideSafe: string[];
  inZone: string[];
  overlaps: [string, string][];
  crowded: [string, string][];
  smallText: { id: string; px: number }[];
  words: number;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A small seeded random generator (mulberry32), so "random" layouts are the same on every render. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fontStack(name: string, kind: "display" | "body" | "mono" | "hand"): string {
  const fallback = kind === "mono" ? "ui-monospace, Consolas, monospace" : kind === "hand" ? "'Comic Sans MS', cursive" : "system-ui, 'Segoe UI', sans-serif";
  return name ? `"${name.replace(/"/g, "")}", ${fallback}` : fallback;
}

export class Runtime {
  stage: HTMLDivElement;
  bundle: Bundle | null = null;
  built: Built[] = [];
  errors: string[] = [];
  chrome: Chrome | null = null;
  private tearEdge: SVGSVGElement | null = null;
  private fontCss = new Map<string, Promise<void>>();
  private fontStyle: HTMLStyleElement;
  private loadToken = 0;
  private fontErrors: string[] = [];
  private lastT = 0;

  constructor(stage: HTMLDivElement) {
    this.stage = stage;
    this.fontStyle = document.createElement("style");
    document.head.appendChild(this.fontStyle);
  }

  get duration(): number {
    return this.bundle?.duration ?? 0;
  }

  get paper(): boolean {
    return this.bundle?.theme === "paper";
  }

  /** Builds (or rebuilds) every scene from the bundle. Resolves once fonts and images are ready. */
  async load(bundle: Bundle): Promise<{ duration: number; errors: string[]; version: number }> {
    const token = ++this.loadToken;
    this.applyBrand(bundle);
    await this.loadFonts(bundle.brand);
    if (token !== this.loadToken) return { duration: bundle.duration, errors: [], version: bundle.version };
    for (const b of this.built) {
      b.tl.kill();
      b.host.remove();
    }
    this.built = [];
    this.errors = document.documentElement.dataset.mode === "render" ? [...this.fontErrors] : [];
    this.bundle = bundle;
    this.chrome?.root.remove();
    this.chrome = null;
    this.tearEdge?.remove();
    this.tearEdge = null;
    if (bundle.theme === "paper") {
      const brand = bundle.brand;
      this.chrome = buildChrome(this.stage, {
        title: bundle.title,
        wordmark: brand.wordmark || brand.name,
        tagline: brand.tagline || "",
        iconUrl: brand.iconUrl,
        // the video's settings: a Udemy film shows neither our logo card nor our web address
        url: (brand as FrameBrand).showUrl === false ? "" : brand.endCard?.url || "",
        showLogo: (brand as FrameBrand).showLogo !== false,
        grainUrl: `${bundle.themeBase}paper/grain.png`,
      });
      this.tearEdge = tearEdgeSvg();
      this.stage.appendChild(this.tearEdge);
    }
    for (const scene of bundle.scenes) {
      const b = this.build(bundle, scene);
      this.built.push(b);
      this.errors.push(...b.errors);
    }
    await this.imagesReady();
    this.seek(Math.min(this.lastT, bundle.duration));
    return { duration: bundle.duration, errors: this.errors, version: bundle.version };
  }

  private applyBrand(bundle: Bundle) {
    const b: Brand = bundle.brand;
    const s = document.documentElement.style;
    for (const [k, v] of Object.entries(b.palette)) s.setProperty(`--${k}`, v);
    for (const [k, v] of Object.entries(b.extras ?? {})) s.setProperty(`--c-${k}`, v);
    s.setProperty("--font-display", fontStack(b.fonts.display, "display"));
    s.setProperty("--font-body", fontStack(b.fonts.body, "body"));
    s.setProperty("--font-mono", fontStack(b.fonts.mono, "mono"));
    s.setProperty("--font-hand", fontStack(b.fonts.hand || "Caveat", "hand"));
    s.setProperty("--radius", `${b.radius}px`);
    const paper = bundle.theme === "paper";
    s.setProperty(
      "--bg-layer",
      paper ? `url("${bundle.themeBase}paper/paper-grid.svg") 0 0 / 100% 100% no-repeat, ${b.palette.bg}` : b.background ? `${b.background}, ${b.palette.bg}` : b.palette.bg,
    );
    s.setProperty("--stage-w", `${bundle.width}px`);
    s.setProperty("--stage-h", `${bundle.height}px`);
    const safe = paper ? { top: 150, right: 140, bottom: 51, left: 140 } : safeInsets(bundle.aspect, bundle.width, bundle.height);
    s.setProperty("--safe-top", `${safe.top}px`);
    s.setProperty("--safe-right", `${safe.right}px`);
    s.setProperty("--safe-bottom", `${safe.bottom}px`);
    s.setProperty("--safe-left", `${safe.left}px`);
    this.stage.style.width = `${bundle.width}px`;
    this.stage.style.height = `${bundle.height}px`;
  }

  /** The kit's fonts (system fonts are used as they are). The preview waits up to 6 s; a render waits up to
   * 30 s and reports any family that didn't load, so an export never mixes fallback and brand fonts. */
  private async loadFonts(brand: Brand) {
    const families = [...new Set([brand.fonts.display, brand.fonts.body, brand.fonts.mono, brand.fonts.hand].filter(Boolean) as string[])];
    const jobs = families
      .filter((f) => !SYSTEM_FONTS.has(f.toLowerCase()))
      .map((family) => {
        if (!this.fontCss.has(family)) this.fontCss.set(family, this.fetchFontCss(family));
        return this.fontCss.get(family)!;
      });
    const render = document.documentElement.dataset.mode === "render";
    const timeout = new Promise<void>((r) => setTimeout(r, render ? 30000 : 6000));
    await Promise.race([
      (async () => {
        await Promise.all(jobs);
        const loads: Promise<unknown>[] = [];
        for (const f of families) for (const w of [400, 500, 700, 800]) loads.push(document.fonts.load(`${w} 40px "${f}"`).catch(() => null));
        await Promise.all(loads);
        await document.fonts.ready;
      })(),
      timeout,
    ]);
    this.fontErrors = families
      .filter((f) => !SYSTEM_FONTS.has(f.toLowerCase()))
      .filter((f) => !document.fonts.check(`800 40px "${f}"`) && !document.fonts.check(`400 40px "${f}"`))
      .map((f) => `The font "${f}" didn't load (offline, or not a Google Font); the frames would use a fallback font.`);
  }

  private async fetchFontCss(family: string): Promise<void> {
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    // the app keeps a copy of each Google font on this computer: fast and the same in every frame
    try {
      const res = await fetch(`/api/motion/fonts.css?family=${name}`);
      if (res.ok) {
        this.fontStyle.textContent += "\n" + (await res.text());
        return;
      }
    } catch {
      /* the app is not reachable (a static preview): try Google directly */
    }
    const urls = [
      `https://fonts.googleapis.com/css2?family=${name}:wght@400;500;600;700;800&display=block`,
      `https://fonts.googleapis.com/css2?family=${name}:wght@400;700&display=block`,
      `https://fonts.googleapis.com/css2?family=${name}&display=block`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          this.fontStyle.textContent += "\n" + (await res.text());
          return;
        }
      } catch {
        return; // offline: the fallback fonts are used
      }
    }
  }

  private async imagesReady() {
    const imgs: HTMLImageElement[] = [];
    for (const b of this.built) imgs.push(...Array.from(b.root.querySelectorAll("img")));
    if (this.chrome) imgs.push(...Array.from(this.chrome.root.querySelectorAll("img")));
    await Promise.race([
      Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => null)))),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  }

  private resolveAssets(text: string, base: string): string {
    return text.replace(/asset:\/\/([A-Za-z0-9._-]+)/g, (_, name: string) => base + encodeURIComponent(name));
  }

  private build(bundle: Bundle, scene: BundleScene): Built {
    const errors: string[] = [];
    const sfx: SfxEvent[] = [];
    const paper = bundle.theme === "paper";
    const host = document.createElement("div");
    host.className = "scene-host";
    host.dataset.scene = scene.id;
    // Built laid out but unseen (display:none comes after the script): GSAP reads each element's CSS
    // transform when it first animates it, and inside display:none every tilt reads as 0, so a stamp
    // landed flat and tilted stickies and tags lost their turn. Arrow tips need the layout too.
    host.style.cssText = "position:absolute;left:0;top:0;display:block;visibility:hidden;";
    host.style.width = `${bundle.width}px`;
    host.style.height = `${bundle.height}px`;
    const shadow = host.attachShadow({ mode: "open" });

    // props with asset:// links resolved
    const props: Record<string, PropValue> = {};
    for (const [k, v] of Object.entries(scene.props ?? {})) {
      props[k] = typeof v === "string" ? this.resolveAssets(v, bundle.assetBase) : v;
    }
    const brand = bundle.brand;
    const lookup = (key: string): string => {
      const parts = key.split(".");
      if (parts[0] === "brand") {
        if (parts[1] === "logo") return brand.logoUrl ?? "";
        if (parts[1] === "icon") return brand.iconUrl ?? "";
        let cur: unknown = brand;
        for (const p of parts.slice(1)) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
        return cur == null ? "" : String(cur);
      }
      const v = props[key];
      if (v === undefined) {
        errors.push(`Scene ${scene.id}: no prop for {{${key}}}`);
        return "";
      }
      return Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
    };

    let css = "";
    let script = "";
    let markup = "";
    if (scene.kind === "endscreen") {
      const opts = { wordmark: brand.wordmark || brand.name, tagline: brand.tagline || "", iconUrl: brand.iconUrl, url: brand.endCard?.url || "", props };
      if (paper) {
        // the paper look's own end screen: the logo card, a marker stroke, ink cards and red pen
        const es = paperEndScreen(opts);
        css = es.css;
        markup = es.markup;
        script = es.script;
      } else {
        const es = endScreen(opts);
        css = es.css;
        markup = es.markup;
        script = `tl.fromTo($$('.es > *:not(.es-frame)'), { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power2.out', stagger: 0.05 }, cue(0));`;
      }
    } else if (scene.source) {
      const src = this.resolveAssets(scene.source, bundle.assetBase);
      css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
      script = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n;\n");
      markup = src.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
      markup = markup.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k: string) => escapeHtml(lookup(k)));
      css = css.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k: string) => lookup(k).replace(/[<>{};]/g, ""));
    } else {
      const say = (scene.narration || "").replace(/<\s*cue\s*\/?\s*>/gi, " ").trim();
      markup = `<div class="motion-planned"><div class="pl-tag">Planned scene</div><div class="pl-name">${escapeHtml(scene.name)}</div><div class="pl-idea">${escapeHtml(scene.idea || "")}</div>${say ? `<div class="pl-say">${escapeHtml(say.slice(0, 220))}${say.length > 220 ? "…" : ""}</div>` : ""}</div>`;
    }
    shadow.innerHTML = `<style>${BASE_CSS}${paper ? PAPER_CSS : ""}</style><style>${css}</style><div class="scene-root">${markup}<div class="mo-shade"></div></div>`;
    const root = shadow.querySelector(".scene-root") as HTMLDivElement;
    const shade = shadow.querySelector(".mo-shade") as HTMLDivElement;
    this.stage.insertBefore(host, this.chrome?.root ?? null);

    const tl = gsap.timeline({ paused: true });
    const cues = scene.cues?.length ? scene.cues : [scene.lead ?? TRANSITION_SECONDS];
    const voiceStart = cues[0];
    const voiceEnd = (scene.lead ?? voiceStart) + (scene.speech ?? 0);
    const cue = (n: number, plus = 0): number => {
      const i = Math.max(0, Math.floor(Number(n) || 0));
      if (i >= cues.length) {
        errors.push(`Scene ${scene.id}: cue(${i}) but the narration has ${cues.length - 1} <cue/> mark${cues.length === 2 ? "" : "s"}`);
        return Math.max(0, voiceEnd - 0.3) + plus;
      }
      return Math.max(0, cues[i] + plus);
    };
    const fx = makeFx(tl, scene.id, sfx);

    // the paper page's label, torn on as the voice starts
    if (paper && scene.kind !== "endscreen" && scene.label) {
      const label = buildLabel(root, scene.label, seedOf(scene.id));
      fx.tearOn(label, Math.max(0.15, voiceStart - 0.1));
    }
    if (paper) tearEdges(root, scene.id);
    arrowTips(root); // tips for "p-arrow head" paths, before the script pins them to the timeline

    if (script.trim()) {
      const $ = (id: string): HTMLElement => {
        const el = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!el) throw new Error(`No element with data-id="${id}"`);
        return el as HTMLElement;
      };
      const $$ = (sel: string): HTMLElement[] => Array.from(root.querySelectorAll(sel)) as HTMLElement[];
      const random = seeded(hashString(bundle.projectId + ":" + scene.id));
      const asset = (name: string) => bundle.assetBase + encodeURIComponent(name);
      try {
        const run = new Function(
          "tl", "$", "$$", "root", "props", "brand", "duration", "stage", "random", "asset", "motion", "cue", "voiceStart", "voiceEnd", "fx",
          "gsap", "SplitText", "DrawSVGPlugin", "MotionPathPlugin", "MorphSVGPlugin", "CustomEase", "TextPlugin",
          '"use strict";\n' + script,
        );
        run(
          tl, $, $$, root, props, brand, scene.duration, { width: bundle.width, height: bundle.height }, random, asset, motionPresets(brand.motion),
          cue, voiceStart, voiceEnd, fx, gsap, SplitText, DrawSVGPlugin, MotionPathPlugin, MorphSVGPlugin, CustomEase, TextPlugin,
        );
      } catch (err) {
        errors.push(`Scene ${scene.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // the page change's own sound, at the start of the scene
    if (scene.transition === "tear") sfx.push({ sceneId: scene.id, t: 0, name: "rip", gain: 1 });
    if (scene.transition === "turn") sfx.push({ sceneId: scene.id, t: 0, name: "page", gain: 1 });
    if (errors.length) {
      const box = document.createElement("div");
      box.className = "motion-error";
      box.textContent = errors.join("\n");
      root.appendChild(box);
    }
    host.style.display = "none";
    host.style.visibility = "";
    return { scene, host, root, shade, tl, errors, sfx };
  }

  /** Every sound effect the scenes asked for, in scene-local seconds (the export mixes them). */
  sfx(): SfxEvent[] {
    return this.built.flatMap((b) => b.sfx.filter((e) => e.t <= b.scene.duration));
  }

  /** Index of the scene playing at time t (the last scene holds its final frame at the very end). */
  indexAt(t: number): number {
    const scenes = this.bundle?.scenes ?? [];
    for (let i = 0; i < scenes.length; i++) {
      if (t < scenes[i].start + scenes[i].duration) return i;
    }
    return scenes.length - 1;
  }

  seek(t: number) {
    this.lastT = t;
    if (!this.bundle || !this.built.length) return;
    const i = this.indexAt(Math.max(0, t));
    this.show(i, Math.max(0, t - this.bundle.scenes[i].start));
  }

  seekScene(id: string, local: number) {
    const i = this.built.findIndex((b) => b.scene.id === id);
    if (i < 0) throw new Error(`No scene ${id}`);
    this.lastT = this.built[i].scene.start + local;
    this.show(i, local);
  }

  /** Shows scene i at its local time; during its page change the previous scene's last frame takes part. */
  private show(i: number, local: number) {
    const cur = this.built[i];
    const dur = cur.scene.duration;
    const tdur = Math.min(TRANSITION_SECONDS, dur * 0.5);
    let kind = cur.scene.transition;
    const inTransition = kind !== "cut" && local < tdur;
    const prev = inTransition && i > 0 ? this.built[i - 1] : null;
    if (!prev && (kind === "tear" || kind === "turn")) kind = "fade"; // the first page arrives from the paper
    for (const b of this.built) {
      const visible = b === cur || b === prev;
      b.host.style.display = visible ? "block" : "none";
      b.host.style.opacity = "";
      b.host.style.transform = "";
      b.host.style.transformOrigin = "";
      b.host.style.clipPath = "";
      b.host.style.zIndex = b === cur ? "2" : "1";
      b.shade.style.opacity = "0";
    }
    if (this.tearEdge) this.tearEdge.style.display = "none";
    if (prev) prev.tl.time(prev.scene.duration, false);
    cur.tl.time(Math.min(local, dur), false);
    if (this.chrome) {
      this.chrome.setPart(cur.scene.part || "");
      this.chrome.setVisible(!(cur.scene.kind === "endscreen" && (!inTransition || local > tdur * 0.5)));
    }
    if (!inTransition) return;
    const x = local / tdur;
    const h = cur.host.style;
    const p = gsap.parseEase("power2.inOut")(x);
    if (kind === "fade") h.opacity = String(gsap.parseEase("sine.inOut")(x));
    else if (kind === "slide-up") h.transform = `translateY(${(1 - p) * 100}%)`;
    else if (kind === "slide-left") h.transform = `translateX(${(1 - p) * 100}%)`;
    else if (kind === "zoom") {
      h.transform = `scale(${0.92 + 0.08 * p})`;
      h.opacity = String(p);
    } else if (kind === "wipe") h.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
    else if (kind === "tear" && prev) {
      // the old page on top, ripped away left to right; its torn edge and strip ride on the tear
      const e = tearEase(x);
      prev.host.style.zIndex = "3";
      prev.host.style.clipPath = tearClip(e);
      if (this.tearEdge) {
        this.tearEdge.style.display = "block";
        this.tearEdge.style.transform = tearEdgeTransform(e);
      }
    } else if (kind === "turn" && prev) {
      // the old page turns over about its left edge, darkening as it goes edge-on; the new page's shadow lifts
      const e = gsap.parseEase("sine.inOut")(x);
      prev.host.style.zIndex = "3";
      prev.host.style.transformOrigin = "0 50%";
      prev.host.style.transform = `perspective(5200px) rotateY(${(-90 * e).toFixed(3)}deg)`;
      prev.shade.style.background = "linear-gradient(90deg, rgba(0,0,0,.04), rgba(0,0,0,.42))";
      prev.shade.style.opacity = String(gsap.parseEase("power1.in")(x));
      cur.shade.style.background = "linear-gradient(90deg, rgba(0,0,0,.32), rgba(0,0,0,.1) 45%, rgba(0,0,0,0) 80%)";
      cur.shade.style.opacity = String(1 - gsap.parseEase("power1.in")(x));
    }
    if (kind === "tear" || kind === "turn") {
      if (prev) prev.host.style.display = "block";
    }
  }

  /** The scene element under a point, for comments. */
  pick(path: EventTarget[]): { sceneId: string; elementId: string | null; label: string } | null {
    let elementId: string | null = null;
    let label = "";
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (!elementId && node.hasAttribute("data-id")) {
        elementId = node.getAttribute("data-id");
        label = ownText(node).slice(0, 120);
      }
      if (node instanceof HTMLElement && node.classList.contains("scene-host")) {
        return { sceneId: node.dataset.scene!, elementId, label };
      }
    }
    return null;
  }

  /** Layout report for Claude: what is visible and what looks wrong at this moment. */
  diagnose(id: string, local: number): Diagnosis {
    this.seekScene(id, local);
    const b = this.built.find((x) => x.scene.id === id)!;
    const bundle = this.bundle!;
    const W = bundle.width;
    const H = bundle.height;
    const paper = bundle.theme === "paper";
    const safe = paper ? { left: PAPER_CONTENT[0], top: PAPER_CONTENT[1], right: W - PAPER_CONTENT[2], bottom: H - PAPER_CONTENT[3] } : safeInsets(bundle.aspect, W, H);
    const stageRect = this.stage.getBoundingClientRect();
    const scale = stageRect.width / W || 1;
    const minPx = paper ? 22 : Math.round(Math.min(W, H) * 0.028);
    const out: Diagnosis = { sceneId: id, t: local, errors: [...b.errors], visible: [], offStage: [], outsideSafe: [], inZone: [], overlaps: [], crowded: [], smallText: [], words: 0 };
    if (b.scene.kind === "endscreen") return out;
    type Item = { id: string; el: Element; r: { x: number; y: number; w: number; h: number }; text: string };
    const texts: Item[] = [];
    for (const el of Array.from(b.root.querySelectorAll("[data-id]"))) {
      const rr = el.getBoundingClientRect();
      if (rr.width < 0.5 || rr.height < 0.5 || effectiveOpacity(el, b.root) < 0.05) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = { x: (rr.left - stageRect.left) / scale, y: (rr.top - stageRect.top) / scale, w: rr.width / scale, h: rr.height / scale };
      const id2 = el.getAttribute("data-id")!;
      const isFrame = id2 === "frame-label";
      const text = ownText(el);
      out.visible.push({ id: id2, text: text.slice(0, 40) });
      if (isFrame || el.hasAttribute("data-bleed")) continue;
      const big = r.w * r.h > W * H * 0.5; // a page-wide wrapper or decoration layer: its children are checked instead
      if (!big && (r.x < -2 || r.y < -2 || r.x + r.w > W + 2 || r.y + r.h > H + 2)) out.offStage.push(id2);
      if (paper && !big) {
        // the films' own recording window reaches into the narrator corner, so there only words, pictures
        // and small pieces count; the other zones take nothing at all
        const small = r.w * r.h < 400 * 300;
        const direct = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim());
        for (const z of PAPER_ZONES) {
          if (z.name === "narrator corner" && !(direct || el.tagName.toLowerCase() === "img" || small)) continue;
          const ix = Math.min(r.x + r.w, z.r[2]) - Math.max(r.x, z.r[0]);
          const iy = Math.min(r.y + r.h, z.r[3]) - Math.max(r.y, z.r[1]);
          if (ix > 4 && iy > 4) out.inZone.push(`${id2} (${z.name})`);
        }
      }
      const isImg = el.tagName.toLowerCase() === "img";
      if (!text && !isImg && !paper) continue;
      if (!big && (text || isImg || paper) && (r.x < safe.left - 4 || r.y < safe.top - 4 || r.x + r.w > W - safe.right + 4 || r.y + r.h > H - safe.bottom + 4)) {
        if (!out.offStage.includes(id2)) out.outsideSafe.push(id2);
      }
      if (text) {
        texts.push({ id: id2, el, r, text });
        out.words += text.split(/\s+/).filter(Boolean).length;
        const px = (parseFloat(cs.fontSize) * (rr.width / Math.max(1, (el as HTMLElement).offsetWidth || rr.width))) / scale;
        if (px && px < minPx) out.smallText.push({ id: id2, px: Math.round(px) });
      }
    }
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i];
        const c = texts[j];
        if (a.el.contains(c.el) || c.el.contains(a.el)) continue;
        const ix = Math.max(0, Math.min(a.r.x + a.r.w, c.r.x + c.r.w) - Math.max(a.r.x, c.r.x));
        const iy = Math.max(0, Math.min(a.r.y + a.r.h, c.r.y + c.r.h) - Math.max(a.r.y, c.r.y));
        const smaller = Math.min(a.r.w * a.r.h, c.r.w * c.r.h);
        if (smaller > 0 && (ix * iy) / smaller > 0.12) {
          out.overlaps.push([a.id, c.id]);
          continue;
        }
        // Side by side or one above the other, but closer than CROWD px: they read as touching (a card's
        // hard shadow alone takes 10 px). Measured on the axis where they are apart, when they share the other.
        const gapX = Math.max(a.r.x, c.r.x) - Math.min(a.r.x + a.r.w, c.r.x + c.r.w);
        const gapY = Math.max(a.r.y, c.r.y) - Math.min(a.r.y + a.r.h, c.r.y + c.r.h);
        if (Math.max(gapX, gapY) < CROWD && Math.min(gapX, gapY) < 0) out.crowded.push([a.id, c.id]);
      }
    }
    return out;
  }
}

/** Text that belongs to this element itself (not to children that have their own data-id). */
function ownText(el: Element): string {
  let s = "";
  const walk = (n: Node) => {
    for (const child of Array.from(n.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) s += child.textContent ?? "";
      else if (child instanceof Element && !child.hasAttribute("data-id") && !["STYLE", "SCRIPT"].includes(child.tagName)) {
        // split words (SplitText) and line breaks are separate elements: keep a space between them
        const inline = ["SPAN", "B", "I", "EM", "STRONG", "CODE", "SMALL", "SUP", "SUB", "MARK"].includes(child.tagName);
        if (!inline) s += " ";
        walk(child);
        if (!inline) s += " ";
      }
    }
  };
  walk(el);
  return s.replace(/\s+/g, " ").trim();
}

function effectiveOpacity(el: Element, root: Element): number {
  let o = 1;
  let n: Element | null = el;
  while (n && n !== root.parentNode) {
    const cs = getComputedStyle(n);
    o *= parseFloat(cs.opacity || "1");
    if (cs.visibility === "hidden" || cs.display === "none") return 0;
    if (n === root) break;
    n = n.parentElement;
  }
  return o;
}
