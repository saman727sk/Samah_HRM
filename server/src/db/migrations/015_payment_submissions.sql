-- A company reports a payment it made outside the system (bank transfer, cash,
-- cheque, mobile wallet...) with an optional receipt; the super admin confirms
-- it (the payment is recorded and the invoice cleared) or rejects it with a
-- reason. A report can pay an open invoice, or buy a plan (the plan starts
-- when the payment is confirmed, exactly like a card payment).
create table payment_submissions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  kind           text not null check (kind in ('invoice', 'plan')),
  invoice_id     uuid,
  plan_id        uuid references plans(id),
  billing_cycle  text check (billing_cycle in ('monthly', 'yearly')),
  amount         numeric(12,2) not null check (amount > 0),
  currency       text not null,
  method         text not null check (method in ('bank_transfer', 'cash', 'cheque', 'card', 'online', 'other')),
  reference      text,
  paid_on        date not null,
  note           text,
  proof_mime     text check (proof_mime in ('image/png', 'image/jpeg', 'application/pdf')),
  proof_data     text,                                 -- base64, at most 2 MB
  status         text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  review_note    text,
  payment_id     uuid references payments(id),
  submitted_by   uuid references users(id),
  reviewed_by    uuid references users(id),
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id),
  check ((kind = 'invoice') = (invoice_id is not null)),
  check ((kind = 'plan') = (plan_id is not null and billing_cycle is not null)),
  check ((proof_data is null) = (proof_mime is null))
);
create index payment_submissions_tenant on payment_submissions (tenant_id, created_at desc);
create index payment_submissions_pending on payment_submissions (created_at) where status = 'pending';

insert into translations (tenant_id, locale, key, value) values
  (null, 'en', 'notify.billing_payment_submitted.title', 'Payment sent for confirmation: {amount}'),
  (null, 'en', 'notify.billing_payment_submitted.body', 'We received your payment notice ({what}). You will be told as soon as it is confirmed, usually within one working day.'),
  (null, 'en', 'notify.billing_payment_rejected.title', 'Payment not confirmed: {amount}'),
  (null, 'en', 'notify.billing_payment_rejected.body', 'Your payment notice ({what}) could not be confirmed: {reason}. Please check it and send it again, or contact us.')
on conflict (tenant_id, locale, key) do nothing;
