// The video's own settings, in the top bar's "Video" menu: who the film is made for (YouTube or Udemy),
// what frames and ends it (the logo card and web address on every page, the AlgoInsight promo before
// the end, the end screen) and the length the script aims for.
//
// A Udemy film can't show our website, URL, price or platform (the paper style guide's rule), so Udemy
// turns all four off; the server enforces it too. The promo is drawn in the paper look only.

import { useEffect, useState } from "react";

import { clock } from "./api";
import { DEFAULT_CLOSING, type Closing, type Destination, type ProjectView } from "./types";

type Props = {
  view: ProjectView;
  disabled: boolean;
  onPatch: (body: Record<string, unknown>) => Promise<unknown>;
};

/** The closing settings, filled in for a project saved before they existed. */
export function closingOf(view: ProjectView): Closing {
  const saved = view.project.closing;
  if (saved) return { ...DEFAULT_CLOSING, ...saved };
  // older projects: the end screen is on when the video has one
  return { ...DEFAULT_CLOSING, endscreen: view.bundle.scenes.some((s) => s.kind === "endscreen") || DEFAULT_CLOSING.endscreen };
}

export function destinationOf(view: ProjectView): Destination {
  return view.project.destination === "udemy" ? "udemy" : "youtube";
}

/** One line for the export panel: what this video is made for and what frames it. */
export function closingSummary(view: ProjectView): string {
  if (destinationOf(view) === "udemy") return "Made for Udemy: no logo card, web address, promo or end screen.";
  const c = closingOf(view);
  const on = [c.logo && "logo card", c.url && "web address", c.promo && "AlgoInsight promo", c.endscreen && "end screen"].filter(Boolean) as string[];
  const off = [!c.logo && "logo card", !c.url && "web address", !c.promo && "promo", !c.endscreen && "end screen"].filter(Boolean) as string[];
  return `Made for YouTube${on.length ? `: ${on.join(", ")}` : ""}${off.length ? ` (no ${off.join(", ")})` : ""}.`;
}

export default function VideoSettings({ view, disabled, onPatch }: Props) {
  // a click shows at once; the saved project (or the server's refusal) settles it when the reply comes
  const [shown, setShown] = useState<{ destination?: Destination; closing?: Partial<Closing> } | null>(null);
  const destination = shown?.destination ?? destinationOf(view);
  const udemyNow = destination === "udemy";
  const closing = udemyNow ? { logo: false, url: false, promo: false, endscreen: false } : { ...closingOf(view), ...(shown?.closing ?? {}) };
  const udemy = udemyNow;
  const paper = view.bundle.theme === "paper";
  const promoScenes = view.bundle.scenes.filter((s) => s.kind === "promo");
  const promoUnvoiced = promoScenes.filter((s) => s.narration && !s.voiced).length;
  const target = view.project.targetSeconds ?? null;
  const [minutes, setMinutes] = useState(target ? String(Math.round((target / 60) * 10) / 10) : "");
  const [busy, setBusy] = useState(false);

  // show a target changed elsewhere (Claude, another tab) unless the field is being edited
  useEffect(() => {
    if (document.activeElement?.id !== "mo-target") setMinutes(target ? String(Math.round((target / 60) * 10) / 10) : "");
  }, [target]);

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await onPatch(body);
    } finally {
      setBusy(false);
      setShown(null);
    }
  }

  const setClosing = (key: keyof Closing, value: boolean) => {
    setShown({ closing: { [key]: value } });
    void run({ closing: { [key]: value } });
  };
  const setDestination = (d: Destination) => {
    setShown({ destination: d });
    void run({ destination: d });
  };

  function saveTarget() {
    const raw = minutes.trim();
    if (!raw) {
      if (target) void run({ targetSeconds: null });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setMinutes(target ? String(Math.round((target / 60) * 10) / 10) : "");
      return;
    }
    const seconds = Math.round(n * 60);
    if (seconds !== Math.round(target ?? 0)) void run({ targetSeconds: seconds });
  }

  const lock = disabled || busy;
  const row = (key: keyof Closing, title: string, hint: string, extraDisabled?: string) => {
    const off = udemy || !!extraDisabled;
    return (
      <label className={`mo-check-row ${off ? "off" : ""}`} title={extraDisabled}>
        <input type="checkbox" checked={!udemy && closing[key] && !extraDisabled} disabled={lock || off} onChange={(e) => setClosing(key, e.target.checked)} />
        <span>
          <span className="mo-check-title">{title}</span>
          <span className="muted small">{extraDisabled && !udemy ? extraDisabled : hint}</span>
        </span>
      </label>
    );
  };

  return (
    <div className="mo-settings">
      <div className="mo-field">
        <span className="label">Made for</span>
        <div className="mo-seg mo-seg-wide" role="radiogroup" aria-label="Made for">
          {(["youtube", "udemy"] as Destination[]).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={destination === d} className={destination === d ? "on" : ""} disabled={lock} onClick={() => destination !== d && setDestination(d)}>
              {d === "youtube" ? "YouTube" : "Udemy"}
            </button>
          ))}
        </div>
        {udemy ? (
          <p className="mo-settings-note">Udemy films can't show our website, URL, price or platform, so the logo card, web address, promo and end screen are off.</p>
        ) : null}
      </div>

      <div className="mo-field">
        <span className="label">On every page</span>
        {row("logo", "AlgoInsight logo card", "Top left, with the tagline under it.")}
        {row("url", "Web address", "algoinsight.io, bottom right.")}
      </div>

      <div className="mo-field">
        <span className="label">At the end</span>
        {row("promo", "AlgoInsight promo before the end", "About 1 min, 4 narrated scenes: lessons, practice, mock interviews, the mentor.", paper ? undefined : "The promo is drawn in the paper look: switch the brand kit to AlgoInsight Paper.")}
        {!udemy && closing.promo && promoScenes.length && promoUnvoiced ? (
          <p className="mo-settings-note">
            {promoUnvoiced} promo scene{promoUnvoiced > 1 ? "s have" : " has"} no voice yet: open Voice and press Generate voice.
          </p>
        ) : null}
        {row("endscreen", "End screen", "Thanks for watching, Watch next and More from the series, Subscribe.")}
      </div>

      <label className="mo-field" htmlFor="mo-target">
        <span className="label">Target length (minutes)</span>
        <input
          id="mo-target"
          type="number"
          min={0.2}
          max={45}
          step={0.5}
          value={minutes}
          disabled={lock}
          placeholder="No target"
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={saveTarget}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <span className="muted small">
          The video is {clock(view.bundle.duration)} now{target ? `; Claude aims for about ${clock(target)}` : ""}. A timed transcript sets this on its own; empty means no target.
        </span>
      </label>
    </div>
  );
}
