// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Project Studio clip panel.
import { useEffect, useState } from "react";
import { cn, downloadUrl, safeFilename } from "@/lib/utils";
import type { VideoSpeakers } from "@/lib/api";
import { type CaptionLine, type Region, fmtTime, isBusy, isExported, parseTime, tierOf, titleOf } from "./model";
import { statusLabel } from "./RegionList";
import { StudioCaptions } from "./StudioCaptions";

const TIER_TEXT: Record<string, string> = {
  top: "AI pick", runner_up: "Another idea from the AI", manual: "Your clip",
};

/** Everything about the selected clip: title choice, start/end, captions, copy, export. */
export function RegionPanel({ region, lines, speakers, duration, onPatch, onMoreTitles, onExport, onPublish,
                              onDelete, onPlay, onSeek, onSaveCaptions }: {
  region: Region;
  lines: CaptionLine[];
  speakers?: VideoSpeakers | null;
  duration: number;
  onPatch: (body: { title?: string; start_sec?: number; end_sec?: number }) => Promise<void>;
  onMoreTitles: () => Promise<void>;
  onExport: () => Promise<void>;
  onPublish: () => void;
  onDelete: () => Promise<void>;
  onPlay: () => void;
  onSeek: (t: number) => void;
  onSaveCaptions: (lines: CaptionLine[]) => Promise<void>;
}) {
  const c = region.clip;
  const meta = c.clip_metadata ?? {};
  const busy = isBusy(c);
  const exported = isExported(c);
  const title = titleOf(c);
  const options = meta.title_options ?? [];
  const [custom, setCustom] = useState("");
  const [err, setErr] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setCustom(""); setErr(""); setConfirmDelete(false); }, [c.id]);

  async function run(label: string, fn: () => Promise<void>) {
    setWorking(label); setErr("");
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong. Try again."); }
    finally { setWorking(null); }
  }

  const st = statusLabel(region);
  const platforms = Object.entries(meta.platform_copy ?? meta.platforms ?? {});

  return (
    <section aria-label="Selected clip" className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto rounded-[14px] border border-c-border bg-surface-1 p-4">
      <header>
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] font-semibold uppercase tracking-[.08em] text-c-text-muted">
          <span className={cn(tierOf(c) === "top" ? "text-[#ff7a9a]" : tierOf(c) === "manual" ? "text-amber-300" : "text-sky-300")}>
            {TIER_TEXT[tierOf(c)]}
          </span>
          {c.score != null && <span className="font-mono normal-case">score {Number(c.score).toFixed(1)}</span>}
          <span className={cn("normal-case tracking-normal", st.cls)}>{st.text}</span>
        </p>
        <h2 className="mt-1 font-display text-[16px] font-bold leading-snug text-c-text">{title}</h2>
        {meta.viral_reason && <p className="mt-1 text-[12px] leading-snug text-c-text-muted">{meta.viral_reason}</p>}
        {meta.regenerate_error && !busy && (
          <p role="alert" className="mt-2 whitespace-normal break-words rounded-[8px] border border-red-400/25 bg-red-400/10 px-2.5 py-1.5 text-[11.5px] text-red-300">
            Export failed: {meta.regenerate_error}
          </p>
        )}
      </header>

      <Timing region={region} duration={duration} disabled={busy}
        onPlay={onPlay}
        onSet={(s, e) => run("timing", () => onPatch({ start_sec: s, end_sec: e }))} />

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[11px] font-bold uppercase tracking-[.1em] text-c-text-muted">Title</h3>
          <button type="button" disabled={meta.titles_pending || working === "titles"}
            onClick={() => void run("titles", onMoreTitles)}
            className="rounded-[7px] border border-c-border px-2 py-0.5 text-[11.5px] font-semibold text-c-text-secondary hover:text-c-text disabled:opacity-50">
            {meta.titles_pending ? "Asking the AI…" : "✦ More titles"}
          </button>
        </div>
        {meta.titles_error && !meta.titles_pending && <p role="alert" className="mb-1.5 text-[11.5px] text-red-400">{meta.titles_error}</p>}
        <div role="radiogroup" aria-label="Title options" className="space-y-1">
          {options.map((o) => {
            const on = o.text === title;
            return (
              <button key={o.text} type="button" role="radio" aria-checked={on} disabled={busy || !!working}
                onClick={() => { if (!on) void run("title", () => onPatch({ title: o.text })); }}
                className={cn("flex w-full items-start gap-2 rounded-[8px] border px-2.5 py-1.5 text-left text-[12.5px] transition",
                  on ? "border-[#ff3d6a]/50 bg-[#ff3d6a]/10 text-c-text" : "border-c-border bg-surface-2 text-c-text-secondary hover:text-c-text")}>
                <span className={cn("mt-1 h-2.5 w-2.5 flex-none rounded-full border", on ? "border-[#ff3d6a] bg-[#ff3d6a]" : "border-c-text-muted")} />
                <span className="flex-1">{o.text}</span>
                {o.score != null && <span className="font-mono text-[10.5px] text-c-text-muted">{o.score}</span>}
              </button>
            );
          })}
          {!options.length && !meta.titles_pending && (
            <p className="text-[12px] text-c-text-muted">No title ideas yet — ask for some, or type your own.</p>
          )}
        </div>
        <form className="mt-1.5 flex gap-1.5" onSubmit={(e) => {
          e.preventDefault();
          const t = custom.trim();
          if (t) void run("title", async () => { await onPatch({ title: t }); setCustom(""); });
        }}>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={100} disabled={busy}
            placeholder="Or type your own title" aria-label="Your own title"
            className="min-w-0 flex-1 rounded-[8px] border border-c-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-c-text outline-none focus:border-[#ff3d6a]/40" />
          <button type="submit" disabled={!custom.trim() || busy || !!working}
            className="rounded-[8px] border border-c-border px-2.5 text-[12px] font-semibold text-c-text-secondary hover:text-c-text disabled:opacity-40">Use</button>
        </form>
        <p className="mt-1 text-[11px] text-c-text-muted">The title is also the hook text on the video when your template shows one.</p>
      </div>

      <div>
        <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-[.1em] text-c-text-muted">Captions</h3>
        <StudioCaptions lines={lines} edited={Boolean(meta.custom_captions)} speakers={speakers}
          disabled={busy} onSeek={onSeek} onSave={onSaveCaptions} />
      </div>

      {platforms.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-[.1em] text-c-text-muted">Post text</summary>
          <div className="mt-2 space-y-2">
            {platforms.map(([p, v]) => (
              <div key={p} className="rounded-[8px] bg-surface-2 p-2 text-[12px] text-c-text-secondary">
                <p className="mb-0.5 text-[10.5px] font-semibold uppercase text-c-text-muted">{p}</p>
                <p className="whitespace-pre-line">{v.description}</p>
                {v.tags?.length > 0 && <p className="mt-1 text-[11px] text-sky-300">{v.tags.map((t) => `#${t}`).join(" ")}</p>}
              </div>
            ))}
          </div>
        </details>
      )}

      {err && <p role="alert" className="text-[12px] text-red-400">{err}</p>}

      <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-c-border pt-3">
        <button type="button" disabled={busy || !!working} onClick={() => void run("export", onExport)}
          className="rounded-[9px] bg-[#ff3d6a] px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_2px_12px_rgba(255,61,106,.3)] disabled:opacity-50">
          {busy ? "Exporting…" : working === "export" ? "Starting…" : exported ? "↻ Export again" : "⬇ Export clip"}
        </button>
        {exported && !busy && (
          <>
            <button type="button" onClick={onPublish}
              className="rounded-[9px] border border-c-border px-3 py-2 text-[12.5px] font-semibold text-c-text-secondary hover:text-c-text">↗ Publish</button>
            <button type="button" onClick={() => void downloadUrl(c.storage_url!, safeFilename(title, "mp4"))}
              className="rounded-[9px] border border-c-border px-3 py-2 text-[12.5px] font-semibold text-c-text-secondary hover:text-c-text">↓ Download</button>
          </>
        )}
        {!busy && (confirmDelete
          ? <span className="ml-auto flex items-center gap-1.5 text-[12px]">
              <button type="button" onClick={() => void run("delete", onDelete)}
                className="rounded-[7px] bg-red-500 px-2.5 py-1 font-semibold text-white">Delete</button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-c-text-muted">Cancel</button>
            </span>
          : <button type="button" onClick={() => setConfirmDelete(true)}
              className="ml-auto text-[12px] text-c-text-muted hover:text-red-400">Delete</button>)}
      </footer>
    </section>
  );
}

/** Start/end of the clip in the original video, typed as m:ss(.s). */
function Timing({ region, duration, disabled, onSet, onPlay }: {
  region: Region; duration: number; disabled: boolean;
  onSet: (start: number, end: number) => void; onPlay: () => void;
}) {
  const [s, setS] = useState(fmtTime(region.start, true));
  const [e, setE] = useState(fmtTime(region.end, true));
  const [bad, setBad] = useState("");
  useEffect(() => { setS(fmtTime(region.start, true)); setE(fmtTime(region.end, true)); setBad(""); }, [region.start, region.end]);

  const commit = () => {
    const ns = parseTime(s), ne = parseTime(e);
    if (ns == null || ne == null) { setBad("Use minutes:seconds, like 1:05.5"); return; }
    if (ne - ns < 1) { setBad("The clip must be at least 1 second long."); return; }
    if (ne - ns > 600) { setBad("A clip can be at most 10 minutes long."); return; }
    if (duration && ns >= duration) { setBad("That's past the end of the video."); return; }
    setBad("");
    if (Math.abs(ns - region.start) >= 0.05 || Math.abs(ne - region.end) >= 0.05) onSet(ns, Math.min(ne, duration || ne));
  };
  const field = "w-[86px] rounded-[7px] border border-c-border bg-surface-2 px-2 py-1 font-mono text-[12.5px] text-c-text outline-none focus:border-[#ff3d6a]/40";
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[10.5px] font-semibold uppercase text-c-text-muted">Start
          <input className={cn(field, "mt-0.5 block")} value={s} disabled={disabled} aria-label="Start time"
            onChange={(ev) => setS(ev.target.value)} onBlur={commit}
            onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
        </label>
        <label className="text-[10.5px] font-semibold uppercase text-c-text-muted">End
          <input className={cn(field, "mt-0.5 block")} value={e} disabled={disabled} aria-label="End time"
            onChange={(ev) => setE(ev.target.value)} onBlur={commit}
            onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
        </label>
        <span className="pb-1.5 font-mono text-[12px] text-c-text-muted">{Math.round(region.end - region.start)}s</span>
        <button type="button" onClick={onPlay}
          className="ml-auto rounded-[8px] border border-c-border px-2.5 py-1 text-[12px] font-semibold text-c-text-secondary hover:text-c-text">▶ Play clip</button>
      </div>
      {bad && <p role="alert" className="mt-1 text-[11.5px] text-red-400">{bad}</p>}
      <p className="mt-1 text-[11px] text-c-text-muted">Or drag the clip and its edges on the timeline.</p>
    </div>
  );
}

