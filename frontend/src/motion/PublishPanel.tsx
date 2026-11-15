// Publish, the top bar's own menu: everything the YouTube or Udemy upload needs, ready to download.
//
// - Everything at once: one zip with the thumbnail, the SRT and VTT captions, the chapters for the
//   description and YOUTUBE.md (what doesn't exist yet is left out), and the latest exported MP4.
//
// - Captions: the SRT and VTT files, timed from the voice (scenes without a voice use estimates, so
//   the voice is best generated first). They come from the server as text and are saved here, so a
//   missing route or a failed request shows as a line in the menu instead of a broken download.
// - Thumbnail: the 1280x720 image Claude designs with write_thumbnail. Its preview, Download and
//   Refresh when there is one; "Ask Claude to design it" sends the chat message through the editor's
//   normal send path (so it shows in the chat like any other message), and is off while Claude works.
//
// The preview follows project.thumbnail.rev: the editor reloads the project view on every change, so a
// new design changes the image URL and the preview redraws by itself.

import { useState } from "react";

import { ago, fileSlug, motionApi } from "./api";
import type { CaptionFormat, ProjectView } from "./types";
import { destinationOf } from "./VideoSettings";

/** The chat message the thumbnail button sends. */
export const THUMBNAIL_TEXT = "Design the YouTube thumbnail for this video with write_thumbnail.";

type Props = {
  projectId: string;
  view: ProjectView;
  /** Claude is working on this video: the thumbnail button waits for it */
  running: boolean;
  /** sends THUMBNAIL_TEXT through the editor's send path */
  onAskThumbnail: () => Promise<void>;
  /** reloads the project view (for a thumbnail saved without an event reaching this page) */
  onRefresh: () => Promise<void>;
  onOpen: (menu: "voice") => void;
};

const CAPTION_TYPE: Record<CaptionFormat, string> = { srt: "application/x-subrip", vtt: "text/vtt" };

/** Saves text as a file through a temporary link (the browser's normal download). */
function saveText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // the download has its own copy by now
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A short, stable fingerprint of what the thumbnail is drawn from (FNV-1a, hex). */
function lookKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export default function PublishPanel({ projectId, view, running, onAskThumbnail, onRefresh, onOpen }: Props) {
  const [fetching, setFetching] = useState<CaptionFormat | null>(null);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // a Refresh adds a fresh query value, so the browser fetches the image again even at the same rev
  const [nonce, setNonce] = useState(0);
  // the image URL that failed to load, and the one that loaded (a new rev or a Refresh gives a new URL,
  // which clears both). The server draws the image on the first request after a change (20 s or so)
  // and takes a few seconds even after that, so the box says it is loading until the image arrives.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  const b = view.bundle;
  const slug = fileSlug(view.project.title);
  const udemy = destinationOf(view) === "udemy";
  // the same count as the Voice button: narrated scenes, not the end screen
  const narrated = b.scenes.filter((s) => s.narration && s.kind !== "endscreen");
  // the newest finished export (the server lists them newest first)
  const latest = view.renders[0] ?? null;
  const voiced = narrated.filter((s) => s.voiced).length;

  // missing until the server knows about thumbnails: the same as none
  const thumb = view.project.thumbnail ?? null;
  const look = lookKey(JSON.stringify([b.brand, view.project.closing ?? null, b.aspect]));
  const src = thumb ? `${motionApi.thumbnailUrl(projectId, thumb.rev, look)}${nonce ? `&r=${nonce}` : ""}` : null;
  const broken = !!src && brokenSrc === src;
  const loading = !!src && !broken && loadedSrc !== src;
  // updatedAt is in seconds; a value in milliseconds is read as such
  const updated = thumb?.updatedAt ? ago(thumb.updatedAt > 1e12 ? thumb.updatedAt / 1000 : thumb.updatedAt) : null;

  async function downloadCaptions(format: CaptionFormat) {
    setFetching(format);
    setCaptionError(null);
    try {
      const text = await motionApi.captions(projectId, format);
      saveText(`${slug}.${format}`, text, CAPTION_TYPE[format]);
    } catch (err) {
      const status = (err as { status?: number }).status;
      setCaptionError(
        status === 404
          ? "The captions didn't come back (404). If Motion was just updated, restart it."
          : `Couldn't get the captions: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setFetching(null);
    }
  }

  async function ask() {
    setAsking(true);
    setAskError(null);
    try {
      await onAskThumbnail();
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setNonce(Date.now());
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="mo-publish">
      <div className="mo-publish-head">
        <span className={`mo-dest mo-dest-${udemy ? "udemy" : "youtube"}`} aria-hidden="true" />
        <strong>For the {udemy ? "Udemy" : "YouTube"} upload</strong>
      </div>
      <section className="mo-publish-section" aria-labelledby="mo-pub-all">
        <span className="label" id="mo-pub-all">
          Everything at once
        </span>
        <div className="mo-publish-row">
          <a className="btn btn-small btn-primary" href={motionApi.publishKitUrl(projectId)} download={`${slug}-publish-kit.zip`}>
            Download all (.zip)
          </a>
          {latest ? (
            <a className="btn btn-small" href={latest.url} download={latest.file} title={latest.file}>
              Latest MP4 ({(latest.bytes / 1e6).toFixed(0)} MB)
            </a>
          ) : null}
        </div>
        <span className="muted small">
          The zip holds the thumbnail, the SRT and VTT captions, the chapters for the description and YOUTUBE.md (titles, description, tags), whichever exist.
          {latest ? ` The MP4 is the last export, made ${ago(latest.at)}.` : " No MP4 yet: Export makes it."}
        </span>
      </section>
      <section className="mo-publish-section" aria-labelledby="mo-pub-captions">
        <span className="label" id="mo-pub-captions">
          Captions
        </span>
        {narrated.length ? (
          <>
            <div className="mo-publish-row">
              {(["srt", "vtt"] as CaptionFormat[]).map((f) => (
                <button key={f} type="button" className="btn btn-small" disabled={!!fetching} onClick={() => void downloadCaptions(f)}>
                  {fetching === f ? <span className="spinner" aria-label="Getting the captions" /> : `Download ${f.toUpperCase()}`}
                </button>
              ))}
            </div>
            {voiced === narrated.length ? (
              <span className="muted small">
                Timed from the voice: all {narrated.length} narrated scene{narrated.length > 1 ? "s are" : " is"} voiced.
              </span>
            ) : (
              <span className="mo-warn-text small">
                Timed from the voice, so it is best to generate the voice first: {voiced} of {narrated.length} scenes voiced, the rest use estimates.{" "}
                <button type="button" className="linkish" onClick={() => onOpen("voice")}>
                  Open Voice
                </button>
              </span>
            )}
            <span className="muted small">{udemy ? "Udemy takes the VTT file." : "YouTube takes either file."}</span>
            {captionError ? <p className="error small">{captionError}</p> : null}
          </>
        ) : (
          <span className="muted small">No narration in this video, so there are no captions.</span>
        )}
      </section>

      <section className="mo-publish-section" aria-labelledby="mo-pub-thumb">
        <div className="mo-publish-label-row">
          <span className="label" id="mo-pub-thumb">
            Thumbnail
          </span>
          {thumb && updated ? <span className="muted small">1280x720, made {updated}</span> : null}
        </div>
        {thumb && src ? (
          <>
            <div className="mo-thumb">
              {broken ? (
                <span className="mo-thumb-note">The image didn't load. Press Refresh to try again.</span>
              ) : (
                <>
                  <img key={src} src={src} alt="The video's thumbnail" onLoad={() => setLoadedSrc(src)} onError={() => setBrokenSrc(src)} />
                  {loading ? (
                    <span className="mo-thumb-note mo-thumb-loading">
                      <span className="spinner" aria-hidden="true" /> Loading the thumbnail…
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <div className="mo-publish-row">
              {broken || loading ? (
                <button type="button" className="btn btn-small" disabled>
                  Download
                </button>
              ) : (
                // download=1 asks the server to send it as a file named after the video
                <a className="btn btn-small" href={`${src}&download=1`} download={`${slug}-thumbnail.jpg`}>
                  Download
                </a>
              )}
              <button type="button" className="btn btn-small" disabled={refreshing} onClick={() => void refresh()} title="Load the thumbnail again from the server">
                {refreshing ? <span className="spinner" aria-label="Refreshing" /> : "Refresh"}
              </button>
            </div>
          </>
        ) : (
          <span className="muted small">No thumbnail yet.</span>
        )}
        <div className="mo-publish-row">
          <button
            type="button"
            className={`btn btn-small ${thumb ? "" : "btn-primary"}`}
            disabled={running || asking}
            onClick={() => void ask()}
            title={running ? "Claude is working on this video. Wait for it to finish." : THUMBNAIL_TEXT}
          >
            {asking ? <span className="spinner" aria-label="Sending" /> : "Ask Claude to design it"}
          </button>
        </div>
        <span className="muted small">
          {running
            ? "Claude is working. A thumbnail it saves shows here by itself."
            : thumb
              ? "Claude makes a new design in the video's look; it replaces this one."
              : "Claude designs a 1280x720 image in the video's look. It shows here when it's saved."}
        </span>
        {udemy ? <span className="muted small">Udemy uses the course image, not one per lecture, so this one is for YouTube.</span> : null}
        {askError ? <p className="error small">{askError}</p> : null}
      </section>
    </div>
  );
}
