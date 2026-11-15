-- =====================================================================
-- Rota: the shift a person works on a given day, set by their manager or HR.
--   One row per employee and date. shift_id = work that shift that day (it replaces the person's
--   usual shift for attendance); is_off = a rest day (counts like a weekend day). No row = the usual
--   shift and calendar apply. Attendance and payroll read it through services/rota.js.
--
-- Help desk: an employee asks HR something (payslip, leave balance, IT...), HR answers in a thread.
-- =====================================================================

create table rota_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  employee_id  uuid not null references employees(id),
  date         date not null,
  shift_id     uuid references shifts(id),
  is_off       boolean not null default false,
  note         text check (note is null or length(note) <= 200),
  updated_by   uuid references users(id),
  updated_at   timestamptz not null default now(),
  unique (employee_id, date),
  check (is_off or shift_id is not null),
  check (not (is_off and shift_id is not null)),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, shift_id) references shifts (tenant_id, id)
);
create index rota_entries_tenant_date on rota_entries (tenant_id, date);

create table support_tickets (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  number           int not null,                                     -- per company: #1, #2...
  employee_id      uuid not null references employees(id),
  category         text not null check (category in ('payroll', 'leave', 'attendance', 'it', 'documents', 'other')),
  subject          text not null check (length(subject) between 3 and 150),
  status           text not null default 'open' check (status in ('open', 'answered', 'closed')),
  last_message_at  timestamptz not null default now(),
  closed_at        timestamptz,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  unique (tenant_id, number),
  unique (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id)
);
create index support_tickets_status on support_tickets (tenant_id, status, last_message_at desc);
create index support_tickets_employee on support_tickets (tenant_id, employee_id, last_message_at desc);

create table support_messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  ticket_id       uuid not null,
  author_user_id  uuid references users(id),
  from_hr         boolean not null default false,
  body            text not null check (length(body) between 1 and 5000),
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, ticket_id) references support_tickets (tenant_id, id)
);
create index support_messages_ticket on support_messages (tenant_id, ticket_id, created_at);

insert into translations (tenant_id, locale, key, value) values
  (null, 'en', 'notify.rota_changed.title', 'Your rota changed'),
  (null, 'en', 'notify.rota_changed.body', '{by} updated your shifts for the week of {week}. See them on your dashboard.'),
  (null, 'en', 'notify.ticket_new.title', 'Help desk #{number}: {subject}'),
  (null, 'en', 'notify.ticket_new.body', '{name} asked HR ({category}).'),
  (null, 'en', 'notify.ticket_reply.title', 'Reply on #{number}: {subject}'),
  (null, 'en', 'notify.ticket_reply.body', '{name}: {preview}'),
  (null, 'en', 'notify.ticket_closed.title', 'Request #{number} closed'),
  (null, 'en', 'notify.ticket_closed.body', '"{subject}" was closed. Reply to it to open it again.');
