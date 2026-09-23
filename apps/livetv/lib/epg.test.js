// The XMLTV parse runs on a worker thread in the shell, so both paths are held
// to the same answer.
const test = require("node:test");
const assert = require("node:assert");
const epg = require("./epg");
const provider = require("./provider");

const XML = `<tv>
<programme start="20240101060000 +0100" stop="20240101070000 +0100" channel="a.hu"><title>Hírek &amp; időjárás</title></programme>
<programme start_timestamp="1704088800" stop_timestamp="1704092400" channel="a.hu"><title><![CDATA[Film]]></title></programme>
<programme start="20240101050000 +0000" stop="20240101060000 +0000" channel="b.hu"><title>Early</title></programme>
<programme start="20250101050000" stop="20250101060000" channel="b.hu"><title>Too late</title></programme>
</tv>`;
const LO = Date.UTC(2024, 0, 1, 0) / 1000;
const HI = Date.UTC(2024, 0, 2, 0) / 1000;

test("standard and Xtream timestamps both parse, sorted, inside the window", () => {
  const p = epg.parse(XML, LO, HI);
  assert.deepStrictEqual(
    p["a.hu"].map((x) => x.title),
    ["Hírek & időjárás", "Film"],
  );
  assert.strictEqual(p["a.hu"][0].start, Date.UTC(2024, 0, 1, 5) / 1000);
  assert.deepStrictEqual(
    p["b.hu"].map((x) => x.title),
    ["Early"],
  );
});

test("the worker thread gives the same answer as the inline parse", async () => {
  assert.deepStrictEqual(await provider._test.parseEpgOffThread(XML, LO, HI), epg.parse(XML, LO, HI));
});

test("a repeated tvg-id still gives every channel its own id", () => {
  const m3u = [
    "#EXTM3U",
    '#EXTINF:-1 tvg-id="x.hu" group-title="A",X HD',
    "http://example.com/1",
    '#EXTINF:-1 tvg-id="x.hu" group-title="A",X SD',
    "http://example.com/2",
    '#EXTINF:-1 tvg-id="y.hu" group-title="A",Y',
    "http://example.com/3",
  ].join("\n");
  const ch = provider._test.channelsFromM3U(m3u);
  assert.deepStrictEqual(
    ch.map((c) => [c.id, c.epgId]),
    [
      ["x.hu", "x.hu"],
      ["x.hu~2", "x.hu"],
      ["y.hu", "y.hu"],
    ],
  );
});
