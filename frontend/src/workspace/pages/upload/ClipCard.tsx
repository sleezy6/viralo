// Modified 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): working Regenerate.
import { useState } from "react";
import { cn, safeFilename, downloadBlob, downloadUrl, stripSrtTimecodes } from "@/lib/utils";
import { videoApi, platformApi, type ClipApiResponse, type ScheduledPost, type ScheduledPostSummary } from "@/lib/api";
import { UniversalClipCard, type ClipCardAction } from "../../components/UniversalClipCard";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PLAT_DISPLAY, PlatPill, VirChip, fmtSec } from "./helpers";
import { BulkPublishModal } from "./BulkPublishModal";
import { VideoEditor } from "../../components/VideoEditor";
import { RegenerateDialog, CLIP_BUSY_STATUSES } from "./RegenerateDialog";

/* ─── Clip detail modal ─── */
const DETAIL_PLAT_CFG: Record<string, { color: string; icon: string }> = {
  youtube:{color:"#FF0000",icon:"▶"},shorts:{color:"#FF0000",icon:"▶"},
  tiktok:{color:"#69C9D0",icon:"♪"},reels:{color:"#E1306C",icon:"◈"},
  instagram:{color:"#E1306C",icon:"◈"},twitter:{color:"#1DA1F2",icon:"𝕏"},
  facebook:{color:"#1877F2",icon:"f"},linkedin:{color:"#0A66C2",icon:"in"},
};

type DetailTab = "info" | "copy" | "assets";

// Re-export for use in ResultsView
export { PLAT_DISPLAY, PlatPill, VirChip };

import { useRef, useCallback, useEffect } from "react";

export function ClipDetailModal({ clip, isPosted, isScheduled, posts = [], onClose, onPublish, onEdit }: {
  clip: ClipApiResponse;
  isPosted?: boolean;
  isScheduled?: boolean;
  posts?: ScheduledPostSummary[];
  onClose: () => void;
  onPublish?: () => void;
  /** Opens the video editor for this clip (the window closes first). */
  onEdit?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(clip.duration_ms ? clip.duration_ms / 1000 : 0);
  const [tab, setTab] = useState<DetailTab>("info");
  const [activePlatIdx, setActivePlatIdx] = useState(0);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const onTime = () => { setCurrentTime(v.currentTime); setProgress(v.duration ? v.currentTime / v.duration : 0); };
    const onMeta = () => setDuration(v.duration);
    const onEnd = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime); v.addEventListener("loadedmetadata", onMeta); v.addEventListener("ended", onEnd);
    return () => { v.removeEventListener("timeupdate", onTime); v.removeEventListener("loadedmetadata", onMeta); v.removeEventListener("ended", onEnd); };
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const togglePlay = () => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  };
  const seekFromEvent = useCallback((e: React.MouseEvent | MouseEvent) => {
    const v = videoRef.current;
    if (!barRef.current || !v || !v.duration) return;
    const rect = barRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    v.currentTime = ratio * v.duration; setProgress(ratio);
  }, []);
  const onBarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); seekFromEvent(e);
    const onMove = (ev: MouseEvent) => seekFromEvent(ev);
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  };

  const platformKey = clip.platform ?? "shorts";
  const platformContent = clip.clip_metadata?.platforms?.[platformKey] ?? null;
  const allPlatformEntries = Object.entries(clip.clip_metadata?.platforms ?? {});
  const primaryDescription = platformContent?.description ?? clip.clip_metadata?.ai_title ?? clip.title ?? "";
  const primaryTags = platformContent?.tags ?? [];
  const scoreValue = clip.score ?? 0;
  const scoreColor = scoreValue >= 7 ? "#34d399" : scoreValue >= 4 ? "#fbbf24" : "#f87171";
  const scorePct = Math.min(100, Math.round(scoreValue * 10));
  const clipStart = clip.start_ms != null ? fmt(clip.start_ms / 1000) : "--:--";
  const clipEnd = clip.end_ms != null ? fmt(clip.end_ms / 1000) : "--:--";
  const durMs = clip.duration_ms ?? 0;
  const cleanCaptionPreview = clip.caption_srt
    ? clip.caption_srt.split("\n").filter((l) => l && !/^\d+$/.test(l) && !l.includes("-->")).join(" ").replace(/\s+/g, " ").slice(0, 320)
    : "";
  const captionLineCount = clip.caption_srt ? clip.caption_srt.split(/\n\n+/).filter(Boolean).length : 0;

  const activePlat = allPlatformEntries[activePlatIdx];
  const activePlatContent = activePlat?.[1] as { description: string; tags: string[] } | undefined;
  const activePlatCfg = activePlat ? (DETAIL_PLAT_CFG[activePlat[0].toLowerCase()] ?? { color: "#ff3d6a", icon: "↗" }) : null;

  const TABS: { id: DetailTab; label: string; count?: number }[] = [
    { id: "info", label: "Info" },
    { id: "copy", label: "Copy", count: allPlatformEntries.length },
    { id: "assets", label: "Assets", count: posts.length > 0 ? posts.length : undefined },
  ];

  // suppress unused warning
  void currentTime;
  void duration;

  return (
    <div
      className="fixed inset-0 z-[500] flex flex-col sm:items-center sm:justify-center sm:p-5"
      style={{ background: "rgba(3,6,14,.82)", backdropFilter: "blur(12px)", animation: "fadeUp .14s ease" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Shell: stacked on mobile, 2-col grid from md up */}
      <div
        data-testid="clip-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clip-detail-title"
        className={cn(
          "flex h-[100dvh] w-full min-h-0 flex-col overflow-hidden border-c-border bg-surface-0 shadow-[0_48px_120px_rgba(0,0,0,.85)]",
          "sm:h-auto sm:max-h-[min(90vh,900px)] sm:max-w-[1200px] sm:rounded-[22px] sm:border",
          // Video column: as wide as fits a 9:16 preview in the window's height.
          "md:grid md:grid-cols-[minmax(0,min(380px,calc(90vh*0.5625)))_minmax(0,1fr)] md:grid-rows-1",
          "lg:grid-cols-[minmax(0,min(500px,calc(90vh*0.5625)))_minmax(0,1fr)]",
        )}
        style={{ animation: "fadeUp .22s cubic-bezier(.22,.8,.4,1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Video player ── */}
        <div className="flex shrink-0 items-center justify-center overflow-hidden border-b border-c-border bg-black md:h-full md:shrink md:border-b-0 md:border-r">
          {/* A size container: the phone-style overlays below are sized in cqw (1% of the
              video's width) so they grow with the preview; the px values are minimums. */}
          <div className="relative mx-auto aspect-[9/16] w-full max-h-[min(38dvh,320px)] max-w-[min(72vw,240px)] overflow-hidden [container-type:inline-size] md:h-full md:max-h-none md:max-w-none">
            {clip.storage_url
              ? <video ref={videoRef} src={clip.storage_url} className="absolute inset-0 h-full w-full object-cover" playsInline preload="metadata" poster={clip.thumbnail_url ?? undefined} />
              : clip.thumbnail_url
              ? <img src={clip.thumbnail_url} alt={clip.title ?? "clip"} className="absolute inset-0 h-full w-full object-cover" />
              : <div className="absolute inset-0 bg-gradient-to-b from-rose-700/50 to-violet-900/60" />}

            {/* gradient overlay */}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" />

            {/* social sidebar */}
            <div className="absolute right-[max(6px,2cqw)] bottom-[max(64px,24cqw)] z-10 flex flex-col items-center gap-[max(10px,3.5cqw)]">
              {([["👍","4.2K"],["💬","312"],["↗","1.1K"]] as [string,string][]).map(([icon, val], i) => (
                <div key={i} className="flex flex-col items-center gap-[max(2px,0.6cqw)]">
                  <div className="grid h-[max(28px,10cqw)] w-[max(28px,10cqw)] place-items-center rounded-full bg-white/15 text-[max(12px,4.4cqw)] backdrop-blur-md">{icon}</div>
                  <span className="text-[max(7px,2.6cqw)] font-bold text-white/80">{val}</span>
                </div>
              ))}
            </div>

            {/* caption overlay */}
            <div className="absolute bottom-[max(32px,9cqw)] left-[max(8px,3cqw)] right-[max(36px,15cqw)] z-10">
              <p className="text-[max(7.5px,3cqw)] font-bold text-white/90 drop-shadow">@viralo</p>
              {primaryDescription && <p className="mt-[max(2px,0.6cqw)] line-clamp-2 text-[max(7px,2.8cqw)] leading-[1.35] text-white/80 drop-shadow">{primaryDescription}</p>}
              {primaryTags.length > 0 && (
                <div className="mt-[max(2px,0.6cqw)] flex flex-wrap gap-[max(2px,1cqw)]">
                  {primaryTags.slice(0, 3).map((t) => <span key={t} className="text-[max(6.5px,2.6cqw)] font-bold text-[#ff6b8a] drop-shadow">#{t}</span>)}
                </div>
              )}
            </div>

            {/* play button */}
            <button className="absolute inset-0 z-20 flex items-center justify-center cursor-pointer" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {!playing && (
                <div className="grid h-[max(44px,14cqw)] w-[max(44px,14cqw)] place-items-center rounded-full bg-black/50 text-white shadow-[0_4px_20px_rgba(0,0,0,.6)] backdrop-blur-sm transition hover:scale-105">
                  <svg className="h-[max(14px,4.6cqw)] w-[max(14px,4.6cqw)]" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </div>
              )}
            </button>

            {/* seek bar */}
            <div className="absolute bottom-0 left-0 right-0 z-30 px-[max(8px,3cqw)] pb-[max(6px,2.4cqw)]">
              <div className="flex items-center gap-[max(4px,1.6cqw)]">
                <span className="font-mono text-[max(6.5px,2.5cqw)] text-white/60">{fmt(videoRef.current?.currentTime ?? 0)}</span>
                {/* taller hit area than the visible line, so it's easy to grab */}
                <div ref={barRef} className="relative flex h-[max(10px,3.6cqw)] flex-1 cursor-pointer items-center" onMouseDown={onBarMouseDown}>
                  <div className="relative h-[max(3px,1cqw)] w-full rounded-full bg-white/25">
                    <div className="h-full rounded-full bg-white" style={{ width: `${progress * 100}%` }} />
                  </div>
                  <div className="absolute top-1/2 h-[max(10px,3cqw)] w-[max(10px,3cqw)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `${progress * 100}%` }} />
                </div>
                <span className="font-mono text-[max(6.5px,2.5cqw)] text-white/60">{fmt(videoRef.current?.duration ?? 0)}</span>
              </div>
            </div>

            {/* status badge */}
            {(isPosted || isScheduled) && (
              <div className={cn("absolute left-[max(8px,3cqw)] top-[max(8px,3cqw)] z-20 flex items-center gap-[max(4px,1.2cqw)] rounded-full px-[max(8px,2.6cqw)] py-[max(2px,0.8cqw)] text-[max(9px,3cqw)] font-bold text-white backdrop-blur-sm", isPosted ? "bg-amber-500/90" : "bg-blue-500/80")}>
                <svg className="h-[max(10px,3cqw)] w-[max(10px,3cqw)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>{isPosted ? <path d="M20 6 9 17l-5-5"/> : <><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>}</svg>
                {isPosted ? "Live" : "Queued"}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: header + tabs + content + footer ── */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* Header */}
          <div className="flex shrink-0 items-start gap-3 border-b border-c-border bg-surface-1 px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 id="clip-detail-title" className="truncate text-[16px] font-bold leading-tight tracking-[-0.01em] text-c-text">
                {clip.clip_metadata?.ai_title ?? clip.title ?? "Untitled clip"}
              </h2>
              {primaryDescription && (
                <p className="mt-0.5 line-clamp-1 text-[12px] text-c-text-muted">{primaryDescription}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-semibold",
                clip.status === "ready" ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-c-border text-c-text-muted"
              )}>{clip.status}</span>
              <button
                onClick={onClose}
                aria-label="Close"
                className="grid h-7 w-7 place-items-center rounded-full border border-c-border text-c-text-muted transition hover:border-c-border-hover hover:text-c-text cursor-pointer"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>

          {/* Tab bar */}
          <div role="tablist" aria-label="Clip details" className="flex shrink-0 items-center gap-1 border-b border-c-border px-4 py-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                id={`clip-detail-tab-${t.id}`}
                role="tab"
                type="button"
                aria-selected={tab === t.id}
                aria-controls={`clip-detail-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12px] font-semibold transition cursor-pointer",
                  tab === t.id
                    ? "bg-surface-2 text-c-text"
                    : "text-c-text-muted hover:text-c-text-secondary"
                )}
              >
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className={cn("rounded-full px-1.5 py-px text-[10px] font-bold", tab === t.id ? "bg-[#ff3d6a]/20 text-[#ff6a8a]" : "bg-surface-2 text-c-text-muted")}>
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable on mobile */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">

            {/* ── INFO tab ── */}
            {tab === "info" && (
              <div
                id="clip-detail-panel-info"
                role="tabpanel"
                aria-labelledby="clip-detail-tab-info"
                className="flex h-full flex-col gap-3 p-4"
              >
                {/* Score + Duration */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-[12px] border border-c-border bg-surface-2 p-3">
                    <p className="text-[9px] font-bold uppercase tracking-[.13em] text-c-text-muted">Score</p>
                    <div className="mt-2 flex items-end gap-2">
                      <span className="font-mono text-[26px] font-black leading-none" style={{ color: scoreColor }}>
                        {clip.score != null ? clip.score.toFixed(1) : "--"}
                      </span>
                      <div className="mb-1 h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full rounded-full transition-all" style={{ width: `${scorePct}%`, background: scoreColor }} />
                      </div>
                    </div>
                  </div>
                  <div className="rounded-[12px] border border-c-border bg-surface-2 p-3">
                    <p className="text-[9px] font-bold uppercase tracking-[.13em] text-c-text-muted">Duration</p>
                    <p className="mt-2 font-mono text-[26px] font-black leading-none text-white">{fmt(durMs / 1000)}</p>
                  </div>
                </div>

                {/* 4-cell meta */}
                <div className="grid grid-cols-2 gap-2">
                  {([["Platform", clip.platform ?? "—"], ["Format", "9:16"], ["Timeline", `${clipStart}–${clipEnd}`], ["Created", new Date(clip.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })]] as [string,string][]).map(([label, value]) => (
                    <div key={label} className="rounded-[10px] border border-c-border bg-surface-2 px-3 py-2">
                      <p className="text-[9px] font-bold uppercase tracking-[.1em] text-c-text-muted">{label}</p>
                      <p className="mt-0.5 truncate text-[13px] font-semibold text-c-text capitalize">{value}</p>
                    </div>
                  ))}
                </div>

                {/* Primary hashtags */}
                {primaryTags.length > 0 && (
                  <div className="min-h-0 flex-1 rounded-[12px] border border-c-border bg-surface-2 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-[9px] font-bold uppercase tracking-[.13em] text-c-text-muted">Primary hashtags</p>
                      <span className="text-[10px] text-c-text-muted">{primaryTags.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {primaryTags.map((tag) => (
                        <span key={tag} className="rounded-full border border-[#ff3d6a]/20 bg-[#ff3d6a]/[.08] px-2.5 py-1 text-[11px] font-semibold text-rose-300">#{tag}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Posts status (if any) */}
                {posts.length > 0 && (
                  <div className="shrink-0 flex flex-wrap gap-1.5">
                    {posts.slice(0, 4).map((p) => {
                      const pcfg = DETAIL_PLAT_CFG[p.platform?.toLowerCase() ?? ""] ?? { color: "#ff3d6a", icon: "↗" };
                      const isLive = p.status === "posted";
                      const isQ = ["scheduled","pending","processing"].includes(p.status);
                      return (
                        <span key={p.id} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold"
                          style={{ borderColor: `${pcfg.color}30`, background: `${pcfg.color}10`, color: pcfg.color }}>
                          <span>{pcfg.icon}</span>
                          <span className="capitalize">{p.platform}</span>
                          {isLive && <span className="text-amber-400">✓</span>}
                          {isQ && <span className="text-blue-400">⏱</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── COPY tab ── */}
            {tab === "copy" && (
              <div
                id="clip-detail-panel-copy"
                role="tabpanel"
                aria-labelledby="clip-detail-tab-copy"
                className="flex min-h-0 flex-col"
              >
                {allPlatformEntries.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-[12px] text-c-text-muted">No platform copy generated yet.</div>
                ) : (
                  <>
                    {/* Platform pill selector */}
                    <div className="shrink-0 flex gap-1.5 overflow-x-auto px-4 py-3 [scrollbar-width:none]">
                      {allPlatformEntries.map(([plat], i) => {
                        const pcfg = DETAIL_PLAT_CFG[plat.toLowerCase()] ?? { color: "#ff3d6a", icon: "↗" };
                        return (
                          <button
                            key={plat}
                            onClick={() => setActivePlatIdx(i)}
                            className={cn(
                              "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition cursor-pointer whitespace-nowrap",
                              activePlatIdx === i
                                ? "border-transparent text-white"
                                : "border-c-border bg-transparent text-c-text-muted hover:text-c-text-secondary"
                            )}
                            style={activePlatIdx === i ? { background: `${pcfg.color}20`, borderColor: `${pcfg.color}40`, color: pcfg.color } : {}}
                          >
                            <span className="grid h-4 w-4 place-items-center rounded-[3px] text-[9px] font-black text-white" style={{ background: pcfg.color }}>{pcfg.icon}</span>
                            <span className="capitalize">{plat}</span>
                            <span className="rounded-full bg-surface-2 px-1 text-[10px] text-c-text-muted">{(allPlatformEntries[i][1] as { tags: string[] }).tags?.length ?? 0}</span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Content for selected platform */}
                    {activePlatContent && activePlatCfg && (
                      <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 pb-4">
                        {/* Description */}
                        <div className="rounded-[12px] border border-c-border bg-surface-2 p-3.5">
                          <p className="mb-2 text-[9px] font-bold uppercase tracking-[.13em] text-c-text-muted">Description</p>
                          <p className="text-[13px] leading-[1.6] text-c-text">{activePlatContent.description}</p>
                        </div>

                        {/* Tags */}
                        {activePlatContent.tags?.length > 0 && (
                          <div className="rounded-[12px] border border-c-border bg-surface-2 p-3.5">
                            <p className="mb-2 text-[9px] font-bold uppercase tracking-[.13em] text-c-text-muted">Tags · {activePlatContent.tags.length}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {activePlatContent.tags.map((tag) => (
                                <span key={tag} className="rounded-full border px-2.5 py-1 text-[11px] font-semibold"
                                  style={{ borderColor: `${activePlatCfg.color}35`, background: `${activePlatCfg.color}12`, color: activePlatCfg.color }}>
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── ASSETS tab ── */}
            {tab === "assets" && (
              <div
                id="clip-detail-panel-assets"
                role="tabpanel"
                aria-labelledby="clip-detail-tab-assets"
                className="flex h-full flex-col gap-3 overflow-hidden p-4"
              >
                {/* Caption preview */}
                {cleanCaptionPreview && (
                  <div className="rounded-[12px] border border-c-border bg-surface-2 p-3.5">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-[9px] font-bold uppercase tracking-[.13em] text-c-text-muted">Transcript preview</p>
                      {captionLineCount > 0 && <span className="text-[10px] text-c-text-muted">{captionLineCount} captions</span>}
                    </div>
                    <p className="line-clamp-4 text-[12px] leading-[1.6] text-c-text-muted">{cleanCaptionPreview}…</p>
                  </div>
                )}

                {/* Quick links */}
                <div className="grid grid-cols-2 gap-2">
                  {clip.storage_url && (
                    <a href={clip.storage_url} target="_blank" rel="noreferrer"
                      className="flex items-center justify-center gap-2 rounded-[10px] border border-c-border bg-surface-2 py-3 text-[12px] font-semibold text-c-text-secondary transition hover:border-c-border-hover hover:bg-surface-2 hover:text-c-text cursor-pointer">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                      Open video
                    </a>
                  )}
                  {clip.thumbnail_url && (
                    <a href={clip.thumbnail_url} target="_blank" rel="noreferrer"
                      className="flex items-center justify-center gap-2 rounded-[10px] border border-c-border bg-surface-2 py-3 text-[12px] font-semibold text-c-text-secondary transition hover:border-c-border-hover hover:bg-surface-2 hover:text-c-text cursor-pointer">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                      Thumbnail
                    </a>
                  )}
                </div>

                {/* Published posts in assets tab */}
                {posts.length > 0 && (
                  <div className="rounded-[12px] border border-c-border bg-surface-2 p-3.5">
                    <p className="mb-2.5 text-[9px] font-bold uppercase tracking-[.13em] text-c-text-muted">Published / Scheduled</p>
                    <div className="space-y-2">
                      {posts.map((p) => {
                        const pcfg = DETAIL_PLAT_CFG[p.platform?.toLowerCase() ?? ""] ?? { color: "#ff3d6a", icon: "↗" };
                        const isLive = p.status === "posted", isQ = ["scheduled","pending","processing"].includes(p.status), isFail = p.status === "failed";
                        return (
                          <div key={p.id} className="flex items-center gap-2.5 rounded-[9px] border px-2.5 py-2"
                            style={{ borderColor: isLive ? "rgba(52,211,153,.2)" : isQ ? "rgba(96,165,250,.18)" : isFail ? "rgba(248,113,113,.18)" : "rgba(255,255,255,.06)", background: isLive ? "rgba(52,211,153,.04)" : isQ ? "rgba(96,165,250,.04)" : "rgba(255,255,255,.01)" }}>
                            <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-black text-white" style={{ background: pcfg.color }}>{pcfg.icon}</div>
                            <span className="flex-1 text-[12px] font-semibold capitalize" style={{ color: pcfg.color }}>{p.platform}</span>
                            {isLive && <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-400">✓ Live</span>}
                            {isQ && <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-bold text-blue-400">Queued</span>}
                            {isFail && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-bold text-red-400">Failed</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* IDs */}
                <div className="mt-auto space-y-1 text-[9px] text-zinc-700">
                  <p className="truncate font-mono">Clip · {clip.id}</p>
                  <p className="truncate font-mono">Video · {clip.video_id}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div className="shrink-0 border-t border-c-border bg-surface-1 px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:pb-3">
            <div className="flex items-center gap-2">
              <button
                className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-[#ff3d6a] py-2.5 text-[13px] font-semibold text-white shadow-[0_2px_16px_rgba(255,61,106,.3)] transition hover:bg-[#e8304f] hover:shadow-[0_4px_24px_rgba(255,61,106,.4)] cursor-pointer"
                onClick={() => { onPublish?.(); onClose(); }}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
                {isPosted ? "Publish again" : isScheduled ? "Reschedule" : "Publish"}
              </button>
              {onEdit && (
              <button
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-c-border bg-surface-2 text-c-text-secondary transition hover:border-c-border-hover hover:bg-surface-3 hover:text-c-text cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Edit clip"
                title="Open in the editor"
                disabled={!clip.storage_url || CLIP_BUSY_STATUSES.includes(clip.status)}
                onClick={() => { onClose(); onEdit(); }}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              )}
              <button
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-c-border bg-surface-2 text-c-text-secondary transition hover:border-c-border-hover hover:bg-surface-3 hover:text-c-text cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                disabled={!clip.storage_url}
                aria-label="Download"
                onClick={() => { if (clip.storage_url) void downloadUrl(clip.storage_url, safeFilename(clip.title, "mp4")); }}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Download menu ─── */
function DownloadMenu({ clip, onClose }: { clip: ClipApiResponse; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const fn = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    setTimeout(() => document.addEventListener("click", fn), 50);
    return () => document.removeEventListener("click", fn);
  }, []);

  const title = clip.title ?? "clip";

  const items: { label: string; icon: string; onClick?: () => void; disabled?: boolean }[] = [
    {
      label: "Download MP4", icon: "🎬",
      disabled: !clip.storage_url,
      onClick: () => { void downloadUrl(clip.storage_url!, safeFilename(title, "mp4")); onClose(); },
    },
    {
      label: "Download SRT", icon: "💬",
      disabled: !clip.caption_srt,
      onClick: () => { downloadBlob(clip.caption_srt!, safeFilename(title, "srt"), "text/plain"); onClose(); },
    },
    {
      label: "Download thumbnail", icon: "🖼",
      disabled: !clip.thumbnail_url,
      onClick: () => { void downloadUrl(clip.thumbnail_url!, safeFilename(title, "jpg")); onClose(); },
    },
    {
      label: copied ? "Copied!" : "Copy transcript", icon: "📝",
      disabled: !clip.caption_srt,
      onClick: () => {
        navigator.clipboard.writeText(stripSrtTimecodes(clip.caption_srt!))
          .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
      },
    },
    {
      label: "Share link", icon: "🔗",
      onClick: () => { navigator.clipboard.writeText(window.location.href); onClose(); },
    },
  ];

  return (
    <div ref={ref} className="absolute bottom-[calc(100%+6px)] right-0 z-50 w-48 overflow-hidden rounded-[11px] border border-c-border bg-surface-1 shadow-[0_16px_40px_rgba(0,0,0,.5)]"
      onClick={(e) => e.stopPropagation()}>
      {items.map((item, i) => {
        const cls = `flex w-full items-center gap-2.5 px-3.5 py-2.5 text-[12.5px] transition ${item.disabled ? "cursor-not-allowed opacity-40 text-c-text-muted" : "text-c-text-secondary hover:bg-surface-2 hover:text-c-text"}`;
        return (
          <div key={item.label}>
            {i === 3 && <div className="mx-3 border-t border-c-border" />}
            <button onClick={item.disabled ? undefined : item.onClick} disabled={item.disabled} className={cls}>
              <span>{item.icon}</span>{item.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Clip card ─── */
export function ClipCard({ clip, idx, selected = false, onToggleSelect, isPosted = false, isScheduled = false, posts = [], onOpen, totalClips = 1, onRegenerated, sourceDuration }: {
  clip: ClipApiResponse;
  idx: number;
  selected?: boolean;
  onToggleSelect?: () => void;
  isPosted?: boolean;
  isScheduled?: boolean;
  posts?: ScheduledPostSummary[];
  onOpen?: () => void;
  /** Clips in this video, for the dialog's "All clips" option. */
  totalClips?: number;
  /** Called after a regenerate job is queued, so the page can refresh and poll. */
  onRegenerated?: () => void;
  /** Length of the original video in seconds, so Regenerate can extend the clip. */
  sourceDuration?: number | null;
}) {
  const [showEditor,     setShowEditor]     = useState(false);
  const [showDl,         setShowDl]         = useState(false);
  const [showPublish,    setShowPublish]    = useState(false);
  const [showRegen,      setShowRegen]      = useState(false);
  const [upscaling,      setUpscaling]      = useState(false);
  const [localClip,      setLocalClip]      = useState(clip);
  // Pick up fresh data when the page reloads clips (e.g. while a regenerate runs).
  // Just after this card queues a regenerate, a list poll that was already in flight can
  // still carry the clip's old "ready" state; ignore that for a few seconds so the busy
  // overlay doesn't flicker off.
  const queuedAt = useRef(0);
  useEffect(() => {
    setLocalClip((cur) =>
      CLIP_BUSY_STATUSES.includes(cur.status) && !CLIP_BUSY_STATUSES.includes(clip.status)
        && Date.now() - queuedAt.current < 6000 ? cur : clip);
  }, [clip]);
  const regenerating = CLIP_BUSY_STATUSES.includes(localClip.status);
  const regenError = localClip.clip_metadata?.regenerate_error;

  const handleRegen = () => setShowRegen(true);

  const handleUpscale = async () => {
    setUpscaling(true);
    try {
      const updated = await videoApi.upscaleClip(localClip.id, "4K");
      setLocalClip(updated);
    } catch {
      // leave clip unchanged; user can retry
    } finally {
      setUpscaling(false);
    }
  };

  // suppress unused warning
  void fmtSec;
  void PLAT_DISPLAY;
  void PlatPill;
  void VirChip;
  void videoApi;
  void platformApi;
  void DropdownMenu;
  void DropdownMenuContent;
  void DropdownMenuItem;
  void DropdownMenuTrigger;

  const actions: Array<{
    id: ClipCardAction;
    label?: string;
    icon?: string;
    primary?: boolean;
    disabled?: boolean;
    onClick?: (clip: ClipApiResponse) => void;
  }> = [
    { id: "publish", primary: true, onClick: () => setShowPublish(true) },
    { id: "trim", label: "Trim", icon: "✂", onClick: () => setShowEditor(true) },
    { id: "edit", label: "Edit", icon: "✎", onClick: () => setShowEditor(true) },
    ...(localClip.caption_srt ? [{ id: "transcript" as ClipCardAction, label: "Transcript", icon: "☷" }] : []),
    { id: "regenerate", label: regenerating ? "Regenerating…" : "Regenerate", icon: "✦", disabled: regenerating, onClick: handleRegen },
    { id: "upscale", label: upscaling ? "Upscaling…" : localClip.upscaled_storage_url ? "Upscaled ✓" : "Upscale 4K", icon: "⬆", disabled: upscaling, onClick: handleUpscale },
    { id: "download", label: "Download", icon: "↓", onClick: () => setShowDl(true) },
  ];

  return (
    <>
      <div className="relative">
        <UniversalClipCard
          clip={localClip}
          delay={idx * 60}
          selected={selected}
          selectable={Boolean(onToggleSelect)}
          onSelect={() => onToggleSelect?.()}
          onClick={() => onOpen?.()}
          actions={actions}
          density="compact"
          isPosted={isPosted}
          isScheduled={isScheduled}
          posts={posts as ScheduledPost[]}
          showTags={false}
        />
        {regenerating && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[16px] bg-black/45 backdrop-blur-[1px]">
            <div className="flex flex-col items-center gap-2">
              <span className="block h-10 w-10 rounded-full border-[3px] border-white/20 border-t-white animate-spin" />
              <span className="text-[12px] font-semibold text-white/90">Regenerating…</span>
            </div>
          </div>
        )}
        {!regenerating && regenError && (
          <p role="status" title={regenError}
            className="mt-1.5 whitespace-normal break-words rounded-[8px] border border-red-400/25 bg-red-400/10 px-2.5 py-1.5 text-[11px] leading-snug text-red-300">
            Regenerate failed: {regenError}
          </p>
        )}
        {showDl && <DownloadMenu clip={localClip} onClose={() => setShowDl(false)} />}
      </div>

      {showRegen && (
        <RegenerateDialog
          videoId={localClip.video_id}
          clip={localClip}
          totalClips={totalClips}
          sourceDuration={sourceDuration}
          onClose={() => setShowRegen(false)}
          onQueued={({ clip: updated }) => {
            if (updated) { queuedAt.current = Date.now(); setLocalClip(updated); }
            onRegenerated?.();
          }}
        />
      )}

      {showEditor && (
        <VideoEditor
          clip={localClip}
          onClose={() => setShowEditor(false)}
          onPost={() => setShowPublish(true)}
          onApplied={(updated) => { queuedAt.current = Date.now(); setLocalClip(updated); onRegenerated?.(); }}
        />
      )}

      {showPublish && (
        <BulkPublishModal
          clips={[localClip]}
          onClose={() => setShowPublish(false)}
        />
      )}
    </>
  );
}
