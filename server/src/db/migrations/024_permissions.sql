-- =====================================================================
-- Per-person rights, set by HR on the "Teams & access" page.
--   null = the defaults for the person's access level:
--     manager / team lead: team.approve, team.rota, team.tasks, team.attendance
--     employee: nothing extra
--   otherwise the list of granted rights:
--     team.approve     approve leave, WFH and overtime of their team
--     team.rota        plan their team's rota
--     team.tasks       assign tasks to their team and read their work logs
--     team.attendance  record attendance for their team
--     team.access      choose which features each person in their team can use
--     helpdesk         answer everyone's help desk requests (e.g. a support manager)
--     payroll          run payroll and manage salaries and loans (e.g. a payroll manager)
-- HR admins always have every right. See services/permissions.js.
-- =====================================================================
alter table employees add column permissions jsonb
  check (permissions is null or jsonb_typeof(permissions) = 'array');

insert into translations (tenant_id, locale, key, value) values
  (null, 'en', 'notify.access_changed.title', 'Your access changed'),
  (null, 'en', 'notify.access_changed.body', '{by} changed what you can do in the app: {summary}.')
on conflict (tenant_id, locale, key) do nothing;
