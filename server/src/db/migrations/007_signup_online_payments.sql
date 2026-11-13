-- =====================================================================
-- Public company sign-up (email verified before anything is created) and
-- online payments through a payment provider (Stripe Checkout).
-- =====================================================================

-- Company contact details collected at sign-up.
alter table tenants add column contact_email text;
alter table tenants add column phone text;
alter table tenants add column country text;

-- A sign-up waits here until its email link is opened; only then are the
-- company and its first HR admin created. The token is stored hashed.
-- Firebase mode: the Firebase account is created disabled and enabled on
-- verification (firebase_uid); local mode keeps the bcrypt hash.
create table signup_requests (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  company_name   text not null,
  owner_name     text not null,
  phone          text,
  country        text,
  timezone       text not null,
  currency       text not null,
  password_hash  text,
  firebase_uid   text,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  verified_at    timestamptz,
  tenant_id      uuid references tenants(id),
  ip             text,
  created_at     timestamptz not null default now()
);
create index signup_requests_email on signup_requests (lower(email));

-- One row per checkout started by a company (pay an invoice, or buy a plan).
create table payment_checkouts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  provider       text not null,
  session_id     text unique,                         -- provider's checkout session id
  kind           text not null check (kind in ('invoice', 'plan')),
  invoice_id     uuid,
  plan_id        uuid references plans(id),
  billing_cycle  text check (billing_cycle in ('monthly', 'yearly')),
  amount         numeric(12,2) not null check (amount > 0),
  currency       text not null,
  status         text not null default 'open' check (status in ('open', 'completed', 'expired', 'failed')),
  note           text,                                -- e.g. why a paid checkout needs a manual refund
  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id),
  check ((kind = 'invoice') = (invoice_id is not null)),
  check ((kind = 'plan') = (plan_id is not null and billing_cycle is not null))
);
create index payment_checkouts_tenant on payment_checkouts (tenant_id, created_at desc);

-- Every webhook delivery, verified first. (provider, event_id) makes a
-- redelivered event a no-op; failed ones are retried by the provider.
create table payment_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  event_id      text not null,
  type          text not null,
  payload       jsonb not null,
  status        text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (provider, event_id)
);

update platform_settings set value = value || '{"signupEnabled": true}' where id = 'billing';
