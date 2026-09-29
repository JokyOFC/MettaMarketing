-- Self sign-up (/cadastro, docs/PLATFORM.md §2.5). A person creates the client
-- account (company) and its first access, active right away. clients.source
-- tells the team where an account came from, and users.terms_accepted_at
-- records the acceptance given in the form.

ALTER TABLE users ADD COLUMN terms_accepted_at VARCHAR(32);

ALTER TABLE clients ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'staff';
ALTER TABLE clients ADD CONSTRAINT clients_source_check CHECK (source IN ('staff','signup'));
