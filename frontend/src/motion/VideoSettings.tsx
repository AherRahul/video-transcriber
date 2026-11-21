// The video's own settings, in the top bar's "Video" menu: who the film is made for (YouTube or Udemy),
// what frames and ends it (the logo card and web address on every page, the AlgoInsight promo before
// the end, the end screen), a length the user sets (otherwise the topic decides, in Claude's plan), the
// script's tone (normal, funny, focused, informational), and whether the script waits for the user's own
// words before any scene code.
//
// A Udemy film can't show our website, URL, price or platform (the paper style guide's rule), so Udemy
// turns the web address, the promo and the end screen off. It keeps the AlgoInsight logo card (the
// founder, 2026-11-21), drawn without the kit's tagline. All four are fixed for Udemy; the server enforces
// it too. The promo is drawn in the paper look only.

import { useEffect, useState } from "react";

import { clock } from "./api";
import { DEFAULT_CLOSING, TONE_OPTIONS, UDEMY_CLOSING, type Closing, type Destination, type ProjectView, type Tone } from "./types";

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
  const c = closingOf(view);
  if (destinationOf(view) === "udemy") {
    // what the server says (a server started before 2026-11-21 still has the logo card off for Udemy)
    return c.logo ? "Made for Udemy: the AlgoInsight logo card only (no tagline, web address, promo or end screen)." : "Made for Udemy: no logo card, web address, promo or end screen.";
  }
  const on = [c.logo && "logo card", c.url && "web address", c.promo && "AlgoInsight promo", c.endscreen && "end screen"].filter(Boolean) as string[];
  const off = [!c.logo && "logo card", !c.url && "web address", !c.promo && "promo", !c.endscreen && "end screen"].filter(Boolean) as string[];
  return `Made for YouTube${on.length ? `: ${on.join(", ")}` : ""}${off.length ? ` (no ${off.join(", ")})` : ""}.`;
}

export default function VideoSettings({ view, disabled, onPatch }: Props) {
  // a click shows at once; the saved project (or the server's refusal) settles it when the reply comes
  const [shown, setShown] = useState<{ destination?: Destination; closing?: Partial<Closing>; tone?: Tone } | null>(null);
  const tone: Tone = shown?.tone ?? view.project.tone ?? "normal";
  const destination = shown?.destination ?? destinationOf(view);
  const udemyNow = destination === "udemy";
  // Udemy's are fixed: while the switch to Udemy is on its way, what Udemy gives; after it, what the server saved
  const closing = udemyNow ? (shown?.destination === "udemy" ? UDEMY_CLOSING : closingOf(view)) : { ...closingOf(view), ...(shown?.closing ?? {}) };
  const udemy = udemyNow;
  const paper = view.bundle.theme === "paper";
  const promoScenes = view.bundle.scenes.filter((s) => s.kind === "promo");
  const promoUnvoiced = promoScenes.filter((s) => s.narration && !s.voiced).length;
  const target = view.project.targetSeconds ?? null;
  const plan = view.project.plan ?? null;
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
  // a new tone shapes the next draft; a script already written is rewritten when the user asks Claude
  const setTone = (t: Tone) => {
    setShown({ tone: t });
    void run({ tone: t });
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
  // udemyHint: the line a Udemy film shows instead of the hint (the settings are fixed there)
  const row = (key: keyof Closing, title: string, hint: string, extraDisabled?: string, udemyHint?: string) => {
    const off = udemy || !!extraDisabled;
    const checked = udemy ? closing[key] : closing[key] && !extraDisabled;
    return (
      <label className={`mo-check-row ${off && !(udemy && checked) ? "off" : ""}`} title={extraDisabled}>
        <input type="checkbox" checked={checked} disabled={lock || off} onChange={(e) => setClosing(key, e.target.checked)} />
        <span>
          <span className="mo-check-title">{title}</span>
          <span className="muted small">{udemy && udemyHint ? udemyHint : extraDisabled && !udemy ? extraDisabled : hint}</span>
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
          <p className="mo-settings-note">
            Udemy films can't show our website, URL, price or platform, so the web address, promo and end screen are off.
            {closing.logo ? " The AlgoInsight logo card stays, without its tagline." : ""}
          </p>
        ) : null}
      </div>

      <div className="mo-field">
        <span className="label">On every page</span>
        {row(
          "logo",
          "AlgoInsight logo card",
          "Top left on the paper, with the tagline under it; bottom left in other kits.",
          undefined,
          closing.logo ? "Always on for Udemy: the icon and name, without the tagline." : "Restart the app to show it on Udemy films.",
        )}
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
          The video is {clock(view.bundle.duration)} now
          {target ? `; it must land near ${clock(target)}` : plan ? `; Claude planned about ${plan.minutes} min (${plan.lengthWhy})` : ""}. Empty lets the topic decide: Claude
          picks the length it needs and says why.
        </span>
      </label>

      <div className="mo-field" role="radiogroup" aria-label="Script tone">
        <span className="label">Script tone</span>
        {TONE_OPTIONS.map((t) => (
          <label key={t.id} className={`mo-check-row ${lock ? "off" : ""}`}>
            <input type="radio" name="mo-tone" checked={tone === t.id} disabled={lock} onChange={() => setTone(t.id)} />
            <span>
              <span className="mo-check-title">{t.label}</span>
              <span className="muted small">{t.hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mo-field">
        <span className="label">The script</span>
        {/* Claude writes the whole script and builds in one go (no "Your words" step since 2026-11-19); with a
            reference, the video runs about as long as the reference and covers all of it */}
        <p className="mo-settings-note">Claude writes the whole script and builds the scenes in one go. With a reference video, it runs about as long and covers everything it covers.</p>
        {plan ? (
          <p className="mo-settings-note">
            Shape: <b>{plan.shape}</b>, {plan.why}
          </p>
        ) : null}
      </div>
    </div>
  );
}
