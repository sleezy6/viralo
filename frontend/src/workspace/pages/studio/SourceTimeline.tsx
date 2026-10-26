// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Project Studio timeline.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { type Region, clampRegion, fmtTime, isBusy, isExported, tierOf, titleOf } from "./model";

type Drag = { id: string; edge: "start" | "end" | "move"; x0: number; s0: number; e0: number };

const ZOOMS = [1, 2, 4, 8, 16];

/** Ruler step (seconds) that keeps labels roughly 80px apart. */
function tickStep(pxPerSec: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s * pxPerSec >= 80) ?? 3600;
}

/**
 * The whole source video as a timeline: ruler, waveform, and the clips as regions
 * (AI picks on the top lane, other ideas and your own clips below). Drag a region to
 * move it, its edges to trim or extend it; click anywhere to move the playhead.
 */
export function SourceTimeline({ duration, regions, selectedId, time, peaks, onSeek, onSelect, onChange }: {
  duration: number;
  regions: Region[];
  selectedId: string | null;
  time: number;
  peaks: { per_sec: number; peaks: number[] } | null;
  onSeek: (t: number) => void;
  onSelect: (id: string) => void;
  /** A region was moved or resized (seconds of the original video). */
  onChange: (id: string, start: number, end: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [viewW, setViewW] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<{ id: string; start: number; end: number } | null>(null);
  const dur = Math.max(duration, 1);
  const width = viewW * zoom;
  const pxPerSec = width / dur;
  const x = useCallback((t: number) => (t / dur) * width, [dur, width]);

  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth || 800));
    ro.observe(el);
    setViewW(el.clientWidth || 800);
    return () => ro.disconnect();
  }, []);

  // Waveform from the peaks file: one bar per pixel column.
  useEffect(() => {
    const c = canvas.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(width * dpr)); c.height = 48 * dpr;
    const ctx = c.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!peaks?.peaks?.length) return;
    ctx.fillStyle = "rgba(255,255,255,.22)";
    const cols = Math.floor(width);
    const per = peaks.peaks.length / Math.max(cols, 1);
    for (let i = 0; i < cols; i++) {
      let m = 0;
      const a = Math.floor(i * per), b = Math.max(a + 1, Math.floor((i + 1) * per));
      for (let j = a; j < b && j < peaks.peaks.length; j++) m = Math.max(m, peaks.peaks[j]);
      const h = Math.max(1, (m / 100) * 44 * dpr);
      ctx.fillRect(i * dpr, (c.height - h) / 2, Math.max(1, dpr * 0.8), h);
    }
  }, [peaks, width]);

  // Keep the playhead in view when zoomed in.
  useEffect(() => {
    const el = scroller.current; if (!el || zoom === 1 || drag) return;
    const px = x(time);
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, px - el.clientWidth / 3);
  }, [time, zoom, x, drag]);

  const timeAt = (clientX: number) => {
    const el = scroller.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(dur, Math.max(0, ((clientX - r.left + el.scrollLeft) / width) * dur));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dt = ((e.clientX - drag.x0) / width) * dur;
    const [s, en] = clampRegion(
      drag.edge === "end" ? drag.s0 : drag.s0 + dt,
      drag.edge === "start" ? drag.e0 : drag.e0 + dt, dur, drag.edge);
    setPreview({ id: drag.id, start: s, end: en });
  };
  const endDrag = () => {
    if (drag && preview && (preview.start !== drag.s0 || preview.end !== drag.e0)) {
      onChange(drag.id, preview.start, preview.end);
    }
    setDrag(null);
    // keep the dragged position on screen until the saved clip comes back
    setTimeout(() => setPreview(null), 600);
  };

  const ticks = useMemo(() => {
    const step = tickStep(pxPerSec);
    const out: number[] = [];
    for (let t = 0; t <= dur; t += step) out.push(t);
    return out;
  }, [pxPerSec, dur]);

  const lanes: Record<string, number> = { top: 0, runner_up: 1, manual: 1 };

  return (
    <div className="rounded-[14px] border border-c-border bg-surface-1">
      <div className="flex items-center gap-2 border-b border-c-border px-3 py-2 text-[11.5px] text-c-text-muted">
        <span className="font-semibold uppercase tracking-[.1em]">Timeline</span>
        <span className="font-mono">{fmtTime(time, true)} / {fmtTime(dur)}</span>
        <span className="ml-3 hidden items-center gap-3 sm:flex">
          <Legend cls="bg-[#ff3d6a]" label="AI pick" />
          <Legend cls="border border-dashed border-sky-300 bg-sky-400/20" label="Other idea" />
          <Legend cls="border border-amber-300 bg-amber-400/20" label="Yours" />
        </span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" disabled={zoom === ZOOMS[0]}
            onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])}
            className="grid h-6 w-6 place-items-center rounded-[6px] border border-c-border hover:text-c-text disabled:opacity-40">−</button>
          <span className="w-8 text-center font-mono">{zoom}×</span>
          <button type="button" aria-label="Zoom in" disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])}
            className="grid h-6 w-6 place-items-center rounded-[6px] border border-c-border hover:text-c-text disabled:opacity-40">+</button>
        </div>
      </div>

      <div ref={scroller} className="relative overflow-x-auto overflow-y-hidden"
        onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <div className="relative select-none" style={{ width, height: 150 }}
          onPointerDown={(e) => { if (e.button === 0 && !(e.target as HTMLElement).closest("[data-region]")) onSeek(timeAt(e.clientX)); }}>
          {/* ruler */}
          <div className="absolute inset-x-0 top-0 h-5 border-b border-c-border">
            {ticks.map((t) => (
              <span key={t} className="absolute top-0 h-full border-l border-c-border pl-1 font-mono text-[10px] leading-5 text-c-text-muted"
                style={{ left: x(t) }}>{fmtTime(t)}</span>
            ))}
          </div>
          {/* waveform */}
          <canvas ref={canvas} aria-hidden className="absolute left-0 top-6" style={{ width, height: 48 }} />
          {/* regions */}
          {regions.map((r) => {
            const p = preview?.id === r.id ? preview : r;
            const tier = tierOf(r.clip);
            const lane = lanes[tier] ?? 1;
            const sel = r.id === selectedId;
            const busy = isBusy(r.clip);
            const w = Math.max(6, x(p.end) - x(p.start));
            return (
              <div key={r.id} data-region
                role="button" tabIndex={0}
                aria-label={`${titleOf(r.clip)}, ${fmtTime(p.start)} to ${fmtTime(p.end)}`}
                aria-pressed={sel}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(r.id); } }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  onSelect(r.id);
                  if (busy) return;
                  scroller.current?.setPointerCapture?.(e.pointerId);
                  setDrag({ id: r.id, edge: "move", x0: e.clientX, s0: r.start, e0: r.end });
                }}
                className={cn(
                  "group absolute flex h-[34px] items-center overflow-hidden rounded-[7px] px-2 text-[11px] font-semibold",
                  busy ? "cursor-progress" : "cursor-grab active:cursor-grabbing",
                  tier === "top" && "bg-[#ff3d6a]/80 text-white",
                  tier === "runner_up" && "border border-dashed border-sky-300/80 bg-sky-400/15 text-sky-100",
                  tier === "manual" && "border border-amber-300/80 bg-amber-400/15 text-amber-50",
                  sel && "ring-2 ring-white ring-offset-1 ring-offset-black",
                )}
                style={{ left: x(p.start), width: w, top: 78 + lane * 36 }}>
                {!busy && <Handle side="start" onDown={(e) => {
                  e.stopPropagation(); onSelect(r.id);
                  scroller.current?.setPointerCapture?.(e.pointerId);
                  setDrag({ id: r.id, edge: "start", x0: e.clientX, s0: r.start, e0: r.end });
                }} />}
                <span className="truncate">
                  {isExported(r.clip) && "✓ "}{busy && "⏳ "}{titleOf(r.clip)}
                </span>
                {!busy && <Handle side="end" onDown={(e) => {
                  e.stopPropagation(); onSelect(r.id);
                  scroller.current?.setPointerCapture?.(e.pointerId);
                  setDrag({ id: r.id, edge: "end", x0: e.clientX, s0: r.start, e0: r.end });
                }} />}
              </div>
            );
          })}
          {/* playhead */}
          <div aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-white" style={{ left: x(time) }}>
            <span className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-white" />
          </div>
          {drag && preview && (
            <span className="pointer-events-none absolute top-6 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10.5px] text-white"
              style={{ left: x(preview.start) }}>
              {fmtTime(preview.start, true)} – {fmtTime(preview.end, true)} ({Math.round(preview.end - preview.start)}s)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Handle({ side, onDown }: { side: "start" | "end"; onDown: (e: React.PointerEvent<HTMLSpanElement>) => void }) {
  return (
    <span aria-hidden onPointerDown={onDown}
      className={cn("absolute inset-y-0 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/40",
        side === "start" ? "left-0" : "right-0")} />
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return <span className="flex items-center gap-1"><span className={cn("h-2.5 w-4 rounded-[3px]", cls)} />{label}</span>;
}
