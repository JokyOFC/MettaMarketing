-- Self sign-up (/cadastro, docs/PLATFORM.md §2.5). A person creates the client
-- account (company) and its first access. The access stays 'pending' until
-- the e-mail link (auth_tokens purpose 'verify') is opened; only then can it
-- log in. clients.source tells the team where an account came from, and
-- users.terms_accepted_at records the acceptance given in the form.

ALTER TABLE users DROP CHECK users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('invited','pending','active','disabled'));
ALTER TABLE users ADD COLUMN terms_accepted_at VARCHAR(32);

ALTER TABLE auth_tokens DROP CHECK auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check CHECK (purpose IN ('invite','reset','verify'));

ALTER TABLE clients ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'staff';
ALTER TABLE clients ADD CONSTRAINT clients_source_check CHECK (source IN ('staff','signup'));
