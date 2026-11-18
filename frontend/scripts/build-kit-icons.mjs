/**
 * build-kit-icons - packs the explainer kit's icons and logos into public/assets/motion/kit.
 *
 *   npm pack lucide-static@0.460.0               (anywhere outside the repo)
 *   tar xzf lucide-static-0.460.0.tgz
 *   node scripts/build-kit-icons.mjs <that folder>/package <AlgoInsight>/client/public/film-art/logos
 *
 * Icons: Lucide (ISC licence), every icon as its inner SVG markup in one file, icons/lucide.json
 * ({name: markup}), and its search words in icons/tags.json ({name: [tags]}). The player draws an icon by name
 * on the 24 x 24 grid Lucide uses, in the ink colour; the backend's find_icons searches the names and tags.
 * Only the SVG files and the tags are read: the package is not a dependency of this project.
 *
 * Logos: the AlgoInsight films' one shared logo library (AWS and Azure architecture icons, Simple Icons brand
 * marks, our own drawings), copied as it is with its SOURCES.md (each group has its own terms), and an index,
 * logos/index.json ({"aws/s3": "s3", "azure/acr": "Container Registries", ...}) with the names SOURCES.md
 * gives them.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(FRONTEND, "public", "assets", "motion", "kit");
const [LUCIDE, LOGOS] = process.argv.slice(2);
if (!LUCIDE || !LOGOS) {
  console.error("usage: node scripts/build-kit-icons.mjs <lucide-static>/package <film-art>/logos");
  process.exit(2);
}

// ── Lucide: the inner markup of each icon (the <svg> wrapper is the player's own) ──

const icons = {};
for (const file of readdirSync(join(LUCIDE, "icons")).filter((f) => f.endsWith(".svg")).sort()) {
  const svg = readFileSync(join(LUCIDE, "icons", file), "utf8");
  const inner = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/\s*\n\s*/g, "")
    .trim();
  icons[basename(file, ".svg")] = inner;
}
const tags = JSON.parse(readFileSync(join(LUCIDE, "tags.json"), "utf8"));
mkdirSync(join(OUT, "icons"), { recursive: true });
writeFileSync(join(OUT, "icons", "lucide.json"), JSON.stringify(icons));
writeFileSync(join(OUT, "icons", "tags.json"), JSON.stringify(Object.fromEntries(Object.keys(icons).map((n) => [n, tags[n] ?? []]))));
copyFileSync(join(LUCIDE, "LICENSE"), join(OUT, "icons", "LICENSE.txt"));

// ── the logo library: the files as they are, and their names from SOURCES.md ──

const sources = readFileSync(join(LOGOS, "SOURCES.md"), "utf8");
/** each group's "name (Label)" tokens, from its own "## <group>" section (aws/waf and azure/waf differ) */
const named = {};
for (const section of sources.split(/\r?\n## /).slice(1)) {
  const group = section.split(/\s/)[0];
  const labels = (named[group] = {});
  for (const m of section.matchAll(/\b([a-z0-9]+) \(([^)#][^)]*)\)/g)) labels[m[1]] ??= m[2].split(/[:,]/)[0].replace(/\s+/g, " ").trim();
}
const index = {};
for (const group of ["aws", "azure", "brands", "drawn"]) {
  mkdirSync(join(OUT, "logos", group), { recursive: true });
  for (const file of readdirSync(join(LOGOS, group)).filter((f) => f.endsWith(".svg")).sort()) {
    copyFileSync(join(LOGOS, group, file), join(OUT, "logos", group, file));
    const name = basename(file, ".svg");
    index[`${group}/${name}`] = named[group]?.[name] ?? name;
  }
}
copyFileSync(join(LOGOS, "SOURCES.md"), join(OUT, "logos", "SOURCES.md"));
writeFileSync(join(OUT, "logos", "index.json"), JSON.stringify(index, null, 1));
console.log(`${Object.keys(icons).length} icons, ${Object.keys(index).length} logos written to ${OUT}`);
