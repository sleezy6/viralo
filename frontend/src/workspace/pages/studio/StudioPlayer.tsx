// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Project Studio player.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { VideoSpeakers } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type CaptionLine, fmtTime, speakerColor } from "./model";

export interface StudioPlayerHandle {
  seek: (t: number) => void;
  /** Play from `start`, stopping at `end` (seconds of the original video). */
  playRange: (start: number, end: number) => void;
  toggle: () => void;
}

/** "9:16" → 0.5625 */
const ratio = (ar: string | undefined) => {
  const m = /^(\d+):(\d+)$/.exec(ar ?? "");
  return m ? Number(m[1]) / Number(m[2]) : 9 / 16;
};

/**
 * The whole source video (the Studio preview: no burned-in captions) with the export
 * frame and the selected clip's captions drawn on top, so what you see is what the
 * export will look like.
 */
export const StudioPlayer = forwardRef<StudioPlayerHandle, {
  src: string | null;
  aspect?: string;
  captions: CaptionLine[];
  speakers?: VideoSpeakers | null;
  showCaptions: boolean;
  onTime: (t: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  emptyState?: React.ReactNode;
}>(function StudioPlayer({ src, aspect, captions, speakers, showCaptions, onTime, onPlayingChange, emptyState }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [srcRatio, setSrcRatio] = useState(16 / 9);
  const [error, setError] = useState("");

  useImperativeHandle(ref, () => ({
    seek: (t) => {
      stopAt.current = null;
      if (video.current) video.current.currentTime = Math.max(0, t);
      setTime(t); onTime(t);
    },
    playRange: (start, end) => {
      const v = video.current; if (!v) return;
      v.currentTime = start;
      stopAt.current = end;
      void v.play().catch(() => {});
    },
    toggle: () => {
      const v = video.current; if (!v) return;
      if (v.paused) { stopAt.current = null; void v.play().catch(() => {}); } else v.pause();
    },
  }), [onTime]);

  // Smooth playhead while playing; stop at the end of a played range.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        if (stopAt.current != null && v.currentTime >= stopAt.current) {
          v.pause(); v.currentTime = stopAt.current; stopAt.current = null;
        }
        setTime(v.currentTime); onTime(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, onTime]);

  useEffect(() => { setError(""); }, [src]);

  const target = ratio(aspect);
  const narrower = target < srcRatio - 0.01;
  const line = showCaptions ? captions.find((c) => time >= c.start && time <= c.end) : undefined;
  const color = line ? speakerColor(speakers, line.speaker) : null;

  if (!src) {
    return (
      <div className="grid aspect-video w-full place-items-center rounded-[14px] border border-c-border bg-black/60 p-6 text-center text-[13px] text-c-text-muted">
        {emptyState ?? "No preview"}
      </div>
    );
  }

  return (
    <div className="relative w-full overflow-hidden rounded-[14px] border border-c-border bg-black"
      style={{ aspectRatio: String(srcRatio) }}>
      <video
        ref={video}
        src={src}
        preload="metadata"
        playsInline
        className="absolute inset-0 h-full w-full object-contain"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setSrcRatio(v.videoWidth / v.videoHeight);
        }}
        onPlay={() => { setPlaying(true); onPlayingChange?.(true); }}
        onPause={() => { setPlaying(false); onPlayingChange?.(false); }}
        onSeeked={(e) => { setTime(e.currentTarget.currentTime); onTime(e.currentTarget.currentTime); }}
        onError={() => setError("The preview couldn't be played.")}
        onClick={() => { const v = video.current; if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause(); } }}
      />

      {/* Export frame: the part of the picture a vertical clip keeps. */}
      {narrower && (() => {
        const w = (target / srcRatio) * 100, side = `${(100 - w) / 2}%`;
        return (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 bg-black/60" style={{ width: side }} />
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 bg-black/60" style={{ width: side }} />
            <div aria-hidden className="pointer-events-none absolute inset-y-0 border-x border-dashed border-white/40 [container-type:inline-size]"
              style={{ left: side, width: `${w}%` }}>
              {line && <Caption text={line.text} color={color} />}
            </div>
          </>
        );
      })()}
      {!narrower && line && (
        <div aria-hidden className="pointer-events-none absolute inset-0 [container-type:inline-size]">
          <Caption text={line.text} color={color} />
        </div>
      )}

      {error && (
        <div role="alert" className="absolute inset-x-3 top-3 rounded-[8px] bg-red-500/20 px-3 py-1.5 text-[12px] text-red-200">{error}</div>
      )}
      <button type="button" onClick={() => { const v = video.current; if (v) { if (v.paused) { stopAt.current = null; void v.play().catch(() => {}); } else v.pause(); } }}
        aria-label={playing ? "Pause" : "Play"}
        className={cn("absolute bottom-3 left-3 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80")}>
        {playing ? "❚❚" : "▶"}
      </button>
      <span className="absolute bottom-4 left-14 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[11px] text-white/90">{fmtTime(time, true)}</span>
    </div>
  );
});

function Caption({ text, color }: { text: string; color: string | null }) {
  return (
    <div className="absolute inset-x-[6%] bottom-[14%] text-center">
      <span className="font-display font-extrabold uppercase leading-tight"
        style={{ fontSize: "clamp(10px, 7cqw, 40px)", color: color ?? "#fff",
                 WebkitTextStroke: "0.06em #000", paintOrder: "stroke fill",
                 textShadow: "0 2px 6px rgba(0,0,0,.6)" }}>
        {text}
      </span>
    </div>
  );
}
