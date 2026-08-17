# mcp-youtube

An MCP server that turns a YouTube link into something a model can read: the
video's **transcript**, or its **metadata**. A link is not its contents — an
agent handed a YouTube URL cannot summarise the video until the words are in
hand. This closes that gap, and only that gap.

Keyless by default: it asks YouTube's own innertube `player` endpoint — the
JSON the app itself boots from — and the caption endpoint it names. With a
`YOUTUBE_API_KEY` set, `get_video_info` moves onto the official Data API v3
instead, which datacenter egress IPs are not bot-gated out of; transcripts
cannot make that move (caption *download* needs OAuth and video ownership), so
`get_transcript` always rides innertube.

## Tools

| Tool | What it returns |
|---|---|
| `get_transcript` | The captions as `[m:ss] line` rows under a small metadata header. Prefers a human-made track over the auto-generated one; `language` ('en', 'ko', …) narrows, and a miss lists the languages that exist. Bounded at 90,000 characters with the cut reported in the text. |
| `get_video_info` | Title, channel, duration, publish date, view count, description (capped), and which transcript languages exist. |

Both accept a `url` that is any usual link shape — `watch?v=`, `youtu.be/`,
`shorts/`, `embed/`, `live/` — or a bare 11-character video id.

Both wrap their output in an *untrusted content* header: transcripts and
descriptions are third-party text from an address the model chose, and the
provenance is stated at the point of use.

### Outbound boundary

The server never fetches the caller's URL. It parses a video id out of it and
talks only to `youtube.com` (and `googleapis.com` when a Data API key is set);
even the caption URL — which arrives inside YouTube's own page — is refused if
it points anywhere else.

## Protocol

MCP over plain HTTP (`POST /mcp`), served by `@modelcontextprotocol/server`.
**Both protocol eras from one endpoint**: a client that opens with
`server/discover` gets revision `2026-07-28`, and one that opens with the
`initialize` handshake is served statelessly as before. Nothing here holds
state between calls either way.

The protocol used to be implemented here by hand, on the grounds that the
surface was four JSON-RPC methods and an SDK whose schema generation shifts
underneath is the dependency most likely to break a server like this. Revision
`2026-07-28` ended that trade: it removed the handshake and added a per-request
`_meta` envelope, `server/discover`, `resultType` on every result, the
`ttlMs`/`cacheScope` hints the list verbs now require, `Mcp-Param-*` mirroring
from a tool's own schema, and multi round-trip results. Four methods became a
moving surface, and following it by hand is the larger risk now.

`GET /health` answers `200 {"status":"ok"}` for probes.

The process logs one JSON line per event. Every tool call leaves a `tool_call`
line on stdout — the tool, the video id, how long it took and whether it
answered (`ok`) — and a lookup that failed is written to stderr as well, with
YouTube's reason, so "videos started failing on Tuesday" has evidence behind it:
`warn` for a refusal the model can act on (no captions, not playable), `error`
for a bug or a dependency failing. Neither carries the input or the transcript:
the input is arbitrary text a model wrote, and the id is what a failure is
identified by.

    {"level":"info","event":"tool_call","tool":"get_transcript","videoId":"dQw4w9WgXcQ","ms":812,"ok":true}
    {"level":"warn","event":"tool_failed","message":"…","tool":"get_transcript","videoId":"dQw4w9WgXcQ"}

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port. |
| `MCP_API_KEY` | unset | When set, every call must present it as a bearer token. Unset answers **any** caller — safe only while nothing routes to the server from outside the cluster, and the startup log says loudly which mode is active. |
| `YOUTUBE_API_KEY` | unset | A YouTube Data API v3 key. When set, `get_video_info` is answered by the official API instead of innertube — immune to the `LOGIN_REQUIRED` bot gate datacenter IPs run into. Costs quota: 1 unit for the video, 50 for the caption-language listing, against the free 10,000/day. `get_transcript` is unaffected either way. |

## Develop

```bash
npm install
npm run dev        # tsx src/server.ts on :3000
npm test           # node --test via tsx
npm run typecheck
```

Try it:

```bash
curl -s localhost:3000/mcp -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "get_transcript",
              "arguments": { "url": "https://youtu.be/dQw4w9WgXcQ" } }
}'
```

## Deploy

The image is what ships (see `Dockerfile`). CI builds it on every pull request
and push to `main`; a `v*` tag publishes it to ECR + GHCR and then dispatches
the released version to the GitOps repository (`opspresso/argocd-env-demo`),
which rolls out the deploy. The intended deployment is a Deployment behind a
ClusterIP in the `agent-mcps` namespace, beside its siblings `mcp-url-fetch`
and `mcp-memory`.
