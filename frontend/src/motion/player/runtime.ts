// The Motion player: turns a bundle (brand + scenes as code) into a stage that can show any moment.
//
// Every frame is a pure function of time: scenes are built once, each with a paused GSAP timeline, and
// `seek(t)` sets every timeline to the right moment. The preview calls it every animation frame; the
// export calls it once per output frame. Nothing here plays on its own, so the MP4 matches the preview.
//
// Narration: each scene carries its cue times (estimated before the voice exists, measured after), and
// scene code pins animations to them with cue(n), so generating the voice re-times every scene for free.
//
// Each scene is built in its own shadow root: .scene-root (the page) holds .scene-cam (the camera, with the
// scene's markup in it, moved by fx.focus), the torn label and the turn's shade. Elements marked data-carry
// travel across a page change in an overlay of their own (carry.ts). A scene of kind "thumbnail" is a still:
// no frame, label, page change or sounds. timing() reports where a narrated page sits still and which
// entrances land a phrase late, for the audit.
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
import { carryLayer, cameraOf, drawnBox, placeCarry, snapCarries, type CarryLayer, type CarrySnap } from "./carry";
import { CODE_CSS, buildCode } from "./code";
import { buildPlainChrome } from "./frame";
import { hasSurface, inkBand, type Box } from "./geometry";
import { KIT_CSS, finishKit, kitReady, kitSync, loadKit, makeKit, newKitAssets, prepareKit, type KitAssets, type KitCtx } from "./kit";
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
import { timelineGaps, type LateEntrance, type Timing } from "./timing";

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
/** A thumbnail has no frame, so its words may go nearer the edge: this much margin all round (stage px). */
const THUMB_MARGIN = 40;
/** The brand as the frame reads it: the video's settings say whether the logo card and web address show. */
type FrameBrand = { showLogo?: boolean; showUrl?: boolean };
/** A still picture (the video's thumbnail): no frame, label, page change or sounds. The scene kinds in
 *  ../types predate it, so the player compares the kind as a plain string. */
const isThumbnail = (scene: { kind: string }) => scene.kind === "thumbnail";
/** A narrated scene has words and the speech's length; a silent one is timed in plain seconds. */
const narrated = (scene: BundleScene) => !!(scene.narration || "").trim() && (scene.speech ?? 0) > 0;

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
/* the camera: every scene's markup sits in it (fx.focus pans and zooms it). Transparent: in a scene that
   uses the camera, fx moves the page's paper onto it (so a zoom takes the graph paper with it); in any
   other scene it changes nothing on the page. */
.scene-cam { position: absolute; left: 0; top: 0; width: var(--stage-w); height: var(--stage-h); transform-origin: 0 0; }
/* a carried element is hidden on both pages while its copy travels between them (see carry.ts) */
.mo-carry-away { visibility: hidden !important; }
`;

type Built = {
  scene: BundleScene;
  host: HTMLDivElement;
  root: HTMLDivElement;
  /** the camera inside the root: the wrapper around the scene's markup */
  cam: HTMLDivElement;
  shade: HTMLDivElement;
  tl: gsap.core.Timeline;
  errors: string[];
  sfx: SfxEvent[];
  /** the scene's own CSS (a carried copy needs it in its overlay) */
  css: string;
  /** data-carry elements at rest, by key */
  carries: Map<string, CarrySnap>;
  /** fx entrances whose start came from cue(n, plus), for the timing report */
  cued: (LateEntrance & { late: boolean })[];
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
  /** boxes whose words run past their padding (a label wider than its card), by how many stage px */
  overflow: { id: string; px: number }[];
  smallText: { id: string; px: number }[];
  /** SVGs that look like a chart drawn by hand (axes, bars or a data line with no words): use fx.chart */
  handChart: string[];
  /** red pen marks (link arrows, circle loops, hand-drawn arrows) running through words or another card */
  penOver: [string, string][];
  /** arrows drawn by hand as a gentle curve, where a straight line (or an elbow) says it plainly */
  curvedArrow: string[];
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
  /** carried elements: one overlay per page that receives some (by scene index), where each one starts
   *  (the old element's box at the end of its page, measured once per load) and what is hidden right now */
  private carryLayers = new Map<number, CarryLayer>();
  private carryFrom = new Map<string, Box>();
  private carryHidden: HTMLElement[] = [];
  /** the explainer kit's files for the loaded video (icons, the cast, drawings), and the media still settling
   *  after the last seek (a b-roll clip finding its frame) */
  private kit: KitAssets | null = null;
  private pending: Promise<void> | null = null;

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
    // the explainer kit fetches what the scenes use (icons, the cast, Excalidraw drawings, the sketch fonts)
    if (!this.kit || this.kit.assetBase !== bundle.assetBase) this.kit = newKitAssets(`${bundle.themeBase}kit/`, bundle.assetBase);
    const kitErrors = await loadKit(bundle, this.kit);
    if (token !== this.loadToken) return { duration: bundle.duration, errors: [], version: bundle.version };
    for (const b of this.built) {
      b.tl.kill();
      b.host.remove();
    }
    this.built = [];
    this.errors = document.documentElement.dataset.mode === "render" ? [...this.fontErrors] : [];
    this.errors.push(...kitErrors);
    this.bundle = bundle;
    this.chrome?.root.remove();
    this.chrome = null;
    this.tearEdge?.remove();
    this.tearEdge = null;
    for (const layer of this.carryLayers.values()) layer.host.remove();
    this.carryLayers.clear();
    this.carryFrom.clear();
    this.carryHidden = [];
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
    } else {
      // the other kits: the logo bottom-left and the web address bottom-right, when the kit has them and the
      // video's settings show them (frame.ts); a kit without a logo or a url draws nothing, as before
      const brand = bundle.brand;
      this.chrome = buildPlainChrome(this.stage, {
        width: bundle.width,
        height: bundle.height,
        aspect: bundle.aspect,
        wordmark: brand.wordmark || brand.name,
        iconUrl: brand.iconUrl,
        logoUrl: brand.logoUrl,
        url: (brand as FrameBrand).showUrl === false ? "" : brand.endCard?.url || "",
        showLogo: (brand as FrameBrand).showLogo !== false,
      });
    }
    bundle.scenes.forEach((scene, i) => {
      const b = this.build(bundle, scene, i > 0 ? bundle.scenes[i - 1] : null);
      this.built.push(b);
      this.errors.push(...b.errors);
    });
    this.buildCarries(bundle);
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
    // document.fonts.check() is true when no face of the family exists at all, so a family whose
    // @font-face rules never arrived counts as missing too
    const declared = (f: string) => [...document.fonts].some((face) => face.family.replace(/["']/g, "") === f);
    this.fontErrors = families
      .filter((f) => !SYSTEM_FONTS.has(f.toLowerCase()))
      .filter((f) => !declared(f) || (!document.fonts.check(`800 40px "${f}"`) && !document.fonts.check(`400 40px "${f}"`)))
      .map((f) => `The font "${f}" didn't load (offline, or not a Google Font); the frames would use a fallback font.`);
  }

  private async fetchFontCss(family: string): Promise<void> {
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    // the app keeps a copy of each Google font on this computer: fast and the same in every frame
    try {
      const res = await fetch(`/api/motion/fonts.css?family=${name}`);
      if (res.ok) {
        // the text first, then the append: `textContent += await ...` read the old text before waiting,
        // so the families loading side by side overwrote each other and one went missing at random
        const css = await res.text();
        this.fontStyle.textContent += "\n" + css;
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
          const css = await res.text();
          this.fontStyle.textContent += "\n" + css;
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
    for (const layer of this.carryLayers.values()) imgs.push(...Array.from(layer.host.shadowRoot?.querySelectorAll("img") ?? []));
    await Promise.race([
      Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => null)))),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    // the kit's media too (b-roll clips), up to 20 s
    await Promise.race([kitReady(this.built.map((b) => b.root)), new Promise((r) => setTimeout(r, 20000))]);
  }

  private resolveAssets(text: string, base: string): string {
    return text.replace(/asset:\/\/([A-Za-z0-9._-]+)/g, (_, name: string) => base + encodeURIComponent(name));
  }

  private build(bundle: Bundle, scene: BundleScene, before: BundleScene | null): Built {
    const errors: string[] = [];
    const sfx: SfxEvent[] = [];
    const paper = bundle.theme === "paper";
    const thumb = isThumbnail(scene);
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
    // the markup goes inside the camera (fx.focus moves it); the page's label, the turn's shade and any
    // error box stay outside it, on the page itself
    shadow.innerHTML = `<style>${BASE_CSS}${paper ? PAPER_CSS : ""}${CODE_CSS}${KIT_CSS}</style><style>${css}</style><div class="scene-root"><div class="scene-cam">${markup}</div><div class="mo-shade"></div></div>`;
    const root = shadow.querySelector(".scene-root") as HTMLDivElement;
    const cam = root.querySelector(".scene-cam") as HTMLDivElement;
    const shade = shadow.querySelector(".mo-shade") as HTMLDivElement;
    buildCode(cam); // code blocks become numbered, highlighted lines before anything measures them
    this.stage.insertBefore(host, this.chrome?.root ?? null);

    const tl = gsap.timeline({ paused: true });
    const cues = scene.cues?.length ? scene.cues : [scene.lead ?? TRANSITION_SECONDS];
    const voiceStart = cues[0];
    const voiceEnd = (scene.lead ?? voiceStart) + (scene.speech ?? 0);
    // every time cue() hands out, with the n and plus it came from, so the timing report can tell which
    // phrase an entrance was meant for
    const cueLog: { t: number; n: number; plus: number }[] = [];
    const cue = (n: number, plus = 0): number => {
      const i = Math.max(0, Math.floor(Number(n) || 0));
      let t: number;
      if (i >= cues.length) {
        errors.push(`Scene ${scene.id}: cue(${i}) but the narration has ${cues.length - 1} <cue/> mark${cues.length === 2 ? "" : "s"}`);
        t = Math.max(0, voiceEnd - 0.3) + plus;
      } else t = Math.max(0, cues[i] + plus);
      cueLog.push({ t, n: i, plus: Number(plus) || 0 });
      return t;
    };
    const cued: Built["cued"] = [];
    const entrance = (kind: string, els: Element[], at: number) => {
      // the latest cue() call that gave exactly this time (a script asks for the time just before using it)
      let hit: (typeof cueLog)[number] | undefined;
      for (let k = cueLog.length - 1; k >= 0 && !hit; k--) if (cueLog[k].t === at) hit = cueLog[k];
      if (!hit || !narrated(scene)) return;
      const nextCue = hit.n + 1 < cues.length ? cues[hit.n + 1] : voiceEnd;
      const late = at > nextCue + 1e-6 || at > voiceEnd + 1e-6;
      const ids = els.length ? els.map((el) => el.getAttribute("data-id") || el.tagName.toLowerCase()) : [kind === "focus" ? "camera" : kind];
      for (const id of ids) cued.push({ id, at: Math.round(at * 1000) / 1000, cue: hit.n, plus: hit.plus, nextCue: Math.round(nextCue * 1000) / 1000, late });
    };
    const content: [number, number, number, number] = paper
      ? PAPER_CONTENT
      : (() => {
          const s = safeInsets(bundle.aspect, bundle.width, bundle.height);
          return [s.left, s.top, bundle.width - s.right, bundle.height - s.bottom];
        })();
    // the smallest text the layout report accepts (as diagnose measures it): fx.chart sizes its labels from it
    const minText = paper ? 22 : Math.round(Math.min(bundle.width, bundle.height) * 0.028);
    const fx = makeFx(tl, scene.id, sfx, { cam, width: bundle.width, height: bundle.height, content, entrance, minText });
    // the explainer kit: its markup is drawn (icons, sketch shapes, people) before anything measures the page,
    // and fx gains its helpers (fx.sketch, fx.array, fx.person, ...)
    const kit: KitCtx = {
      sceneId: scene.id, tl, root, cam, width: bundle.width, height: bundle.height, content, minText, paper, duration: scene.duration,
      assets: this.kit ?? newKitAssets(`${bundle.themeBase}kit/`, bundle.assetBase),
      sound: fx.sound, mark: entrance, seed: (s: string) => hashString(`${scene.id}:${s}`), errors, fx: fx as unknown as Record<string, unknown>,
    };
    prepareKit(kit);
    Object.assign(fx, makeKit(kit));

    // the paper page's label, torn on as the voice starts (a thumbnail is a picture: no label)
    if (paper && scene.kind !== "endscreen" && !thumb && scene.label) {
      const label = buildLabel(root, scene.label, seedOf(scene.id));
      fx.tearOn(label, Math.max(0.15, voiceStart - 0.1));
    }
    if (paper) tearEdges(root, scene.id);
    arrowTips(root); // tips for "p-arrow head" paths, before the script pins them to the timeline
    // carried elements, copied at rest before any entrance touches them
    const carries = thumb ? new Map<string, CarrySnap>() : snapCarries(cam, bundle.width);

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
    finishKit(kit); // what the kit plans from everything the script set (a person's blinks)
    try {
      fx.finish(); // the camera's moves and the code bands, in time order
    } catch (err) {
      errors.push(`Scene ${scene.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (thumb) sfx.length = 0; // a still picture makes no sound
    else {
      // the page change's own sound, at the start of the scene
      if (scene.transition === "tear") sfx.push({ sceneId: scene.id, t: 0, name: "rip", gain: 1 });
      if (scene.transition === "turn") sfx.push({ sceneId: scene.id, t: 0, name: "page", gain: 1 });
      // a new part opens with a short sting, under the page change
      const part = (scene.part || "").trim();
      if (part && part !== (before?.part || "").trim()) sfx.push({ sceneId: scene.id, t: 0.2, name: "sting", gain: 0.55 });
    }
    if (errors.length) {
      const box = document.createElement("div");
      box.className = "motion-error";
      box.textContent = errors.join("\n");
      root.appendChild(box);
    }
    host.style.display = "none";
    host.style.visibility = "";
    return { scene, host, root, cam, shade, tl, errors, sfx, css, carries, cued };
  }

  /** The overlays for carried elements: a page whose data-carry element has a partner of the same key on
   *  the page before it gets one (see carry.ts). Built once every scene exists. */
  private buildCarries(bundle: Bundle) {
    const paper = bundle.theme === "paper";
    for (let i = 1; i < this.built.length; i++) {
      const cur = this.built[i];
      const prev = this.built[i - 1];
      if (!cur.carries.size || isThumbnail(prev.scene)) continue;
      const pairs = [...cur.carries.values()]
        .map((snap) => ({ snap, old: prev.root.querySelector<HTMLElement>(`[data-carry="${CSS.escape(snap.key)}"]`) }))
        .filter((p): p is { snap: CarrySnap; old: HTMLElement } => !!p.old);
      if (!pairs.length) continue;
      const css = `${BASE_CSS}${paper ? PAPER_CSS : ""}${CODE_CSS}${KIT_CSS}\n${cur.css}`;
      this.carryLayers.set(i, carryLayer(this.stage, css, bundle.width, bundle.height, pairs));
    }
  }

  /** Every sound effect the scenes asked for, in scene-local seconds (the export mixes them). */
  sfx(): SfxEvent[] {
    return this.built.flatMap((b) => b.sfx.filter((e) => e.t <= b.scene.duration));
  }

  /**
   * The timing report for one scene (the audit asks for it), in scene seconds:
   *  - gaps: stretches longer than 6 s inside the voice (voiceStart to voiceEnd) where nothing on the scene's
   *    timeline is moving: no tween or set running (the label's tear-on counts). A silent scene has none.
   *  - late: entrances made through fx whose time came from cue(n, plus) but start after the next cue (they
   *    land during the next phrase) or after the voice has ended.
   */
  timing(id: string): Timing {
    const b = this.built.find((x) => x.scene.id === id);
    if (!b) throw new Error(`No scene ${id}`);
    if (!narrated(b.scene)) return { gaps: [], late: [] };
    const cues = b.scene.cues?.length ? b.scene.cues : [b.scene.lead ?? TRANSITION_SECONDS];
    const voiceEnd = (b.scene.lead ?? cues[0]) + (b.scene.speech ?? 0);
    return {
      gaps: timelineGaps(b.tl, cues[0], voiceEnd, 6),
      late: b.cued.filter((x) => x.late).map(({ id: el, at, cue, plus, nextCue }) => ({ id: el, at, cue, plus, nextCue })),
    };
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

  /** What the last seek still waits for (a b-roll clip seeking to its frame), or null when the page is ready. */
  settled(): Promise<void> | null {
    return this.pending;
  }

  seekScene(id: string, local: number) {
    const i = this.built.findIndex((b) => b.scene.id === id);
    if (i < 0) throw new Error(`No scene ${id}`);
    this.lastT = this.built[i].scene.start + local;
    this.show(i, local);
  }

  /**
   * The page as it stands, as text, for the export: the stage's own markup (which pages show and how far
   * their page change has got, the frame, the carried copies) and each shown page's inner markup (every
   * inline style, attribute and word the timeline sets). Two moments with the same text draw the same
   * pixels, so the export reuses the frame before instead of capturing it again: about two frames in three
   * of an explainer repeat the one before. Null when something moves by itself (a running CSS animation or
   * transition, a video, a canvas): then every frame is captured.
   */
  frameState(): string | null {
    if (document.getAnimations().some((a) => a.playState === "running")) return null;
    let state = this.stage.innerHTML;
    for (const b of this.built) {
      if (b.host.style.display === "none") continue;
      const shadow = b.root.getRootNode();
      if (!(shadow instanceof ShadowRoot)) return null;
      if (shadow.querySelector("video, canvas")) return null;
      state += "\u0000" + shadow.innerHTML;
    }
    return state;
  }

  /** Shows scene i at its local time; during its page change the previous scene's last frame takes part. */
  private show(i: number, local: number) {
    const cur = this.built[i];
    const dur = cur.scene.duration;
    const tdur = Math.min(TRANSITION_SECONDS, dur * 0.5);
    const thumb = isThumbnail(cur.scene);
    let kind = thumb ? "cut" : cur.scene.transition; // a thumbnail is a still: no page change
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
    // media that runs by itself (a b-roll clip) goes to the same moment; an export frame waits for it
    const exact = document.documentElement.dataset.mode === "render";
    const waits = [kitSync(cur.root, Math.min(local, dur), exact), prev ? kitSync(prev.root, prev.scene.duration, exact) : null].filter(Boolean) as Promise<void>[];
    this.pending = waits.length ? Promise.all(waits).then(() => undefined) : null;
    if (this.chrome) {
      this.chrome.setPart(cur.scene.part || "");
      this.chrome.setVisible(!(cur.scene.kind === "endscreen" && (!inTransition || local > tdur * 0.5)));
      this.chrome.setBare(thumb);
    }
    this.carry(i, local, tdur, thumb);
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

  /**
   * Carried elements (data-carry) during scene i's page change: the copy travels from the old page's element
   * to the new page's, both originals hidden meanwhile. Everything is worked out from i and the local time
   * (the old element's place is measured once, at the end of its page), so any frame comes out the same
   * however the player got there.
   */
  private carry(i: number, local: number, tdur: number, thumb: boolean) {
    for (const el of this.carryHidden) el.classList.remove("mo-carry-away");
    this.carryHidden = [];
    for (const layer of this.carryLayers.values()) layer.host.style.display = "none";
    const layer = this.carryLayers.get(i);
    if (!layer || thumb || i < 1 || !(local < tdur) || !this.bundle) return;
    const W = this.bundle.width;
    const prev = this.built[i - 1];
    const cur = this.built[i];
    for (const item of layer.items) {
      const key = `${i}:${item.snap.key}`;
      if (!this.carryFrom.has(key)) {
        // the old page as it ends, untransformed (a cut doesn't show it, so it is shown for the moment)
        const hidden = prev.host.style.display === "none";
        if (hidden) {
          prev.host.style.display = "block";
          prev.tl.time(prev.scene.duration, false);
        }
        this.carryFrom.set(key, drawnBox(item.old, prev.host, W));
        if (hidden) prev.host.style.display = "none";
      }
    }
    const e = gsap.parseEase("power2.inOut")(Math.max(0, Math.min(1, local / tdur)));
    const camNow = cameraOf(cur.cam, cur.host, W);
    for (const item of layer.items) {
      placeCarry(item, e, this.carryFrom.get(`${i}:${item.snap.key}`)!, camNow);
      for (const el of [item.old, item.snap.el]) {
        el.classList.add("mo-carry-away");
        this.carryHidden.push(el);
      }
    }
    layer.host.style.display = "block";
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
    const thumb = isThumbnail(b.scene);
    const safe = thumb
      ? { left: THUMB_MARGIN, top: THUMB_MARGIN, right: THUMB_MARGIN, bottom: THUMB_MARGIN }
      : paper
        ? { left: PAPER_CONTENT[0], top: PAPER_CONTENT[1], right: W - PAPER_CONTENT[2], bottom: H - PAPER_CONTENT[3] }
        : safeInsets(bundle.aspect, W, H);
    const stageRect = this.stage.getBoundingClientRect();
    const scale = stageRect.width / W || 1;
    const minPx = paper ? 22 : Math.round(Math.min(W, H) * 0.028);
    const out: Diagnosis = { sceneId: id, t: local, errors: [...b.errors], visible: [], offStage: [], outsideSafe: [], inZone: [], overlaps: [], crowded: [], overflow: [], smallText: [], handChart: [], penOver: [], curvedArrow: [], words: 0 };
    if (b.scene.kind === "endscreen") return out;
    // While the camera is zoomed in, the page is meant to reach past the frame and over the reserved
    // zones, so the placement checks skip what is inside the camera (errors and small text still count).
    const zoomed = b.cam.getBoundingClientRect().width / (b.root.getBoundingClientRect().width || 1) > 1.01;
    const placed = (el: Element) => !(zoomed && b.cam.contains(el));
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
      const check = placed(el);
      if (check && !big && (r.x < -2 || r.y < -2 || r.x + r.w > W + 2 || r.y + r.h > H + 2)) out.offStage.push(id2);
      // a thumbnail has no frame, so it has no reserved zones either
      // the reserved zones count while zoomed too (the camera keeps the page's top below the header, so
      // anything there is a real collision); only the empty narrator corner is let off then
      if (paper && !thumb && !big) {
        // the films' own recording window reaches into the narrator corner, so there only words, pictures
        // and small pieces count; the other zones take nothing at all
        const small = r.w * r.h < 400 * 300;
        const direct = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim());
        for (const z of PAPER_ZONES) {
          if (z.name === "narrator corner" && (!check || !(direct || el.tagName.toLowerCase() === "img" || small))) continue;
          const ix = Math.min(r.x + r.w, z.r[2]) - Math.max(r.x, z.r[0]);
          const iy = Math.min(r.y + r.h, z.r[3]) - Math.max(r.y, z.r[1]);
          if (ix > 4 && iy > 4) out.inZone.push(`${id2} (${z.name})`);
        }
      }
      // words that run past the inside of their own box: a label wider than the card it sits in
      if (check && !big) {
        const past = wordsPastPadding(el, scale);
        if (past > 3) out.overflow.push({ id: id2, px: Math.round(past) });
      }
      const isImg = el.tagName.toLowerCase() === "img";
      if (!text && !isImg && !paper) continue;
      if (check && !big && (text || isImg || paper) && (r.x < safe.left - 4 || r.y < safe.top - 4 || r.x + r.w > W - safe.right + 4 || r.y + r.h > H - safe.bottom + 4)) {
        if (!out.offStage.includes(id2)) out.outsideSafe.push(id2);
      }
      if (text) {
        texts.push({ id: id2, el, r, text });
        // code on a code card is read differently from words on the page: it doesn't count toward the limit;
        // nor does a chart's frame (fx.chart): its numbers (tick labels and bar values, the p-chart's own
        // text), its axis titles and its note. Its series names, marks and legend count.
        const frame = el.classList.contains("p-chart") || (!!el.closest(".p-chart") && (el.classList.contains("p-chart-title") || el.classList.contains("p-chart-note-text")));
        // a terminal's session reads like code, and a coding visual's values, indices and pointer names
        // (kit/ds.ts, kit/sequence.ts) are data, not words
        if (!el.classList.contains("p-code") && !el.classList.contains("p-term") && !el.closest(".p-ds") && !frame) out.words += text.split(/\s+/).filter(Boolean).length;
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
        // the parts of one coding visual (cells side by side, an index under its cell) sit close on purpose
        const ds = a.el.closest(".p-ds");
        const kin = !!ds && ds === c.el.closest(".p-ds");
        if (!kin && placed(a.el) && placed(c.el) && Math.max(gapX, gapY) < CROWD && Math.min(gapX, gapY) < 0) out.crowded.push([a.id, c.id]);
      }
    }
    out.handChart = handCharts(b.root, stageRect, scale);
    const pen = penMarks(b.root, stageRect, scale, W, H);
    out.penOver = pen.over;
    out.curvedArrow = pen.curved;
    return out;
  }
}

type Pt = { x: number; y: number };

/**
 * Red pen marks on the page (fx.link arrows, fx.circle loops, arrows drawn by hand as p-arrow paths), for the
 * layout report:
 *  - over: a mark that runs through words or across a card that isn't its own, as [mark, element]. Each mark
 *    that is drawn at this moment is sampled every 6 stage px along its whole length; a sample inside a line
 *    of words (as tall as its glyphs) or a drawn box (2 px in from its edges) counts. Reported as "the red
 *    circle highlighting overlaps other words". What doesn't count:
 *     - a mark's own targets: what a loop is drawn around, the two ends of a link, whatever holds the mark,
 *       and for an arrow drawn by hand whatever its start or end touches (within 30 px);
 *     - a box over or around one of those (a dashed group round the card a link reaches, a stacked card
 *       behind the one it leaves), and for a loop the neighbours touching what it rings (a bar's next
 *       segment);
 *     - for a line drawn by hand, a card painted over it (a route line passing under its stops).
 *  - curved: an arrow drawn by hand (one with a tip, or a hand-drawn head) as a gentle curve, where a
 *    straight line says the same thing plainly ("why are these arrows curved?"): a first stroke with curve
 *    commands whose ends are at least 60% of its length apart (it runs one way) and which bows off the
 *    straight line between them by 4% to 30% of that distance. An arch or a loop that comes back round is a
 *    deliberate gesture and doesn't count, nor does a pen line with no head (a strike-through, an
 *    underline), nor the player's own links (they bow only to get round something).
 */
function penMarks(root: Element, stageRect: DOMRect, scale: number, W: number, H: number): { over: [string, string][]; curved: string[] } {
  const over: [string, string][] = [];
  const curved: string[] = [];
  const shown = (el: Element) => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && effectiveOpacity(el, root) >= 0.05;
  };
  const toStage = (q: { left: number; top: number; width: number; height: number }): Box => ({
    x: (q.left - stageRect.left) / scale,
    y: (q.top - stageRect.top) / scale,
    w: q.width / scale,
    h: q.height / scale,
  });
  // what a mark may not cross: each element's lines of words, or its whole box when it is drawn (a card)
  type Thing = { id: string; el: Element; boxes: Box[] };
  const things: Thing[] = [];
  const range = document.createRange();
  for (const el of Array.from(root.querySelectorAll("[data-id]"))) {
    if (el.closest(".p-links") || (el instanceof SVGElement && !(el instanceof SVGSVGElement))) continue;
    const rr = el.getBoundingClientRect();
    if (rr.width < 1 || rr.height < 1 || !shown(el)) continue;
    const r = toStage(rr);
    const tag = el.tagName.toLowerCase();
    if (r.w * r.h > W * H * 0.25 || (tag === "svg" && (r.w > 200 || r.h > 200))) continue;
    const id = el.getAttribute("data-id")!;
    if (hasSurface(el) || ["img", "canvas", "video", "svg"].includes(tag)) {
      things.push({ id, el, boxes: [r] });
      continue;
    }
    // its own words (not those of children with their own data-id), line by line
    const boxes: Box[] = [];
    const walk = (n: Node) => {
      for (const child of Array.from(n.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && (child.textContent || "").trim()) {
          range.selectNodeContents(child);
          for (const q of Array.from(range.getClientRects())) {
            if (q.width < 0.5 || q.height < 0.5) continue;
            const [a, z] = inkBand(child, q.top, q.height); // the glyphs, not the font's whole line box
            boxes.push(toStage({ left: q.left, top: a, width: q.width, height: z - a }));
          }
        } else if (child instanceof Element && !child.hasAttribute("data-id") && !["STYLE", "SCRIPT", "svg"].includes(child.tagName)) walk(child);
      }
    };
    walk(el);
    if (boxes.length) things.push({ id, el, boxes });
  }
  const byId = (id: string | null) => (id ? root.querySelector(`[data-id="${CSS.escape(id)}"]`) : null);
  const related = (a: Element, b: Element) => a === b || a.contains(b) || b.contains(a);
  for (const mark of Array.from(root.querySelectorAll<SVGPathElement>("path.p-arrow"))) {
    if (mark.classList.contains("p-arrow-tip") || !shown(mark)) continue;
    const cs = getComputedStyle(mark);
    const dash = cs.strokeDasharray && cs.strokeDasharray !== "none" ? parseFloat(cs.strokeDasharray) : NaN;
    if (Number.isFinite(dash) && dash < 1) continue; // not drawn on yet
    let len = 0;
    try {
      len = mark.getTotalLength();
    } catch {
      continue;
    }
    const ctm = mark.getScreenCTM();
    if (!(len > 2) || !ctm) continue;
    const m = DOMMatrix.fromMatrix(ctm);
    const at = (s: number): Pt => {
      const p = mark.getPointAtLength(s);
      const q = new DOMPoint(p.x, p.y).matrixTransform(m);
      return { x: (q.x - stageRect.left) / scale, y: (q.y - stageRect.top) / scale };
    };
    const unit = Math.hypot(m.a, m.b) / scale || 1; // stage px per path unit
    const steps = Math.min(600, Math.max(8, Math.ceil((len * unit) / 6)));
    const pts = Array.from({ length: steps + 1 }, (_, k) => at((len * k) / steps));
    const markId = mark.getAttribute("data-id") || mark.closest("[data-id]")?.getAttribute("data-id") || "arrow";
    const fx = mark.getAttribute("data-fx");
    const own: Element[] = [];
    for (const key of ["data-around", "data-from", "data-to"]) {
      const el = byId(mark.getAttribute(key));
      if (el) own.push(el);
    }
    const ends = [pts[0], pts[pts.length - 1]];
    const near = (b: Box, p: Pt, pad: number) => p.x > b.x - pad && p.x < b.x + b.w + pad && p.y > b.y - pad && p.y < b.y + b.h + pad;
    const ownBoxes = own.map((o) => toStage(o.getBoundingClientRect()));
    const overlap = (a: Box, b: Box, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
    const holder = mark.ownerSVGElement && !(mark.ownerSVGElement.parentNode instanceof SVGElement) ? mark.ownerSVGElement : mark.closest("svg");
    const z = (e: Element) => parseInt(getComputedStyle(e).zIndex, 10) || 0;
    for (const t of things) {
      if (t.el.contains(mark) || own.some((o) => related(o, t.el))) continue;
      if (!fx && t.boxes.some((b) => ends.some((p) => near(b, p, 30)))) continue; // what a hand-drawn arrow points from or to
      // the group a mark's own element belongs to, and for a loop the strip it sits in
      if (t.boxes.some((b) => ownBoxes.some((o) => overlap(o, b, fx === "circle" ? 3 : -1)))) continue;
      // a line drawn by hand under a card: the card is painted over it (later on the page, not lower)
      if (!fx && holder && hasSurface(t.el) && holder.compareDocumentPosition(t.el) & Node.DOCUMENT_POSITION_FOLLOWING && z(t.el) >= z(holder)) continue;
      if (pts.some((p) => t.boxes.some((b) => near(b, p, -2)))) over.push([markId, t.id]);
    }
    // a gentle curve drawn by hand, in its first stroke (a hand-drawn head is a second one)
    const d = mark.getAttribute("d") || "";
    const first = d.match(/^\s*[Mm][^Mm]*/)?.[0] ?? "";
    const arrow = mark.classList.contains("head") || (d.match(/[Mm]/g) || []).length > 1; // a tip, or a head drawn by hand
    if (!fx && arrow && /[CcQqSsTtAa]/.test(first)) {
      const probe = mark.cloneNode(false) as SVGPathElement;
      probe.setAttribute("d", first);
      probe.removeAttribute("data-id");
      mark.parentNode?.appendChild(probe);
      try {
        const l = probe.getTotalLength();
        const a = probe.getPointAtLength(0);
        const z = probe.getPointAtLength(l);
        const chord = Math.hypot(z.x - a.x, z.y - a.y);
        if (l > 0 && chord >= 0.6 * l) {
          let dev = 0;
          for (let k = 1; k < 24; k++) {
            const p = probe.getPointAtLength((l * k) / 24);
            dev = Math.max(dev, Math.abs((z.x - a.x) * (a.y - p.y) - (a.x - p.x) * (z.y - a.y)) / (chord || 1));
          }
          if (dev > 0.04 * chord && dev <= 0.3 * chord) curved.push(markId);
        }
      } catch {
        /* no geometry */
      } finally {
        probe.remove();
      }
    }
  }
  const seen = new Set<string>();
  return { over: over.filter(([a, b]) => !seen.has(`${a}|${b}`) && !!seen.add(`${a}|${b}`)), curved: [...new Set(curved)] };
}

/**
 * Charts drawn by hand, for the layout report's hint "hand-drawn chart: use fx.chart" (Claude used to draw
 * axes as an L-shaped path and data as a polyline, with no ticks, values or titles). An <svg> on the page
 * counts when it is at least 200 x 120 stage px, sits outside any p-chart, is not the player's own drawing
 * layer, has no words of its own, and holds one of:
 *  - axes: a long upright line and a long level line meeting at the bottom-left corner (one L-shaped path
 *    or two lines), with something drawn inside the corner;
 *  - bars: three or more rects of one width standing on one baseline, not all of one height;
 *  - a data line: a straight-segment path or polyline of four or more points running one way across, at
 *    least 240 px wide, with a bend in it.
 * Arrows (p-arrow paths), icons (small SVGs) and elbow connectors with nothing in their corner don't count.
 * Gives each one's data-id (its own, or the nearest one around it).
 */
function handCharts(root: Element, stageRect: DOMRect, scale: number): string[] {
  const out: string[] = [];
  for (const svg of Array.from(root.querySelectorAll("svg"))) {
    // the kit's own drawings (data-kit: sketch strokes, an imported Excalidraw drawing) are not charts drawn by hand
    if (svg.parentElement?.closest("svg") || svg.closest(".p-chart") || svg.classList.contains("p-links") || svg.closest("[data-kit]") || svg.closest(".p-ds")) continue;
    const rr = svg.getBoundingClientRect();
    if (rr.width / scale < 200 || rr.height / scale < 120 || effectiveOpacity(svg, root) < 0.05) continue;
    if (Array.from(svg.querySelectorAll("text, foreignObject")).some((t) => (t.textContent || "").trim())) continue;
    // every shape in stage px: its straight runs (lines, polylines, M/L/H/V paths) and its box
    const runs: { el: Element; pts: Pt[] }[] = [];
    const boxes: { el: Element; tag: string; b: Box }[] = [];
    for (const el of Array.from(svg.querySelectorAll<SVGGraphicsElement>("path, polyline, polygon, line, rect, circle, ellipse"))) {
      if (el.closest("defs, mask, clipPath, marker, pattern, symbol") || el.classList.contains("p-arrow-tip") || el.classList.contains("p-packet")) continue;
      const ctm = el.getScreenCTM();
      if (!ctm) continue;
      const m = DOMMatrix.fromMatrix(ctm);
      const at = (x: number, y: number): Pt => {
        const p = new DOMPoint(x, y).matrixTransform(m);
        return { x: (p.x - stageRect.left) / scale, y: (p.y - stageRect.top) / scale };
      };
      const tag = el.tagName.toLowerCase();
      let lists: [number, number][][] | null = null;
      if (tag === "path") lists = straightRuns(el.getAttribute("d") || "");
      else if (tag === "polyline") lists = [Array.from({ length: (el as SVGPolylineElement).points.numberOfItems }, (_, i) => { const q = (el as SVGPolylineElement).points.getItem(i); return [q.x, q.y] as [number, number]; })];
      else if (tag === "line") {
        const l = el as SVGLineElement;
        lists = [[[l.x1.baseVal.value, l.y1.baseVal.value], [l.x2.baseVal.value, l.y2.baseVal.value]]];
      }
      if (lists && !el.classList.contains("p-arrow")) for (const l of lists) if (l.length >= 2) runs.push({ el, pts: l.map(([x, y]) => at(x, y)) });
      try {
        const bb = el.getBBox();
        const a = at(bb.x, bb.y);
        const c = at(bb.x + bb.width, bb.y + bb.height);
        boxes.push({ el, tag, b: { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) } });
      } catch {
        /* a shape with no geometry yet */
      }
    }
    if (handAxes(runs, boxes) || handBars(boxes) || handLine(runs)) out.push(svg.closest("[data-id]")?.getAttribute("data-id") ?? "svg");
  }
  return [...new Set(out)];
}

/** A path's straight runs ([x, y] lists, one per subpath) when it has only M, L, H, V and Z; null for curves. */
function straightRuns(d: string): [number, number][][] | null {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === "Z" || cmd === "z") {
        if (cur.length) cur.push([sx, sy]);
        x = sx;
        y = sy;
        continue;
      }
    } else if (!cmd) return null;
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case "M": {
        const nx = num();
        const ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        if (cur.length > 1) out.push(cur);
        cur = [[x, y]];
        sx = x;
        sy = y;
        cmd = rel ? "l" : "L"; // more pairs after a move are lines
        break;
      }
      case "L": {
        const nx = num();
        const ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        cur.push([x, y]);
        break;
      }
      case "H":
        x = rel ? x + num() : num();
        cur.push([x, y]);
        break;
      case "V":
        y = rel ? y + num() : num();
        cur.push([x, y]);
        break;
      default:
        return null; // a curve or an arc
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Axes: an upright run (90 px or more) and a level one (160 px or more) meeting at the bottom-left, with
 *  some other shape drawn inside the corner they make. */
function handAxes(runs: { el: Element; pts: Pt[] }[], boxes: { el: Element; b: Box }[]): boolean {
  type Leg = { el: Element; a: Pt; b: Pt };
  const ups: Leg[] = [];
  const levels: Leg[] = [];
  for (const r of runs) {
    for (let k = 1; k < r.pts.length; k++) {
      const p = r.pts[k - 1];
      const q = r.pts[k];
      if (Math.abs(q.x - p.x) <= 3 && Math.abs(q.y - p.y) >= 90) ups.push(p.y > q.y ? { el: r.el, a: p, b: q } : { el: r.el, a: q, b: p }); // a: the bottom
      if (Math.abs(q.y - p.y) <= 3 && Math.abs(q.x - p.x) >= 160) levels.push(p.x < q.x ? { el: r.el, a: p, b: q } : { el: r.el, a: q, b: p }); // a: the left
    }
  }
  for (const u of ups) {
    for (const l of levels) {
      if (Math.abs(u.a.x - l.a.x) > 6 || Math.abs(u.a.y - l.a.y) > 6) continue;
      const corner = { x: u.a.x - 8, y: u.b.y - 8, w: l.b.x - u.a.x + 16, h: u.a.y - u.b.y + 16 };
      const inside = boxes.some(({ el, b }) => {
        if (el === u.el || el === l.el || (b.w < 4 && b.h < 4)) return false;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        return cx > corner.x && cx < corner.x + corner.w && cy > corner.y && cy < corner.y + corner.h;
      });
      if (inside) return true;
    }
  }
  return false;
}

/** Bars: three or more rects of about one width (within 15%) on one baseline (within 4 px), side by side
 *  across 160 px or more, not all of one height. */
function handBars(boxes: { tag: string; b: Box }[]): boolean {
  const rects = boxes.filter((x) => x.tag === "rect" && x.b.w >= 8 && x.b.h >= 4).map((x) => x.b);
  for (const a of rects) {
    const row = rects.filter((c) => Math.abs(c.y + c.h - (a.y + a.h)) <= 4 && Math.abs(c.w - a.w) <= a.w * 0.15).sort((p, q) => p.x - q.x);
    if (row.length < 3) continue;
    const apart = row.every((c, k) => k === 0 || c.x >= row[k - 1].x + row[k - 1].w - 2);
    const span = row[row.length - 1].x + row[row.length - 1].w - row[0].x;
    const heights = row.map((c) => c.h);
    if (apart && span >= 160 && Math.max(...heights) - Math.min(...heights) > 6) return true;
  }
  return false;
}

/** A data line: four or more points running one way across (each a step of more than 2 px), at least 240 px
 *  wide, with a point more than 3 px off the straight line from its first point to its last. */
function handLine(runs: { el: Element; pts: Pt[] }[]): boolean {
  return runs.some(({ el, pts }) => {
    if (el.tagName.toLowerCase() === "line" || pts.length < 4) return false;
    const dir = Math.sign(pts[pts.length - 1].x - pts[0].x);
    if (!dir || !pts.every((p, k) => k === 0 || (p.x - pts[k - 1].x) * dir > 2)) return false;
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(b.x - a.x) < 240) return false;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return pts.some((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len > 3);
  });
}

/**
 * How far an element's words run past the inside of its own box (its padding edge), in stage px: a label
 * wider than the card it sits in ("Database" in a fixed 230 px box touched the border). Measured on the
 * rendered words of the whole box, children included. 0 for a box that doesn't frame its words (no side
 * padding or border), for an ellipsis on purpose, and for a strongly turned element (a stamp), whose
 * on-screen box would read as overflow.
 */
function wordsPastPadding(el: Element, scale: number): number {
  if (!(el instanceof HTMLElement)) return 0;
  const cs = getComputedStyle(el);
  if (cs.textOverflow === "ellipsis") return 0;
  const px = (v: string) => parseFloat(v) || 0;
  const left = px(cs.paddingLeft) + px(cs.borderLeftWidth);
  const right = px(cs.paddingRight) + px(cs.borderRightWidth);
  const top = px(cs.paddingTop) + px(cs.borderTopWidth);
  const bottom = px(cs.paddingBottom) + px(cs.borderBottomWidth);
  if (left + right < 4) return 0;
  if (cs.transform && cs.transform !== "none") {
    const m = new DOMMatrixReadOnly(cs.transform);
    if (Math.abs(Math.atan2(m.b, m.a)) > 0.06) return 0;
  }
  const box = el.getBoundingClientRect();
  const inner = { l: box.left + left * scale, r: box.right - right * scale, t: box.top + top * scale, b: box.bottom - bottom * scale };
  let past = 0;
  const range = document.createRange();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!(n.textContent || "").trim()) continue;
    if (n.parentElement && n.parentElement !== el && n.parentElement.closest("svg")) continue; // SVG text has its own geometry
    range.selectNodeContents(n);
    for (const q of Array.from(range.getClientRects())) {
      if (q.width < 0.5) continue;
      past = Math.max(past, (inner.l - q.left) / scale, (q.right - inner.r) / scale);
      // up and down only a whole extra line counts: a glyph box overhangs a tight line height a little,
      // and words rising into place (fx.rise, 16 px) pass through the padding for a moment
      past = Math.max(past, (inner.t - q.top) / scale - 20, (q.bottom - inner.b) / scale - 20);
    }
  }
  return past;
}

/** Text that belongs to this element itself (not to children that have their own data-id). */
function ownText(el: Element): string {
  let s = "";
  const walk = (n: Node) => {
    for (const child of Array.from(n.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) s += child.textContent ?? "";
      // the words of the user's own Excalidraw drawing (data-kit-uncounted) are its own layout: not counted
      else if (child instanceof Element && !child.hasAttribute("data-id") && !child.hasAttribute("data-kit-uncounted") && !["STYLE", "SCRIPT"].includes(child.tagName)) {
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
