// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Project Studio.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { videoApi, type ClipApiResponse, type TranscriptWord, type VideoResponse } from "@/lib/api";
import { EditableTitle } from "../../components/EditableTitle";
import { SpeakersPanel } from "../upload/SpeakersPanel";
import { BulkPublishModal } from "../upload/BulkPublishModal";
import { FailedErrorCard, RetryVideoButton, ZipDownloadModal } from "./common";
import { StudioPlayer, type StudioPlayerHandle } from "./StudioPlayer";
import { SourceTimeline } from "./SourceTimeline";
import { RegionList } from "./RegionList";
import { RegionPanel } from "./RegionPanel";
import { type CaptionLine, captionsFor, isBusy, isExported, keepLinks, regionOf, samePath, titleOf, titlesPending } from "./model";

const NEW_CLIP_SEC = 30;
const PREVIEW_STALE_SEC = 5 * 3600;

/**
 * A project: the whole source video on one timeline with the AI's suggested clips
 * (and your own) as regions. Pick titles, adjust the clips and captions, then export.
 */
export function ProjectStudio({ video, onVideoChange, onBack, onNewUpload }: {
  video: VideoResponse;
  onVideoChange: (v: VideoResponse) => void;
  onBack: () => void;
  onNewUpload?: () => void;
}) {
  const [clips, setClips] = useState<ClipApiResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [words, setWords] = useState<TranscriptWord[]>([]);
  const [peaks, setPeaks] = useState<{ per_sec: number; peaks: number[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("clip"));
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [time, setTime] = useState(0);
  const [view, setView] = useState<"source" | "export">("source");
  const [showCaptions, setShowCaptions] = useState(true);
  const [publish, setPublish] = useState<ClipApiResponse[] | null>(null);
  const [zip, setZip] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const player = useRef<StudioPlayerHandle>(null);
  const askedPreview = useRef(false);
  const duration = video.duration_sec ?? 0;

  const loadClips = useCallback(async () => {
    try {
      const res = await videoApi.clips(video.id, 1, 100, true);
      setClips((prev) => keepLinks(prev, res.items.filter((c) => c.status !== "deleted")));
    } catch { /* keep what we have; the next poll retries */ }
    finally { setLoaded(true); }
  }, [video.id]);

  useEffect(() => { void loadClips(); }, [loadClips]);
  useEffect(() => {
    videoApi.transcript(video.id).then((r) => setWords(r.words)).catch(() => setWords([]));
  }, [video.id]);
  // Signed links change on every response: keep using the same preview link (no
  // reload, no jump back to 0) until it's a different file or the player fails with it.
  const [previewSrc, setPreviewSrc] = useState<string | null>(video.studio?.preview_url ?? null);
  const nextPreview = video.studio?.preview_url ?? null;
  useEffect(() => { setPreviewSrc((p) => (samePath(p, nextPreview) ? p : nextPreview)); }, [nextPreview]);
  const refreshedAt = useRef(0);
  const onPreviewError = useCallback(() => {
    if (Date.now() - refreshedAt.current < 30_000) return;  // expired link: fetch a fresh one, once
    refreshedAt.current = Date.now();
    videoApi.get(video.id).then((v) => { onVideoChange(v); setPreviewSrc(v.studio?.preview_url ?? null); }).catch(() => {});
  }, [video.id, onVideoChange]);

  const peaksPath = video.studio?.peaks_url?.split("?")[0];
  useEffect(() => {
    const url = video.studio?.peaks_url;
    if (!url) return;
    fetch(url).then((r) => (r.ok ? r.json() : null)).then(setPeaks).catch(() => setPeaks(null));
  }, [peaksPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // A build that never finished (its task died) counts as failed, so it can be retried.
  const rawStatus = video.studio?.status ?? null;
  const stale = (rawStatus === "queued" || rawStatus === "building")
    && Date.now() / 1000 - (video.studio?.at ?? Date.now() / 1000) > PREVIEW_STALE_SEC;
  const studioStatus = stale ? "failed" : rawStatus;
  // A YouTube project without a stored copy can still get a preview: it's downloaded again.
  const canPreview = Boolean(video.has_source) || video.source_type === "youtube_url";
  // Projects made before the Studio: build the preview once.
  useEffect(() => {
    if (askedPreview.current || video.studio?.preview_url || !canPreview) return;
    if (studioStatus === "queued" || studioStatus === "building" || studioStatus === "failed") return;
    askedPreview.current = true;
    videoApi.studioPreview(video.id).then(onVideoChange).catch(() => {});
  }, [video.id, video.studio?.preview_url, canPreview, studioStatus, onVideoChange]);

  // Follow exports, title requests and the preview build.
  const following = clips.some((c) => isBusy(c) || titlesPending(c));
  useEffect(() => {
    if (!following) return;
    const t = setInterval(() => void loadClips(), 4000);
    return () => clearInterval(t);
  }, [following, loadClips]);
  const previewBuilding = studioStatus === "queued" || studioStatus === "building";
  useEffect(() => {
    if (!previewBuilding) return;
    const t = setInterval(() => { videoApi.get(video.id).then(onVideoChange).catch(() => {}); }, 6000);
    return () => clearInterval(t);
  }, [previewBuilding, video.id, onVideoChange]);

  const regions = useMemo(() => clips.map(regionOf).sort((a, b) => a.start - b.start), [clips]);
  const selected = regions.find((r) => r.id === selectedId) ?? null;
  useEffect(() => {  // pick the best AI clip when nothing (or a removed clip) is selected
    if (!loaded || selected || !regions.length) return;
    const best = [...regions].sort((a, b) => (b.clip.score ?? 0) - (a.clip.score ?? 0))[0];
    setSelectedId(best.id);
  }, [loaded, selected, regions]);
  useEffect(() => { setView("source"); }, [selectedId]);

  const lines = useMemo(() => (selected ? captionsFor(words, selected.start, selected.end, selected.clip) : []),
    [words, selected]);

  const replace = (c: ClipApiResponse) => setClips((cs) => cs.map((x) => (x.id === c.id ? c : x)));
  const flash = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 5000);
  };

  const select = (id: string) => {
    setSelectedId(id);
    const r = regions.find((x) => x.id === id);
    if (r && (time < r.start || time > r.end)) { if (player.current) player.current.seek(r.start); else setTime(r.start); }
  };

  const moveRegion = async (id: string, start: number, end: number) => {
    const before = clips.find((c) => c.id === id);
    if (!before) return;
    replace({ ...before, start_ms: Math.round(start * 1000), end_ms: Math.round(end * 1000) });
    try { replace(await videoApi.studioPatch(id, { start_sec: start, end_sec: end })); }
    catch (e) { replace(before); flash("err", e instanceof Error ? e.message : "Couldn't move the clip."); }
  };

  const exportIds = async (ids: string[]) => {
    if (!ids.length) return;
    const r = await videoApi.exportClips(video.id, ids);
    flash("ok", `Exporting ${r.queued} clip${r.queued === 1 ? "" : "s"}. They'll appear in your library when done.`);
    await loadClips();
  };

  const addHere = async () => {
    const start = Math.max(0, Math.min(time, Math.max(0, duration - 1)));
    const end = Math.min(duration || start + NEW_CLIP_SEC, start + NEW_CLIP_SEC);
    try {
      const c = await videoApi.addSuggestion(video.id, start, end);
      setClips((cs) => [...cs, c]);
      setSelectedId(c.id);
    } catch (e) { flash("err", e instanceof Error ? e.message : "Couldn't add a clip here."); }
  };

  const checkedClips = clips.filter((c) => checked.has(c.id));
  const exportable = checkedClips.filter((c) => !isBusy(c));
  const publishable = (checkedClips.length ? checkedClips : clips).filter((c) => isExported(c) && !isBusy(c));

  if (video.status === "failed") {
    return (
      <div className="mx-auto max-w-[1240px] px-3 sm:px-5">
        <button onClick={onBack} className="mb-4 rounded-[8px] border border-c-border bg-surface-2 px-3 py-1.5 text-[12.5px] text-c-text-secondary">‹ Projects</button>
        <FailedErrorCard errorMessage={video.error_message ?? "Processing failed."} videoId={video.id} onRetried={onBack} />
      </div>
    );
  }

  const exportedSrc = selected && isExported(selected.clip) ? selected.clip.storage_url : null;
  const previewEmpty = previewBuilding
    ? <span className="flex items-center gap-2"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-c-border border-t-c-text-secondary" />Preparing the timeline preview…</span>
    : !canPreview
      ? "The original upload isn't stored, so there's no preview. Re-upload the video to edit it here."
      : studioStatus === "failed"
        ? <span>The preview couldn't be made{video.studio?.error ? `: ${video.studio.error}` : "."}{" "}
            <button className="underline" onClick={() => { videoApi.studioPreview(video.id).then(onVideoChange).catch(() => {}); }}>Try again</button></span>
        : "Preparing the timeline preview…";

  return (
    <div className="mx-auto max-w-[1680px] px-3 pb-8 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <button onClick={onBack}
          className="rounded-[8px] border border-c-border bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-c-text-secondary hover:bg-surface-3 hover:text-c-text">
          ‹ Projects
        </button>
        <h2 className="min-w-0 font-display text-[18px] font-bold text-c-text">
          <EditableTitle video={video} onRenamed={onVideoChange} />
        </h2>
        {video.game?.name && (
          <span className="max-w-[220px] truncate rounded-full border border-c-border bg-surface-2 px-2.5 py-0.5 text-[11px] font-semibold text-c-text-secondary">🎮 {video.game.name}</span>
        )}
        {video.status !== "ready" && video.status !== "done" && <RetryVideoButton videoId={video.id} onRetried={onBack} />}
        <div className="ml-auto flex flex-wrap gap-2">
          {onNewUpload && (
            <button onClick={onNewUpload}
              className="rounded-[8px] border border-c-border bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-c-text-secondary hover:text-c-text">+ New upload</button>
          )}
          <button disabled={!publishable.length} onClick={() => setPublish(publishable)}
            className="rounded-[8px] border border-c-border bg-surface-2 px-3 py-1.5 text-[12.5px] font-semibold text-c-text-secondary hover:text-c-text disabled:opacity-40">
            ↗ Publish{publishable.length ? ` ${publishable.length}` : ""}
          </button>
          <button disabled={!clips.some(isExported)} onClick={() => setZip(true)}
            className="rounded-[8px] border border-c-border bg-surface-2 px-3 py-1.5 text-[12.5px] font-semibold text-c-text-secondary hover:text-c-text disabled:opacity-40">
            ↓ Download exported
          </button>
          <button disabled={!exportable.length}
            onClick={() => void exportIds(exportable.map((c) => c.id)).then(() => setChecked(new Set()))
              .catch((e) => flash("err", e instanceof Error ? e.message : "Couldn't start the export."))}
            className="rounded-[8px] bg-[#ff3d6a] px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-[0_2px_12px_rgba(255,61,106,.3)] disabled:opacity-40">
            ⬇ Export {exportable.length ? `${exportable.length} selected` : "selected"}
          </button>
        </div>
      </div>

      {notice && (
        <p role={notice.kind === "err" ? "alert" : "status"}
          className={cn("mb-3 rounded-[10px] border px-3 py-2 text-[12.5px]",
            notice.kind === "err" ? "border-red-400/25 bg-red-400/10 text-red-300" : "border-emerald-300/20 bg-emerald-400/10 text-emerald-200")}>
          {notice.text}
        </p>
      )}

      <SpeakersPanel video={video} onVideoChange={onVideoChange}
        onRerender={() => void exportIds(clips.filter((c) => isExported(c) && !isBusy(c)).map((c) => c.id))
          .catch((e) => flash("err", e instanceof Error ? e.message : "Couldn't start the export."))} />

      <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)_360px] xl:grid-cols-[280px_minmax(0,1fr)_400px]">
        <div className="order-3 lg:order-1 lg:h-[min(64vh,680px)]">
          <RegionList regions={regions} selectedId={selectedId} checked={checked} onSelect={select}
            onCheck={(ids, on) => setChecked((s) => { const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; })} />
        </div>

        <div className="order-1 min-w-0 lg:order-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {exportedSrc && (
              <div className="flex rounded-[8px] border border-c-border p-0.5 text-[12px]" role="group" aria-label="What to show">
                {(["source", "export"] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                    className={cn("rounded-[6px] px-2.5 py-1", view === v ? "bg-surface-3 text-c-text" : "text-c-text-muted")}>
                    {v === "source" ? "Edit" : "Exported video"}
                  </button>
                ))}
              </div>
            )}
            <label className="flex items-center gap-1.5 text-[12px] text-c-text-secondary">
              <input type="checkbox" checked={showCaptions} onChange={(e) => setShowCaptions(e.target.checked)}
                className="h-3.5 w-3.5 accent-[#ff3d6a]" />
              Show captions
            </label>
            <button type="button" onClick={() => void addHere()} disabled={!duration}
              className="ml-auto rounded-[8px] border border-amber-300/40 bg-amber-400/10 px-3 py-1 text-[12px] font-semibold text-amber-100 hover:bg-amber-400/20 disabled:opacity-40">
              + Clip here
            </button>
          </div>
          {view === "export" && exportedSrc
            ? <div className="mx-auto aspect-[9/16] max-h-[64vh] overflow-hidden rounded-[14px] border border-c-border bg-black">
                <video key={exportedSrc} src={exportedSrc} controls playsInline className="h-full w-full object-contain" />
              </div>
            : <StudioPlayer ref={player} src={previewSrc} onError={onPreviewError}
                aspect={selected?.clip.clip_metadata?.aspect_ratio ?? video.clip_config?.aspect_ratio ?? "9:16"}
                captions={lines} speakers={video.speakers} showCaptions={showCaptions && video.clip_config?.add_captions !== false}
                onTime={setTime} emptyState={previewEmpty} />}
          {selected && (
            <p className="mt-2 truncate text-[12px] text-c-text-muted">
              Editing <span className="font-semibold text-c-text-secondary">{titleOf(selected.clip)}</span>
            </p>
          )}
        </div>

        <div className="order-2 lg:order-3 lg:h-[min(64vh,680px)]">
          {selected
            ? <RegionPanel
                key={selected.id}
                region={selected} lines={lines} speakers={video.speakers} duration={duration}
                onPlay={() => player.current?.playRange(selected.start, selected.end)}
                onSeek={(t) => (player.current ? player.current.seek(t) : setTime(t))}
                onPatch={async (body) => replace(await videoApi.studioPatch(selected.id, body))}
                onMoreTitles={async () => replace(await videoApi.moreTitles(selected.id))}
                onExport={() => exportIds([selected.id])}
                onPublish={() => setPublish([selected.clip])}
                onDelete={async () => {
                  await videoApi.deleteClip(selected.id);
                  setClips((cs) => cs.filter((c) => c.id !== selected.id));
                  setSelectedId(null);
                }}
                onSaveCaptions={async (ls: CaptionLine[]) => replace(await videoApi.studioPatch(selected.id, {
                  captions: ls.map((l) => ({ text: l.text, start_sec: l.start, end_sec: l.end })) }))}
              />
            : <div className="grid h-full min-h-[200px] place-items-center rounded-[14px] border border-c-border bg-surface-1 p-6 text-center text-[12.5px] text-c-text-muted">
                {loaded ? "Pick a clip on the timeline, or add your own with “+ Clip here”." : "Loading clips…"}
              </div>}
        </div>
      </div>

      <div className="mt-3">
        <SourceTimeline duration={duration} regions={regions} selectedId={selectedId} time={time} peaks={peaks}
          onSeek={(t) => (player.current ? player.current.seek(t) : setTime(t))} onSelect={select} onChange={(id, s, e) => void moveRegion(id, s, e)} />
      </div>

      {publish && <BulkPublishModal clips={publish} onClose={() => setPublish(null)} />}
      {zip && <ZipDownloadModal clips={clips.filter(isExported)} videoTitle={video.title ?? "clips"} onClose={() => setZip(false)} />}
    </div>
  );
}
