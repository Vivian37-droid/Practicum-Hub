-- =========================================================================
-- 0007 -- Prompt 4: protect destructive and finalising actions.
--
-- audit_log gains:
--   reason       -- optional/required operator-supplied justification for a
--                    destructive or correcting action (e.g. why an intern
--                    placement was deactivated, why an hours entry was
--                    corrected). Was structurally absent before this.
--   restored_at  -- set the first time a 'delete' row is used to restore a
--                    referral/supervision/pilot_feedback record, so the same
--                    deletion can't be restored twice into two rows.
--
-- upsert_monthly_report is fixed so a second "Reviewed" call (re-clicking
-- "Mark reviewed", or a second reviewer) can no longer silently re-stamp
-- reviewed_at/reviewed_by_name — those are now only-set-once, the same
-- pattern already used elsewhere in this file (update_case_status,
-- update_referral). A repeat review call still updates supervisor_comment.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- =========================================================================
alter table audit_log add column if not exists reason text;
alter table audit_log add column if not exists restored_at timestamptz;

create or replace function upsert_monthly_report(
  p_intern_id int, p_month date, p_status text, p_intern_comment text, p_supervisor_comment text,
  p_reviewed_by_name text default null
) returns monthly_reports
language plpgsql as $$
declare result monthly_reports;
begin
  insert into monthly_reports(intern_profile_id, month, status, intern_comment, supervisor_comment, submitted_at, reviewed_at, reviewed_by_name)
  values (p_intern_id, p_month, p_status, p_intern_comment, p_supervisor_comment,
    case when p_status = 'Submitted' then now() end,
    case when p_status = 'Reviewed' then now() end,
    case when p_status = 'Reviewed' then p_reviewed_by_name end)
  on conflict(intern_profile_id, month) do update set status = excluded.status,
    intern_comment = coalesce(excluded.intern_comment, monthly_reports.intern_comment),
    supervisor_comment = coalesce(excluded.supervisor_comment, monthly_reports.supervisor_comment),
    submitted_at = case when excluded.status = 'Submitted' then now() else monthly_reports.submitted_at end,
    reviewed_at = coalesce(monthly_reports.reviewed_at, case when excluded.status = 'Reviewed' then now() end),
    reviewed_by_name = coalesce(monthly_reports.reviewed_by_name, case when excluded.status = 'Reviewed' then excluded.reviewed_by_name end),
    updated_at = now()
  returning * into result;
  return result;
end;
$$;
