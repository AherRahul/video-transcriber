// The explainer kit's shared shapes: what every kit module gets from the runtime, and what it can give back.
//
// The kit adds the building blocks a tech explainer needs to the scene contract: icons and product logos, the
// Excalidraw-style sketch look, coding visuals (arrays, trees, stacks, grids), sequence diagrams, the cast
// (our own cartoon people with poses and faces), b-roll clips and the user's own Excalidraw drawings. Each lives in
// its own module (kit/<name>.ts) and plugs in through KitModule; kit/index.ts lists them. They are building
// blocks, never page templates: every scene is still laid out for its own content.

import type { Bundle } from "../../types";

// gsap.core.Timeline below is gsap's global type namespace (no import needed)

/** What the kit has fetched for the loaded video, shared by every scene: each module keeps its own entries
 *  under its own keys (icons under "icons", the cast under "cast", an Excalidraw file under "doc:<asset>"). */
export type KitAssets = {
  /** where the kit's own files are served: "/assets/motion/kit/" */
  kitBase: string;
  /** where this video's uploaded files are served: "/api/motion/projects/<id>/assets/" */
  assetBase: string;
  store: Map<string, unknown>;
};

/** One scene, as a kit module sees it while the scene is being built. */
export type KitCtx = {
  sceneId: string;
  /** the scene's paused timeline: everything a module animates goes on it, pinned to the times it is given */
  tl: gsap.core.Timeline;
  /** the page (.scene-root) and the camera inside it (.scene-cam), which holds the scene's markup */
  root: HTMLElement;
  cam: HTMLElement;
  /** the stage in design units, and the content box (x0, y0, x1, y1) a page's content belongs in */
  width: number;
  height: number;
  content: [number, number, number, number];
  /** the smallest text the layout report accepts */
  minText: number;
  /** the scene's length in seconds */
  duration: number;
  /** the AlgoInsight paper look (theme "paper"), or a plain brand kit */
  paper: boolean;
  assets: KitAssets;
  /** a sound effect at a scene time (the paper sounds: pop, pencil, whoosh, ...) */
  sound: (name: string, at: number, gain?: number) => void;
  /** tells the timing report about an entrance (its kind, its elements and when it starts) */
  mark: (kind: string, els: Element[], at: number) => void;
  /** a stable number for a string (a data-id): the same drawing in every frame and every export */
  seed: (s: string) => number;
  /** problems to show on the page and report to Claude (a missing icon, a bad spec) */
  errors: string[];
  /** the scene's fx, for a module that builds on the paper look's own entrances (fx.pop, fx.draw, ...) */
  fx: Record<string, unknown>;
};

export type KitModule = {
  /** the module's name, for errors */
  name: string;
  /** CSS for every scene's shadow root (and carried copies) */
  css?: string;
  /** fetches what this video's scenes need, once per load (a module looks at the scenes' sources and keeps
   *  what it fetched in assets.store); errors come back as sentences */
  load?: (bundle: Bundle, assets: KitAssets) => Promise<string[]>;
  /** turns the module's markup into what is drawn (data-icon into an icon, a sketch box into its strokes),
   *  after the scene's markup is on the page and before its script runs */
  prepare?: (ctx: KitCtx) => void;
  /** what the module adds to the scene's fx (fx.sketch, fx.array, fx.person, ...) */
  make?: (ctx: KitCtx) => Record<string, unknown>;
  /** runs once the scene's script is done (what depends on everything the script set, like a person's blinks) */
  finish?: (ctx: KitCtx) => void;
  /** waits until the module's media is ready to show (b-roll clips loaded) */
  ready?: (root: ParentNode) => Promise<void>;
  /** puts media that runs by itself (a b-roll clip) at the scene time just seeked to. Returns a promise when
   *  the export has to wait for it (exact: an export frame), or null when nothing needs waiting for */
  sync?: (root: ParentNode, local: number, exact: boolean) => Promise<void> | null;
};
