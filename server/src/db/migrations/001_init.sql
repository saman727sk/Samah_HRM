-- =====================================================================
-- HRM SaaS — initial schema
--
-- Conventions
--  * Every business table carries tenant_id; every query filters on it.
--  * Business rules are NOT columns here. They live as versioned JSON in
--    settings / setting_versions and are resolved by the config engine.
--  * Lookup tables (departments, leave_types, shifts, ...) replace enums so
--    HR can add / rename / disable entries. CHECK constraints are only used
--    for engine-level states (draft/published, pending/approved, in/out...).
--  * Append-only tables (attendance_events, leave_ledger, audit_log) are
--    protected by a trigger that rejects UPDATE and DELETE.
-- =====================================================================

create function reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; write a new row instead', TG_TABLE_NAME
    using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------
-- Tenancy & identity
-- ---------------------------------------------------------------------
create table tenants (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null unique,
  timezone        text not null default 'Asia/Karachi',
  currency        text not null default 'PKR',
  default_locale  text not null default 'en',
  -- Leave ledgers / attendance start from this date; earlier history is
  -- brought in as opening-balance adjustments.
  go_live_date    date not null default current_date,
  status          text not null default 'active' check (status in ('active', 'suspended')),
  created_at      timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references tenants(id),          -- null only for super admins
  email          text not null unique,
  password_hash  text not null,
  -- Security access level (fixed by the product's RBAC model). Job titles are
  -- the dynamic `roles` lookup below.
  access_level   text not null check (access_level in ('super_admin', 'hr_admin', 'manager', 'employee')),
  locale         text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  check ((access_level = 'super_admin') = (tenant_id is null))
);

-- ---------------------------------------------------------------------
-- Lookup tables (dynamic entities)
-- ---------------------------------------------------------------------
create table departments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  parent_id   uuid references departments(id),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create table roles (                                   -- job roles / designations
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create table employment_types (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create table locations (                               -- offices (geofences)
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  address     text,
  lat         numeric(9, 6),
  lng         numeric(9, 6),
  radius_m    int check (radius_m is null or radius_m > 0),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

-- Shift identity only; timings/grace/thresholds are versioned settings
-- (key 'shift.rules', subject = shift id) so edits never rewrite history.
create table shifts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create table holiday_calendars (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);
create unique index holiday_calendars_one_default on holiday_calendars (tenant_id) where is_default;

create table holidays (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  calendar_id  uuid not null references holiday_calendars(id),
  date         date not null,
  name         text not null,
  is_optional  boolean not null default false,
  note         text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (calendar_id, date)
);

-- Leave type identity only; entitlement, accrual, carry-forward etc. are
-- versioned settings (key 'leave.type', subject = leave type id).
create table leave_types (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  color       text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

-- ---------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------
create table employees (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id),
  user_id              uuid unique references users(id),
  employee_code        text not null,
  full_name            text not null,
  email                text,
  phone                text,
  department_id        uuid references departments(id),
  role_id              uuid references roles(id),
  employment_type_id   uuid references employment_types(id),
  manager_id           uuid references employees(id),
  shift_id             uuid references shifts(id),
  location_id          uuid references locations(id),
  holiday_calendar_id  uuid references holiday_calendars(id),
  joining_date         date not null,
  probation_end_date   date,
  exit_date            date,
  status               text not null default 'active' check (status in ('active', 'inactive', 'exited')),
  custom_fields        jsonb not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, employee_code),
  check (manager_id is null or manager_id <> id)
);
create index employees_manager on employees (tenant_id, manager_id);
create index employees_department on employees (tenant_id, department_id);

-- ---------------------------------------------------------------------
-- Configuration store
-- ---------------------------------------------------------------------
-- A `setting` is a stable identity: (key, subject, scope). Its values over
-- time are rows in setting_versions.
--   key        e.g. 'wfh.policy', 'leave.type', 'attendance.calendar'
--   subject    optional entity the rule is about (a leave type, a shift)
--   scope      who it applies to: company | department | employment_type | role | employee
create table settings (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  key          text not null,
  subject_id   uuid,
  scope_type   text not null check (scope_type in ('company', 'department', 'employment_type', 'role', 'employee')),
  scope_id     uuid,
  name         text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  check ((scope_type = 'company') = (scope_id is null)),
  unique nulls not distinct (tenant_id, key, subject_id, scope_type, scope_id)
);

create table setting_versions (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id),
  setting_id            uuid not null references settings(id),
  version               int not null,
  status                text not null check (status in ('draft', 'published', 'archived')),
  value                 jsonb not null,
  effective_from        date,
  effective_to          date,
  change_note           text,
  based_on_version_id   uuid references setting_versions(id),
  created_by            uuid references users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  published_by          uuid references users(id),
  published_at          timestamptz,
  unique (setting_id, version),
  check (status = 'draft' or effective_from is not null),
  check (effective_to is null or effective_to >= effective_from)
);
create unique index setting_versions_one_draft on setting_versions (setting_id) where status = 'draft';
create index setting_versions_lookup on setting_versions (tenant_id, status, setting_id);

-- Editable starting points ("Hybrid 2 days", "Standard 30 leaves").
-- tenant_id null = global template offered to every tenant.
create table setting_templates (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id),
  key          text not null,
  code         text not null,
  name         text not null,
  description  text,
  value        jsonb not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique nulls not distinct (tenant_id, key, code)
);

create table feature_flags (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  module_key  text not null,
  enabled     boolean not null default false,
  config      jsonb not null default '{}',
  updated_at  timestamptz not null default now(),
  unique (tenant_id, module_key)
);

-- tenant_id null = product default text; tenant rows override (rename terms).
create table translations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references tenants(id),
  locale      text not null,
  key         text not null,
  value       text not null,
  updated_at  timestamptz not null default now(),
  unique nulls not distinct (tenant_id, locale, key)
);

create table custom_fields (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  entity      text not null check (entity in ('employee', 'leave_request', 'wfh_request')),
  field_key   text not null,
  label       text not null,
  field_type  text not null check (field_type in ('text', 'number', 'date', 'dropdown', 'file')),
  options     jsonb not null default '[]',
  required    boolean not null default false,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, entity, field_key)
);

-- ---------------------------------------------------------------------
-- Work from home
-- ---------------------------------------------------------------------
create table wfh_overrides (                           -- temporary exception, top priority
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  employee_id    uuid not null references employees(id),
  start_date     date not null,
  end_date       date not null,
  reason         text not null,
  bypass_limits  boolean not null default true,
  status         text not null default 'active' check (status in ('active', 'cancelled')),
  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  check (end_date >= start_date)
);
create index wfh_overrides_emp on wfh_overrides (tenant_id, employee_id, start_date);

create table wfh_requests (                            -- one row per requested date
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  employee_id       uuid not null references employees(id),
  request_group_id  uuid not null,
  date              date not null,
  status            text not null check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reason            text,
  recurrence        jsonb,
  auto_approved     boolean not null default false,
  policy_snapshot   jsonb,                              -- resolved policy + version ids used
  custom_fields     jsonb not null default '{}',
  decided_by        uuid references users(id),
  decided_at        timestamptz,
  decision_comment  text,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now()
);
create unique index wfh_requests_active_day on wfh_requests (employee_id, date) where status in ('pending', 'approved');
create index wfh_requests_emp_date on wfh_requests (tenant_id, employee_id, date);

-- ---------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------
create table leave_requests (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  employee_id       uuid not null references employees(id),
  leave_type_id     uuid not null references leave_types(id),
  start_date        date not null,
  end_date          date not null,
  unit              text not null default 'day' check (unit in ('day', 'half_day', 'hour')),
  half_day_part     text check (half_day_part in ('first', 'second')),
  hours             numeric(5, 2),
  days              numeric(6, 2) not null,             -- total days counted
  paid_days         numeric(6, 2) not null,
  unpaid_days       numeric(6, 2) not null default 0,   -- excess converted to unpaid
  status            text not null check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reason            text,
  attachment_ref    text,
  policy_snapshot   jsonb,
  custom_fields     jsonb not null default '{}',
  decided_by        uuid references users(id),
  decided_at        timestamptz,
  decision_comment  text,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  check (end_date >= start_date)
);
create index leave_requests_emp on leave_requests (tenant_id, employee_id, start_date);

-- Every balance movement, so a balance can be explained line by line.
create table leave_ledger (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id),
  employee_id           uuid not null references employees(id),
  leave_type_id         uuid not null references leave_types(id),
  leave_year            int not null,                   -- label = calendar year the leave year starts in
  entry_date            date not null,
  kind                  text not null check (kind in (
                          'grant', 'policy_adjustment', 'accrual', 'usage', 'usage_reversal',
                          'adjustment', 'carry_forward', 'lapse', 'expiry', 'encashment')),
  days                  numeric(7, 2) not null,
  period_key            text,                           -- idempotency key for automatic entries
  ref_type              text,
  ref_id                uuid,
  setting_version_ids   jsonb not null default '[]',
  note                  text,
  created_by            uuid references users(id),
  created_at            timestamptz not null default now()
);
create unique index leave_ledger_auto_once on leave_ledger (employee_id, leave_type_id, kind, period_key)
  where period_key is not null;
create index leave_ledger_emp_year on leave_ledger (tenant_id, employee_id, leave_type_id, leave_year);
create trigger leave_ledger_append_only before update or delete on leave_ledger
  for each row execute function reject_mutation();

-- ---------------------------------------------------------------------
-- Attendance (Phase 2 logic; tables defined now)
-- ---------------------------------------------------------------------
create table attendance_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  employee_id      uuid not null references employees(id),
  event_type       text not null check (event_type in ('in', 'out')),
  server_time      timestamptz not null default now(),
  device_time      timestamptz,
  work_date        date not null,
  lat              numeric(9, 6),
  lng              numeric(9, 6),
  accuracy_m       numeric(8, 2),
  method           text not null check (method in (
                     'office_auto', 'office_manual', 'wfh', 'web', 'system_autoclose', 'correction')),
  location_id      uuid references locations(id),
  selfie_ref       text,
  ip               text,
  device_id        text,
  time_verified    boolean not null default true,
  client_punch_id  text,
  correction_id    uuid,
  flags            jsonb not null default '[]',
  created_at       timestamptz not null default now(),
  unique (tenant_id, client_punch_id)
);
create index attendance_events_emp on attendance_events (tenant_id, employee_id, work_date);
create trigger attendance_events_append_only before update or delete on attendance_events
  for each row execute function reject_mutation();

create table attendance_corrections (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  employee_id      uuid not null references employees(id),
  work_date        date not null,
  event_type       text not null check (event_type in ('in', 'out')),
  corrected_time   timestamptz not null,
  target_event_id  uuid references attendance_events(id),
  reason           text not null,
  status           text not null check (status in ('pending', 'approved', 'rejected')),
  requested_by     uuid references users(id),
  decided_by       uuid references users(id),
  decided_at       timestamptz,
  decision_comment text,
  created_at       timestamptz not null default now()
);

-- Runtime approval steps; the workflow definitions are versioned settings
-- (key 'workflow', subject-less, one per request type in the value).
create table approval_tasks (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id),
  request_type          text not null,
  request_id            uuid not null,
  step_no               int not null,
  approver_kind         text not null,
  approver_employee_id  uuid references employees(id),
  status                text not null check (status in ('waiting', 'pending', 'approved', 'rejected', 'skipped', 'escalated')),
  due_at                timestamptz,
  decided_by            uuid references users(id),
  decided_at            timestamptz,
  comment               text,
  created_at            timestamptz not null default now()
);
create index approval_tasks_req on approval_tasks (tenant_id, request_type, request_id);

-- ---------------------------------------------------------------------
-- Payroll (Phase 4 logic; tables defined now).
-- Formulas, payroll rules and tax tables are versioned settings
-- ('payroll.component', 'payroll.rules', 'payroll.tax') so they get
-- draft/publish/history/rollback for free.
-- ---------------------------------------------------------------------
create table salary_components (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  kind        text not null check (kind in ('earning', 'deduction')),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create table salary_structures (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  employee_id     uuid not null references employees(id),
  effective_from  date not null,
  effective_to    date,
  note            text,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  unique (employee_id, effective_from)
);

create table salary_structure_lines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  structure_id  uuid not null references salary_structures(id),
  component_id  uuid not null references salary_components(id),
  amount        numeric(14, 2) not null,
  unique (structure_id, component_id)
);

create table payroll_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  period_key    text not null,
  period_start  date not null,
  period_end    date not null,
  status        text not null check (status in ('draft', 'review', 'approved', 'locked')),
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  approved_by   uuid references users(id),
  approved_at   timestamptz,
  locked_by     uuid references users(id),
  locked_at     timestamptz,
  unique (tenant_id, period_key)
);

create table payroll_items (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id),
  payroll_run_id        uuid not null references payroll_runs(id),
  employee_id           uuid not null references employees(id),
  component_id          uuid references salary_components(id),
  label                 text not null,
  kind                  text not null check (kind in ('earning', 'deduction', 'info')),
  amount                numeric(14, 2) not null,
  inputs                jsonb not null default '{}',     -- variables used, for traceability
  setting_version_ids   jsonb not null default '[]',
  created_at            timestamptz not null default now()
);

create table payslips (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  payroll_run_id  uuid not null references payroll_runs(id),
  employee_id     uuid not null references employees(id),
  gross           numeric(14, 2) not null,
  deductions      numeric(14, 2) not null,
  net             numeric(14, 2) not null,
  summary         jsonb not null default '{}',
  file_ref        text,
  created_at      timestamptz not null default now(),
  unique (payroll_run_id, employee_id)
);

create table loans (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  employee_id         uuid not null references employees(id),
  kind                text not null check (kind in ('loan', 'advance')),
  principal           numeric(14, 2) not null,
  installment_amount  numeric(14, 2) not null,
  start_period        text not null,
  status              text not null check (status in ('active', 'closed', 'cancelled')),
  note                text,
  created_by          uuid references users(id),
  created_at          timestamptz not null default now()
);

create table loan_installments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  loan_id         uuid not null references loans(id),
  period_key      text not null,
  amount          numeric(14, 2) not null,
  payroll_run_id  uuid references payroll_runs(id),
  status          text not null check (status in ('scheduled', 'deducted', 'skipped')),
  unique (loan_id, period_key)
);

-- ---------------------------------------------------------------------
-- Notifications, consent, audit
-- ---------------------------------------------------------------------
create table notifications (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  user_id       uuid not null references users(id),
  channel       text not null check (channel in ('in_app', 'email')),
  template_key  text not null,
  payload       jsonb not null default '{}',
  status        text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'read')),
  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index notifications_user on notifications (tenant_id, user_id, created_at desc);

create table consents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  user_id     uuid not null references users(id),
  kind        text not null check (kind in ('location', 'selfie')),
  granted     boolean not null,
  text_version text,
  created_at  timestamptz not null default now()
);

create table audit_log (
  id             bigint generated always as identity primary key,
  tenant_id      uuid references tenants(id),
  actor_user_id  uuid references users(id),
  action         text not null,
  entity_type    text not null,
  entity_id      text,
  old_value      jsonb,
  new_value      jsonb,
  meta           jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index audit_log_tenant on audit_log (tenant_id, created_at desc);
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function reject_mutation();
