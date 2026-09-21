-- Integrated placement workflow: referrals become cases without duplicate
-- capture, and each intern receives a standard placement milestone plan.

alter table cases
  add column if not exists referral_id integer references referrals(id) on delete set null;

create unique index if not exists uq_cases_referral_id
  on cases(referral_id) where referral_id is not null;

-- Link case rows that were previously entered separately with the same
-- de-identified code. If duplicates exist, the oldest case is authoritative.
with ranked_referrals as (
  select id, intern_profile_id, upper(referral_code) code,
         row_number() over (partition by intern_profile_id, upper(referral_code) order by created_at, id) rn
  from referrals
), ranked_cases as (
  select id, intern_profile_id, upper(case_code) code,
         row_number() over (partition by intern_profile_id, upper(case_code) order by created_at, id) rn
  from cases where referral_id is null
), matches as (
  select r.id referral_id, c.id case_id
  from ranked_referrals r join ranked_cases c
    on c.intern_profile_id = r.intern_profile_id and c.code = r.code and c.rn = r.rn
)
update cases c set referral_id = m.referral_id
from matches m
where c.id = m.case_id and m.case_id is not null and c.referral_id is null;

create or replace function sync_referral_case()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  mapped_status text;
begin
  mapped_status := case
    when new.status = 'Booked' then 'Booked'
    when new.status = 'Intake completed' then 'Intake'
    when new.status in ('Active', 'Awaiting feedback') then 'Active'
    when new.status like 'Closed%' then 'Exited'
    else null
  end;

  -- Contact-only referrals remain referrals. Once booked/intake/active they
  -- become a case; later referral edits keep the linked record aligned.
  if mapped_status is not null then
    insert into cases (
      referral_id, case_code, intern_profile_id, site, presenting_category,
      status, planned_frequency_weeks, allocated_at, first_contact_at,
      booked_at, intake_at, exited_at, created_by_identity_user_id
    ) values (
      new.id, upper(new.referral_code), new.intern_profile_id,
      coalesce(nullif(new.site, ''), 'Facility not recorded'),
      new.presenting_category, mapped_status, 1,
      coalesce(new.created_at, now()),
      case when new.contact_attempts > 0 or new.status <> 'Allocated' then coalesce(new.updated_at, now()) end,
      case when new.status in ('Booked','Intake completed','Active','Awaiting feedback') or new.status like 'Closed%' then coalesce(new.updated_at, now()) end,
      case when new.status in ('Intake completed','Active','Awaiting feedback') or new.status like 'Closed%' then coalesce(new.updated_at, now()) end,
      case when new.status like 'Closed%' then coalesce(new.closed_at, now()) end,
      new.created_by_identity_user_id
    )
    on conflict (referral_id) where referral_id is not null do update set
      case_code = excluded.case_code,
      intern_profile_id = excluded.intern_profile_id,
      site = excluded.site,
      presenting_category = excluded.presenting_category,
      status = excluded.status,
      booked_at = coalesce(cases.booked_at, excluded.booked_at),
      intake_at = coalesce(cases.intake_at, excluded.intake_at),
      exited_at = case when excluded.status = 'Exited' then coalesce(cases.exited_at, excluded.exited_at) else null end,
      updated_at = now();
  elsif tg_op = 'UPDATE' then
    update cases set
      case_code = upper(new.referral_code),
      intern_profile_id = new.intern_profile_id,
      site = coalesce(nullif(new.site, ''), site),
      presenting_category = new.presenting_category,
      updated_at = now()
    where referral_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_referral_case on referrals;
create trigger trg_sync_referral_case
after insert or update of referral_code, intern_profile_id, site,
  presenting_category, status, contact_attempts, closed_at
on referrals for each row execute function sync_referral_case();

-- Backfill qualifying referrals immediately.
update referrals set status = status
where status in ('Booked','Intake completed','Active','Awaiting feedback','Closed – completed');

create table if not exists placement_milestones (
  id integer generated always as identity primary key,
  intern_profile_id integer not null references profiles(id) on delete cascade,
  milestone_code text not null,
  title text not null,
  due_date date,
  status text not null default 'Not started'
    check (status in ('Not started','In progress','Complete','Not applicable')),
  completed_at timestamptz,
  note text,
  sort_order integer not null default 0,
  updated_by_identity_user_id uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (intern_profile_id, milestone_code)
);
create index if not exists idx_placement_milestones_due
  on placement_milestones(intern_profile_id, status, due_date);
alter table placement_milestones enable row level security;

create or replace function seed_placement_milestones(p_intern_id integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into placement_milestones(intern_profile_id, milestone_code, title, sort_order)
  values
    (p_intern_id,'orientation','Orientation completed',10),
    (p_intern_id,'confidentiality','Confidentiality and access agreements',20),
    (p_intern_id,'learning-plan','Initial learning plan',30),
    (p_intern_id,'case-presentation','Case presentation',40),
    (p_intern_id,'mid-evaluation','Mid-placement evaluation',50),
    (p_intern_id,'competency-review','Competency review',60),
    (p_intern_id,'assessment-exposure','Assessment exposure',70),
    (p_intern_id,'final-evaluation','Final evaluation',80),
    (p_intern_id,'logbook-verification','Logbook verification',90),
    (p_intern_id,'exit-interview','Exit interview',100),
    (p_intern_id,'placement-complete','Placement completion',110)
  on conflict (intern_profile_id, milestone_code) do nothing;
end;
$$;

do $$ declare r record; begin
  for r in select id from profiles where role = 'intern' loop
    perform seed_placement_milestones(r.id);
  end loop;
end $$;

create or replace function seed_new_intern_milestones()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'intern' then perform seed_placement_milestones(new.id); end if;
  return new;
end;
$$;
drop trigger if exists trg_seed_new_intern_milestones on profiles;
create trigger trg_seed_new_intern_milestones
after insert on profiles for each row execute function seed_new_intern_milestones();
