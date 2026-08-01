/**
 * The two questions this server answers about a YouTube link: what is this
 * video, and what was said in it.
 *
 * The transcript is answered by the innertube `player` endpoint, asked for as
 * the ANDROID client (see `playerResponse.ts` for why the web path is a
 * trap). The metadata rides the same response — unless a Data API key is
 * configured, in which case it moves to the official API and out of reach of
 * the bot gate (see `dataApi.ts`). Neither ever fetches the caller's URL: an
 * id is parsed out of it and every request goes to youtube.com or
 * googleapis.com. The caption payload's own URL is checked against that same
 * boundary — it arrives inside YouTube's response, but "data said so" is not
 * a reason to send a request somewhere new.
 */

import {
  parseCaptionsListResponse,
  parseVideosListResponse,
} from "./dataApi.js";
import {
  describeTrack,
  parsePlayerResponse,
  selectTrack,
  type PlayerData,
} from "./playerResponse.js";
import { formatTimestamp, json3ToTranscript } from "./transcript.js";
import { parseVideoId } from "./videoId.js";

/** A failure the model can react to, as opposed to a bug. */
export class YoutubeError extends Error {
  override name = "YoutubeError";
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Bounds what one tool call returns. Chosen to sit under the 100k-character
 * clip MCP clients commonly apply to a tool result — a cut taken here is
 * reported in the text; one taken by the client is silent.
 */
const MAX_TRANSCRIPT_CHARS = 90_000;
const MAX_DESCRIPTION_CHARS = 2_000;

const PLAYER_ENDPOINT = "https://www.youtube.com/youtubei/v1/player";
const DATA_API_ORIGIN = "https://www.googleapis.com";

/**
 * The clients this server can claim to be, tried in order.
 *
 * One client is not enough in production: YouTube challenges datacenter egress
 * IPs per client (`LOGIN_REQUIRED: Sign in to confirm you're not a bot`), and
 * which client survives varies by IP reputation and time — the same chain
 * yt-dlp walks for the same reason. Android first because its caption URLs are
 * not token-gated; iOS second as a differently-treated primary surface; the TV
 * embedded player last, because it also answers ERROR for every video whose
 * owner disabled embedding — a real fallback, but one that fails on content
 * the others serve fine. A version YouTube has retired starts failing with an
 * explicit playability error, not silently — bump it here when that day comes.
 */
const CLIENTS: ReadonlyArray<{
  label: string;
  client: Record<string, unknown>;
  thirdParty?: { embedUrl: string };
  userAgent: string;
}> = [
  {
    label: "android",
    client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30 },
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
  },
  {
    label: "ios",
    client: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
    },
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
  },
  {
    label: "tv-embedded",
    client: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0" },
    thirdParty: { embedUrl: "https://www.google.com" },
    userAgent:
      "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/13.0 Safari/605.1.15",
  },
];

function clientHeaders(userAgent: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": userAgent,
    "accept-language": "en-US,en;q=0.9",
  };
}

export interface ToolResult {
  videoId: string;
  body: string;
  /** What was lost or worth knowing — truncation, an auto-generated track, … */
  note?: string;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function requestYoutube(
  fetchImpl: Fetcher,
  url: string,
  init: RequestInit,
  headers: Record<string, string>,
  what: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new YoutubeError(
      timedOut ? `the ${what} request timed out` : `the ${what} request failed`,
    );
  }
  if (!response.ok) {
    throw new YoutubeError(`YouTube answered ${response.status} for the ${what}`);
  }
  return response;
}

/** One client's attempt: the player data, or the refusal to try the next client past. */
async function playerAs(
  clientSpec: (typeof CLIENTS)[number],
  videoId: string,
  fetchImpl: Fetcher,
): Promise<PlayerData> {
  const response = await requestYoutube(
    fetchImpl,
    PLAYER_ENDPOINT,
    {
      method: "POST",
      body: JSON.stringify({
        context: {
          client: { ...clientSpec.client, hl: "en" },
          ...(clientSpec.thirdParty ? { thirdParty: clientSpec.thirdParty } : {}),
        },
        videoId,
      }),
    },
    clientHeaders(clientSpec.userAgent),
    "player request",
  );
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new YoutubeError("YouTube's player response was not JSON");
  }
  const player = parsePlayerResponse(parsed);
  if (!player) {
    throw new YoutubeError("could not read YouTube's player response");
  }
  return player;
}

function requireVideoId(input: string): string {
  const videoId = parseVideoId(input);
  if (!videoId) {
    throw new YoutubeError(
      "not a YouTube video link or id — expected a watch/youtu.be/shorts/live URL " +
        "or an 11-character video id",
    );
  }
  return videoId;
}

async function loadPlayer(
  input: string,
  fetchImpl: Fetcher,
): Promise<{ videoId: string; player: PlayerData; client: (typeof CLIENTS)[number] }> {
  const videoId = requireVideoId(input);
  // Walk the client chain: any non-OK answer is a reason to ask as someone
  // else, because the gates are per client. The first refusal is what gets
  // reported when nobody succeeds — it names the primary client's problem,
  // which is the one an operator should reason from.
  let firstRefusal: YoutubeError | undefined;
  for (const clientSpec of CLIENTS) {
    let player: PlayerData;
    try {
      player = await playerAs(clientSpec, videoId, fetchImpl);
    } catch (error) {
      if (!(error instanceof YoutubeError)) {
        throw error;
      }
      firstRefusal ??= error;
      continue;
    }
    const status = player.playabilityStatus?.status;
    if (status && status !== "OK") {
      const reason = player.playabilityStatus?.reason;
      firstRefusal ??= new YoutubeError(
        `the video is not playable (${status})${reason ? `: ${reason}` : ""}`,
      );
      continue;
    }
    return { videoId, player, client: clientSpec };
  }
  const refusal = firstRefusal ?? new YoutubeError("could not read YouTube's player response");
  const botChallenged = /LOGIN_REQUIRED|confirm you.re not a bot/i.test(refusal.message);
  throw new YoutubeError(
    `${refusal.message} — tried the ${CLIENTS.map((c) => c.label).join(", ")} clients` +
      (botChallenged
        ? ". YouTube is challenging this server's egress IP (datacenter addresses often are);" +
          " the durable fixes are operational — egress with better reputation, or cookies"
        : ""),
  );
}

/** What both metadata roads produce, so the model reads one shape of answer. */
interface VideoInfoFields {
  title?: string;
  author?: string;
  /** Already worded: `live`, `1:01:40`, or `(unknown)`. */
  duration: string;
  publishDate?: string;
  viewCount?: number;
  /** Already worded: `en, ko (auto)`, `none`, or `(could not be listed)`. */
  languages: string;
  description: string;
}

function videoInfoResult(videoId: string, fields: VideoInfoFields): ToolResult {
  const cut = fields.description.length > MAX_DESCRIPTION_CHARS;
  const lines = [
    `Title: ${fields.title ?? "(unknown)"}`,
    `Channel: ${fields.author ?? "(unknown)"}`,
    `Duration: ${fields.duration}`,
    ...(fields.publishDate ? [`Published: ${fields.publishDate}`] : []),
    ...(fields.viewCount !== undefined
      ? [`Views: ${fields.viewCount.toLocaleString("en-US")}`]
      : []),
    `Watch URL: ${watchUrl(videoId)}`,
    `Transcript languages: ${fields.languages}`,
    "",
    "Description:",
    fields.description ? fields.description.slice(0, MAX_DESCRIPTION_CHARS) : "(none)",
  ];
  return {
    videoId,
    body: lines.join("\n"),
    ...(cut ? { note: `description truncated to ${MAX_DESCRIPTION_CHARS} characters` } : {}),
  };
}

async function requestDataApi(fetchImpl: Fetcher, url: string, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new YoutubeError(
      timedOut ? `the ${what} request timed out` : `the ${what} request failed`,
    );
  }
  if (!response.ok) {
    // The Data API says *why* in the body — a bad key and an exhausted quota
    // are both 403s, and an operator needs to know which. The URL never goes
    // in the message: it carries the key.
    throw new YoutubeError(
      `the Data API answered ${response.status} for the ${what}${await dataApiReason(response)}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new YoutubeError(`the Data API's ${what} response was not JSON`);
  }
}

async function dataApiReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { errors?: Array<{ reason?: string }>; message?: string };
    };
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.message;
    return reason ? ` (${reason})` : "";
  } catch {
    return "";
  }
}

/**
 * The keyed road to the metadata: the official Data API, which datacenter
 * egress IPs are not bot-gated out of. See `dataApi.ts` for why the transcript
 * itself cannot travel this road.
 */
async function videoInfoViaDataApi(
  videoId: string,
  apiKey: string,
  fetchImpl: Fetcher,
): Promise<ToolResult> {
  const key = encodeURIComponent(apiKey);
  const videosUrl =
    `${DATA_API_ORIGIN}/youtube/v3/videos?part=snippet,contentDetails,statistics` +
    `&id=${videoId}&key=${key}`;
  const captionsUrl = `${DATA_API_ORIGIN}/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${key}`;
  // The caption listing costs 50 quota units to the video lookup's 1 and can
  // fail on its own; when it does, one line of the answer degrades rather
  // than the whole answer failing.
  const [videos, captions] = await Promise.all([
    requestDataApi(fetchImpl, videosUrl, "video info"),
    requestDataApi(fetchImpl, captionsUrl, "caption list").catch((error: unknown) => {
      if (error instanceof YoutubeError) {
        return null;
      }
      throw error;
    }),
  ]);
  const listed = parseVideosListResponse(videos);
  if (!listed) {
    throw new YoutubeError("could not read the Data API's video response");
  }
  if ("missing" in listed) {
    throw new YoutubeError("YouTube does not list this video (removed, private, or a wrong id)");
  }
  const info = listed.video;
  const labels = captions === null ? null : parseCaptionsListResponse(captions);
  return videoInfoResult(videoId, {
    ...(info.title ? { title: info.title } : {}),
    ...(info.author ? { author: info.author } : {}),
    duration: info.isLive
      ? "live"
      : info.lengthSeconds
        ? formatTimestamp(info.lengthSeconds * 1000)
        : "(unknown)",
    ...(info.publishDate ? { publishDate: info.publishDate } : {}),
    ...(info.viewCount !== undefined ? { viewCount: info.viewCount } : {}),
    languages:
      labels === null ? "(could not be listed)" : labels.length > 0 ? labels.join(", ") : "none",
    description: info.description,
  });
}

/**
 * Title, channel, duration, dates, and which transcript languages exist.
 *
 * With an API key this is answered by the Data API and never touches
 * innertube — the one tool that can be made immune to the bot gate, is.
 * Keyless, it rides the same player response the transcript path uses.
 */
export async function getVideoInfo(
  input: string,
  fetchImpl: Fetcher = fetch,
  apiKey?: string,
): Promise<ToolResult> {
  if (apiKey) {
    return videoInfoViaDataApi(requireVideoId(input), apiKey, fetchImpl);
  }
  const { videoId, player } = await loadPlayer(input, fetchImpl);
  return videoInfoResult(videoId, {
    ...(player.title ? { title: player.title } : {}),
    ...(player.author ? { author: player.author } : {}),
    duration: player.isLive
      ? "live"
      : player.lengthSeconds
        ? formatTimestamp(player.lengthSeconds * 1000)
        : "(unknown)",
    ...(player.publishDate ? { publishDate: player.publishDate } : {}),
    ...(player.viewCount !== undefined ? { viewCount: player.viewCount } : {}),
    languages:
      player.tracks.length > 0 ? player.tracks.map(describeTrack).join(", ") : "none",
    description: player.shortDescription ?? "",
  });
}

/** The transcript as timestamped lines, from the best track for `language`. */
export async function getTranscript(
  input: string,
  language: string | undefined,
  fetchImpl: Fetcher = fetch,
): Promise<ToolResult> {
  const { videoId, player, client } = await loadPlayer(input, fetchImpl);
  const track = selectTrack(player.tracks, language);
  if ("error" in track) {
    throw new YoutubeError(track.error);
  }
  // The caption URL arrives inside YouTube's response, not from the caller —
  // but it is still data, and data does not get to point this server at a new
  // host.
  let captionsUrl: URL;
  try {
    captionsUrl = new URL(track.baseUrl);
  } catch {
    throw new YoutubeError("the caption track carries an unusable URL");
  }
  const host = captionsUrl.hostname.toLowerCase();
  if (host !== "youtube.com" && !host.endsWith(".youtube.com")) {
    throw new YoutubeError(`the caption track points off youtube.com (${host}); refusing`);
  }
  captionsUrl.searchParams.set("fmt", "json3");
  const raw = await (
    // The same identity that won the player request: a caption URL is issued
    // to the client that asked, and mixing identities re-invites the gate.
    await requestYoutube(
      fetchImpl,
      captionsUrl.href,
      { method: "GET" },
      clientHeaders(client.userAgent),
      "caption track",
    )
  ).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The shape the web client's URLs fail in — an empty 200 — named for what
    // it is, so an operator reading the log is not sent to debug JSON.
    throw new YoutubeError(
      raw.trim() === ""
        ? "YouTube returned an empty caption response (the track may be token-gated)"
        : "the caption track did not return the expected format",
    );
  }
  const { text, note } = json3ToTranscript(parsed, MAX_TRANSCRIPT_CHARS);
  if (!text) {
    throw new YoutubeError(note ?? "the caption track holds no text");
  }
  const trackNote =
    track.kind === "asr" ? `auto-generated ${track.languageCode} captions` : undefined;
  const notes = [trackNote, note].filter((part): part is string => Boolean(part)).join("; ");
  const header = [
    `Title: ${player.title ?? "(unknown)"}`,
    `Channel: ${player.author ?? "(unknown)"}`,
    `Language: ${describeTrack(track)}`,
    "",
  ].join("\n");
  return { videoId, body: header + text, ...(notes ? { note: notes } : {}) };
}
