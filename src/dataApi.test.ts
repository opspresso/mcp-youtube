import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseCaptionsListResponse,
  parseIsoDuration,
  parseVideosListResponse,
} from "./dataApi.js";

test("ISO 8601 durations parse to seconds, including the day form", () => {
  assert.equal(parseIsoDuration("PT3M32S"), 212);
  assert.equal(parseIsoDuration("PT1H1M40S"), 3700);
  assert.equal(parseIsoDuration("P1DT2H"), 93_600);
  // A live stream's placeholder: zero, not an error.
  assert.equal(parseIsoDuration("P0D"), 0);
  assert.equal(parseIsoDuration("3:32"), null);
  assert.equal(parseIsoDuration(""), null);
});

test("a videos.list item maps onto the fields the tool shows", () => {
  const listed = parseVideosListResponse({
    items: [
      {
        snippet: {
          title: "A talk",
          channelTitle: "A channel",
          description: "What the talk covers.",
          publishedAt: "2024-05-01T12:34:56Z",
          liveBroadcastContent: "none",
        },
        contentDetails: { duration: "PT1H1M40S" },
        statistics: { viewCount: "12345" },
      },
    ],
  });
  assert.ok(listed && "video" in listed);
  assert.deepEqual(listed.video, {
    title: "A talk",
    author: "A channel",
    lengthSeconds: 3700,
    viewCount: 12345,
    description: "What the talk covers.",
    publishDate: "2024-05-01",
  });
});

test("an empty items array means the video is missing, not unreadable", () => {
  assert.deepEqual(parseVideosListResponse({ items: [] }), { missing: true });
  assert.equal(parseVideosListResponse({ error: "nope" }), null);
  assert.equal(parseVideosListResponse("not json we expected"), null);
});

test("hidden view counts stay absent instead of becoming zero", () => {
  const listed = parseVideosListResponse({
    items: [{ snippet: { title: "A talk" }, contentDetails: { duration: "PT10S" } }],
  });
  assert.ok(listed && "video" in listed);
  assert.equal(listed.video.viewCount, undefined);
  assert.equal(listed.video.lengthSeconds, 10);
});

test("a live broadcast is marked live and its P0D length stays unknown", () => {
  const listed = parseVideosListResponse({
    items: [
      {
        snippet: { title: "A stream", liveBroadcastContent: "live" },
        contentDetails: { duration: "P0D" },
      },
    ],
  });
  assert.ok(listed && "video" in listed);
  assert.equal(listed.video.isLive, true);
  assert.equal(listed.video.lengthSeconds, undefined);
});

test("caption tracks list in the same vocabulary the innertube path uses", () => {
  const labels = parseCaptionsListResponse({
    items: [
      { snippet: { language: "en", trackKind: "ASR" } },
      { snippet: { language: "ko", trackKind: "standard" } },
      { snippet: { trackKind: "standard" } }, // no language: skipped, not invented
    ],
  });
  assert.deepEqual(labels, ["en (auto)", "ko"]);
  assert.deepEqual(parseCaptionsListResponse({ items: [] }), []);
  assert.equal(parseCaptionsListResponse({ error: "nope" }), null);
});
