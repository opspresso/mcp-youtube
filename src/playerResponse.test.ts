import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  describeTrack,
  parsePlayerResponse,
  selectTrack,
  type CaptionTrack,
} from "./playerResponse.js";

test("the player data keeps what the tools read and drops the rest", () => {
  const data = parsePlayerResponse({
    videoDetails: {
      videoId: "dQw4w9WgXcQ",
      title: "Test video",
      author: "Test channel",
      lengthSeconds: "212",
      viewCount: "1000",
      shortDescription: "About things.",
      isLiveContent: false,
    },
    microformat: { playerMicroformatRenderer: { publishDate: "2009-10-25" } },
    playabilityStatus: { status: "OK" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=en",
            languageCode: "en",
            name: { simpleText: "English" },
          },
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=ko&kind=asr",
            languageCode: "ko",
            kind: "asr",
            name: { runs: [{ text: "Korean " }, { text: "(auto)" }] },
          },
          // A track without a URL is not a track anything can fetch.
          { languageCode: "broken-no-url" },
        ],
      },
    },
  });
  assert.ok(data);
  assert.equal(data.title, "Test video");
  assert.equal(data.lengthSeconds, 212);
  assert.equal(data.publishDate, "2009-10-25");
  assert.equal(data.tracks.length, 2);
  assert.equal(data.tracks[0]?.label, "English");
  assert.equal(data.tracks[1]?.label, "Korean (auto)");
});

test("an alien response is a null, not a crash", () => {
  assert.equal(parsePlayerResponse(null), null);
  assert.equal(parsePlayerResponse("nonsense"), null);
  assert.deepEqual(parsePlayerResponse({})?.tracks, []);
});

const tracks: CaptionTrack[] = [
  { baseUrl: "u1", languageCode: "ko", kind: "asr", label: "Korean (auto)" },
  { baseUrl: "u2", languageCode: "en-US", label: "English (US)" },
  { baseUrl: "u3", languageCode: "en", kind: "asr", label: "English (auto)" },
];

test("track selection prefers a human-made track and matches regional codes", () => {
  // No language: the first human-made track, not the first track.
  assert.equal(selectTrack(tracks, undefined), tracks[1]);
  // "en" reaches en-US, and the human track beats the auto one.
  assert.equal(selectTrack(tracks, "en"), tracks[1]);
  assert.equal(selectTrack(tracks, "EN"), tracks[1]);
  // Only an auto track exists for Korean; it is still an answer.
  assert.equal(selectTrack(tracks, "ko"), tracks[0]);
});

test("a miss names what was available, so the next call can succeed", () => {
  const result = selectTrack(tracks, "ja");
  assert.ok("error" in result);
  assert.match(result.error, /available languages: ko \(auto\), en-US, en \(auto\)/);
  const none = selectTrack([], "en");
  assert.ok("error" in none);
  assert.match(none.error, /no captions/);
});

test("describeTrack marks auto-generated tracks", () => {
  assert.equal(describeTrack(tracks[0]!), "ko (auto)");
  assert.equal(describeTrack(tracks[1]!), "en-US");
});
