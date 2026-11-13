-- =====================================================================
-- Phase 4: payroll runs, overtime claims, payment details, guardrails
-- =====================================================================

-- Employer contributions (e.g. EOBI employer share) are costs to the
-- company that do not change the employee's net pay.
alter table salary_components drop constraint salary_components_kind_check;
alter table salary_components add constraint salary_components_kind_check check (kind in ('earning', 'deduction', 'employer'));
alter table payroll_items drop constraint payroll_items_kind_check;
alter table payroll_items add constraint payroll_items_kind_check check (kind in ('earning', 'deduction', 'employer', 'info'));

alter table payroll_runs add column totals jsonb not null default '{}';
alter table payroll_runs add column warnings jsonb not null default '[]';
alter table payroll_runs add column calculated_at timestamptz;
alter table payroll_runs add column reviewed_by uuid references users(id);
alter table payroll_runs add column reviewed_at timestamptz;

alter table payslips add column employer_cost numeric(14, 2) not null default 0;
create index payslips_employee on payslips (tenant_id, employee_id);
create index payroll_items_run on payroll_items (payroll_run_id, employee_id);

-- Bank details live apart from the employee record so only payroll code
-- (HR, or the employee themself) ever reads them.
create table employee_payment_details (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  employee_id    uuid not null unique references employees(id),
  bank_name      text,
  account_title  text,
  iban           text,
  updated_by     uuid references users(id),
  updated_at     timestamptz not null default now()
);

-- Overtime is paid from approved claims (or straight from attendance when
-- payroll.rules.overtime.requireApproval is off).
create table overtime_claims (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  employee_id         uuid not null references employees(id),
  work_date           date not null,
  minutes             int not null check (minutes > 0),
  attendance_minutes  int not null,                  -- overtime the attendance engine saw when claimed
  off_day             boolean not null default false,
  reason              text,
  status              text not null check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by          uuid references users(id),
  decided_at          timestamptz,
  decision_comment    text,
  created_by          uuid references users(id),
  created_at          timestamptz not null default now()
);
create unique index overtime_claims_active_day on overtime_claims (employee_id, work_date) where status in ('pending', 'approved');
create index overtime_claims_emp on overtime_claims (tenant_id, employee_id, work_date);

alter table loans add column closed_at timestamptz;

-- ---------------------------------------------------------------------
-- Guardrails: an approved or locked payroll can't change underneath its
-- payslips, and a locked run can't change at all.
-- ---------------------------------------------------------------------
create function reject_frozen_payroll_rows() returns trigger language plpgsql as $$
declare
  run_status text;
begin
  select status into run_status from payroll_runs
   where id = case when TG_OP = 'DELETE' then old.payroll_run_id else new.payroll_run_id end;
  if run_status in ('approved', 'locked') then
    raise exception 'Payroll % is %, its payslips can no longer change', TG_TABLE_NAME, run_status using errcode = 'P0001';
  end if;
  return case when TG_OP = 'DELETE' then old else new end;
end $$;

create trigger payroll_items_frozen before insert or update or delete on payroll_items
  for each row execute function reject_frozen_payroll_rows();
create trigger payslips_frozen before insert or update or delete on payslips
  for each row execute function reject_frozen_payroll_rows();

create function reject_locked_run() returns trigger language plpgsql as $$
begin
  if old.status = 'locked' then
    raise exception 'Payroll % is locked and can never change', old.period_key using errcode = 'P0001';
  end if;
  return case when TG_OP = 'DELETE' then old else new end;
end $$;

create trigger payroll_runs_locked before update or delete on payroll_runs
  for each row execute function reject_locked_run();
