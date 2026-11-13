-- "Forgot password" by email (local sign-in; Firebase sign-in uses Firebase's own reset email).
-- A reset link carries a random token stored only as a SHA-256 hash, works once, for one hour.
-- Like signup_requests, this table is never synced to Firebase (it holds token hashes), so it
-- refers to the user by plain id: a foreign key would block the Firebase reload's TRUNCATE.
create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz not null default now()
);
create index password_resets_user on password_resets (user_id);

-- Sessions (JWTs) issued before a password change stop working.
alter table users add column password_changed_at timestamptz;
