// Restrained transactional e-mail in Metta colours. No remote images, no
// tracking; the plain-text part carries the same content.

const C = {
  paper: "#ede9df",
  surface: "#f4f1e9",
  ink: "#252a20",
  muted: "#646858",
  olive: "#202619",
  line: "#d6d2c6",
  sage: "#aeb99a",
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FONT = "Manrope, 'Segoe UI', Helvetica, Arial, sans-serif";
const TITLE_FONT = "Raleway, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * renderEmail({ title, intro, lines, actionLabel, actionUrl, footer, subject })
 *   -> { subject, text, html }
 * lines: strings (paragraphs) or [label, value] pairs shown as a small list.
 */
export function renderEmail({ title, intro, lines = [], actionLabel, actionUrl, footer, subject } = {}) {
  const org = "Metta Marketing";
  const closing =
    footer ?? "Você recebeu este e-mail porque tem acesso à plataforma da Metta Marketing.";

  const text = [
    title,
    "",
    intro,
    ...lines.map((line) => (Array.isArray(line) ? `${line[0]}: ${line[1]}` : line)),
    actionUrl ? `\n${actionLabel ?? "Abrir"}: ${actionUrl}` : null,
    "",
    "—",
    org,
    closing,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  const paragraph = (content) =>
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.7;color:${C.ink};">${content}</p>`;
  const pairs = lines.filter(Array.isArray);
  const paragraphs = lines.filter((line) => !Array.isArray(line));

  const pairRows = pairs.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;border-top:1px solid ${C.line};">${pairs
        .map(
          ([label, value]) =>
            `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};width:40%;">${escapeHtml(label)}</td><td style="padding:10px 0;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:14px;color:${C.ink};">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";

  const button = actionUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 28px;"><tr><td style="border-radius:999px;background:${C.olive};">
        <a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:14px;font-weight:500;letter-spacing:.02em;color:${C.paper};text-decoration:none;border-radius:999px;">${escapeHtml(actionLabel ?? "Abrir")}</a>
      </td></tr></table>
      <p style="margin:0 0 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">Se o botão não funcionar, copie este endereço no navegador:<br><span style="word-break:break-all;color:${C.ink};">${escapeHtml(actionUrl)}</span></p>`
    : "";

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.paper};">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.paper};">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;">
      <tr><td style="padding:0 0 20px;font-family:${FONT};font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:${C.muted};">${org}</td></tr>
      <tr><td style="background:${C.surface};border:1px solid ${C.line};padding:36px 32px;">
        <h1 style="margin:0 0 20px;font-family:${TITLE_FONT};font-weight:300;font-size:28px;line-height:1.2;letter-spacing:-.02em;color:${C.ink};">${escapeHtml(title)}</h1>
        ${intro ? paragraph(escapeHtml(intro)) : ""}
        ${paragraphs.map((line) => paragraph(escapeHtml(line))).join("")}
        ${pairRows}
        ${button}
      </td></tr>
      <tr><td style="padding:20px 4px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">${escapeHtml(closing)}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject: subject ?? title, text, html };
}
