// The frame over every page in the kits that aren't the paper look: the brand's logo bottom-left and its web
// address bottom-right, as small pills in the kit's own colours (its ink on a see-through pill of its
// background), so they read over a black page, a white screenshot or a photo alike. Both sit in the stage's
// bottom margin, outside the safe area the scenes keep to (a 9:16 video has the platform's buttons down there,
// so its frame sits at the top instead). The paper look has its own frame (paper.ts buildChrome); this one
// returns the same Chrome so the runtime, the thumbnail and the end screen treat both alike.

import { iconTag, type Chrome } from "./paper";

/** The pills' look. Sizes are set per stage in buildPlainChrome (they scale with the stage's short side). */
const PLAIN_FRAME_CSS = `
#chrome { position: absolute; inset: 0; pointer-events: none; z-index: 5; }
#chrome .f-pill { position: absolute; display: inline-flex; align-items: center; box-sizing: border-box; white-space: nowrap;
  color: var(--ink); background: color-mix(in srgb, var(--bg) 74%, transparent); border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent); }
#chrome .f-logo .mo-icon { display: inline-flex; flex: none; }
#chrome .f-logo .mo-icon img, #chrome .f-logo .mo-icon svg { width: 100%; height: 100%; display: block; }
#chrome .f-word { font-family: var(--font-body); font-weight: 800; letter-spacing: -0.2px; }
#chrome .f-url { font-family: var(--font-body); font-weight: 700; letter-spacing: 0.3px; }
`;

/** The frame for a kit that isn't paper. Draws nothing for a part it has nothing for: the logo needs the kit's
 *  icon or logo (a kit without one shows no logo, so the kits that never had a frame stay as they were), and
 *  the web address needs the kit's url. Returns null when neither shows. */
export function buildPlainChrome(
  stage: HTMLElement,
  opts: { width: number; height: number; aspect: string; wordmark: string; iconUrl: string | null; logoUrl: string | null; url: string; showLogo: boolean },
): Chrome | null {
  stage.querySelector("#chrome")?.remove();
  stage.querySelector("#chrome-css")?.remove();
  const logo = opts.showLogo && !!(opts.iconUrl || opts.logoUrl);
  if (!logo && !opts.url) return null;
  const style = document.createElement("style");
  style.id = "chrome-css";
  style.textContent = PLAIN_FRAME_CSS;
  stage.appendChild(style);
  const root = document.createElement("div");
  root.id = "chrome";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // 36 px tall on a 1080 px short side, in step with the stage for the other sizes
  const k = Math.min(opts.width, opts.height) / 1080;
  const h = Math.round(36 * k);
  const edge = Math.round(28 * k);
  const tall = opts.aspect === "9:16"; // the platform's buttons cover the bottom of a short: the frame goes on top
  const place = tall ? `top:${Math.round(40 * k)}px;` : `bottom:${Math.round(14 * k)}px;`;
  const pill = `height:${h}px;border-radius:${Math.round(h / 2)}px;${place}`;

  // the logo: the square icon and the wordmark, or the kit's wide logo image when it has no icon
  let logoHtml = "";
  if (logo) {
    const inner = opts.iconUrl
      ? `${iconTag(opts.iconUrl).replace('class="mo-icon"', `class="mo-icon" style="width:${h - Math.round(8 * k)}px;height:${h - Math.round(8 * k)}px"`)}<span class="f-word" style="font-size:${Math.round(19 * k)}px">${esc(opts.wordmark)}</span>`
      : `<img src="${esc(opts.logoUrl!)}" alt="" style="height:${h - Math.round(10 * k)}px;width:auto;display:block">`;
    logoHtml = `<div class="f-pill f-logo" style="${pill}left:${edge}px;gap:${Math.round(8 * k)}px;padding:0 ${Math.round(14 * k)}px 0 ${Math.round(4 * k)}px">${inner}</div>`;
  }
  const urlHtml = opts.url ? `<div class="f-pill f-url" style="${pill}right:${edge}px;padding:0 ${Math.round(14 * k)}px;font-size:${Math.round(18 * k)}px">${esc(opts.url)}</div>` : "";
  root.innerHTML = logoHtml + urlHtml;
  stage.appendChild(root);

  // the paper frame's title and part tag have no place here: hidden stand-ins keep the Chrome shape
  const title = document.createElement("div");
  const part = document.createElement("div");
  return {
    root,
    title,
    part,
    setPart() {},
    setVisible(on: boolean) {
      root.style.display = on ? "block" : "none";
    },
    setBare(on: boolean) {
      // a thumbnail is a picture of its own: no logo or web address on it
      for (const el of Array.from(root.children) as HTMLElement[]) el.style.visibility = on ? "hidden" : "";
    },
  };
}
