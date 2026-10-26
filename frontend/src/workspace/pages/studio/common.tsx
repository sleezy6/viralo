// Moved 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0) from upload/ResultsView.tsx.
import { useState, useEffect, useRef } from "react";
import { cn, safeFilename } from "@/lib/utils";
import { videoApi, type VideoResponse, type ClipApiResponse } from "@/lib/api";

type ZipPhase = "zipping" | "done" | "error";

export function DeleteModal({
  video,
  onConfirm,
  onCancel,
}: {
  video: VideoResponse;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center p-4"
      style={{ background: "rgba(4,7,15,.7)", backdropFilter: "blur(6px)", animation: "fadeUp .15s ease" }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[380px] overflow-hidden rounded-[18px] border border-c-border bg-surface-2 shadow-[0_32px_80px_rgba(0,0,0,.7)]"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "fadeUp .18s cubic-bezier(.22,.8,.4,1)" }}
      >
        <div className="p-6">
          <div className="mb-4 grid h-11 w-11 place-items-center rounded-[12px] border border-red-400/20 bg-red-400/10">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </div>
          <h3 className="font-display text-[16px] font-bold text-c-text">Delete video?</h3>
          <p className="mt-1.5 text-[13px] leading-[1.55] text-c-text-muted">
            <span className="font-semibold text-c-text-secondary">"{video.title ?? "Untitled"}"</span> and all its generated clips will be permanently deleted. This cannot be undone.
          </p>
        </div>
        <div className="flex gap-2 border-t border-c-border px-6 py-4">
          <button
            onClick={onCancel}
            className="flex-1 rounded-[9px] border border-c-border bg-surface-3 py-2 text-[13px] font-semibold text-c-text-secondary transition hover:text-c-text"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-[9px] bg-red-500 py-2 text-[13px] font-semibold text-white shadow-[0_2px_12px_rgba(239,68,68,.3)] transition hover:bg-red-400 hover:shadow-[0_4px_18px_rgba(239,68,68,.4)]"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function ZipDownloadModal({ clips, videoTitle, onClose }: {
  clips: ClipApiResponse[];
  videoTitle: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<ZipPhase>("zipping");
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    async function run() {
      const ids = clips.filter((c) => c.storage_url).map((c) => c.id);
      if (!ids.length) { setError("No downloadable clips."); setPhase("error"); return; }

      try {
        const blob = await videoApi.downloadZip(ids, videoTitle);
        if (cancelledRef.current) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = safeFilename(videoTitle, "zip");
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setPhase("done");
        setTimeout(onClose, 1200);
      } catch (e: unknown) {
        if (cancelledRef.current) return;
        setError(e instanceof Error ? e.message : "Unknown error");
        setPhase("error");
      }
    }

    void run();
    return () => { cancelledRef.current = true; };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[340px] rounded-[16px] border border-c-border bg-surface-2 p-6 shadow-[0_24px_60px_rgba(0,0,0,.7)]"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[14px] font-semibold text-c-text">
            {phase === "zipping" && "Preparing ZIP…"}
            {phase === "done" && "Done!"}
            {phase === "error" && "Error"}
          </span>
          {(phase === "done" || phase === "error") && (
            <button onClick={onClose} className="text-[12px] text-c-text-muted hover:text-c-text-secondary">Close</button>
          )}
        </div>

        {phase === "zipping" && (
          <div className="flex items-center gap-2.5 text-[12px] text-c-text-secondary">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-c-border border-t-c-text-secondary" />
            Server is fetching and zipping {clips.filter((c) => c.storage_url).length} clips…
          </div>
        )}

        {phase === "done" && (
          <div className="text-[12px] text-emerald-400">✓ ZIP downloaded successfully</div>
        )}

        {phase === "error" && (
          <div className="text-[12px] text-red-400">{error}</div>
        )}

        {phase === "zipping" && (
          <button onClick={() => { cancelledRef.current = true; onClose(); }}
            className="mt-4 text-[11.5px] text-c-text-muted hover:text-c-text-secondary">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function RetryVideoButton({ videoId, onRetried }: { videoId: string; onRetried: () => void }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <button
      type="button"
      disabled={retrying}
      onClick={async () => {
        setRetrying(true);
        try { await videoApi.retry(videoId); onRetried(); }
        catch { setRetrying(false); }
      }}
      className="inline-flex items-center gap-1 rounded-full border border-red-400/30 bg-red-400/10 px-2.5 py-0.5 text-[11px] font-semibold text-red-300 hover:bg-red-400/20 disabled:opacity-50 transition cursor-pointer"
    >
      {retrying ? "Retrying…" : "↻ Retry"}
    </button>
  );
}

export function FailedErrorCard({ errorMessage, videoId, onRetried }: { errorMessage: string; videoId: string; onRetried: () => void }) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  type ErrorKind = { label: string; msg: string; hint: string };
  const kind: ErrorKind = (() => {
    if (/429|Too Many Requests/i.test(errorMessage))
      return { label: "Rate limited", msg: "YouTube throttled this request (HTTP 429).", hint: "Wait a few minutes before retrying — YouTube limits how often a server can fetch the same video." };
    if (/403|Forbidden/i.test(errorMessage))
      return { label: "Access denied", msg: "YouTube refused access to this video (HTTP 403).", hint: "The video may be age-restricted, region-locked, or require sign-in. Try a different video." };
    if (/unavailable|removed|private/i.test(errorMessage))
      return { label: "Unavailable", msg: "This video is unavailable or private.", hint: "Check that the link is correct and the video is publicly accessible." };
    const firstLine = errorMessage.split("\n")[0].replace(/^(ERROR|WARNING|CRITICAL):\s*/i, "");
    const msg = firstLine.length > 160 ? firstLine.slice(0, 160) + "…" : firstLine;
    return { label: "Processing error", msg, hint: "Expand the details below for the full error log." };
  })();

  const handleRetry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await videoApi.retry(videoId);
      onRetried();
    } catch {
      setRetryError("Retry failed — check service logs or try again shortly.");
      setRetrying(false);
    }
  };

  return (
    <div className="mx-auto mt-10 max-w-[540px]" style={{ animation: "fadeUp .2s cubic-bezier(.22,.8,.4,1)" }}>
      <div className="overflow-hidden rounded-[18px] border border-red-500/20 bg-surface-2">
        <div className="h-[3px] w-full bg-gradient-to-r from-red-500/80 via-red-400/60 to-transparent" />

        <div className="p-6">
          <div className="mb-5 flex items-start gap-4">
            <div className="mt-0.5 grid h-10 w-10 flex-none place-items-center rounded-[10px] border border-red-500/25 bg-red-500/10">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[13px] font-bold text-red-300">{kind.label}</span>
                <span className="rounded-full border border-red-400/20 bg-red-400/10 px-2 py-0.5 text-[10px] font-semibold text-red-400 uppercase tracking-wide">Failed</span>
              </div>
              <p className="text-[13px] font-medium text-c-text leading-snug mb-2">{kind.msg}</p>
              <p className="text-[12px] text-c-text-muted leading-relaxed">{kind.hint}</p>
            </div>
          </div>

          {retryError && (
            <div className="mb-4 flex items-center gap-2 rounded-[8px] border border-red-500/20 bg-red-500/[.06] px-3 py-2">
              <svg className="h-3.5 w-3.5 flex-none text-red-400" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7.25 4.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zm.75 7a1 1 0 110-2 1 1 0 010 2z"/>
              </svg>
              <span className="text-[11.5px] text-red-400">{retryError}</span>
            </div>
          )}

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="flex cursor-pointer items-center gap-2 rounded-[9px] bg-[#ff3d6a] px-4 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_2px_16px_rgba(255,61,106,.3)] transition-all hover:bg-[#ff3d6a]/85 hover:shadow-[0_4px_20px_rgba(255,61,106,.4)] active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {retrying
                ? <>
                    <span className="block h-3.5 w-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    Retrying…
                  </>
                : <>
                    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13.5 2.5A6.5 6.5 0 012.5 8M2.5 13.5A6.5 6.5 0 0113.5 8"/>
                      <polyline points="2.5,10.5 2.5,13.5 5.5,13.5"/>
                      <polyline points="13.5,2.5 13.5,5.5 10.5,5.5"/>
                    </svg>
                    Retry processing
                  </>
              }
            </button>

            <button
              onClick={() => setExpanded(v => !v)}
              className="flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-c-border bg-surface-3 px-3.5 py-2.5 text-[12px] text-c-text-muted transition hover:border-c-border-hover hover:text-c-text"
            >
              <svg className={cn("h-3.5 w-3.5 transition-transform duration-150", expanded && "rotate-180")} viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 10.94L2.53 5.47a.75.75 0 011.06-1.06L8 8.88l4.41-4.47a.75.75 0 111.06 1.06L8 10.94z"/>
              </svg>
              {expanded ? "Hide details" : "Show details"}
            </button>
          </div>

          {expanded && (
            <div className="mt-4 overflow-hidden rounded-[10px] border border-c-border bg-surface-2">
              <div className="flex items-center gap-2 border-b border-c-border px-3 py-2">
                <span className="h-2 w-2 rounded-full bg-red-400/70" />
                <span className="h-2 w-2 rounded-full bg-yellow-400/40" />
                <span className="h-2 w-2 rounded-full bg-c-border" />
                <span className="ml-2 text-[10.5px] font-mono text-c-text-muted">error.log</span>
              </div>
              <pre className="max-h-[200px] overflow-auto p-4 text-[10.5px] font-mono leading-relaxed text-c-text-secondary whitespace-pre-wrap">
                {errorMessage}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
