-- =====================================================================
-- 1. Manual attendance: HR (or the employee's manager) records a check-in /
--    check-out for someone else. A new append-only event like any other,
--    marked 'manual', with who entered it and why.
-- =====================================================================
alter table attendance_events drop constraint attendance_events_method_check;
alter table attendance_events add constraint attendance_events_method_check check (method in (
  'office_auto', 'office_manual', 'wfh', 'web', 'system_autoclose', 'correction', 'manual'));
alter table attendance_events add column entered_by uuid references users(id);
alter table attendance_events add column note text;

-- =====================================================================
-- 2. Per-employee module access. null = every module the company has on;
--    otherwise the list of personal modules this person may use
--    (attendance, wfh, leave, payroll, tasks). HR admins are never limited.
-- =====================================================================
alter table employees add column module_access jsonb
  check (module_access is null or jsonb_typeof(module_access) = 'array');

-- =====================================================================
-- 3. Daily tasks / work logs with file attachments.
--    Files are base64 text in 512 KB chunks, so they work the same on
--    PostgreSQL, PGlite and the Firebase mirror (which limits value sizes).
-- =====================================================================
create table work_logs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  employee_id  uuid not null references employees(id),
  work_date    date not null,
  title        text not null check (length(title) between 1 and 200),
  description  text check (description is null or length(description) <= 5000),
  hours        numeric(4, 2) not null check (hours >= 0 and hours <= 24),
  status       text not null check (status in ('completed', 'in_progress', 'blocked')),
  blocker      text check (blocker is null or length(blocker) <= 2000),
  links        jsonb not null default '[]',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index work_logs_emp_date on work_logs (tenant_id, employee_id, work_date);
create index work_logs_tenant_date on work_logs (tenant_id, work_date);

create table work_log_files (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  work_log_id  uuid not null references work_logs(id) on delete cascade,
  file_name    text not null,
  mime         text not null,
  size_bytes   int not null check (size_bytes > 0 and size_bytes <= 10485760),
  chunk_count  int not null check (chunk_count > 0),
  uploaded_by  uuid references users(id),
  created_at   timestamptz not null default now()
);
create index work_log_files_log on work_log_files (work_log_id);

create table work_log_file_chunks (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  file_id   uuid not null references work_log_files(id) on delete cascade,
  seq       int not null check (seq >= 0),
  data      text not null,
  unique (file_id, seq)
);

-- The new module: on for every company, and part of every plan.
insert into feature_flags (tenant_id, module_key, enabled)
  select id, 'tasks', true from tenants
  on conflict (tenant_id, module_key) do nothing;
update plans set modules = modules || '["tasks"]'::jsonb, updated_at = now()
  where modules is not null and not modules @> '["tasks"]'::jsonb;
update subscriptions set modules = modules || '["tasks"]'::jsonb
  where modules is not null and not modules @> '["tasks"]'::jsonb;

insert into translations (tenant_id, locale, key, value) values
  (null, 'en', 'notify.attendance_recorded.title', 'Attendance recorded for {date}'),
  (null, 'en', 'notify.attendance_recorded.body', '{enteredBy} recorded your attendance on {date}: {times}. Reason: {reason}'),
  (null, 'en', 'notify.task_blocked.title', 'Blocked: {title}'),
  (null, 'en', 'notify.task_blocked.body', '{employeeName} is blocked on "{title}" ({date}): {blocker}'),
  (null, 'en', 'attendance.manual_in_future', 'Manual attendance can''t be in the future.'),
  (null, 'en', 'attendance.manual_overlaps', 'This overlaps attendance already recorded ({time}). Request a correction instead, or pick other times.'),
  (null, 'en', 'attendance.manual_open_after', 'There is a later check-in at {time} without a check-out. Enter a check-out time too.'),
  (null, 'en', 'attendance.manual_no_check_in', 'There is no open check-in on {date} to close. Enter a check-in time too.'),
  (null, 'en', 'attendance.manual_not_employed', '{date} is outside this person''s employment dates.'),
  (null, 'en', 'flag.manual_entry', 'Entered manually'),
  (null, 'ur', 'flag.manual_entry', 'دستی اندراج')
on conflict (tenant_id, locale, key) do nothing;
