// @vitest-environment jsdom
// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const searchGames = vi.fn();
vi.mock("@/lib/api", () => ({ videoApi: { searchGames: (q: string) => searchGames(q) } }));
import { GameField } from "./GameField";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  searchGames.mockReset().mockResolvedValue([
    { appid: 1943950, name: "Escape the Backrooms", image: "" },
    { appid: 2148510, name: "The Backrooms Game", image: "" },
  ]);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function type(value: string) {
  const input = host.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("GameField", () => {
  it("searches Steam while typing and stores the picked game's app id", async () => {
    const onChange = vi.fn();
    act(() => root.render(<GameField game="" appid={null} onChange={onChange} inputCls="" labelCls="" />));
    type("backrooms");
    expect(onChange).toHaveBeenLastCalledWith({ game: "backrooms", game_appid: null });
    await sleep(400);
    expect(searchGames).toHaveBeenCalledWith("backrooms");
    const option = [...host.querySelectorAll('[role="option"] button')].find((b) => b.textContent?.includes("Escape the Backrooms"))!;
    act(() => { option.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith({ game: "Escape the Backrooms", game_appid: 1943950 });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it("editing after a pick clears the exact match; short input doesn't search", async () => {
    const onChange = vi.fn();
    act(() => root.render(<GameField game="Escape the Backrooms" appid={1943950} onChange={onChange} inputCls="" labelCls="" />));
    type("E");
    await sleep(400);
    expect(searchGames).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith({ game: "E", game_appid: null });
  });
});
