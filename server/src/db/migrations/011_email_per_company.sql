-- The same email may have a separate login in several companies (one person,
-- or two people, working for different customers). An email is unique within
-- one company, and among super admins (tenant_id null). Signing in with an
-- email that matches several companies asks which company (see auth routes).
alter table users drop constraint users_email_key;
create unique index users_email_per_company on users (tenant_id, lower(email)) nulls not distinct;
create index users_email_lookup on users (lower(email));
