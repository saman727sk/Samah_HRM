-- =====================================================================
-- SaaS subscriptions: plans, one subscription per company, invoices and
-- manually recorded payments (bank transfer, cash, cheque...).
--
--  * Plans are platform data (no tenant_id). A subscription copies the
--    plan's price and limits when it is assigned, so editing a plan later
--    never changes what an existing company pays.
--  * One renewal invoice per billing period (partial unique index; see 009), so a renewal
--    that runs twice can't bill twice.
--  * payments and subscription_events are append-only. A refund is a new
--    payment row of kind 'refund'.
--  * Money is numeric(12,2); dates are calendar dates in UTC.
-- =====================================================================

create table platform_settings (
  id          text primary key,                       -- e.g. 'billing'
  value       jsonb not null,
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now()
);

insert into platform_settings (id, value) values ('billing', '{
  "trialPlanCode": "trial",
  "invoiceDueDays": 7,
  "graceDays": 7,
  "taxRate": 0,
  "taxLabel": "Sales tax",
  "trialReminderDays": 3,
  "supportEmail": null
}');

create table plans (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[a-z0-9-]{2,40}$'),
  name           text not null,
  description    text,
  currency       text not null default 'PKR',
  price_monthly  numeric(12,2) not null default 0 check (price_monthly >= 0),
  price_yearly   numeric(12,2) not null default 0 check (price_yearly >= 0),
  trial_days     int not null default 0 check (trial_days between 0 and 365),
  max_employees  int check (max_employees > 0),       -- null = unlimited
  max_admins     int check (max_admins > 0),          -- HR admin logins; null = unlimited
  modules        jsonb,                               -- null = every module; else ["attendance", ...]
  status         text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Example plans (prices in PKR are placeholders: edit them in the super admin panel).
insert into plans (code, name, description, price_monthly, price_yearly, trial_days, max_employees, max_admins, modules, sort_order) values
  ('trial', 'Free trial', 'Every module for 14 days.', 0, 0, 14, 25, 3, null, 0),
  ('starter', 'Starter', 'Attendance, WFH and leave for small teams.', 4999, 49990, 0, 25, 2,
    '["attendance", "wfh", "leave"]', 1),
  ('professional', 'Professional', 'Adds payroll, overtime, loans and auto check-in.', 9999, 99990, 0, 100, 5,
    '["attendance", "wfh", "leave", "payroll", "overtime", "loans", "auto_checkin"]', 2),
  ('enterprise', 'Enterprise', 'Every module, no limits.', 24999, 249990, 0, null, null, null, 3);

create table subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null unique references tenants(id),
  plan_id               uuid not null references plans(id),
  -- Copied from the plan when assigned (custom limits may differ from the plan).
  plan_code             text not null,
  plan_name             text not null,
  billing_cycle         text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  price                 numeric(12,2) not null default 0 check (price >= 0),
  currency              text not null,
  max_employees         int check (max_employees > 0),
  max_admins            int check (max_admins > 0),
  modules               jsonb,
  -- trialing: free until trial_ends_on      active: paid up
  -- past_due: invoice overdue (still works)  unpaid: grace period over (blocked)
  -- cancelled / expired: blocked until a plan is assigned again
  status                text not null check (status in ('trialing', 'active', 'past_due', 'unpaid', 'cancelled', 'expired')),
  trial_ends_on         date,
  current_period_start  date,
  current_period_end    date,
  cancel_at_period_end  boolean not null default false,
  cancelled_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, id),
  check (status <> 'trialing' or trial_ends_on is not null)
);

create table subscription_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  subscription_id  uuid not null,
  event            text not null,                     -- plan_changed, renewed, trial_expired, payment_recorded...
  from_status      text,
  to_status        text,
  detail           jsonb not null default '{}',
  -- Set for automatic events (reminders, renewals) so a re-run never repeats them.
  dedupe_key       text unique,
  actor_user_id    uuid references users(id),
  created_at       timestamptz not null default now(),
  foreign key (tenant_id, subscription_id) references subscriptions (tenant_id, id)
);
create index subscription_events_tenant on subscription_events (tenant_id, created_at desc);
create trigger subscription_events_append_only before update or delete on subscription_events
  for each row execute function reject_mutation();

create sequence invoice_number_seq;

create table invoices (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  subscription_id  uuid not null,
  number           text not null unique,              -- INV-2026-000001
  status           text not null default 'open' check (status in ('open', 'paid', 'void')),
  period_start     date not null,
  period_end       date not null,
  issued_on        date not null,
  due_on           date not null,
  currency         text not null,
  subtotal         numeric(12,2) not null check (subtotal >= 0),
  tax_rate         numeric(5,2) not null default 0 check (tax_rate >= 0),
  tax              numeric(12,2) not null default 0 check (tax >= 0),
  total            numeric(12,2) not null check (total >= 0),
  amount_paid      numeric(12,2) not null default 0,
  lines            jsonb not null default '[]',
  note             text,
  paid_at          timestamptz,
  voided_at        timestamptz,
  void_reason      text,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, subscription_id) references subscriptions (tenant_id, id),
  check (period_end >= period_start and due_on >= issued_on)
);
-- One live invoice per subscription period: renewals can't double-bill.
create unique index invoices_one_per_period on invoices (subscription_id, period_start) where status <> 'void';
create index invoices_tenant on invoices (tenant_id, issued_on desc);
create index invoices_open_due on invoices (due_on) where status = 'open';

create table payments (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id),
  invoice_id           uuid not null,
  kind                 text not null default 'payment' check (kind in ('payment', 'refund')),
  refund_of            uuid references payments(id),
  amount               numeric(12,2) not null check (amount > 0),
  currency             text not null,
  method               text not null check (method in ('bank_transfer', 'cash', 'cheque', 'card', 'online', 'other')),
  reference            text,                          -- bank transaction id, cheque number...
  received_on          date not null,
  note                 text,
  -- For a payment provider (e.g. Stripe) later; never card numbers.
  provider             text,
  provider_payment_id  text unique,
  recorded_by          uuid references users(id),
  created_at           timestamptz not null default now(),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id),
  check ((kind = 'refund') = (refund_of is not null))
);
create index payments_tenant on payments (tenant_id, received_on desc);
create index payments_received on payments (received_on);
create trigger payments_append_only before update or delete on payments
  for each row execute function reject_mutation();

-- Existing companies start a 14-day trial of every module; the super admin
-- then assigns their plan. Nothing is billed until a paid plan is assigned.
insert into subscriptions (tenant_id, plan_id, plan_code, plan_name, billing_cycle, price, currency, max_employees, max_admins, modules,
                           status, trial_ends_on)
select t.id, p.id, p.code, p.name, 'monthly', 0, p.currency, null, null, null, 'trialing', current_date + p.trial_days
  from tenants t cross join plans p
 where p.code = 'trial';

-- Notification texts (product defaults; companies can reword them).
insert into translations (tenant_id, locale, key, value) values
  (null, 'en', 'notify.billing_trial_ending.title', 'Your free trial ends on {date}'),
  (null, 'en', 'notify.billing_trial_ending.body', 'Choose a plan before {date} to keep using the HRM without interruption.'),
  (null, 'en', 'notify.billing_trial_expired.title', 'Your free trial has ended'),
  (null, 'en', 'notify.billing_trial_expired.body', 'The HRM is paused for your company until a plan is chosen. Your data is kept.'),
  (null, 'en', 'notify.billing_invoice_issued.title', 'Invoice {number}: {amount}'),
  (null, 'en', 'notify.billing_invoice_issued.body', 'Your {plan} subscription for {period} is due on {dueOn}.'),
  (null, 'en', 'notify.billing_payment_received.title', 'Payment received: {amount}'),
  (null, 'en', 'notify.billing_payment_received.body', 'Thank you. {amount} was recorded against invoice {number}.'),
  (null, 'en', 'notify.billing_overdue.title', 'Invoice {number} is overdue'),
  (null, 'en', 'notify.billing_overdue.body', '{amount} was due on {dueOn}. Access will be paused on {pauseOn} if it stays unpaid.'),
  (null, 'en', 'notify.billing_unpaid.title', 'Your HRM access is paused'),
  (null, 'en', 'notify.billing_unpaid.body', 'Invoice {number} ({amount}) is unpaid. Access returns as soon as the payment is recorded.')
on conflict (tenant_id, locale, key) do nothing;
