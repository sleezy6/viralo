// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { videoApi, type VideoResponse } from "@/lib/api";

/**
 * A project's name with a pencil to rename it in place. Enter or clicking away saves,
 * Escape cancels. A name set here is never replaced by the automatic game name.
 */
export function EditableTitle({ video, onRenamed, className }: {
  video: VideoResponse;
  onRenamed: (video: VideoResponse) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(video.title ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setValue(video.title ?? ""); }, [video.title, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  async function save() {
    const title = value.trim();
    if (!title || title === (video.title ?? "")) { setEditing(false); setError(""); return; }
    setSaving(true);
    setError("");
    try {
      onRenamed(await videoApi.update(video.id, { title }));
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rename. Try again.");
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <span className="inline-flex min-w-0 flex-col">
        <input
          ref={inputRef}
          aria-label="Project name"
          value={value}
          maxLength={255}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void save(); }
            else if (e.key === "Escape") { setValue(video.title ?? ""); setError(""); setEditing(false); }
          }}
          className={cn("min-w-[12ch] rounded-[8px] border border-[#ff3d6a]/50 bg-surface-2 px-2 py-0.5 text-c-text outline-none", className)}
        />
        {error && <span role="alert" className="mt-1 text-[11.5px] font-normal text-red-400">{error}</span>}
      </span>
    );
  }

  return (
    <span className="group inline-flex min-w-0 items-center gap-1.5">
      <span className={cn("min-w-0", className)}>{video.title || "Untitled"}</span>
      <button type="button" onClick={() => setEditing(true)} aria-label="Rename project" title="Rename"
        className="grid h-6 w-6 flex-none place-items-center rounded-[6px] text-c-text-muted opacity-60 transition hover:bg-surface-3 hover:text-c-text hover:opacity-100 group-hover:opacity-100">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </span>
  );
}
