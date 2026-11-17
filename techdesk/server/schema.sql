CREATE TABLE IF NOT EXISTS organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  ticket_seq integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name text NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','technician','requester')),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  number integer NOT NULL, title text NOT NULL, description text NOT NULL, category text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  requester_id uuid NOT NULL REFERENCES users(id), assignee_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number));
CREATE INDEX IF NOT EXISTS tickets_org_status ON tickets(org_id, status);
CREATE INDEX IF NOT EXISTS tickets_requester ON tickets(org_id, requester_id);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, org_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id), body text NOT NULL,
  internal boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS messages_ticket ON messages(ticket_id, created_at);
CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, org_id uuid NOT NULL,
  uploader_id uuid NOT NULL REFERENCES users(id), filename text NOT NULL, mime text NOT NULL,
  size integer NOT NULL, stored_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY, org_id uuid NOT NULL, actor_id uuid, action text NOT NULL,
  entity text NOT NULL, entity_id text, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS audit_org ON audit_logs(org_id, created_at DESC);

-- v2: subscriptions, invitations, SLA, assets, knowledge base
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS email_domain text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS plan_code text NOT NULL DEFAULT 'starter';
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS period_end timestamptz NOT NULL DEFAULT now() + interval '14 days';
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS paid boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS plans (code text PRIMARY KEY, name text NOT NULL, max_agents integer NOT NULL,
  price_month integer NOT NULL, active boolean NOT NULL DEFAULT true);
-- Placeholder prices in KES. Not market-validated: change them with PATCH /api/platform/plans/:code.
INSERT INTO plans(code,name,max_agents,price_month) VALUES ('starter','Starter',3,2500),('business','Business',10,7500),('enterprise','Enterprise',30,20000) ON CONFLICT (code) DO NOTHING;
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES plans(code), months integer NOT NULL CHECK (months > 0), amount integer NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('mpesa','manual')), status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  phone text, checkout_request_id text UNIQUE, mpesa_receipt text, reference text,
  created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purpose text NOT NULL CHECK (purpose IN ('invite','reset')), email text NOT NULL,
  org_id uuid REFERENCES organisations(id) ON DELETE CASCADE, role text, user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sla_policies (
  org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE, priority text NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  response_min integer NOT NULL CHECK (response_min > 0), resolve_min integer NOT NULL CHECK (resolve_min > 0), PRIMARY KEY (org_id, priority));
CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  tag text NOT NULL, name text NOT NULL, category text NOT NULL, serial text,
  status text NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use','in_stock','repair','retired')),
  assigned_to uuid REFERENCES users(id), location text, warranty_until date, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, tag));
CREATE TABLE IF NOT EXISTS kb_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  title text NOT NULL, body text NOT NULL, category text NOT NULL DEFAULT 'General', published boolean NOT NULL DEFAULT false,
  author_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES assets(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_due timestamptz;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolve_due timestamptz;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_at timestamptz;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS breached boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS tickets_sla ON tickets(breached, status, resolve_due);

-- v3: ticket location, stage history, persistent sessions, forced password change, deadline-miss tracking
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS room text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_breached boolean NOT NULL DEFAULT false;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS breached_at timestamptz;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS breached_assignee_id uuid REFERENCES users(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_breach_assignee_id uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS ticket_events (
  id bigserial PRIMARY KEY, ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, org_id uuid NOT NULL,
  actor_id uuid, type text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ticket_events_ticket ON ticket_events(ticket_id, id);
CREATE INDEX IF NOT EXISTS tickets_org_created ON tickets(org_id, created_at);
