// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0): Project Studio clip list.
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { type Region, fmtTime, isBusy, isExported, tierOf, titleOf } from "./model";

const TIER_LABEL: Record<string, string> = { top: "AI pick", runner_up: "Other idea", manual: "Yours" };

export function statusLabel(r: Region): { text: string; cls: string } {
  const c = r.clip;
  if (isBusy(c)) return { text: "Exporting…", cls: "text-amber-300" };
  if (c.clip_metadata?.dirty) return { text: "Edited · export again", cls: "text-amber-300" };
  if (isExported(c)) return { text: "Exported", cls: "text-emerald-300" };
  if (c.status === "upload_failed" || c.status === "failed") return { text: "Export failed", cls: "text-red-400" };
  return { text: "Not exported", cls: "text-c-text-muted" };
}

/** Every clip on the timeline, with checkboxes for exporting or publishing several. */
export function RegionList({ regions, selectedId, checked, onSelect, onCheck }: {
  regions: Region[];
  selectedId: string | null;
  checked: Set<string>;
  onSelect: (id: string) => void;
  onCheck: (ids: string[], on: boolean) => void;
}) {
  const [sort, setSort] = useState<"time" | "score">("time");
  const sorted = useMemo(() => [...regions].sort((a, b) =>
    sort === "time" ? a.start - b.start : (b.clip.score ?? 0) - (a.clip.score ?? 0)), [regions, sort]);
  const allOn = regions.length > 0 && regions.every((r) => checked.has(r.id));

  return (
    <section aria-label="Clips" className="flex h-full max-h-[420px] min-h-0 flex-col rounded-[14px] lg:max-h-none border border-c-border bg-surface-1">
      <div className="flex items-center gap-2 border-b border-c-border px-3 py-2">
        <input type="checkbox" aria-label="Select all clips" checked={allOn}
          onChange={(e) => onCheck(regions.map((r) => r.id), e.target.checked)}
          className="h-3.5 w-3.5 accent-[#ff3d6a]" />
        <h3 className="text-[11.5px] font-bold uppercase tracking-[.1em] text-c-text-muted">
          Clips <span className="font-mono normal-case">{regions.length}</span>
        </h3>
        <div className="ml-auto flex rounded-[7px] border border-c-border p-0.5 text-[11px]" role="group" aria-label="Sort clips">
          {(["time", "score"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setSort(k)} aria-pressed={sort === k}
              className={cn("rounded-[5px] px-2 py-0.5", sort === k ? "bg-surface-3 text-c-text" : "text-c-text-muted hover:text-c-text-secondary")}>
              {k === "time" ? "Time" : "Score"}
            </button>
          ))}
        </div>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-c-border overflow-y-auto">
        {sorted.map((r) => {
          const st = statusLabel(r);
          const tier = tierOf(r.clip);
          return (
            <li key={r.id}
              className={cn("flex cursor-pointer gap-2.5 px-3 py-2.5 transition",
                r.id === selectedId ? "bg-[#ff3d6a]/10" : "hover:bg-surface-2")}
              onClick={() => onSelect(r.id)}>
              <input type="checkbox" aria-label={`Select ${titleOf(r.clip)}`} checked={checked.has(r.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onCheck([r.id], e.target.checked)}
                className="mt-1 h-3.5 w-3.5 flex-none accent-[#ff3d6a]" />
              {r.clip.thumbnail_url
                ? <img src={r.clip.thumbnail_url} alt="" loading="lazy" className="h-10 w-16 flex-none rounded-[6px] object-cover" />
                : <div className="h-10 w-16 flex-none rounded-[6px] bg-surface-3" />}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[12.5px] font-semibold leading-snug text-c-text">{titleOf(r.clip)}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-c-text-muted">
                  <span className="font-mono">{fmtTime(r.start)}–{fmtTime(r.end)}</span>
                  <span className={cn(tier === "top" ? "text-[#ff7a9a]" : tier === "manual" ? "text-amber-300" : "text-sky-300")}>{TIER_LABEL[tier]}</span>
                  {r.clip.score != null && <span className="font-mono">{Number(r.clip.score).toFixed(1)}</span>}
                  <span className={st.cls}>{st.text}</span>
                </p>
              </div>
            </li>
          );
        })}
        {!regions.length && (
          <li className="px-3 py-8 text-center text-[12.5px] text-c-text-muted">
            No clips yet. Move the playhead and use “+ Clip here”.
          </li>
        )}
      </ul>
    </section>
  );
}
