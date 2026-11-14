// The Brand Kit editor (a dialog): palette roles, extra colours, fonts, corner radius, motion
// personality, background, style notes for Claude, the end card and the logo. "Read from a website"
// fills the form from a site's CSS and logo; nothing is saved until Save.

import { useEffect, useRef, useState } from "react";

import { motionApi } from "./api";
import type { BrandKit, Palette } from "./types";

const ROLES: { key: keyof Palette; label: string; hint: string }[] = [
  { key: "bg", label: "Background", hint: "behind everything" },
  { key: "surface", label: "Surface", hint: "cards and panels" },
  { key: "ink", label: "Ink", hint: "main text" },
  { key: "muted", label: "Muted", hint: "secondary text" },
  { key: "accent", label: "Accent", hint: "highlights, key words" },
  { key: "accent2", label: "Accent 2", hint: "a second highlight" },
];

const FONT_SUGGESTIONS = [
  "Inter", "Bricolage Grotesque", "Space Grotesk", "Manrope", "DM Sans", "Plus Jakarta Sans", "Poppins", "Montserrat",
  "Outfit", "Sora", "Archivo", "Work Sans", "IBM Plex Sans", "Source Serif 4", "Fraunces", "Playfair Display",
  "Lora", "JetBrains Mono", "IBM Plex Mono", "Fira Code", "Caveat", "system-ui", "Segoe UI", "Georgia",
];

const BLANK: Omit<BrandKit, "id"> = {
  name: "New brand kit",
  palette: { bg: "#0f1115", surface: "#1b1f2a", ink: "#f5f5f2", muted: "#9aa1ad", accent: "#4f8cff", accent2: "#f5b14c" },
  extras: {},
  fonts: { display: "Inter", body: "Inter", mono: "JetBrains Mono" },
  radius: 12,
  motion: "snappy",
  background: "",
  style: "",
  endCard: { enabled: false, headline: "", cta: "", url: "" },
};

type Props = {
  kit: BrandKit | null; // null = a new kit
  copyFrom?: BrandKit | null;
  onClose: () => void;
  onSaved: (kit: BrandKit) => void;
};

const hexOk = (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim());

export default function BrandKitEditor({ kit, copyFrom, onClose, onSaved }: Props) {
  const start = kit ?? (copyFrom ? { ...copyFrom, name: `${copyFrom.name} copy` } : BLANK);
  const [form, setForm] = useState<Omit<BrandKit, "id">>({
    name: start.name,
    palette: { ...start.palette },
    extras: { ...start.extras },
    fonts: { ...start.fonts },
    radius: start.radius,
    motion: start.motion,
    background: start.background ?? "",
    style: start.style ?? "",
    endCard: { ...start.endCard },
  });
  const [url, setUrl] = useState("");
  const [reading, setReading] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<BrandKit | null>(kit);
  const [extraName, setExtraName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const badColours = [...Object.values(form.palette), ...Object.values(form.extras)].filter((v) => !hexOk(v));

  async function readSite() {
    if (!url.trim()) return;
    setReading(true);
    setError(null);
    try {
      const info = await motionApi.extractBrand(url.trim());
      setForm((f) => ({
        ...f,
        name: kit ? f.name : info.draft.name,
        palette: { ...f.palette, ...info.draft.palette },
        fonts: { ...f.fonts, ...info.draft.fonts },
        endCard: kit ? f.endCard : { ...f.endCard, ...info.draft.endCard },
      }));
      setLogoUrl(info.logoUrl);
      setCandidates(info.candidates.colors.map((c) => c.hex));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  }

  async function save() {
    if (badColours.length) {
      setError(`Fix these colours first: ${badColours.join(", ")}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = current ? await motionApi.updateKit(current.id, form) : await motionApi.createKit(form, { baseKitId: copyFrom?.id, logoUrl });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(file: File) {
    setError(null);
    try {
      // a new kit is saved first, so the logo has somewhere to go
      const target = current ?? (await motionApi.createKit(form, { baseKitId: copyFrom?.id }));
      const updated = await motionApi.uploadLogo(target.id, file);
      setCurrent(updated);
      setLogoUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const logoShown = current?.logo ? motionApi.logoUrl(current) : logoUrl ?? (copyFrom ? motionApi.logoUrl(copyFrom) : null);

  return (
    <div className="mo-modal-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mo-modal" role="dialog" aria-modal="true" aria-label="Brand kit">
        <header className="mo-modal-head">
          <h2>{kit ? `Edit ${kit.name}` : "New brand kit"}</h2>
          <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="mo-modal-body">
          <section className="mo-kit-section">
            <label className="label" htmlFor="kit-url">
              Read from a website
            </label>
            <div className="row">
              <input id="kit-url" type="url" placeholder="https://your-site.com" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void readSite()} />
              <button type="button" className="btn" onClick={() => void readSite()} disabled={reading || !url.trim()}>
                {reading ? "Reading…" : "Read"}
              </button>
            </div>
            <p className="muted small">Fills in the colours, fonts, name and logo it finds. Check the roles before saving.</p>
            {candidates.length ? (
              <div className="mo-candidates">
                <span className="muted small">Colours on the site (click to copy):</span>
                {candidates.map((c) => (
                  <button key={c} type="button" className="mo-swatch-btn" style={{ background: c }} title={c} onClick={() => navigator.clipboard?.writeText(c)} />
                ))}
              </div>
            ) : null}
          </section>

          <div className="mo-kit-grid">
            <label className="mo-field wide" htmlFor="kit-name">
              <span className="label">Name</span>
              <input id="kit-name" type="text" value={form.name} onChange={(e) => set("name", e.target.value)} />
            </label>

            {ROLES.map((r) => (
              <label key={r.key} className="mo-field" htmlFor={`kit-${r.key}`}>
                <span className="label">
                  {r.label} <span className="muted">· {r.hint}</span>
                </span>
                <span className="mo-color">
                  <input type="color" value={hexOk(form.palette[r.key]) && form.palette[r.key].length === 7 ? form.palette[r.key] : "#000000"} onChange={(e) => set("palette", { ...form.palette, [r.key]: e.target.value })} aria-label={r.label} />
                  <input id={`kit-${r.key}`} type="text" value={form.palette[r.key]} onChange={(e) => set("palette", { ...form.palette, [r.key]: e.target.value })} className={hexOk(form.palette[r.key]) ? "" : "bad"} />
                </span>
              </label>
            ))}

            <div className="mo-field wide">
              <span className="label">Extra colours (Claude uses them as var(--c-name))</span>
              <div className="mo-extras">
                {Object.entries(form.extras).map(([name, value]) => (
                  <span key={name} className="mo-extra">
                    <input type="color" value={value.length === 7 ? value : "#000000"} onChange={(e) => set("extras", { ...form.extras, [name]: e.target.value })} aria-label={name} />
                    <span>{name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      onClick={() => {
                        const next = { ...form.extras };
                        delete next[name];
                        set("extras", next);
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <span className="mo-extra-add">
                  <input type="text" placeholder="name, e.g. success" value={extraName} onChange={(e) => setExtraName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={!extraName || extraName in form.extras}
                    onClick={() => {
                      set("extras", { ...form.extras, [extraName]: form.palette.accent });
                      setExtraName("");
                    }}
                  >
                    Add
                  </button>
                </span>
              </div>
            </div>

            {(["display", "body", "mono"] as const).map((k) => (
              <label key={k} className="mo-field" htmlFor={`kit-font-${k}`}>
                <span className="label">{k === "display" ? "Heading font" : k === "body" ? "Text font" : "Code font"}</span>
                <input id={`kit-font-${k}`} type="text" list="mo-fonts" value={form.fonts[k]} onChange={(e) => set("fonts", { ...form.fonts, [k]: e.target.value })} />
              </label>
            ))}
            <datalist id="mo-fonts">
              {FONT_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>

            <label className="mo-field" htmlFor="kit-radius">
              <span className="label">Corner radius (px)</span>
              <input id="kit-radius" type="number" min={0} max={64} value={form.radius} onChange={(e) => set("radius", Number(e.target.value) || 0)} />
            </label>
            <label className="mo-field" htmlFor="kit-motion">
              <span className="label">Motion</span>
              <select id="kit-motion" value={form.motion} onChange={(e) => set("motion", e.target.value as BrandKit["motion"])}>
                <option value="snappy">Snappy: quick and crisp</option>
                <option value="smooth">Smooth: slower and softer</option>
              </select>
            </label>

            <div className="mo-field wide">
              <span className="label">Logo</span>
              <div className="mo-logo-row">
                <div className="mo-logo-box" style={{ background: form.palette.bg }}>
                  {logoShown ? <img src={logoShown} alt="Logo" /> : <span className="muted small">No logo</span>}
                </div>
                <button type="button" className="btn btn-small" onClick={() => fileRef.current?.click()}>
                  Upload
                </button>
                {current?.logo ? (
                  <button type="button" className="btn btn-small" onClick={() => void motionApi.removeLogo(current.id).then(setCurrent)}>
                    Remove
                  </button>
                ) : null}
                {logoUrl && !current?.logo ? <span className="muted small">From the website; saved with the kit.</span> : null}
                <input ref={fileRef} type="file" hidden accept="image/*,.svg" onChange={(e) => e.target.files?.[0] && void uploadLogo(e.target.files[0])} />
              </div>
            </div>

            <fieldset className="mo-field wide mo-endcard">
              <legend className="label">
                <label className="check">
                  <input type="checkbox" checked={form.endCard.enabled} onChange={(e) => set("endCard", { ...form.endCard, enabled: e.target.checked })} />
                  End every video with an end card
                </label>
              </legend>
              <input type="text" placeholder="Headline" value={form.endCard.headline} onChange={(e) => set("endCard", { ...form.endCard, headline: e.target.value })} disabled={!form.endCard.enabled} />
              <input type="text" placeholder="Call to action" value={form.endCard.cta} onChange={(e) => set("endCard", { ...form.endCard, cta: e.target.value })} disabled={!form.endCard.enabled} />
              <input type="text" placeholder="Website, e.g. algoinsight.io" value={form.endCard.url} onChange={(e) => set("endCard", { ...form.endCard, url: e.target.value })} disabled={!form.endCard.enabled} />
            </fieldset>

            <label className="mo-field wide" htmlFor="kit-style">
              <span className="label">Style notes for Claude</span>
              <textarea id="kit-style" rows={3} placeholder="For example: white cards with a thick ink border and a hard shadow; key words get a yellow marker stroke." value={form.style} onChange={(e) => set("style", e.target.value)} />
            </label>
            <details className="mo-field wide">
              <summary className="label">Background layers (CSS, optional)</summary>
              <textarea rows={3} spellCheck={false} placeholder="radial-gradient(...), linear-gradient(...)" value={form.background} onChange={(e) => set("background", e.target.value)} />
            </details>
          </div>

          <div className="mo-kit-preview" style={{ background: form.background ? `${form.background}, ${form.palette.bg}` : form.palette.bg, borderRadius: form.radius }}>
            <div className="mo-kit-card" style={{ background: form.palette.surface, borderRadius: form.radius }}>
              <div style={{ color: form.palette.accent, fontFamily: `"${form.fonts.body}", system-ui` }} className="mo-kit-tag">
                Preview
              </div>
              <div style={{ color: form.palette.ink, fontFamily: `"${form.fonts.display}", system-ui` }} className="mo-kit-h">
                Why do caches <span style={{ color: form.palette.accent2 }}>break</span>?
              </div>
              <div style={{ color: form.palette.muted, fontFamily: `"${form.fonts.body}", system-ui` }}>Secondary text in the muted colour.</div>
            </div>
          </div>
        </div>

        <footer className="mo-modal-foot">
          {error ? <span className="error small">{error}</span> : <span />}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save kit"}
          </button>
        </footer>
      </div>
    </div>
  );
}
