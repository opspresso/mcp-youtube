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

MCP over plain HTTP (`POST /mcp`, JSON-RPC 2.0): `initialize`, `tools/list`,
`tools/call`, `ping`. Stateless — `DELETE` (session teardown) is a 204, and
notifications are accepted and dropped. Implemented directly rather than
through an SDK, the same choice `mcp-url-fetch` made: the surface is four
methods, and an SDK whose schema generation shifts underneath is the only
dependency that has actually broken a server like this.

`GET /health` answers `200 {"status":"ok"}` for probes.

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
