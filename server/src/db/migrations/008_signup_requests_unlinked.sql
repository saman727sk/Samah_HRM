-- signup_requests is never synced to Firebase (it holds password and token
-- hashes). A foreign key from it to tenants would make the Firebase reload's
-- TRUNCATE of tenants fail, so the link to the created company is kept as a
-- plain id.
alter table signup_requests drop constraint signup_requests_tenant_id_fkey;
