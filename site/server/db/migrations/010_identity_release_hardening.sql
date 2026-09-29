-- Batch B1 — brand identity release hardening.
--
-- 1. Guidelines draft -> released (lead decision D3).
--    brands.usage_guidelines / typography_guidelines keep the RELEASED text,
--    the only text clients receive (Minha marca). The team edits the *_draft
--    columns; a draft exists while guidelines_draft_at IS NOT NULL.
--    POST /api/brands/:id/identity/release with guidelines copies the draft
--    over the released text and stamps guidelines_released_at/_by.
--    Existing text stays released: no draft is created for current rows.
ALTER TABLE brands ADD COLUMN usage_guidelines_draft MEDIUMTEXT;
ALTER TABLE brands ADD COLUMN typography_guidelines_draft MEDIUMTEXT;
ALTER TABLE brands ADD COLUMN guidelines_draft_at VARCHAR(32);
ALTER TABLE brands ADD COLUMN guidelines_draft_by VARCHAR(64);
ALTER TABLE brands ADD COLUMN guidelines_released_at VARCHAR(32);
ALTER TABLE brands ADD COLUMN guidelines_released_by VARCHAR(64);

-- 2. Font licence follows RELEASED brand fonts only (PLATFORM.md §2 rule 5).
--    Re-sync existing font files of materials linked to a brand font: a draft
--    font marked "distribuição permitida" no longer makes files downloadable.
UPDATE material_files
   SET font_distributable = CASE
         WHEN EXISTS (SELECT 1 FROM brand_fonts bf
                       WHERE bf.material_id = material_files.material_id
                         AND bf.distribution = 'allowed' AND bf.visibility = 'released') THEN 1
         ELSE 0
       END
 WHERE media_kind = 'font'
   AND EXISTS (SELECT 1 FROM brand_fonts bf WHERE bf.material_id = material_files.material_id);

--    New font files follow the same rule in the application (attachUploads
--    and version copies in services/materials.js): no trigger, since shared
--    MySQL hosting often refuses CREATE TRIGGER.

-- 3. Webhook log retention (routes/webhooks.js prunes unsigned deliveries).
CREATE INDEX webhook_events_signed_received ON webhook_events(signature_valid, received_at);
