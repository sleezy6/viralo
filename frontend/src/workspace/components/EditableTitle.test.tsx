// @vitest-environment jsdom
// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { VideoResponse } from "@/lib/api";

const update = vi.fn();
vi.mock("@/lib/api", () => ({ videoApi: { update: (...a: unknown[]) => update(...a) } }));
import { EditableTitle } from "./EditableTitle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const video = { id: "v1", title: "2026-10-20 21-14-33" } as VideoResponse;
let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); update.mockReset(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function key(input: HTMLInputElement, k: string) {
  act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
}

describe("EditableTitle", () => {
  it("renames with Enter and reports the updated project", async () => {
    update.mockResolvedValue({ ...video, title: "Backrooms run" });
    const onRenamed = vi.fn();
    act(() => root.render(<EditableTitle video={video} onRenamed={onRenamed} />));
    act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Rename project"]')!.click(); });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    type(input, "  Backrooms run ");
    key(input, "Enter");
    await act(async () => { await Promise.resolve(); });
    expect(update).toHaveBeenCalledWith("v1", { title: "Backrooms run" });
    expect(onRenamed).toHaveBeenCalledWith(expect.objectContaining({ title: "Backrooms run" }));
    expect(host.querySelector("input")).toBeNull();
  });

  it("Escape cancels without saving", () => {
    act(() => root.render(<EditableTitle video={video} onRenamed={() => {}} />));
    act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Rename project"]')!.click(); });
    const input = host.querySelector<HTMLInputElement>("input")!;
    type(input, "Nope");
    key(input, "Escape");
    expect(update).not.toHaveBeenCalled();
    expect(host.textContent).toContain("2026-10-20 21-14-33");
  });
});
