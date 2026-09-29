// Renders a contract PDF in the Metta identity (Raleway title, Manrope text,
// Cormorant accent, vector logo, hairlines) and returns where the signature
// and date fields of each signer must be placed on AssinaVelox, as fractions
// of the page with the origin at the top-left corner.
//
// Layout notes: A4 portrait; the bottom-right corner of every page is kept
// empty because AssinaVelox may add automatic initials there
// (x 0.75-0.96, y 0.92-0.98 for two signers).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { LineCapStyle, PDFDocument, rgb } from "pdf-lib";
import { ROOT_DIR } from "../config.js";

const A4 = [595.28, 841.89];
const MARGIN = { left: 64, right: 64, top: 70, bottom: 86 };
const COLORS = {
  ink: rgb(0x25 / 255, 0x2a / 255, 0x20 / 255),
  muted: rgb(0x5a / 255, 0x5e / 255, 0x4f / 255),
  olive: rgb(0x20 / 255, 0x26 / 255, 0x19 / 255),
  line: rgb(0xc9 / 255, 0xc9 / 255, 0xbd / 255),
  sage: rgb(0x8a / 255, 0x96 / 255, 0x73 / 255),
  guide: rgb(0xf1 / 255, 0xef / 255, 0xe8 / 255),
};
const BODY = { size: 9.6, leading: 14.6 };

const FONT_FILES = {
  body: "manrope/files/manrope-latin-400-normal.woff",
  bold: "manrope/files/manrope-latin-600-normal.woff",
  display: "raleway/files/raleway-latin-300-normal.woff",
  accent: "cormorant-garamond/files/cormorant-garamond-latin-400-italic.woff",
};
let fontBytes = null;
function loadFonts() {
  if (!fontBytes) {
    fontBytes = {};
    for (const [key, file] of Object.entries(FONT_FILES))
      fontBytes[key] = readFileSync(join(ROOT_DIR, "node_modules", "@fontsource", file));
  }
  return fontBytes;
}

// Logo paths from src/Logo.jsx (viewBox 612 × 216).
const LOGO = {
  word: [
    "M8 153V80C27 38 91 42 91 94V153M91 94C91 38 176 36 176 93V153",
    "M306 139C282 157 254 161 230 145C201 126 199 91 215 69C243 30 313 50 313 103H205",
    "M346 12V112C346 149 367 161 401 149",
    "M420 12V112C420 149 441 161 475 149",
    "M323 53H477",
    "M603 153V89C603 49 559 39 512 62M591 102H545C516 102 501 112 501 130C501 163 566 159 592 139",
  ],
  cut: "M4.75 52H11.25V66L4.75 74Z",
  subtitle:
    "M102 212V188L114 212L126 188V212M158 212L169 188L180 212M162 204H176M209 212V188H219C232 188 232 201 219 201H209M219 201L232 212M258 188V212M275 188L259 201L278 212M321 188H306V212H322M306 200H319M351 188H374M362.5 188V212M404 188V212M438 212V188L457 212V188M511 193C506 185 489 185 488 200C487 214 505 216 512 209V201H502",
};

function drawLogo(page, { x, top, width, color = COLORS.olive, subtitle = true }) {
  const scale = width / 612;
  const y = page.getHeight() - top; // drawSvgPath uses the SVG origin at (x, y) with y growing down
  for (const d of LOGO.word)
    page.drawSvgPath(d, { x, y, scale, borderColor: color, borderWidth: 6.5, borderLineCap: LineCapStyle.Butt });
  page.drawSvgPath(LOGO.cut, { x, y, scale, color });
  if (subtitle)
    page.drawSvgPath(LOGO.subtitle, { x, y, scale, borderColor: color, borderWidth: 1.6, borderLineCap: LineCapStyle.Projecting });
}

// ------------------------------------------------------------------ text layout

function splitLong(word, font, size, max) {
  // Hard-breaks a single word wider than the line (URLs, e-mails).
  const pieces = [];
  let current = "";
  for (const ch of word) {
    if (font.widthOfTextAtSize(current + ch, size) > max && current) {
      pieces.push(current);
      current = ch;
    } else current += ch;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** runs [{text, bold}] -> lines [[{text, font}]] fitting maxWidth. */
function wrapRuns(runs, fonts, size, maxWidth) {
  const tokens = [];
  for (const run of runs) {
    const font = run.bold ? fonts.bold : fonts.body;
    for (const part of String(run.text).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) tokens.push({ space: true, font });
      else for (const piece of splitLong(part, font, size, maxWidth)) tokens.push({ text: piece, font });
    }
  }
  const lines = [];
  let line = [];
  let width = 0;
  let pendingSpace = null;
  for (const token of tokens) {
    if (token.space) {
      if (line.length) pendingSpace = token;
      continue;
    }
    const spaceWidth = pendingSpace ? pendingSpace.font.widthOfTextAtSize(" ", size) : 0;
    const wordWidth = token.font.widthOfTextAtSize(token.text, size);
    if (line.length && width + spaceWidth + wordWidth > maxWidth) {
      lines.push(line);
      line = [];
      width = 0;
      pendingSpace = null;
    }
    if (pendingSpace && line.length) {
      line.push({ text: " ", font: pendingSpace.font });
      width += spaceWidth;
    }
    line.push({ text: token.text, font: token.font });
    width += wordWidth;
    pendingSpace = null;
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

function drawLine(page, segments, { x, y, size, color }) {
  let cursor = x;
  for (const segment of segments) {
    if (!segment.text) continue;
    page.drawText(segment.text, { x: cursor, y, size, font: segment.font, color });
    cursor += segment.font.widthOfTextAtSize(segment.text, size);
  }
}

// ------------------------------------------------------------------ document

/**
 * renderContractPdf({ title, subtitle, code, issuedAt, blocks, parties, preview })
 *   parties: { client: { name, email, label }, metta: { name, email, label } }
 *   preview: null | "Pré-visualização" | "Exemplo" (banner on every page)
 * -> { bytes: Uint8Array, pages: number, fields: [{ signer, type, page, x, y, w, h }] }
 */
export async function renderContractPdf({ title, subtitle, code, issuedAt, blocks, parties, preview = null, footer }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bytes = loadFonts();
  const fonts = {
    body: await doc.embedFont(bytes.body, { subset: true }),
    bold: await doc.embedFont(bytes.bold, { subset: true }),
    display: await doc.embedFont(bytes.display, { subset: true }),
    accent: await doc.embedFont(bytes.accent, { subset: true }),
  };
  const [W, H] = A4;
  const contentWidth = W - MARGIN.left - MARGIN.right;
  const pages = [];
  let page;
  let y; // baseline cursor, in PDF points from the bottom

  function newPage() {
    page = doc.addPage(A4);
    pages.push(page);
    if (pages.length === 1) {
      drawLogo(page, { x: MARGIN.left, top: 44, width: 104 });
      const right = [code ? `Contrato ${code}` : null, issuedAt].filter(Boolean);
      right.forEach((text, i) => {
        const width = fonts.body.widthOfTextAtSize(text, 8);
        page.drawText(text, { x: W - MARGIN.right - width, y: H - 58 - i * 12, size: 8, font: fonts.body, color: COLORS.muted });
      });
      y = H - 150;
    } else {
      drawLogo(page, { x: MARGIN.left, top: 36, width: 58, subtitle: false });
      if (code) {
        const text = `Contrato ${code}`;
        const width = fonts.body.widthOfTextAtSize(text, 8);
        page.drawText(text, { x: W - MARGIN.right - width, y: H - 50, size: 8, font: fonts.body, color: COLORS.muted });
      }
      page.drawLine({ start: { x: MARGIN.left, y: H - 66 }, end: { x: W - MARGIN.right, y: H - 66 }, thickness: 0.5, color: COLORS.line });
      y = H - MARGIN.top - 26;
    }
    if (preview) {
      const label = String(preview).toUpperCase();
      const width = fonts.bold.widthOfTextAtSize(label, 7.5);
      page.drawRectangle({ x: W / 2 - width / 2 - 10, y: H - 26, width: width + 20, height: 15, color: COLORS.guide });
      page.drawText(label, { x: W / 2 - width / 2, y: H - 21.5, size: 7.5, font: fonts.bold, color: COLORS.muted });
    }
  }

  const ensure = (height) => {
    if (y - height < MARGIN.bottom) newPage();
  };

  newPage();

  // Title (Raleway light) + subtitle accent (Cormorant italic).
  for (const line of wrapRuns([{ text: title }], { body: fonts.display, bold: fonts.display }, 23, contentWidth)) {
    drawLine(page, line, { x: MARGIN.left, y, size: 23, color: COLORS.ink });
    y -= 28;
  }
  if (subtitle) {
    for (const line of wrapRuns([{ text: subtitle }], { body: fonts.accent, bold: fonts.accent }, 21, contentWidth)) {
      drawLine(page, line, { x: MARGIN.left, y: y + 2, size: 21, color: COLORS.olive });
      y -= 26;
    }
  }
  y -= 8;
  page.drawLine({ start: { x: MARGIN.left, y }, end: { x: MARGIN.left + 36, y }, thickness: 1.2, color: COLORS.sage });
  y -= 26;

  // Body blocks.
  for (const block of blocks) {
    if (block.type === "h1" || block.type === "h2") {
      const size = block.type === "h1" ? 10.2 : 9.6;
      const lines = wrapRuns(block.runs.map((r) => ({ ...r, bold: true })), fonts, size, contentWidth);
      ensure(18 + lines.length * 15 + BODY.leading * 2); // keep headings with their first lines
      y -= 8;
      for (const line of lines) {
        drawLine(page, line, { x: MARGIN.left, y, size, color: COLORS.olive });
        y -= 15;
      }
      y -= 3;
      continue;
    }
    const indent = block.type === "li" ? 16 : 0;
    const lines = wrapRuns(block.runs, fonts, BODY.size, contentWidth - indent);
    lines.forEach((line, index) => {
      ensure(BODY.leading);
      if (block.type === "li" && index === 0)
        page.drawCircle({ x: MARGIN.left + 5, y: y + 3.1, size: 1.5, color: COLORS.sage });
      drawLine(page, line, { x: MARGIN.left + indent, y, size: BODY.size, color: COLORS.ink });
      y -= BODY.leading;
    });
    y -= block.type === "li" ? 2 : 7;
  }

  // Signature block: always complete on a single page.
  const BLOCK_HEIGHT = 196;
  ensure(BLOCK_HEIGHT);
  y -= 12;
  page.drawText("Assinaturas", { x: MARGIN.left, y, size: 10.2, font: fonts.bold, color: COLORS.olive });
  y -= 16;
  const note =
    "As partes assinam eletronicamente pela plataforma AssinaVelox, que registra o aceite de cada uma e anexa a página de evidências ao documento final.";
  for (const line of wrapRuns([{ text: note }], fonts, 8.4, contentWidth)) {
    drawLine(page, line, { x: MARGIN.left, y, size: 8.4, color: COLORS.muted });
    y -= 12.4;
  }
  y -= 14;

  const fields = [];
  const pageIndex = pages.length; // 1-based page number of the signature block
  const colGap = 28;
  const colWidth = (contentWidth - colGap) / 2;
  const signatureHeight = 50;
  const toField = (signer, type, x, top, w, h) =>
    fields.push({
      signer,
      type,
      page: pageIndex,
      x: round(x / W),
      y: round((H - top) / H),
      w: round(w / W),
      h: round(h / H),
    });

  [
    ["client", parties.client],
    ["metta", parties.metta],
  ].forEach(([signer, party], index) => {
    const x = MARGIN.left + index * (colWidth + colGap);
    const top = y; // baseline cursor where the signature area starts
    // signature area (AssinaVelox draws the signature image inside it)
    page.drawRectangle({ x, y: top - signatureHeight, width: colWidth, height: signatureHeight, color: COLORS.guide });
    toField(signer, "signature", x + 6, top - 4, colWidth - 12, signatureHeight - 8);
    const lineY = top - signatureHeight - 2;
    page.drawLine({ start: { x, y: lineY }, end: { x: x + colWidth, y: lineY }, thickness: 0.7, color: COLORS.ink });
    let textY = lineY - 14;
    for (const line of wrapRuns([{ text: party.name, bold: true }], fonts, 9, colWidth).slice(0, 2)) {
      drawLine(page, line, { x, y: textY, size: 9, color: COLORS.ink });
      textY -= 12;
    }
    for (const line of wrapRuns([{ text: party.label }], fonts, 7.8, colWidth).slice(0, 2)) {
      drawLine(page, line, { x, y: textY, size: 7.8, color: COLORS.muted });
      textY -= 11;
    }
    textY -= 6;
    page.drawText("Data do aceite:", { x, y: textY, size: 7.8, font: fonts.body, color: COLORS.muted });
    const labelWidth = fonts.body.widthOfTextAtSize("Data do aceite: ", 7.8);
    toField(signer, "date", x + labelWidth, textY + 9.5, 72, 13);
  });
  y -= BLOCK_HEIGHT - 60;

  // Footers (left side only: the bottom-right corner is left for initials).
  const total = pages.length;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN.left, y: 52 }, end: { x: W * 0.62, y: 52 }, thickness: 0.5, color: COLORS.line });
    const text = `${footer ?? "Metta Marketing"} · Página ${i + 1} de ${total}`;
    p.drawText(text, { x: MARGIN.left, y: 40, size: 7.2, font: fonts.body, color: COLORS.muted });
  });

  doc.setTitle(`${title}${code ? ` — ${code}` : ""}`);
  doc.setAuthor("Metta Marketing");
  doc.setCreator("Plataforma Metta");
  doc.setProducer("Plataforma Metta");
  doc.setSubject(subtitle ?? title);
  doc.setLanguage("pt-BR");
  const pdf = await doc.save({ useObjectStreams: true });
  return { bytes: pdf, pages: total, fields };
}

const round = (n) => Math.round(n * 1e6) / 1e6;
