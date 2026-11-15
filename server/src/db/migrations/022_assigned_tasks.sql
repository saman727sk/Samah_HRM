-- =====================================================================
-- Assigned tasks: a manager (or HR) gives a task to someone under them, with a
-- description, due date and priority. The person moves it through
-- to do -> in progress -> done (or blocked), and both sides discuss it in a
-- message thread on the task. Part of the existing 'tasks' module.
--
-- task_digests remembers which company-days already got the morning
-- "your tasks for today" reminder, so the job sends it once per day.
-- =====================================================================

create table assigned_tasks (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  number           int not null,                                       -- per company: #1, #2...
  employee_id      uuid not null references employees(id),             -- who does it
  assigned_by      uuid references users(id),                          -- null if that login was removed
  title            text not null check (length(title) between 1 and 200),
  description      text check (description is null or length(description) <= 5000),
  due_date         date not null,
  priority         text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status           text not null default 'todo' check (status in ('todo', 'in_progress', 'done', 'blocked')),
  completed_at     timestamptz,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, number),
  unique (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id)
);
create index assigned_tasks_employee on assigned_tasks (tenant_id, employee_id, status, due_date);
create index assigned_tasks_by on assigned_tasks (tenant_id, assigned_by, status, due_date);
create index assigned_tasks_due on assigned_tasks (tenant_id, due_date) where status <> 'done';

create table task_messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  task_id         uuid not null,
  author_user_id  uuid references users(id),
  kind            text not null default 'message' check (kind in ('message', 'status')),
  body            text not null check (length(body) between 1 and 5000),
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, task_id) references assigned_tasks (tenant_id, id) on delete cascade
);
create index task_messages_task on task_messages (tenant_id, task_id, created_at);

create table task_digests (
  tenant_id  uuid not null references tenants(id),
  day        date not null,
  sent       int not null default 0,
  created_at timestamptz not null default now(),
  primary key (tenant_id, day)
);

insert into translations (tenant_id, locale, key, value) values
  (null, 'en', 'notify.task_assigned.title', 'New task: {title}'),
  (null, 'en', 'notify.task_assigned.body', '{by} gave you a task, due {due}. Priority: {priority}.'),
  (null, 'en', 'notify.task_changed.title', 'Task changed: {title}'),
  (null, 'en', 'notify.task_changed.body', '{by} changed this task. It is now due {due}.'),
  (null, 'en', 'notify.tasks_today.title', 'Your tasks for today ({count})'),
  (null, 'en', 'notify.tasks_today.body', '{list}'),
  (null, 'en', 'notify.task_message.title', '{name} on "{title}"'),
  (null, 'en', 'notify.task_message.body', '{preview}'),
  (null, 'en', 'notify.task_status.title', '{name}: "{title}" is {status}'),
  (null, 'en', 'notify.task_status.body', '{name} marked the task {status}.{note}')
on conflict (tenant_id, locale, key) do nothing;
