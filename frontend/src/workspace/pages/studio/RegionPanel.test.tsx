// @vitest-environment jsdom
// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { ClipApiResponse } from "@/lib/api";
import { RegionPanel } from "./RegionPanel";
import { regionOf } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const clip = (over: Partial<ClipApiResponse> = {}) => ({
  id: "c1", video_id: "v1", title: "First", start_ms: 10000, end_ms: 40000, duration_ms: 30000, platform: "tiktok",
  score: 8, status: "suggested", storage_url: null, thumbnail_url: null, caption_srt: null,
  upload_attempts: 0, upload_error: null, upscaled_storage_url: null, created_at: "",
  clip_metadata: { tier: "top", ai_title: "First", title_options: [
    { text: "First", score: 9, hook_type: null }, { text: "Second", score: 7, hook_type: null }] },
  ...over,
}) as ClipApiResponse;

function render(c: ClipApiResponse, handlers: Partial<Parameters<typeof RegionPanel>[0]> = {}) {
  const props = {
    region: regionOf(c), lines: [], duration: 120,
    onPatch: vi.fn().mockResolvedValue(undefined), onMoreTitles: vi.fn().mockResolvedValue(undefined),
    onExport: vi.fn().mockResolvedValue(undefined), onPublish: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined),
    onPlay: vi.fn(), onSeek: vi.fn(), onSaveCaptions: vi.fn().mockResolvedValue(undefined), ...handlers,
  };
  act(() => root.render(<RegionPanel {...props} />));
  return props;
}
const btn = (re: RegExp) => [...host.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""))!;
const setValue = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("RegionPanel", () => {
  it("picks a title option and a custom title", async () => {
    const p = render(clip());
    const radios = host.querySelectorAll('[role="radio"]');
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    await act(async () => { (radios[1] as HTMLButtonElement).click(); });
    expect(p.onPatch).toHaveBeenCalledWith({ title: "Second" });
    setValue(host.querySelector<HTMLInputElement>('input[aria-label="Your own title"]')!, "  Mine ");
    await act(async () => { btn(/^Use$/).click(); });
    expect(p.onPatch).toHaveBeenLastCalledWith({ title: "Mine" });
  });

  it("changes start/end from typed times and rejects bad ones", async () => {
    const p = render(clip());
    const end = host.querySelector<HTMLInputElement>('input[aria-label="End time"]')!;
    setValue(end, "0:10.5");
    act(() => { end.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(host.textContent).toContain("at least 1 second");
    setValue(end, "1:00");
    await act(async () => { end.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(p.onPatch).toHaveBeenCalledWith({ start_sec: 10, end_sec: 60 });
  });

  it("exports, and offers publish/download only once exported", async () => {
    const p = render(clip());
    expect(btn(/Publish/)).toBeUndefined();
    await act(async () => { btn(/Export clip/).click(); });
    expect(p.onExport).toHaveBeenCalled();
    render(clip({ status: "ready", storage_url: "/x.mp4", clip_metadata: { tier: "top", ai_title: "First", dirty: true } }));
    expect(btn(/Export again/)).toBeTruthy();
    expect(btn(/Publish/)).toBeTruthy();
    expect(host.textContent).toContain("export again");
  });

  it("disables editing while exporting", () => {
    render(clip({ status: "regenerating" }));
    expect(btn(/Exporting/)?.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Start time"]')!.disabled).toBe(true);
  });
});
