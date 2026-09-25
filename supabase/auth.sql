-- Run this once in the Supabase SQL Editor, after schema.sql.
-- Then create the first person in Authentication → Users.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  role text not null default 'staff' check (role in ('staff', 'manager'))
);

alter table public.profiles enable row level security;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_name text;
  final_name text;
  suffix int := 0;
begin
  base_name := split_part(new.email, '@', 1);
  final_name := base_name;
  while exists (select 1 from public.profiles where lower(username) = lower(final_name)) loop
    suffix := suffix + 1;
    final_name := base_name || suffix::text;
  end loop;
  insert into public.profiles (id, username, role)
  values (
    new.id,
    final_name,
    case when exists (select 1 from public.profiles where role = 'manager') then 'staff' else 'manager' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (id, username, role)
select id, split_part(email, '@', 1), 'manager'
from auth.users
where not exists (select 1 from public.profiles p where p.id = auth.users.id);
