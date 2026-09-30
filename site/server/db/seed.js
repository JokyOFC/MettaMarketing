// Idempotent base data: system categories, services catalog (only when the
// table is empty, linked to the site's "Comprar" buttons by slug) and default
// settings.
import { contactEmail, identityOffer, plans } from "../../src/data/brand.js";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";

export const SYSTEM_CATEGORIES = [
  { slug: "logotipo", name: "Logotipo", area: "identity", folder: "Logos" },
  { slug: "identidade-visual", name: "Identidade visual", area: "identity", folder: "Elementos visuais" },
  { slug: "manual-da-marca", name: "Manual da marca", area: "identity", folder: "Manual da marca" },
  { slug: "paleta-de-cores", name: "Paleta de cores", area: "identity", folder: "Paleta de cores" },
  { slug: "tipografia", name: "Tipografia", area: "identity", folder: "Tipografia" },
  { slug: "posts-carrosseis", name: "Posts e carrosséis", area: "content", folder: "Posts e carrosséis" },
  { slug: "stories", name: "Stories", area: "content", folder: "Stories" },
  { slug: "reels-videos", name: "Reels e vídeos", area: "content", folder: "Reels e vídeos" },
  { slug: "campanhas", name: "Campanhas", area: "content", folder: "Campanhas" },
  { slug: "apresentacoes", name: "Apresentações", area: "other", folder: "Apresentações" },
  { slug: "materiais-adicionais", name: "Materiais adicionais", area: "other", folder: "Materiais adicionais" },
];

const priceCents = (price) => Math.round(Number(String(price).replace(/\./g, "").replace(",", ".")) * 100);

export async function seed(db) {
  const at = now();
  await db.tx(async () => {
    for (const [index, category] of SYSTEM_CATEGORIES.entries()) {
      await db.run(
        `INSERT IGNORE INTO categories (id, slug, name, area, folder, sort_order, is_system, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [newId("cat"), category.slug, category.name, category.area, category.folder, (index + 1) * 10, at, at],
      );
    }

    const services = (await db.get("SELECT COUNT(*) AS n FROM services")).n;
    if (services === 0) {
      for (const [index, plan] of plans.entries()) {
        await db.run(
          `INSERT INTO services (id, slug, name, kind, price_cents, billing_interval, description, items,
             includes_editables, active, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, 'subscription', ?, 'monthly', ?, ?, 0, 1, ?, ?, ?)`,
          [newId("svc"), plan.slug, plan.name, priceCents(plan.price), plan.description, JSON.stringify(plan.items), (index + 1) * 10, at, at],
        );
      }
      await db.run(
        `INSERT INTO services (id, slug, name, kind, price_cents, billing_interval, description, items,
           includes_editables, active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 'one_off', ?, NULL, NULL, '[]', 0, 1, ?, ?, ?)`,
        [newId("svc"), identityOffer.slug, identityOffer.name, priceCents(identityOffer.price), (plans.length + 1) * 10, at, at],
      );
    }

    const defaults = {
      orgName: "Metta Marketing",
      supportEmail: contactEmail,
      defaultNotifyEmail: true,
      zipRetentionHours: 24,
    };
    for (const [key, value] of Object.entries(defaults)) {
      await db.run("INSERT IGNORE INTO settings (name, value, updated_at) VALUES (?, ?, ?)", [
        key,
        JSON.stringify(value),
        at,
      ]);
    }
  });
}
