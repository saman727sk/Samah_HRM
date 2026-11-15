-- =====================================================================
-- The SaaS owner can delete a company with all its data
-- (services/companyAdmin.js deleteCompany).
--
-- Append-only and frozen-payroll triggers still refuse every change, except
-- deleting rows of the one company named in the transaction-local setting
-- hrm.deleting_tenant, which only deleteCompany sets.
-- =====================================================================

create or replace function deleting_own_company(row_tenant uuid) returns boolean language sql stable as $$
  select row_tenant is not null and coalesce(current_setting('hrm.deleting_tenant', true), '') = row_tenant::text
$$;

create or replace function reject_mutation() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' and deleting_own_company(old.tenant_id) then
    return old;
  end if;
  raise exception '% is append-only; write a new row instead', TG_TABLE_NAME
    using errcode = 'P0001';
end $$;

create or replace function reject_frozen_payroll_rows() returns trigger language plpgsql as $$
declare
  run_status text;
begin
  if TG_OP = 'DELETE' and deleting_own_company(old.tenant_id) then
    return old;
  end if;
  select status into run_status from payroll_runs
   where id = case when TG_OP = 'DELETE' then old.payroll_run_id else new.payroll_run_id end;
  if run_status in ('approved', 'locked') then
    raise exception 'Payroll % is %, its payslips can no longer change', TG_TABLE_NAME, run_status using errcode = 'P0001';
  end if;
  return case when TG_OP = 'DELETE' then old else new end;
end $$;

create or replace function reject_locked_run() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' and deleting_own_company(old.tenant_id) then
    return old;
  end if;
  if old.status = 'locked' then
    raise exception 'Payroll % is locked and can never change', old.period_key using errcode = 'P0001';
  end if;
  return case when TG_OP = 'DELETE' then old else new end;
end $$;
