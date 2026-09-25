create table if not exists service_statistics (
  id integer generated always as identity primary key,
  owner_identity_user_id uuid not null references auth.users(id) on delete cascade,
  work_date date not null,
  facility_id integer references facilities(id),
  facility_name text not null,
  booked integer not null default 0 check(booked between 0 and 500),
  attended integer not null default 0 check(attended between 0 and 500),
  female integer not null default 0 check(female between 0 and 500),
  male integer not null default 0 check(male between 0 and 500),
  other_gender integer not null default 0 check(other_gender between 0 and 500),
  intake integer not null default 0 check(intake between 0 and 500),
  follow_up integer not null default 0 check(follow_up between 0 and 500),
  individual integer not null default 0 check(individual between 0 and 500),
  group_sessions integer not null default 0 check(group_sessions between 0 and 500),
  family_sessions integer not null default 0 check(family_sessions between 0 and 500),
  community_activities integer not null default 0 check(community_activities between 0 and 500),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_identity_user_id,work_date,facility_name)
);
create index if not exists idx_service_statistics_owner_date on service_statistics(owner_identity_user_id,work_date desc);
alter table service_statistics enable row level security;
