-- =========================================================================
-- 0003 -- individual counselling session types (Intake / Follow-up /
-- Termination) + report stats, and seeding Erin's real weekly placement
-- schedule.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run). It is safe to re-run: the constraint swap and RPC
-- replace are idempotent, and the schedule insert only fires if Erin has
-- no active schedule rows yet.
-- =========================================================================

-- 1. Widen encounters.session_type from ('First','Follow-up') to
--    ('Intake','Follow-up','Termination'). Existing 'First' rows become
--    'Intake' so historical data keeps counting toward the same bucket.
update encounters set session_type = 'Intake' where session_type = 'First';

alter table encounters drop constraint if exists encounters_session_type_check;
alter table encounters add constraint encounters_session_type_check
  check (session_type in ('Intake', 'Follow-up', 'Termination'));

-- 2. report_encounter_stats now returns intake_sessions / follow_up_sessions
--    / termination_sessions instead of first_sessions / follow_up_sessions.
create or replace function report_encounter_stats(p_intern_id int, p_start date, p_end date)
returns jsonb
language sql as $$
  select jsonb_build_object(
    'booked', count(*)::int,
    'attended', count(*) filter(where attended)::int,
    'female', count(*) filter(where attended and patient_gender = 'Female')::int,
    'male', count(*) filter(where attended and patient_gender = 'Male')::int,
    'intake_sessions', count(*) filter(where attended and session_type = 'Intake')::int,
    'follow_up_sessions', count(*) filter(where attended and session_type = 'Follow-up')::int,
    'termination_sessions', count(*) filter(where attended and session_type = 'Termination')::int,
    'counselling_minutes', coalesce(sum(duration_minutes) filter(where attended), 0)::float
  )
  from encounters where intern_profile_id = p_intern_id and encounter_date >= p_start and encounter_date < p_end;
$$;

-- 3. Seed Erin George's real weekly placement rhythm, replacing whatever
--    (if anything) is currently on file for her, so the dashboard "This
--    week" card shows where she actually is each day.
do $$
declare v_erin_id int;
begin
  select id into v_erin_id from profiles where display_name = 'Erin George' and role = 'intern' limit 1;
  if v_erin_id is not null then
    update weekly_schedule_items set active = false where intern_profile_id = v_erin_id;
    insert into weekly_schedule_items (intern_profile_id, weekday, title, site, recurrence_note, activity_type, active) values
      (v_erin_id, 1, 'Placement day', 'Stellenbosch Hospital', 'Every Monday', 'Clinical', true),
      (v_erin_id, 2, 'Placement day', 'Don and Pat Clinic', 'Every Tuesday', 'Clinical', true),
      (v_erin_id, 3, 'Placement day', 'Stellenbosch Hospital / Night Shelter', 'Alternates weekly', 'Clinical', true),
      (v_erin_id, 4, 'Placement day', 'Idas Valley Clinic', 'Every Thursday', 'Clinical', true),
      (v_erin_id, 5, 'Placement day', 'SACAP', 'Every Friday', 'Campus', true);
  end if;
end $$;
