import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getTranscript, getVideoInfo, YoutubeError } from "./youtube.js";

const ID = "dQw4w9WgXcQ";

const PLAYER = {
  videoDetails: {
    videoId: ID,
    title: "A talk",
    author: "A channel",
    lengthSeconds: "3700",
    viewCount: "12345",
    shortDescription: "What the talk covers.",
    isLiveContent: false,
  },
  playabilityStatus: { status: "OK" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr",
          languageCode: "en",
          kind: "asr",
          name: { simpleText: "English (auto)" },
        },
      ],
    },
  },
};

const CAPTIONS = {
  events: [
    { tStartMs: 0, segs: [{ utf8: "welcome to the talk" }] },
    { tStartMs: 65_000, segs: [{ utf8: "the main point" }] },
  ],
};

/** A fetcher serving the two requests the server is allowed to make. */
function fakeFetch(
  requested: string[],
  overrides: { player?: unknown; captionsBody?: string } = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
    requested.push(url);
    if (url === "https://www.youtube.com/youtubei/v1/player") {
      // The id travels in the POST body — the endpoint is fixed.
      assert.equal(init?.method, "POST");
      assert.equal((JSON.parse(String(init?.body)) as { videoId: string }).videoId, ID);
      return new Response(JSON.stringify(overrides.player ?? PLAYER), { status: 200 });
    }
    if (url.startsWith("https://www.youtube.com/api/timedtext")) {
      assert.match(url, /fmt=json3/);
      return new Response(overrides.captionsBody ?? JSON.stringify(CAPTIONS), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

test("video info is one player request and reports the transcript languages", async () => {
  const requested: string[] = [];
  const { videoId, body } = await getVideoInfo(`https://youtu.be/${ID}`, fakeFetch(requested));
  assert.equal(videoId, ID);
  assert.equal(requested.length, 1);
  assert.match(body, /Title: A talk/);
  assert.match(body, /Duration: 1:01:40/);
  assert.match(body, /Views: 12,345/);
  assert.match(body, /Transcript languages: en \(auto\)/);
  assert.match(body, /What the talk covers\./);
});

test("a transcript arrives as timestamped lines under a metadata header", async () => {
  const requested: string[] = [];
  const { body, note } = await getTranscript(ID, undefined, fakeFetch(requested));
  assert.equal(requested.length, 2);
  assert.match(body, /Language: en \(auto\)/);
  assert.match(body, /\[0:00\] welcome to the talk/);
  assert.match(body, /\[1:05\] the main point/);
  assert.match(note ?? "", /auto-generated en captions/);
});

test("a caption URL pointing off youtube.com is refused, wherever it came from", async () => {
  const offHost = structuredClone(PLAYER);
  offHost.captions.playerCaptionsTracklistRenderer.captionTracks[0]!.baseUrl =
    "https://evil.example.com/api/timedtext";
  await assert.rejects(
    getTranscript(ID, undefined, fakeFetch([], { player: offHost })),
    (error: unknown) => {
      assert.ok(error instanceof YoutubeError);
      assert.match(error.message, /points off youtube\.com/);
      return true;
    },
  );
});

test("an empty caption body is named for what it is, not a JSON error", async () => {
  // The web client's token-gated URLs fail exactly this way: a 200 with
  // nothing in it. If the Android client ever grows the same gate, the error
  // should say so rather than send an operator to debug JSON.
  await assert.rejects(
    getTranscript(ID, undefined, fakeFetch([], { captionsBody: "" })),
    /empty caption response/,
  );
});

test("an unplayable video reports YouTube's reason instead of an empty transcript", async () => {
  const gated = {
    ...PLAYER,
    playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" },
  };
  await assert.rejects(
    getTranscript(ID, undefined, fakeFetch([], { player: gated })),
    /LOGIN_REQUIRED.*confirm your age/,
  );
});

test("what is not a YouTube link fails before anything is fetched", async () => {
  const requested: string[] = [];
  await assert.rejects(
    getVideoInfo("https://example.com/watch?v=" + ID, fakeFetch(requested)),
    /not a YouTube video link/,
  );
  assert.equal(requested.length, 0);
});

test("a missing language names the ones that exist", async () => {
  await assert.rejects(
    getTranscript(ID, "ja", fakeFetch([])),
    /no "ja" transcript; available languages: en \(auto\)/,
  );
});
