-- Three more example plans (prices in PKR are placeholders: edit them in the super admin panel).
-- Skipped if a plan with the same code already exists, so plans you made yourself are kept.
insert into plans (code, name, description, price_monthly, price_yearly, trial_days, max_employees, max_admins, modules, sort_order) values
  ('basic', 'Basic', 'Attendance and leave for very small teams.', 2499, 24990, 0, 10, 1,
    '["attendance", "leave"]', 1),
  ('growth', 'Growth', 'Starter plus payroll, for growing teams.', 7499, 74990, 0, 50, 3,
    '["attendance", "wfh", "leave", "payroll"]', 3),
  ('business', 'Business', 'Every module for larger companies.', 17999, 179990, 0, 250, 10, null, 5)
on conflict (code) do nothing;

-- Keep the price order: trial, basic, starter, growth, professional, business, enterprise.
update plans set sort_order = 2 where code = 'starter' and sort_order = 1;
update plans set sort_order = 4 where code = 'professional' and sort_order = 2;
update plans set sort_order = 6 where code = 'enterprise' and sort_order = 3;
