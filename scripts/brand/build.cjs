// Builds the logo files from one definition of the pixel crown.
//   node scripts/brand/build.cjs
// Writes SVGs and PNGs to docs/brand/assets and copies the ones the site
// uses to app/public/brand. Letters are outlined from Inter 800, so the SVGs
// do not depend on a font being installed.
const fs = require("node:fs");
const path = require("node:path");
const opentype = require("opentype.js");
const { chromium } = require("playwright");

const GOLD = "#facc15", GROUND = "#1b1d28", INK = "#0f1016", WHITE = "#ffffff", MUTED = "#9ca3af";

// The crown: 11 x 6 pixels. Row 5 is the band (the floor, it never melts).
const CROWN = ["X....X....X", "X....X....X", "XX..XXX..XX", "XXXXXXXXXXX", "XXXXXXXXXXX", "XXXXXXXXXXX"];
// The logo has no drips: the crown is a clean shape. (Melting is shown on the
// site, where pixels leave the crown and fall down the page.)
const DRIPS_ICON = [];
const DRIPS_WORD = [];

const rects = (rows, px, ox = 0, oy = 0, fill = GOLD) =>
  rows.flatMap((row, y) => [...row].map((c, x) => (c === "X"
    ? `<rect x="${(ox + x * px).toFixed(2)}" y="${(oy + y * px).toFixed(2)}" width="${(px + 0.02).toFixed(2)}" height="${(px + 0.02).toFixed(2)}" fill="${fill}"/>` : ""))).join("");

const svg = (w, h, body, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ""}${body}</svg>\n`;

/** Crown alone on a padded square grid. */
function icon({ drips = DRIPS_ICON, fill = GOLD, bg = null, pad = 3, radius = 0 }) {
  const rows = [...CROWN, ...drips];
  const side = 11 + pad * 2;
  const oy = (side - rows.length) / 2;
  const back = bg ? `<rect width="${side}" height="${side}" rx="${radius}" fill="${bg}" shape-rendering="auto"/>` : "";
  return svg(side, side, back + rects(rows, 1, pad, Math.round(oy * 2) / 2, fill));
}

function loadFont(weight) {
  const b = fs.readFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** "cro" + crown + "n". The crown stands on the baseline and is a little
 * taller than the lowercase letters. */
function wordmark({ letters = WHITE, crown = GOLD, bg = null }) {
  const font = loadFont(800);
  const EM = 200, TRACK = -0.03 * EM;
  const xh = (font.tables.os2.sxHeight / font.unitsPerEm) * EM;
  const px = (xh * 1.15) / 6;            // crown is 15% taller than the x-height
  const PAD = 0.12 * EM;
  const baseline = PAD + px * 6;         // top of crown at PAD
  let x = PAD;
  const parts = [];
  // Laid out glyph by glyph (no shaping needed for four plain letters).
  const text = (s) => {
    let prev = null;
    for (const ch of s) {
      const g = font.charToGlyph(ch);
      if (prev) x += (font.getKerningValue(prev, g) / font.unitsPerEm) * EM;
      parts.push(`<path d="${g.getPath(x, baseline, EM).toPathData(2)}" fill="${letters}" shape-rendering="auto"/>`);
      x += (g.advanceWidth / font.unitsPerEm) * EM + TRACK;
      prev = g;
    }
  };
  text("cro");
  x += 0.05 * EM;
  parts.push(rects([...CROWN, ...DRIPS_WORD], px, x, baseline - px * 6, crown));
  x += px * 11 + 0.05 * EM;
  text("n");
  const w = x + PAD - 0.03 * EM, h = baseline + px * DRIPS_WORD.length + PAD;
  return { svg: svg(+w.toFixed(1), +h.toFixed(1), parts.join(""), bg), w, h };
}

async function main() {
  const out = "docs/brand/assets";
  fs.mkdirSync(out, { recursive: true });
  const files = {
    "crown-icon.svg": icon({}),
    "crown-icon-bare.svg": icon({ drips: [], pad: 2 }),
    "crown-icon-white.svg": icon({ fill: WHITE }),
    "crown-icon-ink.svg": icon({ fill: INK }),
    "favicon.svg": icon({ drips: [], pad: 2.5, bg: GROUND, radius: 3 }),
    "wordmark.svg": wordmark({}).svg,
    "wordmark-on-light.svg": wordmark({ letters: INK, crown: INK }).svg,
    "wordmark-white.svg": wordmark({ crown: WHITE }).svg,
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(out, name), body);

  // PNGs, rendered from the same SVGs.
  const inline = (s) => s.replace(/\n$/, "");
  const wm = wordmark({});
  const page = (w, h, bg, html) => ({ w, h, html: `<body style="margin:0;width:${w}px;height:${h}px;background:${bg};display:flex;align-items:center;justify-content:center;overflow:hidden">${html}</body>` });
  const sized = (s, css) => inline(s).replace("<svg ", `<svg style="${css}" `);
  const font500 = fs.readFileSync(require.resolve("@fontsource/inter/files/inter-latin-500-normal.woff")).toString("base64");
  const face = `<style>@font-face{font-family:I;font-weight:500;src:url(data:font/woff;base64,${font500})}</style>`;
  const line = (size) => `<div style="font:500 ${size}px I,sans-serif;color:${MUTED};letter-spacing:-0.01em">the crown gets cheaper every minute.</div>`;
  const pngs = {
    "favicon-32.png": page(32, 32, "transparent", sized(files["favicon.svg"], "width:32px;height:32px")),
    "apple-touch-icon.png": page(180, 180, GROUND, sized(icon({ drips: [], pad: 0 }), "width:118px;height:118px")),
    "avatar-512.png": page(512, 512, GROUND, sized(icon({ pad: 0 }), "width:300px;height:300px")),
    "coin-1000.png": page(1000, 1000, GOLD, sized(icon({ fill: INK, pad: 0 }), "width:620px;height:620px")),
    "og-1200x630.png": page(1200, 630, GROUND, face + `<div style="display:flex;flex-direction:column;gap:34px;align-items:flex-start">${sized(wm.svg, `width:640px;height:${(640 * wm.h / wm.w).toFixed(0)}px`)}${line(40)}</div>`),
    "x-header-1500x500.png": page(1500, 500, GROUND, face + `<div style="display:flex;flex-direction:column;gap:26px;align-items:flex-start">${sized(wm.svg, `width:560px;height:${(560 * wm.h / wm.w).toFixed(0)}px`)}${line(34)}</div>`),
    "x-pfp-black-1000.png": page(1000, 1000, "#000", sized(icon({ pad: 0 }), "width:560px;height:560px")),
    "x-header-black-1500x500.png": page(1500, 500, "#000", face + `<div style="display:flex;flex-direction:column;gap:26px;align-items:flex-start">${sized(wm.svg, `width:560px;height:${(560 * wm.h / wm.w).toFixed(0)}px`)}${line(34)}</div>`),
    "preview-wordmark.png": page(900, 360, GROUND, sized(wm.svg, `width:720px;height:${(720 * wm.h / wm.w).toFixed(0)}px`)),
  };
  const browser = await chromium.launch();
  for (const [name, p] of Object.entries(pngs)) {
    const tab = await browser.newPage({ viewport: { width: p.w, height: p.h }, deviceScaleFactor: 1 });
    await tab.setContent(`<!doctype html><html>${p.html}</html>`);
    await tab.screenshot({ path: path.join(out, name), omitBackground: name.startsWith("favicon") });
    await tab.close();
  }
  await browser.close();

  // What the website serves.
  const pub = "app/public/brand";
  fs.mkdirSync(pub, { recursive: true });
  for (const name of ["crown-icon.svg", "wordmark.svg", "favicon.svg", "favicon-32.png", "apple-touch-icon.png", "og-1200x630.png", "coin-1000.png"]) {
    fs.copyFileSync(path.join(out, name), path.join(pub, name));
  }
  console.log(`wrote ${Object.keys(files).length} SVGs and ${Object.keys(pngs).length} PNGs to ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
