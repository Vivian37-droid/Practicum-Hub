-- =========================================================================
-- 0005 -- fix range_requirement_hours(): it used HAVING on a plain (non-
-- aggregated) SELECT with no GROUP BY, which Postgres rejects outright
-- ("column c.code must appear in the GROUP BY clause or be used in an
-- aggregate function"). Every call failed, which broke the whole Reports
-- page (reports() awaits this in the same Promise.all as the other report
-- data, so one failure here throws for everyone, every month).
--
-- Fix: compute the per-component total in a subquery, then filter on it
-- with a plain WHERE in the outer query instead of HAVING.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- =========================================================================
create or replace function range_requirement_hours(p_intern_id int, p_start date, p_end date)
returns table (code text, name text, total numeric)
language plpgsql as $$
declare v_rp_id int; v_encounter_hours numeric;
begin
  select requirement_profile_id into v_rp_id from profiles where id = p_intern_id;
  select coalesce(sum(duration_minutes) filter(where attended), 0)::float / 60 into v_encounter_hours
  from encounters where intern_profile_id = p_intern_id and encounter_date >= p_start and encounter_date < p_end;

  return query
  select t.code, t.name, t.total from (
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
  ) t
  where t.total > 0;
end;
$$;
