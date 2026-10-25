// @vitest-environment jsdom
// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act, useState } from "react";
import type { VideoResponse } from "@/lib/api";

const updateSpeakers = vi.fn();
vi.mock("@/lib/api", () => ({ videoApi: { updateSpeakers: (...a: unknown[]) => updateSpeakers(...a) } }));
import { SpeakersPanel } from "./SpeakersPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const video = { id: "v1", title: "t", speakers: { colors: true, list: [
  { id: "S1", name: null, color: "#FFFFFF" }, { id: "S2", name: "Sam", color: "#4FD1FF" }] } } as unknown as VideoResponse;
let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); updateSpeakers.mockReset().mockResolvedValue(video); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const setValue = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("SpeakersPanel", () => {
  it("renames a speaker on blur and offers a re-render", async () => {
    const onRerender = vi.fn();
    act(() => root.render(<SpeakersPanel video={video} onVideoChange={() => {}} onRerender={onRerender} />));
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Name for Speaker 1"]')!;
    expect(name.placeholder).toBe("Speaker 1");
    setValue(name, " Rich ");
    act(() => { name.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(updateSpeakers).toHaveBeenCalledWith("v1", { speakers: [{ id: "S1", name: "Rich" }] });
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Re-render clips")!;
    act(() => btn.click());
    expect(onRerender).toHaveBeenCalled();
  });

  it("saves a picked colour once, after the picker settles", async () => {
    vi.useFakeTimers();
    act(() => root.render(<SpeakersPanel video={video} onVideoChange={() => {}} onRerender={() => {}} />));
    const pickers = host.querySelectorAll<HTMLInputElement>('input[type="color"]');
    setValue(pickers[1], "#ff0000"); setValue(pickers[1], "#ff7ac6");
    expect(updateSpeakers).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(updateSpeakers).toHaveBeenCalledTimes(1);
    expect(updateSpeakers).toHaveBeenCalledWith("v1", { speakers: [{ id: "S2", color: "#ff7ac6" }] });
    vi.useRealTimers();
  });

  it("turns speaker colours off", async () => {
    act(() => root.render(<SpeakersPanel video={video} onVideoChange={() => {}} onRerender={() => {}} />));
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => { await Promise.resolve(); });
    expect(updateSpeakers).toHaveBeenCalledWith("v1", { colors: false });
  });

  it("keeps a name being typed when another save comes back", async () => {
    let rerender: (v: VideoResponse) => void = () => {};
    function Host() {
      const [v, setV] = useState(video);
      rerender = setV;
      return <SpeakersPanel video={v} onVideoChange={setV} onRerender={() => {}} />;
    }
    act(() => root.render(<Host />));
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Name for Speaker 1"]')!;
    act(() => { name.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    setValue(name, "Ri");
    // a colour save for Speaker 2 returns the server's copy (Speaker 1 still unnamed)
    act(() => rerender({ ...video, speakers: { colors: true, list: [
      { id: "S1", name: null, color: "#FFFFFF" }, { id: "S2", name: "Sam", color: "#FF7AC6" }] } } as unknown as VideoResponse));
    expect(name.value).toBe("Ri");
    expect(name.disabled).toBe(false);
  });
});
