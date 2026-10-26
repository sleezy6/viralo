// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Project Studio caption editing.
import { useEffect, useState } from "react";
import type { VideoSpeakers } from "@/lib/api";
import { type CaptionLine, fmtTime, speakerColor, speakerName } from "./model";

/**
 * The selected clip's captions, one line per caption. Edit the words of any line;
 * Save keeps them for the export (timings stay those of the speech).
 */
export function StudioCaptions({ lines, edited, speakers, disabled, onSeek, onSave }: {
  lines: CaptionLine[];
  /** The clip already has edited captions (Reset goes back to the transcript). */
  edited: boolean;
  speakers?: VideoSpeakers | null;
  disabled?: boolean;
  onSeek: (t: number) => void;
  /** Save these lines; [] goes back to the transcript's own captions. */
  onSave: (lines: CaptionLine[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string[]>(lines.map((l) => l.text));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const key = lines.map((l) => `${l.start}:${l.text}`).join("|");
  useEffect(() => { setDraft(lines.map((l) => l.text)); setError(""); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = draft.some((t, i) => t !== lines[i]?.text);

  async function save(next: CaptionLine[]) {
    setSaving(true); setError("");
    try { await onSave(next); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't save the captions."); }
    finally { setSaving(false); }
  }

  if (!lines.length) {
    return <p className="text-[12px] text-c-text-muted">No speech in this part of the video.</p>;
  }

  return (
    <div>
      <ol className="max-h-[260px] space-y-1 overflow-y-auto pr-1">
        {lines.map((l, i) => {
          const color = speakerColor(speakers, l.speaker);
          return (
            <li key={`${l.start}-${i}`} className="flex items-start gap-2">
              <button type="button" onClick={() => onSeek(l.start)} title="Jump here"
                className="mt-1.5 w-11 flex-none text-left font-mono text-[10.5px] text-c-text-muted hover:text-c-text">
                {fmtTime(l.start)}
              </button>
              <div className="min-w-0 flex-1">
                {l.speaker && (speakers?.list?.length ?? 0) > 1 && (
                  <span className="text-[10px] font-semibold" style={{ color: color ?? undefined }}>
                    {speakerName(speakers, l.speaker)}
                  </span>
                )}
                <input
                  aria-label={`Caption at ${fmtTime(l.start)}`}
                  value={draft[i] ?? ""}
                  disabled={disabled || saving}
                  onChange={(e) => setDraft((d) => d.map((t, j) => (j === i ? e.target.value : t)))}
                  className="w-full rounded-[7px] border border-transparent bg-surface-2 px-2 py-1 text-[12.5px] text-c-text outline-none focus:border-[#ff3d6a]/40 disabled:opacity-60"
                />
              </div>
            </li>
          );
        })}
      </ol>
      {error && <p role="alert" className="mt-2 text-[12px] text-red-400">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" disabled={!dirty || saving || disabled}
          onClick={() => void save(lines.map((l, i) => ({ ...l, text: draft[i] ?? l.text })))}
          className="rounded-[8px] bg-[#ff3d6a] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40">
          {saving ? "Saving…" : "Save captions"}
        </button>
        {dirty && !saving && (
          <button type="button" onClick={() => setDraft(lines.map((l) => l.text))}
            className="text-[12px] text-c-text-muted hover:text-c-text">Undo</button>
        )}
        {edited && !dirty && (
          <button type="button" disabled={saving || disabled} onClick={() => void save([])}
            className="ml-auto text-[12px] text-c-text-muted hover:text-c-text disabled:opacity-40">
            Reset to transcript
          </button>
        )}
      </div>
    </div>
  );
}
