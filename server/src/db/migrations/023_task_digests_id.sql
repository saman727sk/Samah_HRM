-- The Firebase mirror keys every row by an "id" column: give task_digests one
-- (it had a (tenant_id, day) primary key). Still one reminder run per company-day.
alter table task_digests add column id uuid not null default gen_random_uuid();
alter table task_digests drop constraint task_digests_pkey;
alter table task_digests add primary key (id);
alter table task_digests add constraint task_digests_tenant_day unique (tenant_id, day);
