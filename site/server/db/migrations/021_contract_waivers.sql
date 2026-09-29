-- A contract requirement can be waived for a single order or subscription
-- (e.g. a contract signed outside the platform). Recorded with who and why.
ALTER TABLE orders ADD COLUMN contract_waived_at VARCHAR(32);
ALTER TABLE orders ADD COLUMN contract_waived_by VARCHAR(64);
ALTER TABLE orders ADD COLUMN contract_waiver_reason TEXT;
ALTER TABLE subscriptions ADD COLUMN contract_waived_at VARCHAR(32);
ALTER TABLE subscriptions ADD COLUMN contract_waived_by VARCHAR(64);
ALTER TABLE subscriptions ADD COLUMN contract_waiver_reason TEXT;
