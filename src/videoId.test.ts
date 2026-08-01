import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseVideoId } from "./videoId.js";

const ID = "dQw4w9WgXcQ";

test("reads the id out of every link shape YouTube hands around", () => {
  for (const input of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=share-junk`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/v/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    // A pasted link often arrives without its scheme.
    `youtu.be/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    // A model that already extracted the id should not have to re-wrap it.
    ID,
    `  ${ID}  `,
  ]) {
    assert.equal(parseVideoId(input), ID, input);
  }
});

test("refuses what is not a YouTube video", () => {
  for (const input of [
    "",
    "not a url",
    "https://example.com/watch?v=" + ID,
    "https://evil.youtube.com.example.com/watch?v=" + ID,
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=too-short",
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/playlist?list=PL123",
    "https://youtu.be/",
    "ftp://www.youtube.com/watch?v=" + ID,
    "tooshortid",
  ]) {
    assert.equal(parseVideoId(input), null, input);
  }
});
