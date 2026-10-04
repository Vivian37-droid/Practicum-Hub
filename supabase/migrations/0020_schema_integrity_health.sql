-- Verify the actual schema features used by the current Hub. A single high
-- version marker is not sufficient because an intermediate migration may have
-- been skipped when production was updated manually.
create or replace function app_schema_health()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with checks(name, present) as (values
    ('audit_log.reason', exists(select 1 from information_schema.columns where table_schema='public' and table_name='audit_log' and column_name='reason')),
    ('audit_log.restored_at', exists(select 1 from information_schema.columns where table_schema='public' and table_name='audit_log' and column_name='restored_at')),
    ('report_encounter_stats', to_regprocedure('public.report_encounter_stats(integer,date,date)') is not null),
    ('report_trend_stats', to_regprocedure('public.report_trend_stats(integer,integer)') is not null),
    ('supervision_items.due_date', exists(select 1 from information_schema.columns where table_schema='public' and table_name='supervision_items' and column_name='due_date')),
    ('supervision_items.assigned_supervisor_identity_user_id', exists(select 1 from information_schema.columns where table_schema='public' and table_name='supervision_items' and column_name='assigned_supervisor_identity_user_id')),
    ('referrals.accepted_at', exists(select 1 from information_schema.columns where table_schema='public' and table_name='referrals' and column_name='accepted_at')),
    ('hours.service_type', exists(select 1 from information_schema.columns where table_schema='public' and table_name='hours' and column_name='service_type')),
    ('report_activity_breakdown', to_regprocedure('public.report_activity_breakdown(integer,date,date)') is not null),
    ('cases.referral_id', exists(select 1 from information_schema.columns where table_schema='public' and table_name='cases' and column_name='referral_id')),
    ('placement_milestones', to_regclass('public.placement_milestones') is not null),
    ('weekly_appointments', to_regclass('public.weekly_appointments') is not null),
    ('facilities', to_regclass('public.facilities') is not null),
    ('weekly_appointments.facility_id', exists(select 1 from information_schema.columns where table_schema='public' and table_name='weekly_appointments' and column_name='facility_id')),
    ('service_statistics', to_regclass('public.service_statistics') is not null),
    ('service_schedule', to_regclass('public.service_schedule') is not null)
  ), missing as (
    select coalesce(jsonb_agg(name order by name), '[]'::jsonb) value
    from checks where not present
  )
  select jsonb_build_object(
    'ok', jsonb_array_length(missing.value) = 0,
    'missing', missing.value
  ) from missing;
$$;

revoke all on function app_schema_health() from public, anon, authenticated;
grant execute on function app_schema_health() to service_role;

insert into app_schema_version(version) values (20)
on conflict (version) do update set applied_at = now();
