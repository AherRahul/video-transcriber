// Icons and product logos (kit/icons.ts).
//
// Icons: the 1,539 Lucide line icons (ISC licence), by name. Any element with data-icon="database" gets the
// icon drawn inside it, first, in the ink colour (currentColor), on Lucide's 24 x 24 grid: a card, a badge, a
// sketch node or a plain span. Its size is the CSS variable --icon-size (1.2em by default) and its line
// --icon-stroke (2 on the grid). fx.drawIcon draws an icon's strokes on, the way a pen would.
//
// Logos: the films' shared logo library (AWS and Azure architecture icons, Simple Icons brand marks, our own
// drawings; logos/SOURCES.md has each group's terms). data-logo="aws/s3" puts that logo in the element (an
// <img data-logo> gets it as its picture). The Azure icons are never cropped, flipped, rotated or distorted,
// and every logo stands next to its product's name.
//
// The files: public/assets/motion/kit/icons (lucide.json, tags.json) and kit/logos (index.json and the
// SVGs), written by scripts/build-kit-icons.mjs. They are fetched once, only when a scene uses them.

import type { Bundle } from "../../types";
import type { KitAssets, KitCtx, KitModule } from "./types";

/** what each file is fetched for, once per page (a failed fetch is tried again on the next load) */
const fetched = new Map<string, Promise<unknown>>();
function fetchJson(url: string): Promise<unknown> {
  if (!fetched.has(url)) {
    const job = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.json();
    });
    job.catch(() => fetched.delete(url));
    fetched.set(url, job);
  }
  return fetched.get(url)!;
}

type IconSet = Record<string, string>;
type LogoIndex = Record<string, string>;

/** An icon as SVG markup (the class names it carries), or null when there is no icon by that name. */
export function iconMarkup(assets: KitAssets, name: string, cls = "k-icon"): string | null {
  const inner = (assets.store.get("icons") as IconSet | undefined)?.[name];
  if (inner == null) return null;
  return `<svg class="${cls}" data-icon-name="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** A logo's picture address ("aws/s3"), or null when the library has no such logo. */
export function logoUrl(assets: KitAssets, name: string): string | null {
  const index = assets.store.get("logos") as LogoIndex | undefined;
  return index && name in index ? `${assets.kitBase}logos/${name}.svg` : null;
}

/** A logo's name as its source gives it ("Container Registries" for azure/acr). */
export function logoLabel(assets: KitAssets, name: string): string {
  return (assets.store.get("logos") as LogoIndex | undefined)?.[name] ?? name;
}

const SHAPES = "path, circle, ellipse, line, polyline, polygon, rect";

export const icons: KitModule = {
  name: "icons",
  css: `
.k-icon { width: var(--icon-size, 1.2em); height: var(--icon-size, 1.2em); stroke-width: var(--icon-stroke, 2); flex: none; vertical-align: -0.22em; overflow: visible; }
.k-logo { width: var(--logo-size, 1.6em); height: var(--logo-size, 1.6em); object-fit: contain; flex: none; vertical-align: -0.35em; }
img.k-logo[data-logo] { display: inline-block; }
`,

  async load(bundle: Bundle, assets: KitAssets) {
    // a scene can ask for icons in its markup, in a script (fx.icon) or in a kit spec ({icon: "server"})
    const sources = bundle.scenes.map((s) => s.source || "").join("\n");
    const errors: string[] = [];
    const jobs: Promise<void>[] = [];
    if (/icon/i.test(sources) && !assets.store.has("icons")) {
      jobs.push(
        fetchJson(`${assets.kitBase}icons/lucide.json`)
          .then((set) => void assets.store.set("icons", set))
          .catch((err) => void errors.push(`The icons didn't load (${err instanceof Error ? err.message : err}).`)),
      );
    }
    if (/logo/i.test(sources) && !assets.store.has("logos")) {
      jobs.push(
        fetchJson(`${assets.kitBase}logos/index.json`)
          .then((index) => void assets.store.set("logos", index))
          .catch((err) => void errors.push(`The logo library didn't load (${err instanceof Error ? err.message : err}).`)),
      );
    }
    await Promise.all(jobs);
    return errors;
  },

  prepare(ctx: KitCtx) {
    for (const el of Array.from(ctx.cam.querySelectorAll<HTMLElement>("[data-icon]"))) {
      if (el.querySelector(":scope > svg.k-icon")) continue; // already drawn (a carried copy)
      const name = (el.dataset.icon || "").trim();
      const svg = iconMarkup(ctx.assets, name);
      if (!svg) {
        ctx.errors.push(`Scene ${ctx.sceneId}: no icon named "${name}" (find_icons lists them)`);
        continue;
      }
      el.insertAdjacentHTML("afterbegin", svg);
    }
    for (const el of Array.from(ctx.cam.querySelectorAll<HTMLElement>("[data-logo]"))) {
      const name = (el.dataset.logo || "").trim();
      const url = logoUrl(ctx.assets, name);
      if (!url) {
        ctx.errors.push(`Scene ${ctx.sceneId}: no logo "${name}" in the library (find_icons lists them, like aws/s3 or brands/redis)`);
        continue;
      }
      if (el instanceof HTMLImageElement) {
        el.src = url;
        el.classList.add("k-logo");
        if (!el.alt) el.alt = logoLabel(ctx.assets, name);
      } else if (!el.querySelector(":scope > img.k-logo")) {
        el.insertAdjacentHTML("afterbegin", `<img class="k-logo" src="${url}" alt="${logoLabel(ctx.assets, name).replace(/"/g, "&quot;")}">`);
      }
    }
  },

  make(ctx: KitCtx) {
    const list = (els: Element | Element[] | null | undefined) => (Array.isArray(els) ? els : els ? [els] : []).filter(Boolean) as Element[];
    return {
      /** An icon as an element, for a script that builds markup itself (null when there is no such icon). */
      icon(name: string): SVGSVGElement | null {
        const svg = iconMarkup(ctx.assets, name);
        if (!svg) {
          ctx.errors.push(`Scene ${ctx.sceneId}: no icon named "${name}" (find_icons lists them)`);
          return null;
        }
        const t = document.createElement("template");
        t.innerHTML = svg;
        return t.content.firstElementChild as SVGSVGElement;
      },
      /** Draws an icon's strokes on, one after another, like a pen: the element with data-icon, or the icon's
       *  svg itself. 0.6 s by default. */
      drawIcon(els: Element | Element[], at: number, seconds = 0.6) {
        const targets = list(els);
        ctx.mark("drawIcon", targets, at);
        for (const el of targets) {
          const svg = el.matches("svg.k-icon") ? el : el.querySelector("svg.k-icon");
          if (!svg) {
            ctx.errors.push(`Scene ${ctx.sceneId}: fx.drawIcon: ${el.getAttribute("data-id") || el.tagName} has no icon`);
            continue;
          }
          const shapes = Array.from(svg.querySelectorAll(SHAPES));
          const each = seconds / Math.max(1, shapes.length * 0.6);
          ctx.tl.set(svg, { autoAlpha: 1 }, at);
          shapes.forEach((shape, k) => {
            ctx.tl.fromTo(shape, { drawSVG: "0%" }, { drawSVG: "100%", duration: each, ease: "power1.inOut", immediateRender: true }, at + k * each * 0.6);
          });
        }
        ctx.sound("pencil", at, 0.5);
      },
    };
  },
};
