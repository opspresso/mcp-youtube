/**
 * What this process says about itself.
 *
 * It exists because of where the errors go otherwise. A caption track that is
 * missing, a bot gate, a Data API quota — every one of them is caught in
 * `mcp.ts` and turned into a sentence for the *model*, which reacts to it and
 * carries on. That is the right behaviour for the run and a dead end for the
 * operator: the pod logs stay empty while every lookup fails, and the only
 * trace of it is inside a conversation nobody is reading.
 *
 * The same silence hides the healthy case. A pod that answers every call and
 * one that nobody calls look identical from the outside, so every tool call is
 * written down as well — which tool, for which video, how long it took and
 * whether it answered — and "videos started failing on Tuesday" has evidence
 * behind it.
 *
 * One JSON line per event, so a log collector can index it without a parser and
 * a human can still read it. Failures go to stderr, the rest to stdout.
 *
 * **What must never appear here.** The input is arbitrary text a model wrote,
 * and a transcript is third-party content the caller asked for. Neither is
 * needed to diagnose anything — a failing lookup is identified by the tool and
 * the video id. Nothing in this module accepts more, which is the only reliable
 * way to keep the rest out.
 */

/** The fields a caller may attach. Deliberately not `unknown` — see the module note. */
export interface LogContext {
  tool?: string;
  /** The 11-character id, never the URL or the raw input. */
  videoId?: string;
  /** How long the call took, in whole milliseconds. */
  ms?: number;
  /** Whether the tool answered, or refused with `isError`. */
  ok?: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Record something that happened, as opposed to something that went wrong.
 *
 * `event` names the site, as it does for `logError`, so that one search finds
 * every line of one kind.
 */
export function logInfo(event: string, context: LogContext = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...context }));
}

/**
 * Report a failure the caller is otherwise about to swallow.
 *
 * Two levels, by whose problem it is. A refusal written for the model — a
 * format this does not read, a video with no captions — is `warn`: expected,
 * and the model reacts to it. Anything else is a bug or a dependency failing,
 * and is `error`, which is the level an operator alerts on.
 *
 * `event` names the site rather than the error, so that a log search finds
 * every occurrence of one problem regardless of what YouTube called it that day.
 */
export function logError(event: string, error: unknown, context: LogContext = {}): void {
  logFailure("error", event, error, context);
}

/** A refusal the model can act on — see `logError` for the split. */
export function logWarn(event: string, error: unknown, context: LogContext = {}): void {
  logFailure("warn", event, error, context);
}

function logFailure(
  level: "warn" | "error",
  event: string,
  error: unknown,
  context: LogContext,
): void {
  console.error(
    JSON.stringify({
      level,
      event,
      message: messageOf(error),
      ...(error instanceof Error && error.name !== "Error" ? { type: error.name } : {}),
      ...context,
    }),
  );
}

/** Whole milliseconds since a `performance.now()` reading, for a log line. */
export function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}
