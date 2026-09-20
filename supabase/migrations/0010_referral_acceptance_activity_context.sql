-- Referral acknowledgement and activity context.
-- Safe to run after 0009; existing rows remain valid and are labelled as
-- legacy where the new detail was not previously captured.

alter table referrals
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by_identity_user_id uuid references auth.users(id) on delete set null;

alter table hours
  add column if not exists site text,
  add column if not exists service_type text;

alter table hours drop constraint if exists hours_service_type_check;
alter table hours add constraint hours_service_type_check
  check (service_type is null or service_type in ('Group counselling','Family counselling','Other activity'));

create index if not exists idx_hours_site on hours(intern_profile_id, site, work_date desc);

create or replace function report_activity_breakdown(p_intern_id int, p_start date, p_end date)
returns table (service_type text, site text, hours numeric)
language sql stable as $$
  with activity as (
    select 'Individual counselling'::text service_type,
           coalesce(e.site, 'Facility not recorded')::text site,
           sum(e.duration_minutes)::numeric / 60 hours
    from encounters e
    where e.intern_profile_id = p_intern_id and e.attended
      and e.encounter_date >= p_start and e.encounter_date < p_end
    group by coalesce(e.site, 'Facility not recorded')
    union all
    select coalesce(h.service_type, 'Other activity')::text,
           coalesce(h.site, 'Facility not recorded')::text,
           sum(h.hours)::numeric
    from hours h
    where h.intern_profile_id = p_intern_id
      and h.work_date >= p_start and h.work_date < p_end
    group by coalesce(h.service_type, 'Other activity'), coalesce(h.site, 'Facility not recorded')
  )
  select activity.service_type, activity.site, round(sum(activity.hours), 1)
  from activity
  group by activity.service_type, activity.site
  order by activity.service_type, activity.site;
$$;
