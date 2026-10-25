// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { videoApi, type VideoResponse, type VideoSpeaker } from "@/lib/api";

/**
 * The speakers found in a video's transcript: rename them (the AI uses the names) and
 * pick each one's caption colour. Changes apply to clips rendered afterwards.
 */
export function SpeakersPanel({ video, onVideoChange, onRerender }: {
  video: VideoResponse;
  onVideoChange: (video: VideoResponse) => void;
  /** Opens the "re-render all clips" dialog. */
  onRerender: () => void;
}) {
  const sp = video.speakers;
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [colors, setColors] = useState<Record<string, string>>({});
  const colorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(colorTimer.current), []);

  useEffect(() => {
    setNames(Object.fromEntries((sp?.list ?? []).map((s) => [s.id, s.name ?? ""])));
    setColors(Object.fromEntries((sp?.list ?? []).map((s) => [s.id, s.color])));
  }, [sp]);

  if (!sp || sp.list.length === 0) return null;
  const multi = sp.list.length >= 2;

  async function save(body: Parameters<typeof videoApi.updateSpeakers>[1]) {
    setBusy(true);
    setError("");
    try {
      onVideoChange(await videoApi.updateSpeakers(video.id, body));
      setChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // The picker fires while dragging: show the colour at once, save once it settles.
  const pickColor = (id: string, color: string) => {
    setColors((c) => ({ ...c, [id]: color }));
    clearTimeout(colorTimer.current);
    colorTimer.current = setTimeout(() => void save({ speakers: [{ id, color }] }), 500);
  };

  const label = (s: VideoSpeaker) => `Speaker ${s.id.replace(/^S/, "")}`;
  const commitName = (s: VideoSpeaker) => {
    const name = (names[s.id] ?? "").trim();
    if (name !== (s.name ?? "")) void save({ speakers: [{ id: s.id, name: name || null }] });
  };

  return (
    <section aria-label="Speakers" className="mb-5 rounded-[14px] border border-c-border bg-surface-1 p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-[12px] font-bold uppercase tracking-[.1em] text-c-text-muted">
          Speakers <span className="font-mono normal-case tracking-normal">{sp.list.length}</span>
        </h3>
        {multi && (
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-c-text-secondary">
            <input type="checkbox" checked={sp.colors} disabled={busy}
              onChange={(e) => void save({ colors: e.target.checked })}
              className="h-3.5 w-3.5 accent-[#ff3d6a]" />
            Colour captions by speaker
          </label>
        )}
        {changed && (
          <span className="ml-auto flex items-center gap-2 text-[12px] text-c-text-muted">
            Applies to clips you re-render.
            <button type="button" onClick={onRerender}
              className="rounded-[7px] border border-[#ff3d6a]/35 bg-[#ff3d6a]/10 px-2.5 py-1 text-[12px] font-semibold text-[#ff3d6a] hover:bg-[#ff3d6a]/15">
              Re-render clips
            </button>
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {sp.list.map((s) => (
          <div key={s.id}
            className="flex min-w-0 items-center gap-2 rounded-[10px] border border-c-border bg-surface-2 py-1 pl-1.5 pr-2">
            <label title={multi ? "Caption colour" : undefined}
              className={cn("relative grid h-7 w-7 flex-none place-items-center rounded-[7px] border border-white/15",
                multi && sp.colors ? "cursor-pointer" : "opacity-50")}
              style={{ background: colors[s.id] ?? s.color }}>
              <span className="sr-only">Caption colour for {s.name || label(s)}</span>
              <input type="color" value={colors[s.id] ?? s.color} disabled={!multi || !sp.colors}
                onChange={(e) => pickColor(s.id, e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" />
            </label>
            <input
              aria-label={`Name for ${label(s)}`}
              value={names[s.id] ?? ""}
              placeholder={label(s)}
              maxLength={40}
              disabled={busy}
              onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))}
              onBlur={() => commitName(s)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="w-[118px] min-w-0 bg-transparent text-[13px] font-semibold text-c-text outline-none placeholder:font-normal placeholder:text-c-text-muted"
            />
          </div>
        ))}
      </div>

      {error
        ? <p role="alert" className="mt-2 text-[12px] text-red-400">{error}</p>
        : <p className="mt-2 text-[11.5px] text-c-text-muted">
            {multi
              ? "Names help the AI write titles and captions; colours are used for each speaker's captions."
              : "Only one speaker was found. Names help the AI write titles and captions."}
          </p>}
    </section>
  );
}
