// Added 2026 by sleezy6 (fork of sammyview80/viralo, Apache-2.0).
import { describe, expect, it } from "vitest";
import type { ClipApiResponse, TranscriptWord } from "@/lib/api";
import { captionsFor, clampRegion, fmtTime, keepLinks, parseTime, speakerColor } from "./model";

describe("studio model", () => {
  it("clamps regions to the video and the length limits", () => {
    expect(clampRegion(-5, 20, 100, "move")).toEqual([0, 25]);
    expect(clampRegion(90, 120, 100, "move")).toEqual([70, 100]);
    expect(clampRegion(19.5, 20, 100, "start")).toEqual([19, 20]);
    expect(clampRegion(10, 10.2, 100, "end")).toEqual([10, 11]);
    expect(clampRegion(10, 900, 2000, "end")).toEqual([10, 610]);
    expect(clampRegion(0, 700, 2000, "start")).toEqual([100, 700]);
  });

  it("formats and parses times", () => {
    expect(fmtTime(65.47, true)).toBe("1:05.4");
    expect(fmtTime(3723)).toBe("1:02:03");
    expect(parseTime("1:05.5")).toBe(65.5);
    expect(parseTime("90")).toBe(90);
    expect(parseTime("1:x")).toBeNull();
  });

  it("builds caption lines from the transcript, split by speaker and sentence", () => {
    const w: TranscriptWord[] = [["hi", 1, 1.2, "S1"], ["there.", 1.3, 1.6, "S1"], ["yo", 2, 2.2, "S2"],
      ["what", 2.3, 2.5, "S2"], ["up", 2.6, 2.8, "S1"], ["late", 9, 9.2, "S1"]];
    const lines = captionsFor(w, 1, 5);
    expect(lines.map((l) => [l.text, l.speaker])).toEqual([["hi there.", "S1"], ["yo what", "S2"], ["up", "S1"]]);
  });

  it("keeps transcript captions outside the edited stretch (after extending the clip)", () => {
    const clip = { clip_metadata: { custom_captions: { range: [0, 3], items: [{ text: "Edited!", start: 1, end: 2 }] } } } as unknown as ClipApiResponse;
    const w: TranscriptWord[] = [["a", 1, 1.5, null], ["later.", 6, 6.5, null]];
    expect(captionsFor(w, 0, 8, clip).map((l) => l.text)).toEqual(["Edited!", "later."]);
  });

  it("keeps links whose file didn't change", () => {
    const a = { id: "1", storage_url: "/s/x.mp4?sig=1", thumbnail_url: "/s/t.jpg?sig=1" } as ClipApiResponse;
    const b = { id: "1", storage_url: "/s/x.mp4?sig=2", thumbnail_url: "/s/t2.jpg?sig=2" } as ClipApiResponse;
    expect(keepLinks([a], [b])[0]).toMatchObject({ storage_url: "/s/x.mp4?sig=1", thumbnail_url: "/s/t2.jpg?sig=2" });
  });

  it("uses edited captions when the clip has them", () => {
    const clip = { clip_metadata: { custom_captions: { range: [0, 9], items: [{ text: "Edited!", start: 0.5, end: 3 }] } } } as unknown as ClipApiResponse;
    expect(captionsFor([["x", 1, 2, "S2"]], 1, 5, clip)).toEqual([{ text: "Edited!", start: 1, end: 3, speaker: "S2" }]);
  });

  it("only colours captions with 2+ speakers and colours on", () => {
    const sp = { colors: true, list: [{ id: "S1", name: null, color: "#fff" }, { id: "S2", name: null, color: "#0af" }] };
    expect(speakerColor(sp, "S2")).toBe("#0af");
    expect(speakerColor({ ...sp, colors: false }, "S2")).toBeNull();
    expect(speakerColor({ colors: true, list: [sp.list[0]] }, "S1")).toBeNull();
  });
});
