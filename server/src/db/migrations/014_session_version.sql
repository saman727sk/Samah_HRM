-- Ending sessions after a password change, reliably: every local sign-in token
-- carries the user's session_version; changing the password increments it, so
-- all tokens issued before stop working at once (no reliance on timestamps).
alter table users add column session_version int not null default 0;
