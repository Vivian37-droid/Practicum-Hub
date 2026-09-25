create table if not exists weekly_appointments (
  id integer generated always as identity primary key,
  intern_profile_id integer not null references profiles(id) on delete cascade,
  case_id integer references cases(id) on delete set null,
  appointment_date date not null,
  appointment_time time not null,
  site text not null,
  status text not null default 'Booked' check (status in ('Booked','Attended','Did not attend','Cancelled','Rescheduled')),
  session_type text check (session_type is null or session_type in ('Intake','Follow-up','Termination')),
  duration_minutes integer check (duration_minutes is null or duration_minutes between 15 and 480),
  patient_gender text check (patient_gender is null or patient_gender in ('Female','Male','Other','Unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(intern_profile_id, appointment_date, appointment_time, site)
);
create index if not exists idx_weekly_appointments_intern_date on weekly_appointments(intern_profile_id, appointment_date, appointment_time);
alter table weekly_appointments enable row level security;

-- Erin George's submitted plan for 28 September to 1 October 2026.
with erin as (select id from profiles where role='intern' and lower(display_name)='erin george' order by id limit 1),
slots(day, tm, site) as (values
  ('2026-09-28'::date,'10:30'::time,'Stellenbosch Hospital'),('2026-09-28','11:30','Stellenbosch Hospital'),('2026-09-28','12:30','Stellenbosch Hospital'),('2026-09-28','13:30','Stellenbosch Hospital'),('2026-09-28','14:30','Stellenbosch Hospital'),
  ('2026-09-29','09:00','Don and Pat Clinic'),('2026-09-29','10:00','Don and Pat Clinic'),('2026-09-29','11:00','Don and Pat Clinic'),
  ('2026-09-30','09:00','Stellenbosch Hospital'),('2026-09-30','10:00','Stellenbosch Hospital'),('2026-09-30','11:00','Stellenbosch Hospital'),('2026-09-30','12:00','Stellenbosch Hospital'),('2026-09-30','13:00','Stellenbosch Hospital'),('2026-09-30','14:00','Stellenbosch Hospital'),
  ('2026-10-01','09:00','Idas Valley Clinic'),('2026-10-01','10:00','Idas Valley Clinic'),('2026-10-01','11:00','Idas Valley Clinic')
)
insert into weekly_appointments(intern_profile_id,appointment_date,appointment_time,site)
select erin.id,slots.day,slots.tm,slots.site from erin cross join slots
on conflict do nothing;

with erin as (select id from profiles where role='intern' and lower(display_name)='erin george' order by id limit 1),
tasks(title,note) as (values
 ('Complete termination and referral','Use the de-identified case record; refer to Sr Du Plessis.'),
 ('Follow up and schedule new referrals','Update contact attempts and next actions in Referral tracker.'),
 ('Capture outstanding referrals and sessions','Complete missing Hub records without duplicate entry.'),
 ('Finish and send clinic pamphlet','Weekly action item from submitted reflection.'),
 ('Prepare Did you know posters','Make Mental Health Everybody’s Business campaign.'),
 ('Build needs assessments','Preschool and Kerith outreach activities.')
)
insert into planned_activities(intern_profile_id,title,activity_date,site,note,status)
select erin.id,tasks.title,'2026-10-01','Weekly plan',tasks.note,'Planned' from erin cross join tasks;
