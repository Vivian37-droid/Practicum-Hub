-- Stellenbosch RC Practicum Hub — initial schema
-- Rebuilt for Supabase (Postgres). Ported from the ad-hoc schema that lived
-- only in netlify/functions/api.mjs queries on the old Netlify deploy (no
-- migration file existed there — that drift caused the
-- `updated_by_identity_user_id` production bug documented in REBUILD_SPEC.md
-- §3.2). This file is now the single source of truth for the schema; if the
-- application code references a column, it must exist here first.
--
-- Security model: Cloudflare Pages Functions talk to Supabase with the
-- service_role key (server-side only, never shipped to the browser) and
-- enforce all authorization themselves in JS — the same model the Netlify
-- Functions used. Row Level Security is enabled on every table as
-- defense-in-depth with no permissive policies, so the anon/authenticated
-- keys (the only keys the browser ever sees, via supabase-js for auth only)
-- cannot read or write any table directly even if leaked or misused. Only
-- the service_role key, which bypasses RLS entirely, can touch data.

-- =========================================================================
-- requirement_profiles / requirement_components
-- (created before profiles, which references requirement_profiles)
-- =========================================================================
create table requirement_profiles (
  id                      integer generated always as identity primary key,
  code                    text not null unique,
  name                    text not null,
  overall_programme_hours numeric not null default 720
);

create table requirement_components (
  id                      integer generated always as identity primary key,
  requirement_profile_id  integer not null references requirement_profiles(id) on delete cascade,
  name                    text not null,
  code                    text not null,
  manual_label            text,
  calculation_mode        text not null
                            check (calculation_mode in ('manual','individual_encounters','manual_plus_individual_encounters','deliverable')),
  target_hours            numeric,
  sort_order              integer not null default 0,
  responsibility          text check (responsibility in ('site','shared','campus','information-only')),
  counts_for_pace         boolean not null default true,
  component_type          text,
  unique (requirement_profile_id, code)
);

-- =========================================================================
-- profiles — one row per person (intern, supervisor, programme_lead, management)
-- =========================================================================
create table profiles (
  id                          integer generated always as identity primary key,
  identity_user_id            uuid unique references auth.users(id) on delete set null,
  email                       text not null unique,
  display_name                text not null,
  role                        text not null default 'intern'
                                check (role in ('programme_lead','supervisor','intern','management')),
  active                      boolean not null default true,
  institution                 text,
  placement_start             date,
  placement_end               date,
  required_hours              numeric,
  requirement_profile_id      integer references requirement_profiles(id),
  supervisor_identity_user_id uuid references auth.users(id) on delete set null,
  default_session_minutes     integer not null default 60,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index idx_profiles_role on profiles(role);
create index idx_profiles_supervisor on profiles(supervisor_identity_user_id);

-- =========================================================================
-- requirement_opening_balances — one-time carried-over hours per intern/component
-- =========================================================================
create table requirement_opening_balances (
  id                          integer generated always as identity primary key,
  intern_profile_id           integer not null references profiles(id) on delete cascade,
  component_id                integer not null references requirement_components(id) on delete cascade,
  hours                       numeric not null default 0,
  note                        text,
  updated_by_identity_user_id uuid references auth.users(id) on delete set null,
  updated_at                  timestamptz not null default now(),
  unique (intern_profile_id, component_id)
);

-- =========================================================================
-- deliverable_progress — status tracking for non-hour requirements
-- =========================================================================
create table deliverable_progress (
  id                          integer generated always as identity primary key,
  intern_profile_id           integer not null references profiles(id) on delete cascade,
  component_id                integer not null references requirement_components(id) on delete cascade,
  status                      text not null default 'Not started'
                                check (status in ('Not started','In progress','Complete')),
  note                        text,
  updated_by_identity_user_id uuid references auth.users(id) on delete set null,
  updated_at                  timestamptz not null default now(),
  unique (intern_profile_id, component_id)
);

-- =========================================================================
-- hours — manually logged non-counselling activity
-- =========================================================================
create table hours (
  id                          integer generated always as identity primary key,
  intern_profile_id           integer not null references profiles(id) on delete cascade,
  work_date                   date not null,
  category                    text not null,
  component_code              text,
  hours                       numeric not null check (hours > 0 and hours <= 24),
  note                        text,
  created_by_identity_user_id uuid references auth.users(id) on delete set null,
  created_at                  timestamptz not null default now()
);
create index idx_hours_intern on hours(intern_profile_id, work_date desc);
create index idx_hours_component on hours(intern_profile_id, component_code);

-- =========================================================================
-- cases — de-identified counselling cases
-- =========================================================================
create table cases (
  id                          integer generated always as identity primary key,
  case_code                   text not null,
  intern_profile_id           integer not null references profiles(id) on delete cascade,
  site                        text not null,
  presenting_category         text,
  status                      text not null default 'Allocated'
                                check (status in ('Allocated','Contact attempted','Booked','Intake','Active','Exit review','Exited')),
  planned_frequency_weeks     integer not null default 1 check (planned_frequency_weeks between 1 and 52),
  sessions                    integer not null default 0,
  supervision_status          text,
  allocated_at                timestamptz not null default now(),
  first_contact_at            timestamptz,
  booked_at                   timestamptz,
  intake_at                   timestamptz,
  exited_at                   timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by_identity_user_id uuid references auth.users(id) on delete set null
);
create index idx_cases_intern on cases(intern_profile_id, updated_at desc);
create index idx_cases_site on cases(site);

-- =========================================================================
-- encounters — individual counselling session records
-- =========================================================================
create table encounters (
  id                          integer generated always as identity primary key,
  case_id                     integer not null references cases(id) on delete cascade,
  intern_profile_id           integer not null references profiles(id) on delete cascade,
  encounter_date               date not null,
  booked                      boolean not null default true,
  attended                    boolean not null default true,
  session_type                text not null check (session_type in ('First','Follow-up')),
  patient_gender               text not null default 'Unknown' check (patient_gender in ('Female','Male','Other','Unknown')),
  site                        text,
  duration_minutes            integer not null default 0 check (duration_minutes between 0 and 480),
  created_by_identity_user_id uuid references auth.users(id) on delete set null,
  created_at                  timestamptz not null default now()
);
create index idx_encounters_intern on encounters(intern_profile_id, encounter_date desc);
create index idx_encounters_case on encounters(case_id);

-- =========================================================================
-- supervision_items — supervision prep/review items
-- =========================================================================
create table supervision_items (
  id                          integer generated always as identity primary key,
  intern_profile_id           integer not null references profiles(id) on delete cascade,
  case_id                     integer references cases(id) on delete set null,
  topic                       text not null,
  question                    text not null,
  priority                    text not null default 'Routine'
                                check (priority in ('Routine','Important','Risk / urgent')),
  action_taken                text,
  status                      text not null default 'Open' check (status in ('Open','Reviewed','Closed')),
  supervisor_note             text,
  created_by_identity_user_id uuid references auth.users(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index idx_supervision_intern on supervision_items(intern_profile_id, status, created_at desc);
create index idx_supervision_status on supervision_items(status);

-- =========================================================================
-- competency_definitions / competency_progress
-- =========================================================================
create table competency_definitions (
  id          integer generated always as identity primary key,
  name        text not null,
  description text,
  sort_order  integer not null default 0
);

create table competency_progress (
  id                          integer generated always as identity primary key,
  intern_profile_id           integer not null references profiles(id) on delete cascade,
  competency_id               integer not null references competency_definitions(id) on delete cascade,
  intern_rating                integer check (intern_rating between 1 and 5),
  evidence                    text,
  supervisor_rating           integer check (supervisor_rating between 1 and 5),
  supervisor_comment          text,
  updated_by_identity_user_id uuid references auth.users(id) on delete set null,
  updated_at                  timestamptz not null default now(),
  unique (intern_profile_id, competency_id)
);

-- =========================================================================
-- monthly_reports — one per intern per month
-- =========================================================================
create table monthly_reports (
  id                integer generated always as identity primary key,
  intern_profile_id integer not null references profiles(id) on delete cascade,
  month             date not null,
  status            text not null default 'Draft' check (status in ('Draft','Submitted','Reviewed')),
  intern_comment    text,
  supervisor_comment text,
  submitted_at      timestamptz,
  reviewed_at       timestamptz,
  updated_at        timestamptz not null default now(),
  unique (intern_profile_id, month)
);

-- =========================================================================
-- referrals — de-identified referral tracking
-- =========================================================================
create table referrals (
  id                           integer generated always as identity primary key,
  intern_profile_id            integer not null references profiles(id) on delete cascade,
  referral_code                text not null,
  referral_date                date not null,
  referral_source              text,
  site                         text,
  presenting_category          text,
  priority                     text not null default 'Routine' check (priority in ('Routine','Priority','Urgent')),
  status                       text not null default 'Allocated'
                                 check (status in ('Allocated','Contact attempted','Contact made','Booked','Intake completed','Active','Awaiting feedback','Closed – completed','Closed – no contact','Reallocated')),
  contact_attempts             integer not null default 0 check (contact_attempts between 0 and 100),
  next_action_date             date,
  last_update                  text,
  created_by_identity_user_id  uuid references auth.users(id) on delete set null,
  updated_by_identity_user_id  uuid references auth.users(id) on delete set null,
  closed_at                    timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
create index idx_referrals_intern on referrals(intern_profile_id, next_action_date);
create index idx_referrals_status on referrals(status);

-- =========================================================================
-- weekly_schedule_items — intern's recurring weekly placement rhythm
-- =========================================================================
create table weekly_schedule_items (
  id                integer generated always as identity primary key,
  intern_profile_id integer not null references profiles(id) on delete cascade,
  weekday           integer not null check (weekday between 1 and 7),
  title             text not null,
  start_time        time,
  end_time          time,
  site              text,
  recurrence_note   text,
  activity_type     text,
  active            boolean not null default true
);
create index idx_schedule_intern on weekly_schedule_items(intern_profile_id, active);

-- =========================================================================
-- planned_activities — upcoming planned community/outreach activities
-- =========================================================================
create table planned_activities (
  id                integer generated always as identity primary key,
  intern_profile_id integer not null references profiles(id) on delete cascade,
  title             text not null,
  activity_date     date,
  site              text,
  note              text,
  status            text not null default 'Planned',
  planned_hours     numeric,
  preparation_hours numeric
);
create index idx_planned_intern on planned_activities(intern_profile_id);

-- =========================================================================
-- pilot_feedback — free-text pilot feedback
-- =========================================================================
create table pilot_feedback (
  id                integer generated always as identity primary key,
  intern_profile_id integer not null references profiles(id) on delete cascade,
  feedback_type     text not null default 'General',
  rating            integer check (rating between 1 and 5),
  message           text not null,
  context_view      text,
  status            text not null default 'New',
  created_at        timestamptz not null default now()
);
create index idx_feedback_intern on pilot_feedback(intern_profile_id, created_at desc);

-- =========================================================================
-- audit_log — write audit trail
-- =========================================================================
create table audit_log (
  id                integer generated always as identity primary key,
  identity_user_id  uuid references auth.users(id) on delete set null,
  profile_id        integer references profiles(id) on delete set null,
  action            text not null,
  entity_type       text not null,
  entity_id         text,
  detail            jsonb,
  created_at        timestamptz not null default now()
);
create index idx_audit_profile on audit_log(profile_id, created_at desc);

-- =========================================================================
-- Row Level Security — enabled everywhere, no policies (service_role only)
-- =========================================================================
do $$
declare t text;
begin
  for t in select unnest(array[
    'requirement_profiles','requirement_components','profiles',
    'requirement_opening_balances','deliverable_progress','hours','cases',
    'encounters','supervision_items','competency_definitions',
    'competency_progress','monthly_reports','referrals',
    'weekly_schedule_items','planned_activities','pilot_feedback','audit_log'
  ])
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- =========================================================================
-- Reference data — requirement profiles/components (§7 of REBUILD_SPEC.md)
-- =========================================================================
insert into requirement_profiles (code, name, overall_programme_hours) values
  ('sacap-bpsych', 'SACAP B Psych Practicum', 720),
  ('cornerstone-bpsych', 'Cornerstone Institute Practicum', 720),
  ('generic-720', 'Generic 720-hour practicum', 720);

insert into requirement_components
  (requirement_profile_id, code, name, manual_label, calculation_mode, target_hours, sort_order, responsibility, counts_for_pace, component_type)
select id, v.code, v.name, v.manual_label, v.calculation_mode, v.target_hours, v.sort_order, v.responsibility, v.counts_for_pace, v.component_type
from requirement_profiles, lateral (values
  ('counselling', 'Counselling of children, adolescents & adults', 'Group / family counselling', 'manual_plus_individual_encounters', 202::numeric, 1, 'site', true, 'combined_counselling'),
  ('preparation-documentation', 'Preparation & documentation of client engagement', null, 'manual', 86::numeric, 2, 'site', true, 'preparation_documentation'),
  ('psychoeducation-community', 'Psycho-education / community / public health / advocacy', null, 'manual', 180::numeric, 3, 'shared', true, 'community'),
  ('training-supervision', 'Training & supervision', null, 'manual', 72::numeric, 4, 'shared', true, 'supervision'),
  ('ethical-professional', 'Ethical & professional conduct', null, 'manual', 36::numeric, 5, 'campus', false, 'academic'),
  ('psychometric-assessment', 'Basic psychological assessment', null, 'manual', 72::numeric, 6, 'site', true, 'psychometrics'),
  ('other-professional', 'Other professional activities', null, 'manual', 72::numeric, 7, 'shared', true, 'other')
) as v(code, name, manual_label, calculation_mode, target_hours, sort_order, responsibility, counts_for_pace, component_type)
where requirement_profiles.code = 'sacap-bpsych';

insert into requirement_components
  (requirement_profile_id, code, name, manual_label, calculation_mode, target_hours, sort_order, responsibility, counts_for_pace, component_type)
select id, v.code, v.name, v.manual_label, v.calculation_mode, v.target_hours, v.sort_order, v.responsibility, v.counts_for_pace, v.component_type
from requirement_profiles, lateral (values
  ('individual-counselling', 'A — Individual counselling', null, 'individual_encounters', 120::numeric, 1, 'site', true, 'individual_counselling'),
  ('group-counselling', 'B — Group counselling', null, 'manual', 100::numeric, 2, 'site', true, 'group_counselling'),
  ('professional-skills', 'C — Professional skills development', null, 'manual', 100::numeric, 3, 'shared', true, null),
  ('administration', 'D — Administration', null, 'manual', 140::numeric, 4, 'site', true, 'preparation_documentation'),
  ('supervision', 'E — Supervision', null, 'manual', 24::numeric, 5, 'shared', true, 'supervision'),
  ('presentations', 'F — Presentations', null, 'manual', 20::numeric, 6, 'shared', true, null),
  ('psychometrics', 'G — Psychometrics', null, 'manual', 60::numeric, 7, 'site', true, 'psychometrics'),
  ('community', 'H — Community', null, 'manual', 130::numeric, 8, 'shared', true, 'community'),
  ('other-professional', 'I — Other professional activities', null, 'manual', 26::numeric, 9, 'shared', true, 'other'),
  ('professional-journal', 'J — Professional journal', null, 'deliverable', null, 10, 'campus', false, null),
  ('personal-journal', 'K — Personal journal', null, 'deliverable', null, 11, 'campus', false, null)
) as v(code, name, manual_label, calculation_mode, target_hours, sort_order, responsibility, counts_for_pace, component_type)
where requirement_profiles.code = 'cornerstone-bpsych';

insert into requirement_components
  (requirement_profile_id, code, name, manual_label, calculation_mode, target_hours, sort_order, responsibility, counts_for_pace, component_type)
select id, 'general-activity', 'General practicum activity', null, 'manual', 720::numeric, 1, 'shared', true, null
from requirement_profiles where code = 'generic-720';

-- Fixed 9 competencies (§7)
insert into competency_definitions (name, description, sort_order) values
  ('Intake interviewing', 'Structured, empathic intake that establishes presenting need, risk and context.', 1),
  ('Mental State Examination', 'Systematic observation and reporting of mental state.', 2),
  ('Risk assessment', 'Identification, escalation and documentation of risk.', 3),
  ('Case formulation', 'Integrating information into a coherent, actionable formulation.', 4),
  ('Short-term counselling', 'Delivering focused, time-limited counselling interventions.', 5),
  ('Documentation', 'Accurate, factual, appropriately scoped clinical records.', 6),
  ('Referral & MDT work', 'Effective referral and multidisciplinary collaboration.', 7),
  ('Professional conduct', 'Ethical, boundaried, reflective professional practice.', 8),
  ('Group / community work', 'Facilitating group or community-level interventions.', 9);
