-- =========================================================================
-- 0006 -- record who reviewed a monthly report, and when, so Reports can
-- show reviewer identity instead of just a status tag (Prompt 1: report
-- identity). reviewed_at already existed; reviewed_by_name is new and is
-- only ever set from the authenticated session server-side, never from
-- client input, so it can't be spoofed.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- =========================================================================
alter table monthly_reports add column if not exists reviewed_by_name text;

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
    reviewed_at = case when excluded.status = 'Reviewed' then now() else monthly_reports.reviewed_at end,
    reviewed_by_name = case when excluded.status = 'Reviewed' then excluded.reviewed_by_name else monthly_reports.reviewed_by_name end,
    updated_at = now()
  returning * into result;
  return result;
end;
$$;
