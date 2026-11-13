-- =====================================================================
-- Tenant integrity: a row can only point at rows of its own company.
--
-- The original foreign keys were single-column (employee_id -> employees.id),
-- so the database accepted e.g. a leave_ledger row of company A for an
-- employee of company B. Each reference below gets an extra composite key
--   (tenant_id, x_id) -> parent (tenant_id, id)
-- The old single-column keys stay (nothing is dropped or rewritten).
--
-- Before each key is added, existing rows are checked; if any row already
-- crosses companies the migration stops with a readable message and changes
-- nothing (it runs in one transaction).
-- Actor columns (created_by, decided_by...) are not covered: a super admin
-- (tenant_id null) may act inside a company.
-- =====================================================================

-- Composite targets: (tenant_id, id) must be unique on every parent table.
alter table users              add constraint users_tenant_id_key              unique (tenant_id, id);
alter table departments        add constraint departments_tenant_id_key        unique (tenant_id, id);
alter table roles              add constraint roles_tenant_id_key              unique (tenant_id, id);
alter table employment_types   add constraint employment_types_tenant_id_key   unique (tenant_id, id);
alter table locations          add constraint locations_tenant_id_key          unique (tenant_id, id);
alter table shifts             add constraint shifts_tenant_id_key             unique (tenant_id, id);
alter table holiday_calendars  add constraint holiday_calendars_tenant_id_key  unique (tenant_id, id);
alter table leave_types        add constraint leave_types_tenant_id_key        unique (tenant_id, id);
alter table employees          add constraint employees_tenant_id_key          unique (tenant_id, id);
alter table settings           add constraint settings_tenant_id_key           unique (tenant_id, id);
alter table setting_versions   add constraint setting_versions_tenant_id_key   unique (tenant_id, id);
alter table attendance_events  add constraint attendance_events_tenant_id_key  unique (tenant_id, id);
alter table approval_tasks     add constraint approval_tasks_tenant_id_key     unique (tenant_id, id);
alter table salary_components  add constraint salary_components_tenant_id_key  unique (tenant_id, id);
alter table salary_structures  add constraint salary_structures_tenant_id_key  unique (tenant_id, id);
alter table payroll_runs       add constraint payroll_runs_tenant_id_key       unique (tenant_id, id);
alter table loans              add constraint loans_tenant_id_key              unique (tenant_id, id);

-- Checks existing rows, then adds the composite key. Removed at the end.
create function _add_tenant_fk(child text, col text, parent text) returns void language plpgsql as $$
declare
  bad bigint;
begin
  execute format(
    'select count(*) from %I c where c.%I is not null and not exists
       (select 1 from %I p where p.id = c.%I and p.tenant_id is not distinct from c.tenant_id)',
    child, col, parent, col) into bad;
  if bad > 0 then
    raise exception '% row(s) in %.% point at a % row of another company. Fix or remove them, then run the migration again.',
      bad, child, col, parent;
  end if;
  execute format('alter table %I add constraint %I foreign key (tenant_id, %I) references %I (tenant_id, id)',
    child, child || '_' || col || '_tenant_fk', col, parent);
end $$;

select _add_tenant_fk('departments', 'parent_id', 'departments');
select _add_tenant_fk('holidays', 'calendar_id', 'holiday_calendars');

select _add_tenant_fk('employees', 'user_id', 'users');
select _add_tenant_fk('employees', 'department_id', 'departments');
select _add_tenant_fk('employees', 'role_id', 'roles');
select _add_tenant_fk('employees', 'employment_type_id', 'employment_types');
select _add_tenant_fk('employees', 'manager_id', 'employees');
select _add_tenant_fk('employees', 'shift_id', 'shifts');
select _add_tenant_fk('employees', 'location_id', 'locations');
select _add_tenant_fk('employees', 'holiday_calendar_id', 'holiday_calendars');

select _add_tenant_fk('setting_versions', 'setting_id', 'settings');
select _add_tenant_fk('setting_versions', 'based_on_version_id', 'setting_versions');

select _add_tenant_fk('wfh_overrides', 'employee_id', 'employees');
select _add_tenant_fk('wfh_requests', 'employee_id', 'employees');
select _add_tenant_fk('leave_requests', 'employee_id', 'employees');
select _add_tenant_fk('leave_requests', 'leave_type_id', 'leave_types');
select _add_tenant_fk('leave_ledger', 'employee_id', 'employees');
select _add_tenant_fk('leave_ledger', 'leave_type_id', 'leave_types');

select _add_tenant_fk('attendance_events', 'employee_id', 'employees');
select _add_tenant_fk('attendance_events', 'location_id', 'locations');
select _add_tenant_fk('attendance_corrections', 'employee_id', 'employees');
select _add_tenant_fk('attendance_corrections', 'target_event_id', 'attendance_events');
select _add_tenant_fk('approval_tasks', 'approver_employee_id', 'employees');
select _add_tenant_fk('approval_tasks', 'escalated_from', 'approval_tasks');
select _add_tenant_fk('employee_devices', 'employee_id', 'employees');

select _add_tenant_fk('salary_structures', 'employee_id', 'employees');
select _add_tenant_fk('salary_structure_lines', 'structure_id', 'salary_structures');
select _add_tenant_fk('salary_structure_lines', 'component_id', 'salary_components');
select _add_tenant_fk('payroll_items', 'payroll_run_id', 'payroll_runs');
select _add_tenant_fk('payroll_items', 'employee_id', 'employees');
select _add_tenant_fk('payroll_items', 'component_id', 'salary_components');
select _add_tenant_fk('payslips', 'payroll_run_id', 'payroll_runs');
select _add_tenant_fk('payslips', 'employee_id', 'employees');
select _add_tenant_fk('loans', 'employee_id', 'employees');
select _add_tenant_fk('loan_installments', 'loan_id', 'loans');
select _add_tenant_fk('loan_installments', 'payroll_run_id', 'payroll_runs');
select _add_tenant_fk('employee_payment_details', 'employee_id', 'employees');
select _add_tenant_fk('overtime_claims', 'employee_id', 'employees');

select _add_tenant_fk('notifications', 'user_id', 'users');
select _add_tenant_fk('consents', 'user_id', 'users');

drop function _add_tenant_fk(text, text, text);
