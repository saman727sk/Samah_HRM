-- Two-step sign-in: after the password is right, a 6-digit code is emailed and must be
-- entered within 10 minutes. The browser holds a random challenge token; only hashes of the
-- token and the code are stored. Like password_resets, no foreign key (Firebase reload TRUNCATE).
create table login_challenges (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  token_hash    text not null unique,
  code_hash     text not null,
  expires_at    timestamptz not null,
  attempts      int not null default 0,     -- wrong codes entered
  sends         int not null default 1,     -- codes emailed (first + resends)
  last_sent_at  timestamptz not null default now(),
  used_at       timestamptz,
  ip            text,
  created_at    timestamptz not null default now()
);
create index login_challenges_user on login_challenges (user_id);

-- On by default for this installation (the super admin can turn it off under Settings).
update platform_settings set value = value || '{"loginOtp": true}'::jsonb where id = 'billing';
