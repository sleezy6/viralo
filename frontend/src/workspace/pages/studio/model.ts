// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Project Studio helpers.
import type { ClipApiResponse, TranscriptWord, VideoSpeakers } from "@/lib/api";

/** Shortest and longest clip the Studio lets you make (the server enforces the same). */
export const MIN_CLIP_SEC = 1;
export const MAX_CLIP_SEC = 600;
/** Clip statuses while an export is running. */
export const BUSY = ["regenerating", "pending_upload", "uploading"];

export interface Region {
  id: string;
  start: number;
  end: number;
  clip: ClipApiResponse;
}

export const regionOf = (c: ClipApiResponse): Region => ({
  id: c.id,
  start: (c.start_ms ?? 0) / 1000,
  end: (c.end_ms ?? 0) / 1000,
  clip: c,
});

export const isBusy = (c: ClipApiResponse) => BUSY.includes(c.status);
export const isExported = (c: ClipApiResponse) => Boolean(c.storage_url);
export const tierOf = (c: ClipApiResponse) => c.clip_metadata?.tier ?? (c.status === "suggested" ? "runner_up" : "top");
export const titleOf = (c: ClipApiResponse) => c.clip_metadata?.ai_title || c.title || "Untitled clip";

/** "1:05" / "1:05.4" (with tenths) / "1:02:03". */
export function fmtTime(sec: number, tenths = false): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const frac = tenths ? `.${Math.floor((s * 10) % 10)}` : "";
  const ss = `${String(whole).padStart(2, "0")}${frac}`;
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "1:05", "65", "1:05.5", "1:02:03" → seconds (null if it isn't a time). */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

/** Keep a region inside the video and within the length limits. `edge` says which end
 * the user is moving ("move" keeps the length). */
export function clampRegion(start: number, end: number, duration: number,
                            edge: "start" | "end" | "move"): [number, number] {
  const dur = duration > 0 ? duration : Math.max(end, start + MIN_CLIP_SEC);
  if (edge === "move") {
    const len = Math.min(Math.max(end - start, MIN_CLIP_SEC), MAX_CLIP_SEC, dur);
    const s = Math.min(Math.max(0, start), dur - len);
    return [round2(s), round2(s + len)];
  }
  if (edge === "start") {
    let s = Math.min(Math.max(0, start), end - MIN_CLIP_SEC);
    s = Math.max(s, end - MAX_CLIP_SEC);
    return [round2(Math.max(0, s)), round2(end)];
  }
  let e = Math.max(Math.min(end, dur), start + MIN_CLIP_SEC);
  e = Math.min(e, start + MAX_CLIP_SEC, dur);
  return [round2(start), round2(e)];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CaptionLine {
  text: string;
  start: number; // seconds of the original video
  end: number;
  speaker: string | null;
}

/** The clip's captions: the edited ones where the user edited them, otherwise lines
 * built from the transcript (a new line when the speaker changes, after a sentence end,
 * or every `perLine` words) — the same way exports build them. */
export function captionsFor(words: TranscriptWord[], start: number, end: number,
                            clip?: ClipApiResponse | null, perLine = 5): CaptionLine[] {
  const custom = clip?.clip_metadata?.custom_captions;
  if (custom?.items?.length) {
    // As the export does: the edited lines inside the stretch that was edited, the
    // transcript's own captions outside it (e.g. after the clip was extended).
    const [lo, hi] = custom.range ?? [start, end];
    const edited = custom.items
      .map((it) => ({ text: it.text, start: Math.max(it.start, start), end: Math.min(it.end, end),
                      speaker: speakerAt(words, it.start, it.end) }))
      .filter((l) => l.end - l.start >= 0.05);
    const outside = transcriptLines(words, start, end, perLine)
      .filter((l) => { const mid = (l.start + l.end) / 2; return mid < lo || mid > hi; });
    return [...edited, ...outside].sort((a, b) => a.start - b.start);
  }
  return transcriptLines(words, start, end, perLine);
}

function transcriptLines(words: TranscriptWord[], start: number, end: number, perLine: number): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push({ text: cur.map((w) => w[0]).join(" "), start: cur[0][1], end: cur[cur.length - 1][2],
                 speaker: cur[0][3] ?? null });
    cur = [];
  };
  for (const w of words) {
    if (w[1] < start - 0.05 || w[1] > end) continue;
    if (cur.length && (w[3] ?? null) !== (cur[0][3] ?? null)) flush();
    cur.push(w);
    if (cur.length >= perLine || /[.!?…]$/.test(w[0])) flush();
  }
  flush();
  return lines;
}

/** Who says most of the words between start and end. */
export function speakerAt(words: TranscriptWord[], start: number, end: number): string | null {
  const counts = new Map<string, number>();
  for (const w of words) {
    if (w[3] && w[1] < end && w[2] > start) counts.set(w[3], (counts.get(w[3]) ?? 0) + 1);
  }
  let best: string | null = null, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
}

/** Caption colour for a speaker, as exports use it (only with 2+ speakers and colours on). */
export function speakerColor(speakers: VideoSpeakers | null | undefined, id: string | null): string | null {
  if (!id || !speakers?.colors || (speakers.list?.length ?? 0) < 2) return null;
  return speakers.list.find((s) => s.id === id)?.color ?? null;
}

export function speakerName(speakers: VideoSpeakers | null | undefined, id: string | null): string | null {
  if (!id) return null;
  const s = speakers?.list?.find((x) => x.id === id);
  return s?.name || `Speaker ${id.replace(/^S/, "")}`;
}

/** Same file, maybe a fresh signature: signed links change on every API response. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.split("?")[0] === b.split("?")[0];
}

/** Keep the links already in use when only their signature changed, so players and
 * thumbnails don't reload on every refresh. */
export function keepLinks(prev: ClipApiResponse[], next: ClipApiResponse[]): ClipApiResponse[] {
  const old = new Map(prev.map((c) => [c.id, c]));
  return next.map((c) => {
    const o = old.get(c.id);
    if (!o) return c;
    return {
      ...c,
      storage_url: samePath(o.storage_url, c.storage_url) ? o.storage_url : c.storage_url,
      thumbnail_url: samePath(o.thumbnail_url, c.thumbnail_url) ? o.thumbnail_url : c.thumbnail_url,
    };
  });
}

/** A title request that never finished (its task died) stops counting as running. */
export const titlesPending = (c: ClipApiResponse) =>
  Boolean(c.clip_metadata?.titles_pending)
  && Date.now() / 1000 - (c.clip_metadata?.titles_at ?? Date.now() / 1000) < 20 * 60;
