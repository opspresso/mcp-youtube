/**
 * An MCP server that turns a YouTube link into something a model can read: the
 * video's transcript, or its metadata.
 *
 * It exists because a link is not its contents. An agent handed a YouTube URL
 * cannot summarise the video, quote it, or say where a claim was made — the
 * words were never in hand. This closes that gap, and only that gap.
 *
 * **The protocol comes from the SDK.** It used to be implemented here by hand,
 * on the grounds that the surface was four JSON-RPC methods and an SDK whose
 * schema generation shifts underneath is the dependency most likely to break a
 * server like this. Revision `2026-07-28` ended that trade: it removed the
 * `initialize` handshake and added a per-request `_meta` envelope,
 * `server/discover`, `resultType` on every result, the `ttlMs`/`cacheScope`
 * caching hints the list verbs now require, `Mcp-Param-*` mirroring from a
 * tool's own schema, and multi round-trip results. Four methods became a moving
 * surface, and keeping up with it by hand is the larger risk now.
 *
 * The SDK serves both eras from one endpoint (`legacy: 'stateless'`, its
 * default), so a 2025-era client keeps working while a 2026-07-28 one gets the
 * new shape. What stays here is what the SDK has no opinion about: the health
 * probe, the shared-secret gate, and the routing between them.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { authorizes, describeAuth } from "./auth.js";
import { buildServer } from "./mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const PORT = Number(process.env.PORT ?? 3000);
/** Shared secret callers must present. Unset means no authentication — see `auth.ts`. */
const API_KEY = process.env.MCP_API_KEY;
const mcp = toNodeHandler(
  createMcpHandler(buildServer, {
    onerror: (error) => console.warn(`mcp: ${error.message}`),
  }),
);

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage): boolean {
  return authorizes(API_KEY, request.headers.authorization);
}

const server = createServer((request, response) => {
  void (async () => {
    // On the path alone: a probe or a proxy is free to append a query string,
    // and matching the whole target turned `/health?x=1` into a 404.
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    if (path === "/health") {
      send(response, 200, { status: "ok" });
      return;
    }
    if (!path.startsWith("/mcp")) {
      send(response, 404, { error: "not found" });
      return;
    }
    // Ahead of the handler, because the shared secret is this deployment's
    // gate rather than the protocol's: an unauthorized caller should not reach
    // the point where a server instance is built for it.
    if (!authorized(request)) {
      send(response, 401, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "missing or invalid bearer token" },
      });
      return;
    }
    await mcp(request, response);
  })();
});

server.listen(PORT, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on :${PORT} (POST /mcp)`);
  // Always, not only when open: an operator reading logs to find out which mode
  // an instance is in should not have to infer it from a line that is missing.
  const notice = describeAuth(API_KEY);
  if (API_KEY) {
    console.log(notice);
  } else {
    console.warn(notice);
  }
  // Which road metadata takes, stated like the auth mode is: an operator
  // asking "why is get_video_info bot-gated" should find the answer here.
  console.log(
    process.env.YOUTUBE_API_KEY
      ? "get_video_info: YouTube Data API v3 (keyed)"
      : "get_video_info: innertube (no YOUTUBE_API_KEY; datacenter egress may hit the bot gate)",
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
