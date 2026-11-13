-- Why an invoice was issued. "One live invoice per period" exists to stop a
-- renewal from billing twice; it must not stop a plan change on the same day
-- (e.g. upgrading right after paying) from issuing the new plan's invoice.
alter table invoices add column source text not null default 'plan_change' check (source in ('plan_change', 'renewal'));

drop index invoices_one_per_period;
create unique index invoices_one_renewal_per_period on invoices (subscription_id, period_start) where status <> 'void' and source = 'renewal';
