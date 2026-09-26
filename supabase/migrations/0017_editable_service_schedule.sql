alter table service_schedule
 add column if not exists schedule_status text not null default 'Planned'
 check (schedule_status in ('Planned','Completed','Cancelled'));

create index if not exists service_schedule_owner_date_idx
 on service_schedule(owner_identity_user_id,service_date);
