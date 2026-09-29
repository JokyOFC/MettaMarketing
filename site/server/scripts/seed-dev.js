// Development data: staff accounts for every role, one example client with a
// brand, a client user and one released logo, so flows and isolation can be
// tried by hand. Idempotent. Refuses to run in production.
// Usage: npm run seed:dev
import sharp from "sharp";
import { createContext } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../lib/auth.js";
import { logActivity } from "../lib/audit.js";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";

// Test passwords (development only — never reuse them anywhere real).
export const DEV_ACCOUNTS = [
  { key: "admin", role: "admin", email: "admin@metta.test", name: "Administração Metta (dev)", password: "metta-admin-dev-2026", jobTitle: "Administração" },
  { key: "manager", role: "manager", email: "gestor@metta.test", name: "Gestora de contas (dev)", password: "metta-gestor-dev-2026", jobTitle: "Gestão de contas" },
  { key: "designer", role: "designer", email: "designer@metta.test", name: "Designer (dev)", password: "metta-designer-dev-2026", jobTitle: "Design" },
  { key: "finance", role: "finance", email: "financeiro@metta.test", name: "Financeiro (dev)", password: "metta-financeiro-dev-2026", jobTitle: "Financeiro" },
];
export const DEV_CLIENT_ACCOUNT = {
  email: "cliente@aurora.test",
  name: "Cliente Aurora (exemplo)",
  password: "aurora-cliente-dev-2026",
};

const CLIENT_NAME = "Aurora Pagamentos (exemplo)";
const BRAND = { name: "Aurora", slug: "aurora" };
const PROJECT_NAME = "Identidade visual Aurora (exemplo)";
const LOGO_TITLE = "Logo principal Aurora";

const config = loadConfig();
if (config.isProduction) {
  console.error("seed:dev não roda com NODE_ENV=production.");
  process.exit(1);
}
const ctx = await createContext(config, { jobs: false });
const { db, storage } = ctx;
const at = now();
const created = [];

async function ensureUser({ role, email, name, password, jobTitle = null, clientId = null }) {
  const existing = await db.get("SELECT * FROM users WHERE email = ?", [email]);
  if (existing) return existing;
  const id = newId("usr");
  await db.run(
    `INSERT INTO users (id, email, name, role, client_id, password_hash, status, job_title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [id, email, name, role, clientId, await hashPassword(password), jobTitle, at, at],
  );
  created.push(email);
  return await db.get("SELECT * FROM users WHERE id = ?", [id]);
}

// Simple example mark generated here (not a real client's logo).
function logoSvg() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="480" viewBox="0 0 1200 480">
  <g fill="none" stroke="#202619" stroke-width="14" stroke-linecap="round">
    <path d="M150 330 A110 110 0 0 1 370 330"/>
    <path d="M200 330 A60 60 0 0 1 320 330"/>
    <line x1="120" y1="360" x2="400" y2="360"/>
  </g>
  <text x="460" y="300" font-family="Raleway, Helvetica, Arial, sans-serif" font-size="150" font-weight="300" letter-spacing="-4" fill="#202619">aurora</text>
</svg>`);
}

async function addRenditions(fileId, pngBuffer) {
  for (const [kind, width] of [
    ["thumb", 480],
    ["preview", 1600],
  ]) {
    const { data, info } = await sharp(pngBuffer)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const stored = await storage.putBuffer(data);
    await db.run(
      `REPLACE INTO file_renditions (file_id, kind, storage_key, mime, width, height, size_bytes, created_at)
       VALUES (?, ?, ?, 'image/webp', ?, ?, ?, ?)`,
      [fileId, kind, stored.key, info.width, info.height, stored.size, at],
    );
  }
}

try {
  const staff = {};
  for (const account of DEV_ACCOUNTS) staff[account.key] = await ensureUser(account);

  let client = await db.get("SELECT * FROM clients WHERE name = ?", [CLIENT_NAME]);
  if (!client) {
    const id = newId("cli");
    await db.run(
      `INSERT INTO clients (id, name, contact_name, contact_email, status, internal_notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [id, CLIENT_NAME, DEV_CLIENT_ACCOUNT.name, DEV_CLIENT_ACCOUNT.email, "Cliente de exemplo para desenvolvimento.", staff.admin.id, at, at],
    );
    client = await db.get("SELECT * FROM clients WHERE id = ?", [id]);
  }
  let brand = await db.get("SELECT * FROM brands WHERE client_id = ? AND slug = ?", [client.id, BRAND.slug]);
  if (!brand) {
    const id = newId("brd");
    await db.run(
      `INSERT INTO brands (id, client_id, name, slug, description, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [id, client.id, BRAND.name, BRAND.slug, "Marca de exemplo para desenvolvimento.", staff.admin.id, at, at],
    );
    brand = await db.get("SELECT * FROM brands WHERE id = ?", [id]);
  }
  const clientUser = await ensureUser({ role: "client", clientId: client.id, ...DEV_CLIENT_ACCOUNT });
  await db.run("INSERT IGNORE INTO staff_client_access (user_id, client_id, granted_by, granted_at) VALUES (?, ?, ?, ?)", [
    staff.manager.id,
    client.id,
    staff.admin.id,
    at,
  ]);

  let project = await db.get("SELECT * FROM projects WHERE brand_id = ? AND name = ?", [brand.id, PROJECT_NAME]);
  if (!project) {
    const id = newId("prj");
    const service = await db.get("SELECT id FROM services WHERE name = 'Identidade visual'");
    await db.run(
      `INSERT INTO projects (id, brand_id, service_id, name, status, includes_editables, start_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'in_progress', 1, ?, ?, ?, ?)`,
      [id, brand.id, service?.id ?? null, PROJECT_NAME, at.slice(0, 10), staff.admin.id, at, at],
    );
    project = await db.get("SELECT * FROM projects WHERE id = ?", [id]);
  }
  await db.run("INSERT IGNORE INTO project_members (project_id, user_id, role, added_by, added_at) VALUES (?, ?, 'designer', ?, ?)", [
    project.id,
    staff.designer.id,
    staff.admin.id,
    at,
  ]);

  const existingLogo = await db.get("SELECT id FROM materials WHERE brand_id = ? AND title = ?", [brand.id, LOGO_TITLE]);
  if (!existingLogo) {
    const svg = logoSvg();
    const png = await sharp(svg, { density: 144 }).resize({ width: 1200 }).png().toBuffer();
    const pngMeta = await sharp(png).metadata();
    const svgStored = await storage.putBuffer(svg);
    const pngStored = await storage.putBuffer(png);
    const category = await db.get("SELECT id FROM categories WHERE slug = 'logotipo'");
    const materialId = newId("mat");
    const versionId = newId("ver");
    const releaseId = newId("rel");
    const svgFileId = newId("fil");
    const pngFileId = newId("fil");
    await db.tx(async () => {
      await db.run(
        `INSERT INTO materials (id, kind, brand_id, project_id, category_id, title, description, tags, owner_id, variant,
           preview_bg, is_primary, sort_order, visibility, download_enabled, editable_included, requires_approval,
           approval_status, current_version_id, released_version_id, released_at, released_by, delivered_at,
           created_by, created_at, updated_at)
         VALUES (?, 'asset', ?, ?, ?, ?, ?, '["exemplo"]', ?, 'principal', 'light', 1, 10, 'released', 1, 0, 0,
           'none', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          materialId, brand.id, project.id, category.id, LOGO_TITLE, "Logo de exemplo gerada para desenvolvimento.",
          staff.designer.id, versionId, versionId, at, staff.manager.id, at, staff.designer.id, at, at,
        ],
      );
      await db.run(
        `INSERT INTO material_versions (id, material_id, number, status, change_summary, created_by, created_at,
           submitted_at, released_at, released_by)
         VALUES (?, ?, 1, 'released', 'Primeira versão', ?, ?, ?, ?, ?)`,
        [versionId, materialId, staff.designer.id, at, at, at, staff.manager.id],
      );
      const insertFile = async (id, position, name, ext, mime, stored, kind, width, height) =>
        await db.run(
          `INSERT INTO material_files (id, version_id, material_id, role, position, original_name, display_name, ext, mime,
             size_bytes, sha256, storage_key, media_kind, width, height, preview_status, created_by, created_at)
           VALUES (?, ?, ?, 'original', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
          [id, versionId, materialId, position, name, name, ext, mime, stored.size, stored.sha256, stored.key, kind, width, height, staff.designer.id, at],
        );
      await insertFile(svgFileId, 1, "aurora-logo-principal.svg", "svg", "image/svg+xml", svgStored, "vector", 1200, 480);
      await insertFile(pngFileId, 2, "aurora-logo-principal.png", "png", "image/png", pngStored, "image", pngMeta.width, pngMeta.height);
      await db.run(
        `INSERT INTO releases (id, client_id, brand_id, actor_id, message, notify_email, notify_app, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
        [releaseId, client.id, brand.id, staff.manager.id, "Logo principal disponível (exemplo).", at],
      );
      await db.run("INSERT INTO release_items (release_id, material_id, version_id, download_enabled) VALUES (?, ?, ?, 1)", [
        releaseId,
        materialId,
        versionId,
      ]);
    });
    await addRenditions(svgFileId, png);
    await addRenditions(pngFileId, png);
    const actor = { ctx, user: staff.manager };
    await logActivity(actor, {
      action: "material.released",
      entityType: "material",
      entityId: materialId,
      materialId,
      summary: `A equipe Metta disponibilizou “${LOGO_TITLE}”.`,
      data: { releaseId, versionId },
      visibility: "client",
    });
    created.push(`material "${LOGO_TITLE}"`);
  }

  console.log(created.length ? `Criado: ${created.join(", ")}` : "Nada novo: os dados de desenvolvimento já existem.");
  console.log("\nContas de desenvolvimento:");
  for (const account of DEV_ACCOUNTS) console.log(`  ${account.role.padEnd(9)} ${account.email}`);
  console.log(`  ${"client".padEnd(9)} ${clientUser.email}  (${CLIENT_NAME})`);
  console.log("\nAs senhas estão em server/scripts/seed-dev.js (DEV_ACCOUNTS e DEV_CLIENT_ACCOUNT).");
} finally {
  await ctx.db.close();
}
