create table if not exists facilities (
  id integer generated always as identity primary key,
  name text not null unique,
  service_context text not null default 'Community',
  active boolean not null default true
);
alter table facilities enable row level security;

insert into facilities(name,service_context) values
 ('Stellenbosch Hospital','Inpatient'),
 ('Stellenbosch Hospital OPD','Outpatient'),
 ('Cloetesville CDC','Primary care'),('Groendal Clinic','Primary care'),
 ('Khayamandi Clinic','Primary care'),('Klapmuts Clinic','Primary care'),
 ('Idas Valley Clinic','Primary care'),('Don and Pat Clinic','Primary care'),
 ('Jamestown Clinic','Primary care'),('Night Shelter','Community'),
 ('SACAP campus','Academic'),('Cornerstone campus','Academic')
on conflict(name) do update set service_context=excluded.service_context,active=true;

alter table weekly_appointments add column if not exists facility_id integer references facilities(id);
update weekly_appointments a set facility_id=f.id from facilities f
where a.facility_id is null and lower(a.site)=lower(f.name);
create index if not exists idx_weekly_appointments_facility on weekly_appointments(facility_id,appointment_date);
