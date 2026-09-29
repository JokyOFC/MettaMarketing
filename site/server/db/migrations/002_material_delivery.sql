-- Slice A — delivery engine additions.
--
-- material_files.published: final files attached after a version was released
-- stay invisible to the client (published = 0) until the team delivers them
-- explicitly (POST /api/materials/:id/deliver). Everything else is 1.
ALTER TABLE material_files ADD COLUMN published INTEGER NOT NULL DEFAULT 1;

-- ZIP jobs keep the exact entry list decided (and authorised) at request time:
-- JSON [{f: fileId, m: materialId, p: path, s: store 0|1, n: sizeBytes}].
-- entries_hash lets an identical request reuse a job that is still valid.
ALTER TABLE zip_jobs ADD COLUMN entries TEXT;
ALTER TABLE zip_jobs ADD COLUMN entries_hash TEXT;

-- Lookups used by storage clean-up, stale uploads and ZIP expiry.
CREATE INDEX material_files_storage ON material_files(storage_key);
CREATE INDEX file_renditions_storage ON file_renditions(storage_key);
CREATE INDEX uploads_status_created ON uploads(status, created_at);
CREATE INDEX zip_jobs_status ON zip_jobs(status, expires_at);
CREATE INDEX release_items_material ON release_items(material_id);
CREATE INDEX kit_items_material ON kit_items(material_id);
