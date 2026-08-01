/**
 * Reading YouTube's player response.
 *
 * The response comes from the innertube `player` endpoint — the same JSON the
 * app itself boots from, holding the video's details and its caption track
 * list. Asked for as the ANDROID client on purpose: the web client's caption
 * URLs are gated behind a proof-of-origin token and answer an *empty 200*
 * without one, while the Android client's URLs still serve the captions. The
 * failure mode that forced this is worth remembering: not an error, a success
 * with nothing in it.
 */

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** `"asr"` marks an auto-generated track; absent means human-provided. */
  kind?: string;
  label: string;
}

export interface PlayerData {
  videoId?: string;
  title?: string;
  author?: string;
  lengthSeconds?: number;
  viewCount?: number;
  shortDescription?: string;
  publishDate?: string;
  isLive?: boolean;
  /** Non-OK means the video will not play: private, removed, age-gated, … */
  playabilityStatus?: { status?: string; reason?: string };
  tracks: CaptionTrack[];
}

/** The slice of the player response this server actually reads, typed loosely on purpose. */
export function parsePlayerResponse(parsed: unknown): PlayerData | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const response = parsed as {
    videoDetails?: {
      videoId?: string;
      title?: string;
      author?: string;
      lengthSeconds?: string;
      viewCount?: string;
      shortDescription?: string;
      isLiveContent?: boolean;
    };
    microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
    playabilityStatus?: { status?: string; reason?: string };
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{
          baseUrl?: string;
          languageCode?: string;
          kind?: string;
          name?: { simpleText?: string; runs?: Array<{ text?: string }> };
        }>;
      };
    };
  };
  const details = response.videoDetails ?? {};
  const rawTracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const tracks: CaptionTrack[] = [];
  for (const raw of rawTracks) {
    if (!raw.baseUrl || !raw.languageCode) {
      continue;
    }
    tracks.push({
      baseUrl: raw.baseUrl,
      languageCode: raw.languageCode,
      ...(raw.kind ? { kind: raw.kind } : {}),
      label:
        raw.name?.simpleText ??
        raw.name?.runs?.map((run) => run.text ?? "").join("") ??
        raw.languageCode,
    });
  }
  return {
    ...(details.videoId ? { videoId: details.videoId } : {}),
    ...(details.title ? { title: details.title } : {}),
    ...(details.author ? { author: details.author } : {}),
    ...(details.lengthSeconds ? { lengthSeconds: Number(details.lengthSeconds) } : {}),
    ...(details.viewCount ? { viewCount: Number(details.viewCount) } : {}),
    ...(details.shortDescription ? { shortDescription: details.shortDescription } : {}),
    ...(details.isLiveContent !== undefined ? { isLive: details.isLiveContent } : {}),
    ...(response.microformat?.playerMicroformatRenderer?.publishDate
      ? { publishDate: response.microformat.playerMicroformatRenderer.publishDate }
      : {}),
    ...(response.playabilityStatus ? { playabilityStatus: response.playabilityStatus } : {}),
    tracks,
  };
}

/** `en (auto)` for an asr track, `en` otherwise — how a track is named to the model. */
export function describeTrack(track: CaptionTrack): string {
  return track.kind === "asr" ? `${track.languageCode} (auto)` : track.languageCode;
}

/**
 * Which track a transcript request means.
 *
 * With a language: its tracks, a human-made one before an auto-generated one —
 * `en` also matches `en-US` and `en-GB`, because a caller asking for English
 * is not asking about YouTube's regional suffixes. Without one: the first
 * human-made track, else the first track. The failure message carries what
 * *was* available, so the model's next call can succeed instead of guessing.
 */
export function selectTrack(
  tracks: CaptionTrack[],
  language: string | undefined,
): CaptionTrack | { error: string } {
  if (tracks.length === 0) {
    return { error: "this video has no captions and no auto-generated transcript" };
  }
  const preferHuman = (candidates: CaptionTrack[]): CaptionTrack | undefined =>
    candidates.find((track) => track.kind !== "asr") ?? candidates[0];
  if (!language) {
    const track = preferHuman(tracks);
    return track ?? { error: "this video has no usable caption track" };
  }
  const wanted = language.trim().toLowerCase();
  const matches = tracks.filter((track) => {
    const code = track.languageCode.toLowerCase();
    return code === wanted || code.startsWith(`${wanted}-`);
  });
  const track = matches.length > 0 ? preferHuman(matches) : undefined;
  if (track) {
    return track;
  }
  const available = tracks.map(describeTrack).join(", ");
  return { error: `no "${language}" transcript; available languages: ${available}` };
}
