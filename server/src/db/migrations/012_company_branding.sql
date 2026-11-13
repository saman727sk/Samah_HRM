-- Each company's own identity on its screens and documents (payslips):
-- name, address and logo. The platform (Samah HRM) is only the software.
--
-- The logo lives in its own table so the per-request tenant lookup stays
-- small; tenants.logo_updated_at versions its URL for browser caching.
-- Stored as base64 text (PNG or JPEG, checked by content, max 512 KB) so it
-- works the same on PostgreSQL, PGlite and the Firebase mirror.
alter table tenants add column address text;
alter table tenants add column logo_updated_at timestamptz;

create table tenant_logos (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null unique references tenants(id),
  mime        text not null check (mime in ('image/png', 'image/jpeg')),
  data        text not null,
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now()
);
