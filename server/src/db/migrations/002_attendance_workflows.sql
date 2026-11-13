-- =====================================================================
-- Phase 2: attendance punches, device binding, workflow bookkeeping
-- =====================================================================

-- The instant attendance is calculated from. For online punches this is the
-- server time; for offline punches it is the server-anchored or (flagged as
-- unverified) device time. server_time always records when we received it.
alter table attendance_events add column punch_time timestamptz not null default now();
alter table attendance_events alter column punch_time drop default;
create index attendance_events_punch on attendance_events (tenant_id, employee_id, punch_time);

-- Registered devices / networks, used for "IP/device binding" WFH
-- verification and as the non-biometric alternative to a selfie.
create table employee_devices (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  employee_id  uuid not null references employees(id),
  device_id    text,
  ip           text,
  label        text,
  status       text not null default 'active' check (status in ('active', 'revoked')),
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  check (device_id is not null or ip is not null)
);
create index employee_devices_emp on employee_devices (tenant_id, employee_id) where status = 'active';

-- Workflow resolved at submit time, so editing a workflow never changes
-- requests already in flight.
alter table approval_tasks add column workflow_snapshot jsonb;
alter table approval_tasks add column escalated_from uuid references approval_tasks(id);
alter table approval_tasks add column override boolean not null default false;
create index approval_tasks_inbox on approval_tasks (tenant_id, status, approver_employee_id);

alter table attendance_corrections drop constraint attendance_corrections_status_check;
alter table attendance_corrections add constraint attendance_corrections_status_check
  check (status in ('pending', 'approved', 'rejected', 'cancelled'));
