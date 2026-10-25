// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { useState } from "react";
import { cn } from "@/lib/utils";
import { videoApi, type ClipApiResponse, type RegenerateMode } from "@/lib/api";

const MODES: Array<{ id: RegenerateMode; icon: string; label: string; sub: string }> = [
  { id: "text", icon: "✎", label: "New title, caption & tags",
    sub: "Ask the AI again. The video itself isn't changed." },
  { id: "render", icon: "↻", label: "Re-render the clip",
    sub: "Redraw captions and the hook title with the latest look. Same text." },
  { id: "both", icon: "✦", label: "Both",
    sub: "New AI text, then re-render with it (the hook shows the new title)." },
];

/** Clip statuses while a regenerate (or its upload) is running. */
export const CLIP_BUSY_STATUSES = ["regenerating", "pending_upload", "uploading"];

export type RegenerateScope = "this" | "all";

/**
 * Regenerate one clip or every clip of a video.
 * With `clip`, the dialog offers "This clip" / "All clips"; without it, all clips only.
 */
export function RegenerateDialog({
  videoId,
  clip,
  totalClips,
  defaultScope = clip ? "this" : "all",
  onClose,
  onQueued,
}: {
  videoId: string;
  clip?: ClipApiResponse;
  totalClips: number;
  defaultScope?: RegenerateScope;
  onClose: () => void;
  /** Called once the server accepted the job; `clip` is the updated clip for scope "this". */
  onQueued: (result: { scope: RegenerateScope; mode: RegenerateMode; clip?: ClipApiResponse; queued: number }) => void;
}) {
  const [mode, setMode] = useState<RegenerateMode>("both");
  const [scope, setScope] = useState<RegenerateScope>(clip ? defaultScope : "all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (scope === "this" && clip) {
        const updated = await videoApi.regenerateClip(clip.id, mode);
        onQueued({ scope, mode, clip: updated, queued: 1 });
      } else {
        const res = await videoApi.regenerateVideoClips(videoId, mode);
        onQueued({ scope, mode, queued: res.queued });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start regenerating. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const count = scope === "this" ? 1 : totalClips;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-3 sm:p-6"
      style={{ background: "rgba(4,7,15,.8)", backdropFilter: "blur(6px)", animation: "fadeUp .15s ease" }}
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="regen-title"
        className="w-full max-w-[460px] overflow-hidden rounded-[18px] border border-c-border bg-surface-1 p-4 shadow-[0_40px_100px_rgba(0,0,0,.7)] sm:rounded-[20px] sm:p-6"
        style={{ animation: "fadeUp .2s cubic-bezier(.22,.8,.4,1)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#ff3d6a]/25 bg-[#ff3d6a]/10 text-[#ff3d6a]">✦</div>
          <div className="min-w-0">
            <h3 id="regen-title" className="font-display text-[16px] font-bold text-c-text">Regenerate</h3>
            <p className="truncate text-[12px] text-c-text-muted">
              {clip && scope === "this" ? (clip.title || "This clip") : `All clips in this video`}
            </p>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close"
            className="ml-auto grid h-7 w-7 place-items-center rounded-[7px] border border-c-border text-[13px] text-c-text-muted hover:text-c-text">✕</button>
        </div>

        <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[.1em] text-c-text-muted">What</div>
        <div className="mb-5 flex flex-col gap-2" role="radiogroup" aria-label="What to regenerate">
          {MODES.map((m) => (
            <button key={m.id} role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}
              className={cn("flex items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left transition",
                mode === m.id
                  ? "border-[#ff3d6a]/40 bg-[#ff3d6a]/10"
                  : "border-c-border bg-surface-2 hover:border-c-border-hover")}>
              <span className={cn("mt-px text-[14px]", mode === m.id ? "text-[#ff3d6a]" : "text-c-text-muted")}>{m.icon}</span>
              <span className="min-w-0">
                <span className={cn("block text-[13px] font-semibold", mode === m.id ? "text-[#ff3d6a]" : "text-c-text")}>{m.label}</span>
                <span className="block text-[11.5px] leading-snug text-c-text-muted">{m.sub}</span>
              </span>
            </button>
          ))}
        </div>

        {clip && (
          <>
            <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[.1em] text-c-text-muted">Which clips</div>
            <div className="mb-5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Which clips">
              {([["this", "This clip"], ["all", `All ${totalClips} clips`]] as const).map(([id, label]) => (
                <button key={id} role="radio" aria-checked={scope === id} onClick={() => setScope(id)}
                  className={cn("rounded-[8px] border px-3 py-1.5 text-[12.5px] font-semibold transition",
                    scope === id
                      ? "border-[#ff3d6a]/35 bg-[#ff3d6a]/10 text-[#ff3d6a]"
                      : "border-c-border bg-surface-2 text-c-text-secondary hover:border-c-border-hover hover:text-c-text")}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {mode !== "text" && (
          <p className="mb-4 text-[11.5px] leading-snug text-c-text-muted">
            Re-rendering takes a few minutes per clip. The current version stays playable until the new one is ready.
          </p>
        )}
        {error && <p role="alert" className="mb-4 text-[12px] text-red-400">{error}</p>}

        <div className="flex gap-2.5">
          <button onClick={onClose} disabled={busy}
            className="rounded-[9px] border border-c-border bg-surface-2 px-4 py-2 text-[13px] font-semibold text-c-text-secondary transition hover:text-c-text">
            Cancel
          </button>
          <button onClick={submit} disabled={busy}
            className="ml-auto flex items-center gap-1.5 rounded-[9px] bg-[#ff3d6a] px-4 py-2 text-[13px] font-semibold text-white shadow-[0_2px_12px_rgba(255,61,106,.3)] disabled:opacity-60">
            {busy ? "Starting…" : `✦ Regenerate ${count === 1 ? "clip" : `${count} clips`}`}
          </button>
        </div>
      </div>
    </div>
  );
}
