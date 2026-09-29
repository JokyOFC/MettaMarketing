// Fixture files for the e2e flows, generated per run (made-up marks, not a
// real client's work). Uses sharp, already a project dependency.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const OLIVE = "#3f4a2c";
const INK = "#202619";
const PAPER = "#f4f1ea";

function logoSvg(label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="480" viewBox="0 0 1200 480">
  <g fill="none" stroke="${INK}" stroke-width="16" stroke-linecap="round">
    <circle cx="240" cy="240" r="120"/>
    <path d="M160 300 L240 170 L320 300"/>
  </g>
  <text x="420" y="285" font-family="Helvetica, Arial, sans-serif" font-size="120" font-weight="300" letter-spacing="-3" fill="${INK}">${label}</text>
</svg>`;
}

function slideSvg(n, total, title, tone) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <rect width="1080" height="1350" fill="${tone}"/>
  <rect x="60" y="60" width="960" height="1230" fill="none" stroke="${PAPER}" stroke-width="3"/>
  <text x="110" y="250" font-family="Helvetica, Arial, sans-serif" font-size="64" fill="${PAPER}" letter-spacing="6">${title.toUpperCase()}</text>
  <text x="100" y="900" font-family="Georgia, serif" font-style="italic" font-size="520" fill="${PAPER}">${n}</text>
  <text x="110" y="1220" font-family="Helvetica, Arial, sans-serif" font-size="44" fill="${PAPER}">Slide ${n} de ${total}</text>
</svg>`;
}

const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

/** Writes every fixture into `dir` and returns their absolute paths. */
export async function makeFixtures(dir, { run }) {
  mkdirSync(dir, { recursive: true });
  const out = {};
  const put = (name, data) => {
    const path = join(dir, name);
    writeFileSync(path, data);
    return path;
  };
  const mark = `marca ${run.slice(-4)}`;
  out.logoSvg = put("logo-principal.svg", logoSvg(mark));
  out.logoPng = put("logo-principal.png", await png(logoSvg(mark)));
  const tones = ["#3f4a2c", "#5a4632", "#2f3d44"];
  out.slides = [];
  for (let i = 1; i <= 3; i++) out.slides.push(put(`slide-${i}.png`, await png(slideSvg(i, 3, "Lançamento", tones[i - 1]))));
  // Version 2 replaces slide 3.
  out.slide3v2 = put("slide-3-v2.png", await png(slideSvg(3, 3, "Lançamento v2", "#6b5a2e")));
  // Failure cases: disallowed extension, content that is not what the name says, empty file.
  out.exe = put("instalador.exe", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(510, 0x90)]));
  out.fakePng = put("foto-falsa.png", Buffer.from("isto não é uma imagem PNG, é só texto\n".repeat(20)));
  out.empty = put("vazio.png", Buffer.alloc(0));
  return out;
}
