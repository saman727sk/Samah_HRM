-- =====================================================================
-- Firebase: Authentication (email/password) and Realtime Database as the
-- system of record (see src/firebase/sync.js).
-- =====================================================================

-- Firebase owns passwords; a Firebase-backed user has no local hash.
alter table users add column firebase_uid text unique;
alter table users alter column password_hash drop not null;

-- Which version of the Realtime Database copy this local database matches.
create table _sync_state (
  id          int primary key default 1 check (id = 1),
  version     bigint not null default 0,
  source      text,                                  -- database URL + root the version refers to
  updated_at  timestamptz not null default now()
);
insert into _sync_state (id) values (1);

-- Rows changed locally and not yet written to Firebase. Kept on disk, so a
-- crash or lost connection never loses a change; it is sent on the next flush.
create table _changes (
  id          bigserial primary key,
  tbl         text not null,
  pk          text not null,
  op          text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  row         jsonb,
  created_at  timestamptz not null default now()
);

-- Attached to every business table when Firebase sync is on (sync.js
-- installs it at startup, so tables added by later migrations are covered).
create function capture_change() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    insert into _changes (tbl, pk, op) values (TG_TABLE_NAME, old.id::text, 'DELETE');
    return old;
  end if;
  insert into _changes (tbl, pk, op, row) values (TG_TABLE_NAME, new.id::text, TG_OP, to_jsonb(new));
  return new;
end $$;
