/**
 * A YouTube link is many shapes for one thing: an 11-character video id. This
 * is the single place that knows the shapes, because everything downstream —
 * the watch-page fetch, the transcript request, the URL echoed back to the
 * model — wants the id and nothing else.
 *
 * Parsing the id here is also the outbound security boundary: the server never
 * fetches the caller's URL. It extracts an id from it and talks only to
 * youtube.com, so there is no address a model could steer a request to.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube-nocookie.com",
]);

/** Path prefixes whose next segment is the id: /shorts/ID, /embed/ID, … */
const ID_PATH_PREFIXES = ["/shorts/", "/embed/", "/live/", "/v/"];

/**
 * The video id in `input`, or null when there is none. Accepts a watch URL in
 * its usual disguises (`watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/`),
 * and a bare 11-character id — a model that already extracted one should not
 * have to dress it back up as a URL.
 */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (VIDEO_ID.test(trimmed)) {
    return trimmed;
  }
  let url: URL;
  try {
    // A pasted link often arrives without a scheme; a URL parser refuses it.
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") {
    return idOrNull(url.pathname.split("/")[1]);
  }
  if (!YOUTUBE_HOSTS.has(host)) {
    return null;
  }
  if (url.pathname === "/watch") {
    return idOrNull(url.searchParams.get("v"));
  }
  for (const prefix of ID_PATH_PREFIXES) {
    if (url.pathname.startsWith(prefix)) {
      return idOrNull(url.pathname.slice(prefix.length).split("/")[0]);
    }
  }
  return null;
}

function idOrNull(candidate: string | null | undefined): string | null {
  return candidate && VIDEO_ID.test(candidate) ? candidate : null;
}
