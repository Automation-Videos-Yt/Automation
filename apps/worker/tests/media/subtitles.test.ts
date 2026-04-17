import { describe, expect, it } from "vitest";
import { segmentWordTimestamps } from "../../src/media/subtitles";

describe("segmentWordTimestamps", () => {
  it("splits on sentence boundaries and pauses", () => {
    const segments = segmentWordTimestamps({
      words: [
        { word: "Hello.", start: 0, end: 0.3 },
        { word: "This", start: 0.35, end: 0.6 },
        { word: "is", start: 0.6, end: 0.75 },
        { word: "new", start: 0.75, end: 0.95 },
        { word: "sentence.", start: 0.95, end: 1.2 },
        { word: "Pause", start: 1.7, end: 1.9 },
        { word: "break", start: 1.9, end: 2.2 },
        { word: "works", start: 2.2, end: 2.5 },
      ],
      transcriptText: "Hello. This is new sentence. Pause break works.",
    });

    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0]?.text).toContain("Hello.");
    expect(segments.some((segment) => segment.text.includes("Pause break"))).toBe(true);
  });
});
