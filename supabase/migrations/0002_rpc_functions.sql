-- Cloudflare Pages Functions ↔ Supabase over raw TCP (postgres.js against the
-- Supavisor connection pooler) turned out to be unreliable from this Workers
-- runtime: connections were failing at the network/TLS layer before ever
-- reaching Postgres (confirmed by enabling connection logging and seeing zero
-- corresponding entries), and postgres.js's own reconnect loop then burned
-- through Cloudflare's per-invocation subrequest limit before the runtime
-- forcibly cancelled the request ("Too many subrequests by single Worker
-- invocation"). postgres.js's own docs recommend Cloudflare Hyperdrive for
-- Workers; short of standing up that extra piece of infrastructure, the
-- robust fix is to stop opening raw Postgres sockets from the Worker at all
-- and talk to Supabase exclusively over HTTP, via PostgREST — which is what
-- every request already does successfully for auth (admin.auth.getUser()).
--
-- Simple single-table reads/writes convert directly to the supabase-js
-- `.from()` query builder in the application code. Anything that needs a
-- join Postgres embedding can't express, a multi-row aggregate (COUNT/SUM/
-- FILTER), or a server-side conditional update (only set a timestamp once,
-- etc.) is wrapped here as a plain SQL/PLpgSQL function and called instead
-- via `.rpc(name, args)` — still one HTTP round trip, no TCP socket, no
-- prepared-statement/pooler negotiation to go wrong.
--
-- These run with the caller's privileges. The app only ever calls Supabase
-- with the service_role key, which already bypasses Row Level Security
-- entirely (it's Postgres's built-in bypassrls role) — same as every
-- `.from()` call in the app, so no SECURITY DEFINER is needed here.

-- =========================================================================
-- app_context_upsert — the get-or-create-or-update at the top of every
-- request (was context()'s 2-3 separate round trips).
-- =========================================================================
create or replace function app_context_upsert(
  p_identity_user_id uuid,
  p_email text,
  p_default_display_name text,
  p_role text
) returns profiles
language plpgsql as $$
declare
  result profiles;
begin
  select * into result from profiles
  where identity_user_id = p_identity_user_id or lower(email) = lower(p_email)
  order by identity_user_id is not null desc limit 1;

  if result.id is null then
    insert into profiles(identity_user_id, email, display_name, role)
    values (p_identity_user_id, lower(p_email), p_default_display_name, p_role)
    returning * into result;
  elsif result.identity_user_id is distinct from p_identity_user_id or result.role is distinct from p_role then
    update profiles set identity_user_id = p_identity_user_id, role = p_role, updated_at = now()
    where id = result.id
    returning * into result;
  end if;

  return result;
end;
$$;

-- =========================================================================
-- requirement_progress_data — every raw ingredient requirementProgress()
-- needs for one intern, in a single round trip. The pace/projection math
-- itself stays in JS unchanged; only the data-fetching moves here.
-- =========================================================================
create or replace function requirement_progress_data(p_intern_id int)
returns jsonb
language plpgsql as $$
declare
  v_profile jsonb;
  v_rp_id int;
begin
  select to_jsonb(p) || jsonb_build_object(
    'requirement_profile_code', rp.code,
    'requirement_profile_name', rp.name,
    'overall_programme_hours', rp.overall_programme_hours
  ), p.requirement_profile_id
  into v_profile, v_rp_id
  from profiles p left join requirement_profiles rp on rp.id = p.requirement_profile_id
  where p.id = p_intern_id;

  if v_profile is null then
    raise exception 'Intern not found';
  end if;

  -- Fall back to the institution's default requirement profile if the
  -- intern's profile row predates one being assigned (ensureRequirementProfile
  -- in the old JS code), and persist it the same way that helper did.
  if v_rp_id is null then
    select id into v_rp_id from requirement_profiles where code = (
      case v_profile->>'institution'
        when 'SACAP' then 'sacap-bpsych'
        when 'Cornerstone Institute' then 'cornerstone-bpsych'
        else 'generic-720'
      end
    );
    if v_rp_id is not null then
      update profiles set requirement_profile_id = v_rp_id where id = p_intern_id;
      select to_jsonb(p) || jsonb_build_object(
        'requirement_profile_code', rp.code,
        'requirement_profile_name', rp.name,
        'overall_programme_hours', rp.overall_programme_hours
      )
      into v_profile
      from profiles p left join requirement_profiles rp on rp.id = p.requirement_profile_id
      where p.id = p_intern_id;
    end if;
  end if;

  return jsonb_build_object(
    'profile', v_profile,
    'components', coalesce((
      select jsonb_agg(c order by c.sort_order, c.name)
      from requirement_components c where c.requirement_profile_id = v_rp_id
    ), '[]'::jsonb),
    'manual', coalesce((
      select jsonb_object_agg(component_code, jsonb_build_object('total', total, 'recent', recent_28d))
      from (
        select component_code, sum(hours)::float total,
          sum(hours) filter(where work_date >= current_date - 27)::float recent_28d
        from hours where intern_profile_id = p_intern_id and component_code is not null
        group by component_code
      ) m
    ), '{}'::jsonb),
    'encounter', (
      select jsonb_build_object(
        'minutes', coalesce(sum(duration_minutes) filter(where attended), 0)::float,
        'booked', count(*)::int,
        'attended', count(*) filter(where attended)::int,
        'avg_minutes', avg(duration_minutes) filter(where attended and duration_minutes > 0)::float
      )
      from encounters where intern_profile_id = p_intern_id
    ),
    'recent_encounter', (
      select jsonb_build_object('minutes', coalesce(sum(duration_minutes) filter(where attended), 0)::float)
      from encounters where intern_profile_id = p_intern_id and encounter_date >= current_date - 27
    ),
    'active_cases', (
      select jsonb_build_object(
        'n', count(*)::int,
        'weekly_bookings', coalesce(sum(1.0 / nullif(planned_frequency_weeks, 0)), 0)::float
      )
      from cases where intern_profile_id = p_intern_id and status in ('Booked','Intake','Active','Exit review')
    ),
    'deliverables', coalesce((
      select jsonb_object_agg(component_id, jsonb_build_object('status', status, 'note', note))
      from deliverable_progress where intern_profile_id = p_intern_id
    ), '{}'::jsonb),
    'opening', coalesce((
      select jsonb_object_agg(component_id, jsonb_build_object('hours', hours::float, 'note', note))
      from requirement_opening_balances where intern_profile_id = p_intern_id
    ), '{}'::jsonb)
  );
end;
$$;

-- =========================================================================
-- list_interns_with_counts — profiles(role='intern') + per-intern
-- active_cases / open_supervision, optionally restricted to one supervisor.
-- =========================================================================
create or replace function list_interns_with_counts(p_supervisor_id uuid, p_only_active boolean)
returns table (profile jsonb)
language sql as $$
  select to_jsonb(p) || jsonb_build_object(
    'active_cases', (select count(*) from cases x where x.intern_profile_id = p.id and x.status <> 'Exited'),
    'open_supervision', (select count(*) from supervision_items s where s.intern_profile_id = p.id and s.status = 'Open')
  )
  from profiles p
  where p.role = 'intern'
    and (not p_only_active or p.active = true)
    and (p_supervisor_id is null or p.supervisor_identity_user_id = p_supervisor_id)
  order by (not p_only_active) desc, p.active desc, p.display_name;
$$;

-- =========================================================================
-- upsert_intern — creating/reactivating a placement (interns() POST).
-- =========================================================================
create or replace function upsert_intern(
  p_email text, p_name text, p_institution text, p_code text,
  p_placement_start date, p_placement_end date, p_default_minutes int,
  p_supervisor_id uuid
) returns jsonb
language plpgsql as $$
declare
  v_rp_id int; v_rp_hours numeric; v_was_existing boolean; result profiles;
begin
  select id, overall_programme_hours into v_rp_id, v_rp_hours from requirement_profiles where code = p_code;
  select exists(select 1 from profiles where email = p_email) into v_was_existing;

  insert into profiles(email, display_name, role, institution, placement_start, placement_end, required_hours, requirement_profile_id, supervisor_identity_user_id, default_session_minutes)
  values (p_email, p_name, 'intern', p_institution, p_placement_start, p_placement_end, coalesce(v_rp_hours, 720), v_rp_id, p_supervisor_id, coalesce(p_default_minutes, 60))
  on conflict(email) do update set display_name = excluded.display_name, institution = excluded.institution,
    placement_start = excluded.placement_start, placement_end = excluded.placement_end, required_hours = excluded.required_hours,
    requirement_profile_id = excluded.requirement_profile_id, supervisor_identity_user_id = excluded.supervisor_identity_user_id,
    default_session_minutes = excluded.default_session_minutes, active = true
  returning * into result;

  return to_jsonb(result) || jsonb_build_object('was_existing', v_was_existing);
end;
$$;

-- =========================================================================
-- update_case_status — the only-set-once timestamp logic from cases() PATCH.
-- =========================================================================
create or replace function update_case_status(
  p_case_id int, p_status text, p_supervision_status text, p_frequency int
) returns cases
language plpgsql as $$
declare result cases;
begin
  update cases set
    status = p_status,
    supervision_status = coalesce(p_supervision_status, supervision_status),
    planned_frequency_weeks = coalesce(p_frequency, planned_frequency_weeks),
    first_contact_at = case when p_status in ('Contact attempted','Booked','Intake','Active','Exit review','Exited') then coalesce(first_contact_at, now()) else first_contact_at end,
    booked_at = case when p_status in ('Booked','Intake','Active','Exit review','Exited') then coalesce(booked_at, now()) else booked_at end,
    intake_at = case when p_status in ('Intake','Active','Exit review','Exited') then coalesce(intake_at, now()) else intake_at end,
    exited_at = case when p_status = 'Exited' then coalesce(exited_at, now()) else exited_at end,
    updated_at = now()
  where id = p_case_id
  returning * into result;
  return result;
end;
$$;

-- =========================================================================
-- create_encounter — insert + the conditional case-status/session-count
-- bump from encounters() POST, as one atomic call.
-- =========================================================================
create or replace function create_encounter(
  p_case_id int, p_intern_id int, p_encounter_date date, p_booked boolean, p_attended boolean,
  p_session_type text, p_gender text, p_site text, p_duration int, p_created_by uuid
) returns encounters
language plpgsql as $$
declare result encounters;
begin
  insert into encounters(case_id, intern_profile_id, encounter_date, booked, attended, session_type, patient_gender, site, duration_minutes, created_by_identity_user_id)
  values (p_case_id, p_intern_id, p_encounter_date, p_booked, p_attended, p_session_type, p_gender, p_site, p_duration, p_created_by)
  returning * into result;

  if p_attended then
    update cases set
      sessions = (select count(*) from encounters where case_id = p_case_id and attended = true),
      status = case when status in ('Allocated','Contact attempted','Booked','Intake') then 'Active' else status end,
      updated_at = now()
    where id = p_case_id;
  end if;

  return result;
end;
$$;

-- =========================================================================
-- hours_entries_with_component — hoursView() GET's join (hours joined to
-- requirement_components on code *and* the intern's own requirement profile,
-- which isn't a real foreign key PostgREST could embed automatically).
-- =========================================================================
create or replace function hours_entries_with_component(p_intern_id int)
returns table (entry jsonb)
language sql as $$
  select to_jsonb(h) || jsonb_build_object('component_name', c.name, 'manual_label', c.manual_label, 'calculation_mode', c.calculation_mode)
  from hours h
  left join requirement_components c on c.code = h.component_code
    and c.requirement_profile_id = (select requirement_profile_id from profiles where id = p_intern_id)
  where h.intern_profile_id = p_intern_id
  order by h.work_date desc, h.created_at desc
  limit 300;
$$;

-- =========================================================================
-- hours_feed / supervision_feed — cross-intern feeds for programme_lead /
-- supervisor (§4 gap fix), each a join PostgREST embedding can't express
-- cleanly together with an optional supervisor filter.
-- =========================================================================
create or replace function hours_feed(p_supervisor_id uuid)
returns table (entry jsonb)
language sql as $$
  select to_jsonb(h) || jsonb_build_object('intern_name', p.display_name, 'component_name', c.name, 'manual_label', c.manual_label)
  from hours h
  join profiles p on p.id = h.intern_profile_id
  left join requirement_components c on c.code = h.component_code and c.requirement_profile_id = p.requirement_profile_id
  where p.role = 'intern' and (p_supervisor_id is null or p.supervisor_identity_user_id = p_supervisor_id)
  order by h.work_date desc, h.created_at desc
  limit 300;
$$;

create or replace function supervision_feed(p_supervisor_id uuid)
returns table (item jsonb)
language sql as $$
  select to_jsonb(s) || jsonb_build_object('case_code', x.case_code, 'intern_name', p.display_name)
  from supervision_items s
  join profiles p on p.id = s.intern_profile_id
  left join cases x on x.id = s.case_id
  where p.role = 'intern' and (p_supervisor_id is null or p.supervisor_identity_user_id = p_supervisor_id)
  order by (case when s.status = 'Open' then 0 else 1 end), s.created_at desc
  limit 300;
$$;

-- =========================================================================
-- report_encounter_stats / range_requirement_hours — reports() GET.
-- =========================================================================
create or replace function report_encounter_stats(p_intern_id int, p_start date, p_end date)
returns jsonb
language sql as $$
  select jsonb_build_object(
    'booked', count(*)::int,
    'attended', count(*) filter(where attended)::int,
    'female', count(*) filter(where attended and patient_gender = 'Female')::int,
    'male', count(*) filter(where attended and patient_gender = 'Male')::int,
    'first_sessions', count(*) filter(where attended and session_type = 'First')::int,
    'follow_up_sessions', count(*) filter(where attended and session_type = 'Follow-up')::int,
    'counselling_minutes', coalesce(sum(duration_minutes) filter(where attended), 0)::float
  )
  from encounters where intern_profile_id = p_intern_id and encounter_date >= p_start and encounter_date < p_end;
$$;

create or replace function range_requirement_hours(p_intern_id int, p_start date, p_end date)
returns table (code text, name text, total numeric)
language plpgsql as $$
declare v_rp_id int; v_encounter_hours numeric;
begin
  select requirement_profile_id into v_rp_id from profiles where id = p_intern_id;
  select coalesce(sum(duration_minutes) filter(where attended), 0)::float / 60 into v_encounter_hours
  from encounters where intern_profile_id = p_intern_id and encounter_date >= p_start and encounter_date < p_end;

  return query
  select c.code, c.name,
    round((case
      when c.calculation_mode = 'individual_encounters' then v_encounter_hours
      when c.calculation_mode = 'manual_plus_individual_encounters' then coalesce(m.total, 0) + v_encounter_hours
      else coalesce(m.total, 0)
    end)::numeric, 1) as total
  from requirement_components c
  left join (
    select component_code, sum(hours)::float total from hours
    where intern_profile_id = p_intern_id and work_date >= p_start and work_date < p_end
    group by component_code
  ) m on m.component_code = c.code
  where c.requirement_profile_id = v_rp_id and c.target_hours is not null
  having (case
      when c.calculation_mode = 'individual_encounters' then v_encounter_hours
      when c.calculation_mode = 'manual_plus_individual_encounters' then coalesce(m.total, 0) + v_encounter_hours
      else coalesce(m.total, 0)
    end) > 0;
end;
$$;

-- =========================================================================
-- upsert_monthly_report — reports() POST (submitted_at/reviewed_at only
-- ever get set once, on the matching status transition).
-- =========================================================================
create or replace function upsert_monthly_report(
  p_intern_id int, p_month date, p_status text, p_intern_comment text, p_supervisor_comment text
) returns monthly_reports
language plpgsql as $$
declare result monthly_reports;
begin
  insert into monthly_reports(intern_profile_id, month, status, intern_comment, supervisor_comment, submitted_at, reviewed_at)
  values (p_intern_id, p_month, p_status, p_intern_comment, p_supervisor_comment,
    case when p_status = 'Submitted' then now() end, case when p_status = 'Reviewed' then now() end)
  on conflict(intern_profile_id, month) do update set status = excluded.status,
    intern_comment = coalesce(excluded.intern_comment, monthly_reports.intern_comment),
    supervisor_comment = coalesce(excluded.supervisor_comment, monthly_reports.supervisor_comment),
    submitted_at = case when excluded.status = 'Submitted' then now() else monthly_reports.submitted_at end,
    reviewed_at = case when excluded.status = 'Reviewed' then now() else monthly_reports.reviewed_at end,
    updated_at = now()
  returning * into result;
  return result;
end;
$$;

-- =========================================================================
-- update_referral — referrals() PATCH (closed_at only-set-once logic).
-- =========================================================================
create or replace function update_referral(
  p_referral_id int, p_priority text, p_status text, p_contact_attempts int,
  p_next_action_date date, p_last_update text, p_updated_by uuid
) returns referrals
language plpgsql as $$
declare result referrals;
begin
  update referrals set
    priority = p_priority, status = p_status, contact_attempts = p_contact_attempts,
    next_action_date = p_next_action_date, last_update = p_last_update,
    updated_by_identity_user_id = p_updated_by, updated_at = now(),
    closed_at = case when p_status like 'Closed%' then coalesce(closed_at, now()) else null end
  where id = p_referral_id
  returning * into result;
  return result;
end;
$$;

-- =========================================================================
-- programme_metrics — the whole-of-programme dashboard for management/
-- programme_lead (programme()), one call instead of 7 parallel queries plus
-- a per-intern requirement_progress loop (which the app still does via
-- requirement_progress_data, one HTTP call per intern).
-- =========================================================================
create or replace function programme_metrics()
returns jsonb
language sql as $$
  select jsonb_build_object(
    'intern_ids', coalesce((select jsonb_agg(id) from profiles where role = 'intern' and active = true), '[]'::jsonb),
    'institutions', coalesce((
      select jsonb_agg(jsonb_build_object('institution', institution, 'count', n))
      from (select coalesce(institution, 'Other') institution, count(*) n from profiles where role = 'intern' and active = true group by 1) x
    ), '[]'::jsonb),
    'cases', (select jsonb_build_object('total', count(*), 'active', count(*) filter(where status <> 'Exited')) from cases),
    'open_supervision', (select count(*) from supervision_items where status = 'Open'),
    'reviewed_reports', (select count(*) from monthly_reports where month = date_trunc('month', current_date)::date and status = 'Reviewed'),
    'sites', coalesce((select jsonb_agg(jsonb_build_object('site', site, 'cases', n) order by n desc) from (select site, count(*) n from cases group by site) x), '[]'::jsonb),
    'encounters', (select jsonb_build_object('booked', count(*), 'attended', count(*) filter(where attended)) from encounters),
    'median_days_to_intake', (select percentile_cont(0.5) within group(order by extract(epoch from (intake_at - allocated_at)) / 86400.0) from cases where intake_at is not null)
  );
$$;
