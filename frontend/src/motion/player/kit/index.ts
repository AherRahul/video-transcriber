// The explainer kit: the modules, and the four places the runtime calls them (see kit/types.ts).
//
//   loadKit     once per load, before the scenes are built: each module fetches what the scenes need
//   prepareKit  for each scene, after its markup is on the page and before its script runs
//   makeKit     the scene's fx gains every module's helpers
//   kitReady    waits for media (b-roll) before the first frame; kitSync keeps it at the seeked time

import type { Bundle } from "../../types";
import { broll } from "./broll";
import { cast } from "./cast";
import { ds } from "./ds";
import { excalidraw } from "./excalidraw";
import { icons } from "./icons";
import { sequence } from "./sequence";
import { sketch } from "./sketch";
import type { KitAssets, KitCtx, KitModule } from "./types";

export type { KitAssets, KitCtx, KitModule } from "./types";

// the order matters for prepare: icons first (a sketch node or a person's badge may hold an icon), the sketch
// look next (it draws around what is already there), the rest after
const MODULES: KitModule[] = [icons, sketch, excalidraw, ds, sequence, cast, broll];

export const KIT_CSS = MODULES.map((m) => m.css ?? "").join("\n");

export function newKitAssets(kitBase: string, assetBase: string): KitAssets {
  return { kitBase, assetBase, store: new Map() };
}

/** Every module's load, side by side. Returns the problems they found (a file that didn't load). */
export async function loadKit(bundle: Bundle, assets: KitAssets): Promise<string[]> {
  const results = await Promise.all(
    MODULES.map(async (m) => {
      if (!m.load) return [];
      try {
        return await m.load(bundle, assets);
      } catch (err) {
        return [`The ${m.name} kit didn't load: ${err instanceof Error ? err.message : String(err)}`];
      }
    }),
  );
  return results.flat();
}

export function prepareKit(ctx: KitCtx) {
  for (const m of MODULES) {
    if (!m.prepare) continue;
    try {
      m.prepare(ctx);
    } catch (err) {
      ctx.errors.push(`Scene ${ctx.sceneId}: ${m.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function makeKit(ctx: KitCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of MODULES) if (m.make) Object.assign(out, m.make(ctx));
  return out;
}

/** After the scene's script: each module's finishing pass. */
export function finishKit(ctx: KitCtx) {
  for (const m of MODULES) {
    if (!m.finish) continue;
    try {
      m.finish(ctx);
    } catch (err) {
      ctx.errors.push(`Scene ${ctx.sceneId}: ${m.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function kitReady(roots: ParentNode[]): Promise<void> {
  await Promise.all(MODULES.flatMap((m) => (m.ready ? roots.map((r) => m.ready!(r).catch(() => undefined)) : [])));
}

/** After a seek: media that runs by itself goes to the same moment. Null when nothing has to be waited for. */
export function kitSync(root: ParentNode, local: number, exact: boolean): Promise<void> | null {
  const waits: Promise<void>[] = [];
  for (const m of MODULES) {
    const w = m.sync?.(root, local, exact);
    if (w) waits.push(w);
  }
  return waits.length ? Promise.all(waits).then(() => undefined) : null;
}
