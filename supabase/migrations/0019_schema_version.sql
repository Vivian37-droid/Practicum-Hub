-- Production schema health marker. The Hub reads the highest applied version
-- through its service-role backend and warns the programme lead when a
-- checked-in migration has not yet been applied to Supabase.
create table if not exists app_schema_version (
  version integer primary key,
  applied_at timestamptz not null default now()
);

insert into app_schema_version(version) values (19)
on conflict (version) do update set applied_at = now();

alter table app_schema_version enable row level security;
revoke all privileges on app_schema_version from anon, authenticated;
grant select, insert, update, delete on app_schema_version to service_role;
