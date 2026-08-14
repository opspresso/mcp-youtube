/**
 * What this server calls itself.
 *
 * Its own file because both ends need it and they cannot reach each other:
 * `server.ts` tells a client what it connected to, and `youtube.ts` tells
 * YouTube the same thing in a User-Agent-adjacent sense. `SERVER_VERSION`
 * restates package.json's `version`; a test pins the two together, because
 * nothing else would notice them drifting.
 */

export const SERVER_NAME = "mcp-youtube";
export const SERVER_VERSION = "0.3.0";
