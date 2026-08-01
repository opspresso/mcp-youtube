/**
 * The two questions this server answers about a YouTube link: what is this
 * video, and what was said in it.
 *
 * Both are answered by the innertube `player` endpoint, asked for as the
 * ANDROID client (see `playerResponse.ts` for why the web path is a trap).
 * Neither ever fetches the caller's URL: an id is parsed out of it and every
 * request goes to youtube.com. The caption payload's own URL is checked
 * against that same boundary — it arrives inside YouTube's response, but
 * "data said so" is not a reason to send a request somewhere new.
 */

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
/**
 * The client this server claims to be. A version YouTube has retired starts
 * failing with an explicit playability error, not silently — bump it here
 * when that day comes.
 */
const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30 };
const ANDROID_HEADERS = {
  "content-type": "application/json",
  "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
  "accept-language": "en-US,en;q=0.9",
} as const;

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
  what: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: ANDROID_HEADERS,
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

async function loadPlayer(
  input: string,
  fetchImpl: Fetcher,
): Promise<{ videoId: string; player: PlayerData }> {
  const videoId = parseVideoId(input);
  if (!videoId) {
    throw new YoutubeError(
      "not a YouTube video link or id — expected a watch/youtu.be/shorts/live URL " +
        "or an 11-character video id",
    );
  }
  const response = await requestYoutube(
    fetchImpl,
    PLAYER_ENDPOINT,
    {
      method: "POST",
      body: JSON.stringify({ context: { client: { ...ANDROID_CLIENT, hl: "en" } }, videoId }),
    },
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
  const status = player.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = player.playabilityStatus?.reason;
    throw new YoutubeError(
      `the video is not playable (${status})${reason ? `: ${reason}` : ""}`,
    );
  }
  return { videoId, player };
}

/** Title, channel, duration, dates, and which transcript languages exist. */
export async function getVideoInfo(
  input: string,
  fetchImpl: Fetcher = fetch,
): Promise<ToolResult> {
  const { videoId, player } = await loadPlayer(input, fetchImpl);
  const description = player.shortDescription ?? "";
  const cut = description.length > MAX_DESCRIPTION_CHARS;
  const lines = [
    `Title: ${player.title ?? "(unknown)"}`,
    `Channel: ${player.author ?? "(unknown)"}`,
    `Duration: ${
      player.isLive ? "live" : player.lengthSeconds ? formatTimestamp(player.lengthSeconds * 1000) : "(unknown)"
    }`,
    ...(player.publishDate ? [`Published: ${player.publishDate}`] : []),
    ...(player.viewCount !== undefined
      ? [`Views: ${player.viewCount.toLocaleString("en-US")}`]
      : []),
    `Watch URL: ${watchUrl(videoId)}`,
    `Transcript languages: ${
      player.tracks.length > 0 ? player.tracks.map(describeTrack).join(", ") : "none"
    }`,
    "",
    "Description:",
    description ? description.slice(0, MAX_DESCRIPTION_CHARS) : "(none)",
  ];
  return {
    videoId,
    body: lines.join("\n"),
    ...(cut ? { note: `description truncated to ${MAX_DESCRIPTION_CHARS} characters` } : {}),
  };
}

/** The transcript as timestamped lines, from the best track for `language`. */
export async function getTranscript(
  input: string,
  language: string | undefined,
  fetchImpl: Fetcher = fetch,
): Promise<ToolResult> {
  const { videoId, player } = await loadPlayer(input, fetchImpl);
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
    await requestYoutube(fetchImpl, captionsUrl.href, { method: "GET" }, "caption track")
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
