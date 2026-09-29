// Creates the first administrator as "invited" and prints the invitation
// link (the person sets their own password).
// Usage: npm run create-admin -- --email pessoa@empresa.com --name "Nome"
import { parseArgs } from "node:util";
import { createContext } from "../app.js";
import { loadConfig } from "../config.js";
import { issueToken } from "../lib/auth.js";
import { logActivity } from "../lib/audit.js";
import { renderEmail } from "../lib/emails.js";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";

const INVITE_HOURS = 72;

function fail(message) {
  console.error(message);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } }));
} catch (err) {
  fail(`${err.message}\nUso: npm run create-admin -- --email pessoa@empresa.com --name "Nome"`);
}

let input;
try {
  input = parse(z.object({ email: schemas.email, name: schemas.text(120) }), args);
} catch (err) {
  fail(`Dados inválidos: ${JSON.stringify(err.fields ?? err.message)}\nUso: npm run create-admin -- --email pessoa@empresa.com --name "Nome"`);
}

const config = loadConfig();
const ctx = createContext(config, { jobs: false });
try {
  if (ctx.db.get("SELECT id FROM users WHERE email = ?", [input.email]))
    fail(`Já existe um usuário com o e-mail ${input.email}. Nada foi alterado.`);

  const id = newId("usr");
  const at = now();
  ctx.db.run(
    `INSERT INTO users (id, email, name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'invited', ?, ?)`,
    [id, input.email, input.name, at, at],
  );
  const token = issueToken(ctx, id, "invite", INVITE_HOURS);
  const url = `${config.appUrl}/convite/${token}`;
  logActivity(ctx, {
    action: "user.invited",
    entityType: "user",
    entityId: id,
    summary: `Administrador ${input.name} convidado pela linha de comando.`,
  });

  if (ctx.mailer.isConfigured()) {
    const message = renderEmail({
      title: "Seu acesso à plataforma da Metta",
      intro: `Olá, ${input.name}. Você foi convidado como administrador da plataforma da Metta Marketing.`,
      lines: [`Defina sua senha pelo link abaixo. Ele vale por ${INVITE_HOURS} horas e pode ser usado uma vez.`],
      actionLabel: "Definir senha",
      actionUrl: url,
    });
    const result = await ctx.mailer.send({ to: input.email, toUserId: id, ...message });
    console.log(result.status === "sent" ? `Convite enviado para ${input.email}.` : `O e-mail não foi enviado (${result.status}).`);
  }
  console.log(`Administrador ${input.email} criado como convidado.`);
  console.log(`Link de convite (válido por ${INVITE_HOURS} h, uso único):\n${url}`);
} finally {
  await ctx.mailer.idle();
  ctx.db.close();
}
