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

/**
 * A fetcher serving the requests the server is allowed to make. `playerFor`
 * answers per innertube client name, so a test can gate one client and let
 * the next one through — the exact shape of the production failure.
 */
function fakeFetch(
  requested: string[],
  overrides: {
    player?: unknown;
    playerFor?: Record<string, unknown>;
    captionsBody?: string;
  } = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
    if (url === "https://www.youtube.com/youtubei/v1/player") {
      // The id travels in the POST body — the endpoint is fixed.
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as {
        videoId: string;
        context: { client: { clientName: string } };
      };
      assert.equal(body.videoId, ID);
      const clientName = body.context.client.clientName;
      requested.push(`player:${clientName}`);
      const player = overrides.playerFor?.[clientName] ?? overrides.player ?? PLAYER;
      return new Response(JSON.stringify(player), { status: 200 });
    }
    requested.push(url);
    if (url.startsWith("https://www.youtube.com/api/timedtext")) {
      assert.match(url, /fmt=json3/);
      return new Response(overrides.captionsBody ?? JSON.stringify(CAPTIONS), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

const BOT_GATED = {
  ...PLAYER,
  playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" },
};

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

test("a client the bot gate refuses is walked past, not surrendered to", async () => {
  // The production failure: a datacenter egress IP gets LOGIN_REQUIRED from
  // the primary client while another client still answers.
  const requested: string[] = [];
  const { body } = await getTranscript(
    ID,
    undefined,
    fakeFetch(requested, { playerFor: { ANDROID: BOT_GATED } }),
  );
  assert.deepEqual(requested.slice(0, 2), ["player:ANDROID", "player:IOS"]);
  assert.match(body, /\[0:00\] welcome to the talk/);
});

test("when every client is refused, the error names them and the egress IP", async () => {
  await assert.rejects(getTranscript(ID, undefined, fakeFetch([], { player: BOT_GATED })), (error: unknown) => {
    assert.ok(error instanceof YoutubeError);
    assert.match(error.message, /LOGIN_REQUIRED/);
    assert.match(error.message, /tried the android, ios, tv-embedded clients/);
    assert.match(error.message, /egress IP/);
    return true;
  });
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

const VIDEOS_LIST = {
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
};

const CAPTIONS_LIST = { items: [{ snippet: { language: "en", trackKind: "asr" } }] };

/** A fetcher answering only as the Data API — innertube traffic is a failure. */
function fakeDataApi(
  requested: string[],
  overrides: { videos?: unknown; videosStatus?: number; captionsStatus?: number } = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const refusal = JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } });
  return async (url: string) => {
    const parsed = new URL(url);
    requested.push(parsed.pathname);
    assert.equal(parsed.origin, "https://www.googleapis.com");
    assert.equal(parsed.searchParams.get("key"), "test-key");
    if (parsed.pathname === "/youtube/v3/videos") {
      assert.equal(parsed.searchParams.get("id"), ID);
      if (overrides.videosStatus) {
        return new Response(refusal, { status: overrides.videosStatus });
      }
      return new Response(JSON.stringify(overrides.videos ?? VIDEOS_LIST), { status: 200 });
    }
    if (parsed.pathname === "/youtube/v3/captions") {
      assert.equal(parsed.searchParams.get("videoId"), ID);
      if (overrides.captionsStatus) {
        return new Response(refusal, { status: overrides.captionsStatus });
      }
      return new Response(JSON.stringify(CAPTIONS_LIST), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

test("with a Data API key, video info never touches innertube", async () => {
  const requested: string[] = [];
  const { videoId, body } = await getVideoInfo(
    `https://youtu.be/${ID}`,
    fakeDataApi(requested),
    "test-key",
  );
  assert.equal(videoId, ID);
  assert.deepEqual([...requested].sort(), ["/youtube/v3/captions", "/youtube/v3/videos"]);
  assert.match(body, /Title: A talk/);
  assert.match(body, /Channel: A channel/);
  assert.match(body, /Duration: 1:01:40/);
  assert.match(body, /Published: 2024-05-01/);
  assert.match(body, /Views: 12,345/);
  assert.match(body, /Transcript languages: en \(auto\)/);
  assert.match(body, /What the talk covers\./);
});

test("a caption-listing failure degrades one line, not the answer", async () => {
  const { body } = await getVideoInfo(ID, fakeDataApi([], { captionsStatus: 403 }), "test-key");
  assert.match(body, /Title: A talk/);
  assert.match(body, /Transcript languages: \(could not be listed\)/);
});

test("a video the Data API does not list is named as missing", async () => {
  await assert.rejects(
    getVideoInfo(ID, fakeDataApi([], { videos: { items: [] } }), "test-key"),
    /does not list this video/,
  );
});

test("a Data API refusal carries the reason, never the key", async () => {
  await assert.rejects(
    getVideoInfo(ID, fakeDataApi([], { videosStatus: 403 }), "test-key"),
    (error: unknown) => {
      assert.ok(error instanceof YoutubeError);
      assert.match(error.message, /403.*quotaExceeded/);
      assert.doesNotMatch(error.message, /test-key/);
      return true;
    },
  );
});
