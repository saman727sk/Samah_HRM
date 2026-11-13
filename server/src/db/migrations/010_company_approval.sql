-- The super admin decides which companies may use the platform: a company
-- that signs itself up starts as 'pending' (nobody can sign in) until it is
-- approved. Companies the super admin creates are active at once.
alter table tenants drop constraint tenants_status_check;
alter table tenants add constraint tenants_status_check check (status in ('pending', 'active', 'suspended'));

update platform_settings set value = value || '{"signupRequiresApproval": true}' where id = 'billing';
