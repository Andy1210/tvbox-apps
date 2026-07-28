// The artwork library's decisions, which are all name-shaped: what a file is called
// on disk, which listed file a playlist label refers to, and when a console is
// worth listing again. Those three are what decide whether a game shows a cover.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const art = require("./art");

test("scrubLabel replaces exactly what RetroArch replaces", () => {
  // The set is RetroArch's own, and the server stores its files the same way.
  assert.strictEqual(art.scrubLabel("Tom & Jerry (USA)"), "Tom _ Jerry (USA)");
  assert.strictEqual(art.scrubLabel('a&b*c/d:e`f"g<h>i?j\\k|l'), "a_b_c_d_e_f_g_h_i_j_k_l");
  // Everything else stays, accents and brackets included.
  assert.strictEqual(
    art.scrubLabel("Pokémon - Ruby Version (USA, Europe) [!]"),
    "Pokémon - Ruby Version (USA, Europe) [!]",
  );
  assert.strictEqual(art.scrubLabel(undefined), "");
});

test("a name that could leave its folder is refused", () => {
  assert.ok(art.nameOk("Super Mario World (USA)"));
  assert.ok(!art.nameOk(".."));
  assert.ok(!art.nameOk("a/../../b"));
  assert.ok(!art.nameOk("sub/dir"));
  assert.ok(!art.nameOk("back\\slash"));
  assert.ok(!art.nameOk(".hidden"));
  assert.ok(!art.nameOk("half-written.part"));
  assert.ok(!art.nameOk(""));
  assert.ok(!art.nameOk("x".repeat(300)));
  assert.strictEqual(art.boxartPath("Nintendo - Game Boy Advance", ".."), "");
  assert.strictEqual(art.boxartPath("../../etc", "x"), "");
  assert.ok(
    art
      .boxartPath("Nintendo - Game Boy Advance", "ZooCube (USA)")
      .endsWith("/thumbnails/Nintendo - Game Boy Advance/Named_Boxarts/ZooCube (USA).png"),
  );
});

test("parseIndex reads the server's directory listing, and only files", () => {
  const html = `<html><body><h1>Index of /x</h1>
   <tr><th><a href="?C=N;O=D">Name</a></th></tr>
   <tr><td><a href="/Nintendo%20-%20Game%20Boy%20Advance/">Parent Directory</a></td></tr>
   <tr><td><a href="Tom%20%26%20Jerry%20-%20The%20Magic%20Ring%20(USA).png">Tom &amp; Jerry</a></td></tr>
   <tr><td><a href="ZooCube%20(USA).png">ZooCube (USA).png</a></td></tr>
   <tr><td><a href="notes.txt">notes.txt</a></td></tr>
   </body></html>`;
  assert.deepStrictEqual(art.parseIndex(html), ["Tom & Jerry - The Magic Ring (USA)", "ZooCube (USA)"]);
  assert.deepStrictEqual(art.parseIndex(""), []);
});

test("systemUrl encodes the console name", () => {
  assert.strictEqual(
    art.systemUrl("Nintendo - Game Boy Advance"),
    "https://thumbnails.libretro.com/Nintendo%20-%20Game%20Boy%20Advance/Named_Boxarts/",
  );
});

test("titleKey absorbs tags, case, spacing and punctuation", () => {
  assert.strictEqual(
    art.titleKey("Zelda II - The Adventure of Link (Nintendo) (USA)"),
    art.titleKey("Zelda II - The Adventure of Link (USA)"),
  );
  assert.strictEqual(art.titleKey("WildSnake (USA)"), art.titleKey("Wild Snake (USA)"));
  assert.strictEqual(
    art.titleKey("Zoda's Revenge - Star Tropics II (Nintendo) (USA)"),
    art.titleKey("Zoda's Revenge - StarTropics II (USA)"),
  );
  assert.notStrictEqual(art.titleKey("Super Mario Bros. (USA)"), art.titleKey("Super Mario Bros. 3 (USA)"));
});

test("matcher: the same name wins over anything looser", () => {
  const match = art.matcher(["Super Mario World (USA)", "Super Mario World (Europe)", "super mario world (USA)"]);
  assert.strictEqual(match("Super Mario World (USA)"), "Super Mario World (USA)");
});

test("matcher: case-insensitive is the second step", () => {
  const match = art.matcher(["Sega Smash Pack (USA)"]);
  assert.strictEqual(match("SEGA Smash Pack (USA)"), "Sega Smash Pack (USA)");
});

test("matcher: a label named by another convention finds the right variant", () => {
  // The box's NES set carries the publisher and the server's does not, so nothing
  // matches by name; the region tag is what picks the variant.
  const match = art.matcher([
    "Zelda II - The Adventure of Link (Europe)",
    "Zelda II - The Adventure of Link (Japan)",
    "Zelda II - The Adventure of Link (USA)",
  ]);
  assert.strictEqual(
    match("Zelda II - The Adventure of Link (Nintendo) (USA)"),
    "Zelda II - The Adventure of Link (USA)",
  );
});

test("matcher: with no tag in common, the plainest name wins", () => {
  const match = art.matcher([
    "Super Mario Bros. (19xx)(-)[h2][p][no title, iNES title]",
    "Super Mario Bros. (Japan, USA)",
    "Super Mario Bros. (World)",
  ]);
  // Nothing shares a tag with "(Nintendo) (JP-US)", so what is left is: a
  // [hacked]/[bad] dump loses to a clean one, and fewer tags is closer to plain.
  // Any of these is the same game's cover, which is why this is allowed to be a
  // preference rather than a refusal.
  assert.strictEqual(match("Super Mario Bros. (Nintendo) (JP-US)"), "Super Mario Bros. (World)");
});

test("matcher: a game the server does not carry matches nothing", () => {
  const match = art.matcher(["Contra (USA)"]);
  assert.strictEqual(match("Ninja Five-O (USA)"), null);
});

test("matcher: the pick does not depend on the listing's order", () => {
  const names = ["Wild Snake (Europe)", "Wild Snake (USA)", "Wild Snake (Japan)"];
  const pick = (list) => art.matcher(list)("WildSnake (USA)");
  assert.strictEqual(pick(names), "Wild Snake (USA)");
  assert.strictEqual(pick([...names].reverse()), "Wild Snake (USA)");
});

test("dueForListing: never seen, playlist changed, or gone stale", () => {
  const now = 1_000_000_000_000;
  assert.ok(art.dueForListing(null, 0, now), "never listed");
  assert.ok(art.dueForListing({ checkedAt: now - 1000 }, now - 500, now), "playlist changed since");
  assert.ok(!art.dueForListing({ checkedAt: now - 1000 }, now - 5000, now), "nothing changed");
  assert.ok(art.dueForListing({ checkedAt: now - art.RECHECK_MS - 1 }, 0, now), "stale enough to re-look");
});

test("isPng accepts a PNG and refuses whatever else the server sent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-test-"));
  try {
    const png = path.join(dir, "ok.png");
    fs.writeFileSync(
      png,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]),
    );
    assert.ok(art.isPng(png));
    const html = path.join(dir, "bad.png");
    fs.writeFileSync(html, "<html>404 not found</html>");
    assert.ok(!art.isPng(html));
    const empty = path.join(dir, "empty.png");
    fs.writeFileSync(empty, "");
    assert.ok(!art.isPng(empty), "a zero-length file is what a failed transfer leaves");
    assert.ok(!art.isPng(path.join(dir, "absent.png")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
