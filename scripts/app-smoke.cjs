// Browser smoke test for the website against a mock indexer API.
//   node scripts/app-smoke.cjs            (builds the app, then tests it)
// Screenshots go to .fork/app-*.png.
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { chromium } = require("playwright");

const API_PORT = 8791, APP_PORT = 3111;
const SOL = 1_000_000_000;
const A = "7xKpF1rstK1ngAAAAAAAAAAAAAAAAAAAAAAAAAAAQ2aa";
const B = "FiR2SecondK1ngBBBBBBBBBBBBBBBBBBBBBBBBBB9aBc";
const C = "9aBcTh1rdK1ngCCCCCCCCCCCCCCCCCCCCCCCCCCC7xKp";
const now = () => Math.floor(Date.now() / 1000);

// ---- mock chain state
let down = false;
const takeovers = [
  { signature: "s2", ts: now() - 125, takeoverCount: 2, newKing: A, oldKing: B, pricePaid: String(2.9 * SOL), toOldKing: String(2.61 * SOL), toBurn: String(0.29 * SOL), newPrice: String(4.2 * SOL), jumpBps: 14500, reignSecs: 540, oldReignFees: String(1.1 * SOL) },
  { signature: "s1", ts: now() - 700, takeoverCount: 1, newKing: B, oldKing: null, pricePaid: String(0.5 * SOL), toOldKing: "0", toBurn: String(0.5 * SOL), newPrice: String(0.7 * SOL), jumpBps: 14000, reignSecs: 0, oldReignFees: "0" },
];
const state = { king: A, checkpointPrice: 3.41 * SOL, checkpointTs: now() - 60, meltBps: 400, floor: 1.4 * SOL, takeoverCount: 2, reignStartedTs: now() - 125 };
const crown = () => ({
  mint: "MintMintMintMintMintMintMintMintMintMintMint", king: state.king, price: String(state.checkpointPrice), floor: String(state.floor),
  meltBps: state.meltBps, feesPerMinute: String(0.14 * SOL), checkpointPrice: String(state.checkpointPrice), checkpointTs: state.checkpointTs,
  reignStartedTs: state.reignStartedTs, kingFeesThisReign: String(0.31 * SOL), takeoverCount: state.takeoverCount, totalFees: String(212.4 * SOL),
  totalBurnSol: String(18.2 * SOL), totalTokensBurned: "5000000000", burnBucketLamports: "0", locked: true, params: {}, now: now(),
});
const api = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
  if (down) return send(500, { error: "rpc down" });
  const path = req.url.split("?")[0];
  if (path === "/api/crown") return send(200, crown());
  if (path === "/api/history") return send(200, { takeovers });
  if (path === "/api/leaderboard") return send(200, {
    longestReign: [{ king: B, value: "540" }], mostEarned: [{ king: B, value: String(1.1 * SOL) }],
    biggestTakeover: [{ king: A, value: String(2.9 * SOL), signature: "s2" }], mostBurned: [{ king: B, value: String(0.5 * SOL) }, { king: A, value: String(0.29 * SOL) }],
    totals: { takeovers: 2, solBoughtBack: String(0.5 * SOL), tokensBurned: "5000000000" },
  });
  send(404, { error: "not found" });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (msg) => console.log(`  ok   ${msg}`);

/** With no API configured the site must show the pre-launch page and nothing made up. */
async function prelaunch() {
  const env = { ...process.env, NEXT_PUBLIC_API_URL: "" };
  execFileSync("pnpm", ["--filter", "app", "build"], { env, stdio: "ignore" });
  const app = spawn("pnpm", ["--filter", "app", "exec", "next", "start", "-p", String(APP_PORT)], { env, stdio: "ignore" });
  const base = `http://127.0.0.1:${APP_PORT}`;
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base); break; } catch { await sleep(500); } }
    fs.mkdirSync(".fork", { recursive: true });
    for (const [width, name] of [[1100, "desk"], [390, "phone"]]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const failed = [];
      page.on("requestfailed", (r) => failed.push(r.url()));
      await page.goto(base);
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();
      assert.ok(body.includes("the crown gets cheaper every minute."));
      assert.ok(body.includes("is not live yet"));
      assert.ok(!/SOL\/min|crown price|connect wallet|hall of kings/.test(body), "no live numbers or wallet button before launch");
      assert.ok(!/\d+\.\d+ SOL/.test(body), "no SOL amounts before launch");
      assert.ok(!/koth/i.test(body));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(failed, [], "no failed requests (nothing tries to reach an API)");
      await page.screenshot({ path: `.fork/prelaunch-${name}.png`, fullPage: true });
      await page.goto(base + "/how");
      assert.ok((await page.locator("body").innerText()).includes("there is one crown."));
      await page.goto(base + "/kings");
      assert.ok((await page.locator("body").innerText()).includes("no kings yet"));
    }
    ok("pre-launch page: no numbers, no wallet button, no API calls; /how and /kings render; fits a phone");
    console.log("\nPRE-LAUNCH SMOKE TEST PASSED");
  } finally {
    await browser.close();
    app.kill();
  }
}

async function main() {
  if (process.argv.includes("--prelaunch")) return prelaunch();
  await new Promise((r) => api.listen(API_PORT, r));
  const env = { ...process.env, NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`, NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:1" };
  if (!process.argv.includes("--no-build")) execFileSync("pnpm", ["--filter", "app", "build"], { env, stdio: "ignore" });
  const app = spawn("pnpm", ["--filter", "app", "exec", "next", "start", "-p", String(APP_PORT)], { env, stdio: "ignore" });
  const base = `http://127.0.0.1:${APP_PORT}`;
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base); break; } catch { await sleep(500); } }
    fs.mkdirSync(".fork", { recursive: true });

    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // Start the mock clock now, after the build.
    state.checkpointTs = now() - 60; state.reignStartedTs = now() - 125; takeovers[0].ts = now() - 125; takeovers[1].ts = now() - 700;
    await page.goto(base);
    const price = page.getByTestId("price");
    await price.waitFor();

    // Ticking price: falls each second, with no request to the API in between.
    const read = async () => Number((await price.textContent()).replace(" SOL", ""));
    const p1 = await read();
    assert.ok(Math.abs(p1 - 3.41 * 0.96) < 0.02, `price after ~60s of 4%/min melt, got ${p1}`);
    await sleep(2_300);
    const p2 = await read();
    assert.ok(p2 < p1 && p1 - p2 < 0.01, `price ticked down locally: ${p1} -> ${p2}`);
    ok(`price ticks every second from the checkpoint (${p1} -> ${p2} SOL)`);

    const body = await page.locator("body").innerText();
    for (const want of ["7xKp…Q2aa", "earned this reign", "0.3100 SOL", "1.4000 SOL", "0.1400 SOL a minute", "all-time fees", "212.40 SOL", "burned", "18.20 SOL", "falling 4% a minute", "will not go below 1.4000 SOL", "takeovers", "took it from", "claimed it", "you pay at most"]) {
      assert.ok(body.includes(want), `page shows "${want}"`);
    }
    assert.equal(await page.locator("section[aria-label=takeovers] li").count(), 2);
    ok("king card shows king, fees per minute, earned this reign, all-time fees, floor; feed lists takeovers");
    assert.ok(!/koth|king of the hill|pump\.fun/i.test(body.replace(/pump\.fun/gi, "")), "no other platform's name on the front page");
    assert.ok(!/koth/i.test(body));
    assert.ok(!/lot 1|always for sale/i.test(body), "no auction lot wording");
    // Colour legend: melt 4%/min is gold, so gold is lit and the others faded. Under the crown at this width,
    // left of the page on wide screens.
    const legend = async (p, v, h) => p.getByTestId(`legend-${v}-${h}`).evaluate((el) => ({ current: el.getAttribute("aria-current"), opacity: Number(getComputedStyle(el).opacity) }));
    const checkLegend = async (p, v) => {
      assert.deepEqual(await legend(p, v, "gold"), { current: "true", opacity: 1 });
      for (const h of ["ember", "red"]) { const l = await legend(p, v, h); assert.ok(l.current === null && l.opacity < 0.5, JSON.stringify(l)); }
    };
    await checkLegend(page, "below");
    assert.ok(!(await page.getByTestId("legend-side-gold").isVisible()));
    const wide = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await wide.goto(base);
    await wide.getByTestId("price").waitFor();
    await checkLegend(wide, "side");
    assert.ok(!(await wide.getByTestId("legend-below-gold").isVisible()));
    const box = await wide.getByTestId("legend-side-gold").boundingBox();
    const plate = await wide.locator(".plate").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= plate.x, "side legend sits left of the crown, on screen");
    assert.equal(await wide.evaluate(() => document.documentElement.scrollWidth), 1440, "no sideways scroll on wide screens");
    await wide.screenshot({ path: ".fork/app-wide.png" });
    await wide.close();
    ok("colour legend lights the crown's current colour and fades the others (left of the page when wide, under the crown otherwise)");

    const gauge = page.locator("section[aria-label='the crown'] svg[data-gone]");
    const snap = () => gauge.evaluate((el) => ({ gone: Number(el.getAttribute("data-gone")), standing: el.querySelectorAll("rect").length, fallen: Number(el.dataset.fallen ?? 0) }));
    const first = await snap();
    const gone1 = first.gone;
    assert.ok(gone1 > 20 && gone1 < 315, `crown has lost some pixels (${gone1} of 315)`);
    assert.equal(first.standing, 315 - gone1 + 99, "missing pixels leave holes; the band is whole");
    assert.ok(first.fallen <= 2, "no shower of pixels on page load");
    // Wait for the next pixel to go: it must fall down the page, not just vanish.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const seenFalling = await page.waitForFunction(() => {
      const el = document.querySelector(".falling-pixel");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, size: r.width, pointer: getComputedStyle(el).pointerEvents };
    }, null, { timeout: 30_000, polling: 50 });
    const fp = await seenFalling.jsonValue();
    assert.equal(fp.pointer, "none", "falling pixels never block a click");
    assert.ok(fp.size > 3 && fp.size < 20, `falling pixel is one small crown pixel (${fp.size}px)`);
    // It ends at the bottom of the page and is removed, without making the page longer.
    await page.waitForFunction(() => document.querySelectorAll(".falling-pixel").length === 0, null, { timeout: 15_000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), height, "falling pixels do not stretch the page");
    await page.waitForFunction((n) => Number(document.querySelector("svg[data-gone]").getAttribute("data-gone")) > n, gone1, { timeout: 30_000 });
    const later = await snap();
    assert.ok(later.gone > gone1 && later.fallen >= 1, JSON.stringify({ first, later }));
    assert.equal(later.standing, 315 - later.gone + 99, "every lost pixel leaves a hole");
    ok(`crown loses pixels one by one and they fall down the page (${gone1} gone at load, ${later.gone} a little later)`);
    await page.screenshot({ path: ".fork/app-desk.png", fullPage: true });

    // Takeover while the page is open: card shakes and flashes, feed gets a new card.
    state.king = C; state.takeoverCount = 3; state.checkpointPrice = 4.6 * SOL; state.checkpointTs = now(); state.reignStartedTs = now();
    takeovers.unshift({ signature: "s3", ts: now(), takeoverCount: 3, newKing: C, oldKing: A, pricePaid: String(3.2 * SOL), toOldKing: String(2.88 * SOL), toBurn: String(0.32 * SOL), newPrice: String(4.6 * SOL), jumpBps: 14375, reignSecs: 125, oldReignFees: String(0.31 * SOL) });
    await page.waitForSelector("section.bump", { timeout: 9_000 });
    const anim = await page.locator("section.bump").evaluate((el) => getComputedStyle(el).animationName);
    assert.ok(anim.includes("bump-shake"), anim);
    assert.ok((await page.locator("section.bump .plate").evaluate((el) => getComputedStyle(el).animationName)).includes("bump-flash"));
    assert.equal(await page.locator("li.fresh").count(), 1);
    await page.waitForSelector("section.bump", { state: "detached", timeout: 3_000 });
    assert.equal(await page.locator("section[aria-label=takeovers] li").count(), 3);
    assert.ok(Number(await gauge.getAttribute("data-gone")) <= 3, "whole crown after a takeover");
    assert.ok((await page.locator("body").innerText()).includes("9aBc…7xKp"));
    ok("takeover: king card shakes and flashes, feed gains a card, crown refills");

    // The button with no wallet opens the wallet chooser.
    await page.getByRole("button", { name: "[take the crown]" }).click();
    await page.waitForSelector(".wallet-adapter-modal", { timeout: 3_000 });
    ok("[take the crown] with no wallet opens the wallet chooser");
    await page.keyboard.press("Escape");

    // API failure after load: keeps the last numbers and says so.
    down = true;
    await page.waitForSelector("p[role=alert]", { timeout: 9_000 });
    assert.ok((await page.locator("p[role=alert]").innerText()).includes("showing the last numbers"));
    assert.ok(await price.isVisible());
    down = false;
    ok("indexer outage: last numbers stay, with a plain warning");

    // Other pages.
    await page.goto(base + "/kings");
    await page.waitForSelector("text=longest reign");
    assert.ok((await page.locator("body").innerText()).includes("9m 0s"));
    await page.goto(base + "/how");
    assert.ok((await page.locator("body").innerText()).includes("there is one crown."));
    ok("/kings and /how render");
    assert.deepEqual(errors, [], "no page errors");

    // Phone width: nothing scrolls sideways.
    const phone = await browser.newPage({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 });
    for (const path of ["/", "/kings", "/how"]) {
      await phone.goto(base + path);
      await phone.waitForLoadState("networkidle");
      const over = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(over, 0, `${path} overflows by ${over}px at phone width`);
    }
    await phone.goto(base);
    await phone.getByTestId("price").waitFor();
    await phone.screenshot({ path: ".fork/app-phone.png", fullPage: true });
    ok("no sideways scroll at phone width on any page");

    // Reduced motion: flash only, no shake.
    const calm = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" });
    await calm.goto(base);
    await calm.getByTestId("price").waitFor();
    state.takeoverCount = 4; state.king = B; state.checkpointTs = now();
    takeovers.unshift({ ...takeovers[0], signature: "s4", takeoverCount: 4, newKing: B, oldKing: C, ts: now() });
    await calm.waitForSelector("section.bump", { timeout: 9_000 });
    const calmAnim = await calm.locator("section.bump").evaluate((el) => getComputedStyle(el).animationName);
    assert.ok(!calmAnim.includes("bump-shake"), calmAnim);
    assert.ok((await calm.locator("section.bump .plate").evaluate((el) => getComputedStyle(el).animationName)).includes("bump-flash"));
    await calm.waitForFunction((n) => Number(document.querySelector("svg[data-gone]").getAttribute("data-gone")) > n, Number(await calm.locator("svg[data-gone]").getAttribute("data-gone")), { timeout: 30_000 });
    assert.equal(await calm.locator(".falling-pixel").count(), 0);
    assert.equal(await calm.locator("svg[data-gone]").evaluate((el) => el.dataset.fallen ?? "0"), "0");
    ok("reduced motion: flash without the shake, and lost pixels do not fall");

    console.log("\nAPP SMOKE TEST PASSED");
  } finally {
    await browser.close();
    app.kill();
    api.close();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
