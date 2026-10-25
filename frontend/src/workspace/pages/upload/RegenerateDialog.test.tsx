// @vitest-environment jsdom
// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { ClipApiResponse } from "@/lib/api";

const regenerateClip = vi.fn();
const regenerateVideoClips = vi.fn();
vi.mock("@/lib/api", () => ({
  videoApi: {
    regenerateClip: (...a: unknown[]) => regenerateClip(...a),
    regenerateVideoClips: (...a: unknown[]) => regenerateVideoClips(...a),
  },
}));

import { RegenerateDialog } from "./RegenerateDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clip = { id: "c1", video_id: "v1", title: "Blackout", status: "ready" } as ClipApiResponse;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  regenerateClip.mockReset().mockResolvedValue({ ...clip, status: "regenerating" });
  regenerateVideoClips.mockReset().mockResolvedValue({ queued: 3, clip_ids: ["a", "b", "c"], mode: "both" });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function click(label: string) {
  const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`no button "${label}"`);
  act(() => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function flush() { await act(async () => { await Promise.resolve(); }); }

describe("RegenerateDialog", () => {
  it("defaults to Both for this clip and queues one clip", async () => {
    const onQueued = vi.fn(); const onClose = vi.fn();
    act(() => root.render(<RegenerateDialog videoId="v1" clip={clip} totalClips={3} onClose={onClose} onQueued={onQueued} />));
    click("Regenerate clip");
    await flush();
    expect(regenerateClip).toHaveBeenCalledWith("c1", "both", undefined);
    expect(regenerateVideoClips).not.toHaveBeenCalled();
    expect(onQueued).toHaveBeenCalledWith(expect.objectContaining({ scope: "this", mode: "both", queued: 1 }));
    expect(onClose).toHaveBeenCalled();
  });

  it("text only for all clips calls the video endpoint", async () => {
    const onQueued = vi.fn();
    act(() => root.render(<RegenerateDialog videoId="v1" clip={clip} totalClips={3} onClose={() => {}} onQueued={onQueued} />));
    click("New title, caption & tags");
    click("All 3 clips");
    click("Regenerate 3 clips");
    await flush();
    expect(regenerateVideoClips).toHaveBeenCalledWith("v1", "text");
    expect(onQueued).toHaveBeenCalledWith(expect.objectContaining({ scope: "all", mode: "text", queued: 3 }));
  });

  it("opened from Regenerate all: no clip choice, re-render mode", async () => {
    act(() => root.render(<RegenerateDialog videoId="v1" totalClips={3} onClose={() => {}} onQueued={() => {}} />));
    expect(host.textContent).not.toContain("This clip");
    click("Re-render the clip");
    click("Regenerate 3 clips");
    await flush();
    expect(regenerateVideoClips).toHaveBeenCalledWith("v1", "render");
  });

  it("shows the server error and stays open", async () => {
    regenerateClip.mockRejectedValue(new Error("Clip is busy (uploading); try again when it's ready."));
    const onClose = vi.fn();
    act(() => root.render(<RegenerateDialog videoId="v1" clip={clip} totalClips={1} onClose={onClose} onQueued={() => {}} />));
    click("Regenerate clip");
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Clip is busy");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("extends a clip past its end with +15s, capped at the video length", async () => {
    const timed = { ...clip, start_ms: 60_000, end_ms: 102_000 } as ClipApiResponse;
    act(() => root.render(<RegenerateDialog videoId="v1" clip={timed} totalClips={3} sourceDuration={110}
      onClose={() => {}} onQueued={() => {}} />));
    expect(host.textContent).toContain("Clip timing");
    click("+15s");
    expect(host.textContent).toContain("+8.0s after");
    click("Regenerate clip");
    await flush();
    expect(regenerateClip).toHaveBeenCalledWith("c1", "both", { start_sec: 60, end_sec: 110 });
  });

  it("hides timing for text-only and sends no times when unchanged", async () => {
    const timed = { ...clip, start_ms: 60_000, end_ms: 102_000 } as ClipApiResponse;
    act(() => root.render(<RegenerateDialog videoId="v1" clip={timed} totalClips={3} sourceDuration={300}
      onClose={() => {}} onQueued={() => {}} />));
    click("New title, caption & tags");
    expect(host.textContent).not.toContain("Clip timing");
    click("Regenerate clip");
    await flush();
    expect(regenerateClip).toHaveBeenCalledWith("c1", "text", undefined);
  });
});
