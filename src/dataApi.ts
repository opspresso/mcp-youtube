/**
 * Reading the YouTube Data API v3's answers.
 *
 * `get_video_info` prefers this surface when a key is configured: it is the
 * official, keyed road to the same metadata the innertube player response
 * carries, and — unlike innertube — it does not sit behind the bot gate that
 * datacenter egress IPs run into (`LOGIN_REQUIRED`). What it cannot replace is
 * caption *content*: downloading a track needs OAuth and ownership of the
 * video, so the transcript path stays on innertube. Listing which tracks exist
 * is allowed with a key, at 50 quota units to the video lookup's 1.
 *
 * Only parsing lives here; the requests are made in `youtube.ts`, where the
 * timeout and error conventions already are.
 */

export interface DataApiVideoInfo {
  title?: string;
  author?: string;
  lengthSeconds?: number;
  viewCount?: number;
  description: string;
  publishDate?: string;
  isLive?: boolean;
}

/**
 * `PT1H2M3S` (or `P1DT…`) as whole seconds; null when the shape is not an
 * ISO 8601 duration. A live stream's placeholder `P0D` parses to 0 — the
 * caller treats that as "no known length", which is what it means.
 */
export function parseIsoDuration(iso: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!match) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

/**
 * The slice of a `videos.list` response this server reads. `missing` is the
 * API's way of saying the id names nothing it will admit to — removed,
 * private, or never real — which arrives as a 200 with an empty `items`, not
 * as an error status.
 */
export function parseVideosListResponse(
  parsed: unknown,
): { video: DataApiVideoInfo } | { missing: true } | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  if (items.length === 0) {
    return { missing: true };
  }
  const item = items[0] as {
    snippet?: {
      title?: string;
      channelTitle?: string;
      description?: string;
      publishedAt?: string;
      liveBroadcastContent?: string;
    };
    contentDetails?: { duration?: string };
    statistics?: { viewCount?: string };
  };
  if (!item || typeof item !== "object") {
    return null;
  }
  const snippet = item.snippet ?? {};
  const seconds = item.contentDetails?.duration
    ? parseIsoDuration(item.contentDetails.duration)
    : null;
  return {
    video: {
      ...(snippet.title ? { title: snippet.title } : {}),
      ...(snippet.channelTitle ? { author: snippet.channelTitle } : {}),
      ...(seconds ? { lengthSeconds: seconds } : {}),
      // viewCount is absent when the channel hides it — absent, not zero.
      ...(item.statistics?.viewCount ? { viewCount: Number(item.statistics.viewCount) } : {}),
      description: snippet.description ?? "",
      // The full timestamp, cut to the date: what the innertube path shows,
      // and the precision a "when was this published" answer actually needs.
      ...(snippet.publishedAt ? { publishDate: snippet.publishedAt.slice(0, 10) } : {}),
      ...(snippet.liveBroadcastContent === "live" ? { isLive: true } : {}),
    },
  };
}

/**
 * A `captions.list` response as the track labels the innertube path would
 * show — `en (auto)` for a machine-made track, `en` otherwise — so the model
 * reads one vocabulary whichever road answered. Null means the response was
 * not readable as a caption list at all.
 */
export function parseCaptionsListResponse(parsed: unknown): string[] | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  const labels: string[] = [];
  for (const raw of items) {
    const snippet = (raw as { snippet?: { language?: string; trackKind?: string } } | null)
      ?.snippet;
    if (!snippet?.language) {
      continue;
    }
    labels.push(
      snippet.trackKind?.toLowerCase() === "asr" ? `${snippet.language} (auto)` : snippet.language,
    );
  }
  return labels;
}
