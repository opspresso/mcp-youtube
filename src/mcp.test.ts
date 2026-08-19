/**
 * What a client actually sees, over HTTP and a real client.
 *
 * The protocol moved to the SDK, so the thing worth asserting is no longer the
 * shape of a JSON-RPC envelope this repository writes — it is that a client
 * connects and finds the two tools, on **both** eras. This server is reached by
 * clients that speak `2026-07-28` and by clients that still open with the
 * `initialize` handshake, and the SDK serves both from one endpoint; a change
 * that quietly dropped either would look exactly like everything working.
 *
 * Over HTTP rather than an in-memory pair, because the era is decided by the
 * transport: an in-memory link cannot tell the two apart, so it would assert
 * nothing about the endpoint that actually ships.
 */

import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { buildServer } from "./mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

let http: Server;
let url: URL;

before(async () => {
  const handler = toNodeHandler(createMcpHandler(buildServer));
  http = createServer((request, response) => void handler(request, response));
  await new Promise<void>((ready) => http.listen(0, "127.0.0.1", ready));
  url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
});

after(async () => {
  await new Promise<void>((done) => http.close(() => done()));
});

async function connect(mode?: "auto" | "legacy"): Promise<Client> {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    mode ? { versionNegotiation: { mode } } : undefined,
  );
  await client.connect(new StreamableHTTPClientTransport(url), { timeout: 5_000 });
  return client;
}

describe("what a client is offered", () => {
  it("lists both tools with their schemas", async () => {
    const client = await connect("auto");

    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "get_transcript",
      "get_video_info",
    ]);
    const transcript = tools.find((tool) => tool.name === "get_transcript");
    // The schema is generated from the zod definition rather than written out,
    // so this is what says the generation still produces what a model needs:
    // the required argument, and the optional one that is not required.
    assert.equal(transcript?.inputSchema.type, "object");
    assert.deepEqual(transcript?.inputSchema.required, ["url"]);
    assert.ok(
      Object.keys(transcript?.inputSchema.properties ?? {}).includes("language"),
      "get_transcript should accept a language",
    );
    await client.close();
  });

  it("identifies itself with the version that was published", async () => {
    const client = await connect("auto");

    assert.deepEqual(client.getServerVersion(), {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    await client.close();
  });

  it("serves a client that opens with the 2026-07-28 probe", async () => {
    // The era Agent Studio speaks, and the reason this server moved to the SDK.
    const client = await connect("auto");

    assert.equal(client.getProtocolEra(), "modern");
    assert.equal((await client.listTools()).tools.length, 2);
    await client.close();
  });

  it("still serves a client that opens with the handshake", async () => {
    // The era every other client is still on. Dropping it would be invisible
    // until somebody's existing configuration stopped working.
    const client = await connect("legacy");

    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal((await client.listTools()).tools.length, 2);
    await client.close();
  });
});

describe("the log", () => {
  it("writes one line per call, with the id and never the input", async () => {
    // An input with no id is refused before anything is fetched, which is what
    // makes this callable offline — and a refusal is still a call.
    const write = mock.method(console, "log", () => {});
    const complain = mock.method(console, "error", () => {});
    try {
      const client = await connect();
      const result = await client.callTool({
        name: "get_transcript",
        arguments: { url: "https://example.com/watch?secret=1" },
      });
      await client.close();
      assert.equal(result.isError, true);

      const lines = write.mock.calls
        .map((call) => JSON.parse(String(call.arguments[0])) as Record<string, unknown>)
        .filter((line) => line.event === "tool_call");
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.tool, "get_transcript");
      assert.equal(lines[0]?.ok, false);
      assert.equal(typeof lines[0]?.ms, "number");
      assert.equal("videoId" in lines[0]!, false);

      const failures = complain.mock.calls.map((call) => String(call.arguments[0]));
      assert.equal(failures.length, 1);
      assert.match(failures[0]!, /"event":"tool_failed"/);
      // The raw input is the model's text; neither line repeats it.
      assert.doesNotMatch(JSON.stringify([lines, failures]), /example\.com|secret/);
    } finally {
      write.mock.restore();
      complain.mock.restore();
    }
  });
});
