-- =========================================================================
-- 0009 -- Prompt 8: "Supervision: add priority, due date, related
-- de-identified case code, assigned supervisor, response and resolution
-- state." Priority, case code, response (supervisor_note) and resolution
-- state (status) already existed (0001_init.sql) — this adds the two that
-- didn't: a due date, and which supervisor a routine/important item is
-- assigned to (previously only visible to whichever supervisor manages the
-- intern, with no way to hand a specific item to a named supervisor).
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- =========================================================================
alter table supervision_items add column if not exists due_date date;
alter table supervision_items add column if not exists assigned_supervisor_identity_user_id uuid references auth.users(id) on delete set null;
create index if not exists idx_supervision_due on supervision_items(due_date) where due_date is not null;
