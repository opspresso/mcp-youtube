import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatTimestamp, json3ToTranscript } from "./transcript.js";

test("timestamps render the way YouTube shows them", () => {
  assert.equal(formatTimestamp(0), "0:00");
  assert.equal(formatTimestamp(59_999), "0:59");
  assert.equal(formatTimestamp(61_000), "1:01");
  assert.equal(formatTimestamp(3_599_000), "59:59");
  assert.equal(formatTimestamp(3_600_000), "1:00:00");
  assert.equal(formatTimestamp(7_265_000), "2:01:05");
  assert.equal(formatTimestamp(-5), "0:00");
});

test("events become timestamped lines; empty and whitespace events vanish", () => {
  const { text, note } = json3ToTranscript(
    {
      events: [
        { tStartMs: 0, segs: [{ utf8: "hello " }, { utf8: "world" }] },
        { tStartMs: 1500 }, // a timing-only event, common in asr streams
        { tStartMs: 2000, segs: [{ utf8: "\n" }] },
        { tStartMs: 61_000, segs: [{ utf8: "second  line" }] },
      ],
    },
    10_000,
  );
  assert.equal(text, "[0:00] hello world\n[1:01] second line");
  assert.equal(note, undefined);
});

test("a cut is reported, never taken silently", () => {
  const events = Array.from({ length: 100 }, (_, i) => ({
    tStartMs: i * 1000,
    segs: [{ utf8: `line number ${i}` }],
  }));
  const { text, note } = json3ToTranscript({ events }, 200);
  assert.ok(text.length <= 200);
  assert.ok(note, "expected a truncation note");
  assert.match(note, /truncated/);
  assert.match(note, /of 100 lines kept/);
  assert.match(note, /ending at \[0:0\d\]/);
});

test("an empty or alien payload is an answer about the track, not a crash", () => {
  assert.equal(json3ToTranscript({ events: [] }, 100).note, "the caption track exists but holds no text");
  assert.equal(json3ToTranscript(null, 100).note, "the caption track exists but holds no text");
  assert.equal(json3ToTranscript("nonsense", 100).note, "the caption track exists but holds no text");
});
