// The cast's drawing (kit/toon.ts): our own cartoon person, drawn in code so every person has the same figure
// and outfit in every pose. A slim build in an open jacket, a tee, jeans and sneakers, bright skin, thick dark
// outlines and flat colours, a big head with big eyes. Only the hair, the accessories and the colours change from
// one person to the next (cast.json's spec for each).
//
// It is a rig, not a set of pictures: each arm is a shoulder joint holding the upper arm, which holds an elbow
// joint, the forearm and the hand, so a pose is just two angles per arm and a pose change can move smoothly. The
// faces are layers (eyes, brows, mouth) shown one at a time. personMarkup() draws a person with every layer;
// setArms() puts the arms at a pose's angles.
//
// The canvas: x 0-400, y -40 (above the hair) to 900 (the soles), the figure centred on x 200. The head is drawn
// 1.32 times its own size around the neck, the reference's big-headed proportions.

export const INK = "#1b1b22";
const OL = 7; // the outline's width

export type ToonSpec = {
  skin: string;
  hair: string;
  hairStyle: "long" | "pony" | "short" | "curly" | "bun";
  jacket: string;
  cuff: string;
  tee: string;
  pants: string;
  shoes: string;
  iris?: string;
  lashes?: boolean;
  earrings?: boolean;
  glasses?: boolean;
  beard?: boolean;
};

/** [shoulder, elbow] per arm in degrees (0 hangs straight down, positive swings out from the body) and the hand. */
export type ArmPose = { l: [number, number]; r: [number, number]; lh: Hand; rh: Hand };
type Hand = "open" | "point" | "fist" | "phone";

export const POSES: Record<string, ArmPose> = {
  rest: { l: [12, -10], r: [12, -10], lh: "open", rh: "open" },
  wave: { l: [12, -10], r: [155, 25], lh: "open", rh: "open" },
  point: { l: [12, -10], r: [88, 6], lh: "open", rh: "point" },
  explain: { l: [12, -10], r: [28, -88], lh: "open", rh: "open" },
  think: { l: [-6, -40], r: [-18, -148], lh: "fist", rh: "fist" },
  shrug: { l: [42, -100], r: [42, -100], lh: "open", rh: "open" },
  hips: { l: [38, -95], r: [38, -95], lh: "fist", rh: "fist" },
  phone: { l: [-14, -120], r: [-4, -132], lh: "phone", rh: "open" },
};

type Eyes = "open" | "happy" | "wide" | "look" | "closed";
type Face = { brow: [number, number]; eyes: Eyes; mouth: string; browUp?: boolean };
export const FACES: Record<string, Face> = {
  smile: { brow: [0, 0], eyes: "open", mouth: "smile" },
  talk: { brow: [0, 2], eyes: "open", mouth: "talk" },
  happy: { brow: [-4, 6], eyes: "happy", mouth: "grin" },
  surprised: { brow: [-6, 12], eyes: "wide", mouth: "o" },
  worried: { brow: [14, 4], eyes: "open", mouth: "wavy" },
  thinking: { brow: [0, 0], eyes: "look", mouth: "side", browUp: true },
  confident: { brow: [-8, -2], eyes: "open", mouth: "smirk" },
  sad: { brow: [16, 2], eyes: "open", mouth: "frown" },
};

/** The part of the canvas each crop shows: x, y, w, h. */
export const CROPS: Record<string, [number, number, number, number]> = {
  full: [0, -40, 400, 940],
  bust: [30, -40, 340, 520],
  head: [40, -40, 320, 330],
};

const SHOULDER_Y = 338;
const SHOULDER_DX = 74;
const UPPER = 138;
const FORE = 128;

const tube = (d: string, w: number, color: string) =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w + OL * 2}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const blob = (d: string, fill: string, extra = "") => `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${OL}" stroke-linejoin="round" ${extra}/>`;

// ── the hands, in the forearm's own frame: the wrist at 0,0 and the arm pointing down (+y) ──

function hands(side: number, skin: string): string {
  const thumb = `<path d="M ${-14 * side} -6 Q ${-30 * side} -14 ${-30 * side} 0" fill="${skin}" stroke="${INK}" stroke-width="${OL - 1}" stroke-linecap="round"/>`;
  const open = `<g data-hand="open"><circle r="25" fill="${skin}" stroke="${INK}" stroke-width="${OL}"/>${thumb}</g>`;
  const fist = `<g data-hand="fist"><circle r="23" fill="${skin}" stroke="${INK}" stroke-width="${OL}"/></g>`;
  const point =
    `<g data-hand="point">` +
    blob(`M -18 -8 Q -22 18 0 22 Q 22 20 20 -2 Z`, skin) +
    blob(`M 2 12 Q 4 48 ${8 * side} 62 Q ${16 * side} 66 ${16 * side} 52 L 12 10 Z`, skin) +
    `</g>`;
  // the phone stays upright whatever the forearm does (its group is turned back by the arm's angle)
  const phone =
    `<g data-hand="phone"><g class="t-upright">` +
    `<rect x="-22" y="-46" width="44" height="80" rx="9" fill="#2b2d42" stroke="${INK}" stroke-width="${OL}"/>` +
    `<rect x="-15" y="-38" width="30" height="60" rx="4" fill="#8ecae6"/>` +
    blob(`M -26 6 Q -30 30 -4 32 Q 24 30 26 8 Q 10 16 -26 6 Z`, skin) +
    `</g></g>`;
  return open + fist + point + phone;
}

/** One arm: the shoulder joint (rotated by setArms), the sleeve, the elbow joint, the forearm with its cuff and
 *  the hands (one shown). Drawn twice, behind and in front of the body: a forearm across the chest is in front. */
function armMarkup(side: number, spec: ToonSpec, layer: "back" | "front"): string {
  const sx = 200 + side * SHOULDER_DX;
  return (
    `<g class="t-arm" data-side="${side < 0 ? "l" : "r"}" data-layer="${layer}" transform="translate(${sx} ${SHOULDER_Y})">` +
    `<g class="t-sh">${tube(`M 0 0 L 0 ${UPPER}`, 40, spec.jacket)}` +
    `<g class="t-el" transform="translate(0 ${UPPER})">${tube(`M 0 0 L 0 ${FORE}`, 40, spec.jacket)}` +
    `<path d="M 0 ${FORE * 0.82} L 0 ${FORE}" stroke="${spec.cuff}" stroke-width="40"/>` +
    `<g class="t-hand" transform="translate(0 ${FORE})">${hands(side, spec.skin)}</g>` +
    `</g></g></g>`
  );
}

function legs(spec: ToonSpec): string {
  const out: string[] = [];
  for (const side of [-1, 1]) {
    const hx = 200 + side * 32;
    out.push(tube(`M ${hx} 590 L ${hx + side * 6} 720 L ${hx + side * 8} 842`, 48, spec.pants));
    const fx = hx + side * 8;
    out.push(blob(`M ${fx - 30} 838 Q ${fx - 36} 884 ${fx - 6} 888 L ${fx + side * 52} 888 Q ${fx + side * 70} 884 ${fx + side * 50} 856 Q ${fx + side * 20} 826 ${fx - 30} 838 Z`, spec.shoes));
    out.push(`<path d="M ${fx - 30} 876 L ${fx + side * 60} 876" stroke="#fff" stroke-width="7" stroke-linecap="round"/>`);
  }
  return out.join("");
}

function torso(spec: ToonSpec): string {
  const neck = blob(`M 182 286 L 182 330 Q 200 344 218 330 L 218 286 Z`, spec.skin);
  const tee = blob(`M 140 330 Q 200 318 260 330 L 266 590 Q 200 604 134 590 Z`, spec.tee);
  const left = blob(`M 120 352 Q 120 330 150 326 L 180 324 L 196 470 L 188 596 Q 152 600 128 592 Q 118 470 120 352 Z`, spec.jacket);
  const right = blob(`M 280 352 Q 280 330 250 326 L 220 324 L 204 470 L 212 596 Q 248 600 272 592 Q 282 470 280 352 Z`, spec.jacket);
  const lapels =
    `<path d="M 178 326 L 166 380 L 192 430" fill="none" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` +
    `<path d="M 222 326 L 234 380 L 208 430" fill="none" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`;
  const vneck = `<path d="M 180 324 Q 200 352 220 324" fill="none" stroke="${INK}" stroke-width="5"/>`;
  return neck + tee + left + right + lapels + vneck;
}

// ── the head: drawn on its own grid (the face centred on x 200, the chin at y 284), scaled up as a whole ──

function hairBack(spec: ToonSpec): string {
  const c = spec.hair;
  if (spec.hairStyle === "long") return blob(`M 110 150 Q 84 240 96 330 Q 80 372 112 392 Q 132 404 150 384 Q 140 340 150 300 Q 146 262 150 240 L 250 240 Q 254 262 250 300 Q 260 340 250 384 Q 268 404 288 392 Q 320 372 304 330 Q 316 240 290 150 Q 270 44 200 42 Q 130 44 110 150 Z`, c);
  if (spec.hairStyle === "pony") return blob(`M 268 120 Q 330 130 322 230 Q 314 300 286 330 Q 300 250 270 190 Z`, c);
  if (spec.hairStyle === "bun") return `<circle cx="200" cy="50" r="40" fill="${c}" stroke="${INK}" stroke-width="${OL}"/>`;
  return "";
}

function hairFront(spec: ToonSpec): string {
  const c = spec.hair;
  if (spec.hairStyle === "short") return blob(`M 116 168 Q 104 80 170 62 Q 232 44 270 84 Q 296 112 284 168 Q 270 128 246 116 Q 210 132 170 118 Q 136 128 116 168 Z`, c);
  if (spec.hairStyle === "curly") return blob(`M 112 170 Q 92 120 118 90 Q 122 58 158 56 Q 180 36 210 48 Q 244 38 262 66 Q 298 76 292 116 Q 304 146 286 170 Q 276 132 252 122 Q 222 138 192 124 Q 160 136 140 124 Q 118 138 112 170 Z`, c);
  if (spec.hairStyle === "pony" || spec.hairStyle === "bun") {
    const tie = spec.hairStyle === "pony" ? `<circle cx="272" cy="118" r="10" fill="#e63946" stroke="${INK}" stroke-width="4"/>` : "";
    return blob(`M 116 168 Q 104 82 200 70 Q 296 82 284 168 Q 276 120 250 108 Q 214 124 196 112 Q 160 128 140 118 Q 122 132 116 168 Z`, c) + tie;
  }
  // long: a side parting with a soft fringe
  return blob(`M 114 176 Q 100 80 200 66 Q 300 80 286 176 Q 282 120 236 104 Q 186 140 132 132 Q 118 148 114 176 Z`, c);
}

function eyes(kind: Eyes, spec: ToonSpec): string {
  const one = (cx: number, side: number) => {
    const y = 186;
    if (kind === "closed") return `<path d="M ${cx - 20} ${y} Q ${cx} ${y + 12} ${cx + 20} ${y}" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;
    if (kind === "happy") return `<path d="M ${cx - 20} ${y + 4} Q ${cx} ${y - 16} ${cx + 20} ${y + 4}" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`;
    const ry = kind === "wide" ? 26 : 22;
    const rx = 17;
    const look = kind === "look" ? 6 : 0;
    const lash = spec.lashes ? `<path d="M ${cx + side * 15} ${y - 16} l ${side * 9} -7" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>` : "";
    return (
      `<ellipse cx="${cx}" cy="${y}" rx="${rx}" ry="${ry}" fill="#fff" stroke="${INK}" stroke-width="5"/>` +
      `<circle cx="${cx + look}" cy="${y + 3 - look}" r="${kind === "wide" ? 11 : 13}" fill="${spec.iris || "#5a3825"}"/>` +
      `<circle cx="${cx + look}" cy="${y + 3 - look}" r="6" fill="${INK}"/>` +
      `<circle cx="${cx + look + 5}" cy="${y - 3 - look}" r="4.5" fill="#fff"/><circle cx="${cx + look - 4}" cy="${y + 8 - look}" r="2" fill="#fff"/>` +
      `<path d="M ${cx - rx - 2} ${y - 6} Q ${cx} ${y - ry - 10} ${cx + rx + 2} ${y - 6}" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>` +
      lash
    );
  };
  return one(160, -1) + one(240, 1);
}

function brows(f: Face, spec: ToonSpec): string {
  const one = (cx: number, side: number) => {
    const [tilt, lift] = f.brow;
    const up = f.browUp && side > 0 ? 8 : 0;
    const yi = 150 - lift - tilt * 0.5 - up;
    const yo = 150 - lift + tilt * 0.5 - up;
    const xi = cx - side * 16;
    const xo = cx + side * 18;
    return `<path d="M ${xi} ${yi} Q ${cx} ${Math.min(yi, yo) - 8} ${xo} ${yo}" fill="none" stroke="${spec.hair}" stroke-width="9" stroke-linecap="round"/>`;
  };
  return one(160, -1) + one(240, 1);
}

const MOUTHS: Record<string, string> = {
  smile: `<path d="M 176 244 Q 200 262 224 244" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`,
  talk: `<path d="M 182 240 Q 200 236 218 240 Q 216 266 200 268 Q 184 266 182 240 Z" fill="#7a1f2b" stroke="${INK}" stroke-width="5"/><path d="M 188 258 Q 200 252 212 258 Q 206 266 200 266 Q 194 266 188 258 Z" fill="#ff8fa3"/>`,
  grin: `<path d="M 170 238 Q 200 242 230 238 Q 226 276 200 278 Q 174 276 170 238 Z" fill="#7a1f2b" stroke="${INK}" stroke-width="5"/><path d="M 174 240 Q 200 246 226 240 L 224 250 Q 200 254 176 250 Z" fill="#fff"/><path d="M 184 266 Q 200 258 216 266 Q 208 276 200 276 Q 192 276 184 266 Z" fill="#ff8fa3"/>`,
  o: `<ellipse cx="200" cy="254" rx="13" ry="17" fill="#7a1f2b" stroke="${INK}" stroke-width="5"/>`,
  wavy: `<path d="M 178 252 Q 186 244 194 252 Q 202 260 210 252 Q 216 246 222 252" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`,
  side: `<path d="M 186 252 Q 206 256 222 244" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`,
  smirk: `<path d="M 178 248 Q 204 258 226 240" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`,
  frown: `<path d="M 178 258 Q 200 242 222 258" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`,
};

const vis = (on: boolean) => `style="visibility:${on ? "visible" : "hidden"}"`;

/** The head with every face layer: data-eyes, data-brows and data-mouth groups, one of each shown. */
function headMarkup(spec: ToonSpec, face: string): string {
  const s = spec.skin;
  const f = FACES[face] ?? FACES.smile;
  const parts: string[] = [];
  parts.push(blob(`M 116 176 Q 98 172 100 198 Q 104 224 124 220 Z`, s), blob(`M 284 176 Q 302 172 300 198 Q 296 224 276 220 Z`, s));
  if (spec.earrings) parts.push(`<circle cx="106" cy="226" r="7" fill="#f4c430" stroke="${INK}" stroke-width="3"/><circle cx="294" cy="226" r="7" fill="#f4c430" stroke="${INK}" stroke-width="3"/>`);
  parts.push(blob(`M 120 150 Q 118 92 200 86 Q 282 92 280 150 L 278 200 Q 272 262 200 284 Q 128 262 122 200 Z`, s));
  parts.push(`<ellipse cx="146" cy="222" rx="20" ry="11" fill="#ff7b91" opacity=".45"/><ellipse cx="254" cy="222" rx="20" ry="11" fill="#ff7b91" opacity=".45"/>`);
  for (const k of ["open", "happy", "wide", "look", "closed"] as Eyes[]) parts.push(`<g data-eyes="${k}" ${vis(k === f.eyes)}>${eyes(k, spec)}</g>`);
  for (const [name, def] of Object.entries(FACES)) parts.push(`<g data-brows="${name}" ${vis(name === face)}>${brows(def, spec)}</g>`);
  parts.push(`<path d="M 202 206 Q 210 222 198 226" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`);
  for (const [name, d] of Object.entries(MOUTHS)) parts.push(`<g data-mouth="${name}" ${vis(name === f.mouth)}>${d}</g>`);
  if (spec.beard) parts.push(`<path d="M 132 214 Q 140 268 200 286 Q 260 268 268 214 Q 262 250 236 262 Q 200 276 164 262 Q 138 250 132 214 Z" fill="${spec.hair}" opacity=".28"/>`);
  if (spec.glasses) parts.push(`<g fill="none" stroke="${INK}" stroke-width="6"><rect x="134" y="160" width="54" height="46" rx="16"/><rect x="212" y="160" width="54" height="46" rx="16"/><path d="M 188 180 Q 200 172 212 180"/></g>`);
  parts.push(hairFront(spec));
  return parts.join("");
}

const HEAD_SCALE = "translate(0 22) translate(200 292) scale(1.32) translate(-200 -292)";

/** A whole person as SVG markup: every layer drawn, the given face and pose showing (setArms places the arms). */
export function personMarkup(spec: ToonSpec, face: string, crop: string): string {
  const [x, y, w, h] = CROPS[crop] ?? CROPS.full;
  return (
    `<svg class="t-svg" xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" preserveAspectRatio="xMidYMid meet" overflow="visible">` +
    `<g class="t-headwrap"><g transform="${HEAD_SCALE}">${hairBack(spec)}</g></g>` +
    legs(spec) +
    armMarkup(-1, spec, "back") + armMarkup(1, spec, "back") +
    torso(spec) +
    armMarkup(-1, spec, "front") + armMarkup(1, spec, "front") +
    `<g class="t-headwrap"><g transform="${HEAD_SCALE}">${headMarkup(spec, face)}</g></g>` +
    `</svg>`
  );
}

/** A forearm across the body is drawn in front of the jacket, otherwise behind it. */
const inFront = (sh: number, el: number) => sh + el < -60;

/** Puts a person's arms at these angles (each arm's shoulder and elbow), showing the right hand shapes and the
 *  arm on the right side of the body. */
export function setArms(svg: Element, angles: { l: [number, number]; r: [number, number] }, hands?: { lh: string; rh: string }) {
  for (const arm of Array.from(svg.querySelectorAll<SVGGElement>(".t-arm"))) {
    const left = arm.dataset.side === "l";
    const side = left ? -1 : 1;
    const [sh, el] = left ? angles.l : angles.r;
    arm.querySelector(".t-sh")!.setAttribute("transform", `rotate(${-side * sh})`);
    arm.querySelector(".t-el")!.setAttribute("transform", `translate(0 ${UPPER}) rotate(${-side * el})`);
    // the phone stays upright: its group is turned back by the forearm's angle
    for (const up of Array.from(arm.querySelectorAll(".t-upright"))) up.setAttribute("transform", `rotate(${side * (sh + el)})`);
    const front = inFront(sh, el);
    arm.style.visibility = (arm.dataset.layer === "front") === front ? "visible" : "hidden";
    if (hands) {
      const want = left ? hands.lh : hands.rh;
      for (const h of Array.from(arm.querySelectorAll<SVGGElement>("[data-hand]"))) h.style.visibility = h.dataset.hand === want ? "inherit" : "hidden";
    }
  }
}

/** Turns the head (degrees, about the neck). */
export function setHead(svg: Element, deg: number) {
  for (const h of Array.from(svg.querySelectorAll(".t-headwrap"))) h.setAttribute("transform", `rotate(${deg} 200 330)`);
}
