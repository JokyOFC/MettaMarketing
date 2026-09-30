-- Purchases started on the public site (docs/PLATFORM.md §6.2). services.slug
-- links a catalog item to a "Comprar" button of /planos (src/data/brand.js,
-- siteOffers). Orders and subscriptions bought there are paid first and get
-- the contract after the payment is confirmed: contract_after_payment marks
-- them, and contract_auto_at records when the automatic contract step ran
-- (sent, or the team was told why it could not be sent).

ALTER TABLE services ADD COLUMN slug VARCHAR(64);
ALTER TABLE services ADD UNIQUE KEY services_slug (slug);

ALTER TABLE orders ADD COLUMN contract_after_payment TINYINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN contract_auto_at VARCHAR(32);
ALTER TABLE subscriptions ADD COLUMN contract_after_payment TINYINT NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN contract_auto_at VARCHAR(32);

-- Catalogs seeded before this migration: link the buttons to the services with
-- the same kind and name (oldest first). Fresh installs get the slugs from the
-- seed; afterwards the team changes them in Planos e serviços.
UPDATE services SET slug = 'presenca'
 WHERE id = (SELECT id FROM (SELECT id FROM services WHERE kind = 'subscription' AND name = 'Presença' COLLATE utf8mb4_0900_ai_ci ORDER BY created_at, id LIMIT 1) AS pick);
UPDATE services SET slug = 'gestao'
 WHERE id = (SELECT id FROM (SELECT id FROM services WHERE kind = 'subscription' AND name = 'Gestão' COLLATE utf8mb4_0900_ai_ci ORDER BY created_at, id LIMIT 1) AS pick);
UPDATE services SET slug = 'estrategia'
 WHERE id = (SELECT id FROM (SELECT id FROM services WHERE kind = 'subscription' AND name = 'Estratégia' COLLATE utf8mb4_0900_ai_ci ORDER BY created_at, id LIMIT 1) AS pick);
UPDATE services SET slug = 'identidade-visual'
 WHERE id = (SELECT id FROM (SELECT id FROM services WHERE kind = 'one_off' AND name = 'Identidade visual' COLLATE utf8mb4_0900_ai_ci ORDER BY created_at, id LIMIT 1) AS pick);
