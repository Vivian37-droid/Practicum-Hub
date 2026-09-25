create table if not exists service_schedule (
 id integer generated always as identity primary key,
 owner_identity_user_id uuid not null references auth.users(id) on delete cascade,
 service_date date not null,
 facility_name text not null,
 schedule_pattern text,
 service_focus text,
 sort_order integer not null default 0,
 active boolean not null default true,
 unique(owner_identity_user_id,service_date,facility_name)
);
alter table service_schedule enable row level security;

with owners as (select identity_user_id id from profiles where role='programme_lead' and identity_user_id is not null),
items(service_date,facility,focus,ord) as (values
 ('2026-09-01'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',10),
 ('2026-09-02'::date,'Groendal Clinic','Clinic counselling service',20),
 ('2026-09-03'::date,'Klapmuts Clinic','Clinic counselling service',30),
 ('2026-09-04'::date,'District MH Meeting: Worcester','Professional meeting',40),
 ('2026-09-07'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',50),
 ('2026-09-08'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',60),
 ('2026-09-09'::date,'Khayamandi Clinic','Clinic counselling service',70),
 ('2026-09-10'::date,'Cloetesville CDC','Clinic counselling service',80),
 ('2026-09-11'::date,'Stellenbosch Hospital','Inpatient service',90),
 ('2026-09-14'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',100),
 ('2026-09-15'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',110),
 ('2026-09-16'::date,'Groendal Clinic','Clinic counselling service',120),
 ('2026-09-17'::date,'Klapmuts Clinic','Clinic counselling service',130),
 ('2026-09-18'::date,'Peer Supervision: Worcester','Professional supervision',140),
 ('2026-09-21'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',150),
 ('2026-09-22'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',160),
 ('2026-09-23'::date,'Khayamandi Clinic','Clinic counselling service',170),
 ('2026-09-24'::date,'Heritage Day','Public holiday',180),
 ('2026-09-25'::date,'Annual Leave','Leave',190),
 ('2026-09-28'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',200),
 ('2026-09-29'::date,'Stellenbosch Hospital OPD','Booked outpatient counselling',210),
 ('2026-09-30'::date,'Groendal Clinic','Clinic counselling service',220)
)
insert into service_schedule(owner_identity_user_id,service_date,facility_name,service_focus,sort_order)
select owners.id,items.service_date,items.facility,items.focus,items.ord from owners cross join items
on conflict(owner_identity_user_id,service_date,facility_name) do update set service_focus=excluded.service_focus,sort_order=excluded.sort_order,active=true;
