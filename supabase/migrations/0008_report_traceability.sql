-- =========================================================================
-- 0008 -- Prompt 7: make Monthly Reports / Programme Evidence figures
-- traceable and suitable for governance use.
--
-- 1) report_encounter_stats had two bugs, both silently wrong on every
--    report, every month: it filtered session_type = 'First', but the only
--    values ever stored are 'Intake'/'Follow-up'/'Termination' (see
--    SESSION_TYPES in functions/_shared/util.js and the check constraint on
--    encounters.session_type) — so "Intake" always showed 0 — and it never
--    counted 'Termination' sessions at all, so "Terminations" always showed
--    0 too. It also only ever counted Female/Male, silently dropping
--    Other/Unknown from the reported total (female+male never summed to
--    attended). Fixed to count all four session types and all four gender
--    values.
--
-- 2) range_requirement_hours only ever returned a component's combined
--    total, with no way to tell whether it came from attended sessions or
--    manually logged activity (data provenance). It now also returns
--    encounter_hours and manual_hours separately. This changes the
--    function's return columns, which `create or replace` cannot do, so it
--    is dropped and recreated.
--
-- 3) report_trend_stats is new: booked/attended/hours per month for the
--    last N months, so Reports can show a trend instead of asserting one
--    exists with a single snapshot.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- =========================================================================

create or replace function report_encounter_stats(p_intern_id int, p_start date, p_end date)
returns jsonb
language sql as $$
  select jsonb_build_object(
    'booked', count(*)::int,
    'attended', count(*) filter(where attended)::int,
    'female', count(*) filter(where attended and patient_gender = 'Female')::int,
    'male', count(*) filter(where attended and patient_gender = 'Male')::int,
    'other_gender', count(*) filter(where attended and patient_gender = 'Other')::int,
    'not_recorded_gender', count(*) filter(where attended and patient_gender = 'Unknown')::int,
    'intake_sessions', count(*) filter(where attended and session_type = 'Intake')::int,
    'follow_up_sessions', count(*) filter(where attended and session_type = 'Follow-up')::int,
    'termination_sessions', count(*) filter(where attended and session_type = 'Termination')::int,
    'counselling_minutes', coalesce(sum(duration_minutes) filter(where attended), 0)::float
  )
  from encounters where intern_profile_id = p_intern_id and encounter_date >= p_start and encounter_date < p_end;
$$;

drop function if exists range_requirement_hours(int, date, date);

create function range_requirement_hours(p_intern_id int, p_start date, p_end date)
returns table (code text, name text, total numeric, encounter_hours numeric, manual_hours numeric)
language plpgsql as $$
declare v_rp_id int; v_encounter_hours numeric;
begin
  select requirement_profile_id into v_rp_id from profiles where id = p_intern_id;
  select coalesce(sum(duration_minutes) filter(where attended), 0)::float / 60 into v_encounter_hours
  from encounters where intern_profile_id = p_intern_id and encounter_date >= p_start and encounter_date < p_end;

  return query
  select t.code, t.name, t.total, t.encounter_hours, t.manual_hours from (
    select c.code, c.name,
      round((case
        when c.calculation_mode = 'individual_encounters' then v_encounter_hours
        when c.calculation_mode = 'manual_plus_individual_encounters' then coalesce(m.total, 0) + v_encounter_hours
        else coalesce(m.total, 0)
      end)::numeric, 1) as total,
      round((case when c.calculation_mode in ('individual_encounters', 'manual_plus_individual_encounters') then v_encounter_hours else 0 end)::numeric, 1) as encounter_hours,
      round(coalesce(m.total, 0)::numeric, 1) as manual_hours
    from requirement_components c
    left join (
      select component_code, sum(hours)::float total from hours
      where intern_profile_id = p_intern_id and work_date >= p_start and work_date < p_end
      group by component_code
    ) m on m.component_code = c.code
    where c.requirement_profile_id = v_rp_id and c.target_hours is not null
  ) t
  where t.total > 0;
end;
$$;

-- `hours` here is total attended-session + manually-logged formal activity
-- for the month (encounter_hours + manual_hours) — a general "how much
-- formal activity happened" trend line, not the same figure as a specific
-- component's progress-tracking total.
create or replace function report_trend_stats(p_intern_id int, p_months int default 6)
returns table (month date, booked int, attended int, hours numeric)
language plpgsql as $$
begin
  return query
  select gs.month::date,
    coalesce(e.booked, 0)::int,
    coalesce(e.attended, 0)::int,
    round((coalesce(e.encounter_hours, 0) + coalesce(h.manual_hours, 0))::numeric, 1)
  from generate_series(date_trunc('month', current_date) - ((p_months - 1) || ' months')::interval, date_trunc('month', current_date), interval '1 month') as gs(month)
  left join (
    select date_trunc('month', encounter_date) as month,
      count(*)::int as booked,
      count(*) filter(where attended)::int as attended,
      coalesce(sum(duration_minutes) filter(where attended), 0)::float / 60 as encounter_hours
    from encounters where intern_profile_id = p_intern_id
    group by 1
  ) e on e.month = gs.month
  left join (
    select date_trunc('month', work_date) as month, sum(hours)::float as manual_hours
    from hours where intern_profile_id = p_intern_id
    group by 1
  ) h on h.month = gs.month
  order by gs.month;
end;
$$;
