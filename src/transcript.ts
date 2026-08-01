/**
 * Turning YouTube's caption payload into text a model can read.
 *
 * The `json3` format is a list of timed events, each holding text segments —
 * word-level for auto-generated tracks, line-level for human ones. What a
 * summariser needs is neither: readable lines with a timestamp each, so an
 * answer can say *where* in the video a claim was made.
 */

interface Json3Event {
  tStartMs?: number;
  segs?: Array<{ utf8?: string }>;
}

/** `m:ss` under an hour, `h:mm:ss` from there — how YouTube itself shows time. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mmss = `${String(minutes).padStart(hours > 0 ? 2 : 1, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/**
 * The transcript as `[timestamp] line` rows, bounded by `maxChars`.
 *
 * A cut is reported in `note`, never taken silently: a summary of half a video
 * that does not say so is wrong in a way nobody can see.
 */
export function json3ToTranscript(
  data: unknown,
  maxChars: number,
): { text: string; note?: string } {
  const events = ((data as { events?: Json3Event[] })?.events ?? []).filter(
    (event): event is Json3Event => typeof event === "object" && event !== null,
  );
  const lines: string[] = [];
  for (const event of events) {
    const text = (event.segs ?? [])
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      continue;
    }
    lines.push(`[${formatTimestamp(event.tStartMs ?? 0)}] ${text}`);
  }
  if (lines.length === 0) {
    return { text: "", note: "the caption track exists but holds no text" };
  }
  let total = 0;
  let kept = 0;
  for (const line of lines) {
    // +1 for the joining newline; counting it keeps the bound honest.
    const cost = line.length + (kept > 0 ? 1 : 0);
    if (total + cost > maxChars) {
      break;
    }
    total += cost;
    kept += 1;
  }
  const text = lines.slice(0, kept).join("\n");
  if (kept === lines.length) {
    return { text };
  }
  const lastKept = lines[kept - 1];
  const upTo = lastKept ? lastKept.slice(0, lastKept.indexOf("]") + 1) : "";
  return {
    text,
    note:
      `transcript truncated to the ${maxChars.toLocaleString("en-US")}-character limit: ` +
      `${kept.toLocaleString("en-US")} of ${lines.length.toLocaleString("en-US")} lines kept, ` +
      `ending at ${upTo}`,
  };
}
