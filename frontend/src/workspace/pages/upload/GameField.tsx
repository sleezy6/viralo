// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { videoApi, type SteamGameSuggestion } from "@/lib/api";

/**
 * "Game" input with Steam suggestions. Picking a suggestion stores its Steam app id,
 * so the AI gets that exact game's store info; typing only a name works too, and
 * leaving it empty lets Viralo detect the game from the video title.
 */
export function GameField({
  game,
  appid,
  onChange,
  inputCls,
  labelCls,
  className = "mt-4",
}: {
  game: string | null | undefined;
  appid: number | null | undefined;
  onChange: (patch: { game: string | null; game_appid: number | null }) => void;
  inputCls: string;
  labelCls: string;
  className?: string;
}) {
  const [text, setText] = useState(game ?? "");
  const [items, setItems] = useState<SteamGameSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const skipSearch = useRef(false);

  useEffect(() => { setText(game ?? ""); }, [game]);

  // Debounced Steam search while typing (not right after picking a suggestion).
  useEffect(() => {
    if (skipSearch.current) { skipSearch.current = false; return; }
    const q = text.trim();
    if (q.length < 2) { setItems([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      videoApi.searchGames(q)
        .then((res) => { if (!cancelled) { setItems(res); setActive(-1); setOpen(true); } })
        .catch(() => { if (!cancelled) setItems([]); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [text]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (s: SteamGameSuggestion) => {
    skipSearch.current = true;
    setText(s.name);
    setOpen(false);
    onChange({ game: s.name, game_appid: s.appid });
  };

  return (
    <div ref={boxRef} className={cn("relative", className)}>
      <label htmlFor="game-field" className={labelCls}>
        Game <span className="normal-case tracking-normal text-c-text-muted">optional</span>
      </label>
      <input
        id="game-field"
        type="text"
        autoComplete="off"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls="game-suggestions"
        placeholder="e.g. Escape the Backrooms"
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          onChange({ game: v.trim() || null, game_appid: null });  // typed: no exact match yet
        }}
        onFocus={() => items.length && setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !items.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
        className={inputCls}
      />
      {open && items.length > 0 && (
        <ul id="game-suggestions" role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-[10px] border border-c-border bg-surface-1 p-1 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
          {items.map((s, i) => (
            <li key={s.appid} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}
                className={cn("flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-[13px] text-c-text transition",
                  i === active ? "bg-surface-3" : "hover:bg-surface-2")}>
                {s.image
                  ? <img src={s.image} alt="" className="h-[22px] w-[46px] shrink-0 rounded-[4px] object-cover" />
                  : <span className="h-[22px] w-[46px] shrink-0 rounded-[4px] bg-surface-3" />}
                <span className="truncate">{s.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11.5px] text-c-text-muted">
        {appid
          ? "Steam's description of this game is given to the AI as background."
          : text.trim()
            ? "Pick a suggestion for an exact Steam match, or keep the name as typed."
            : "Leave empty to detect the game from the video title. Its Steam description helps the AI write titles and tags."}
      </p>
    </div>
  );
}
