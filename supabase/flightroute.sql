-- Flightroute: who may sign in. Everything is prefixed fr_ so it can live in an existing Supabase project
-- (for example Learn Spanish's) without touching that app's tables. Safe to run again.
-- Run in Supabase: SQL Editor → New query → paste → Run.

create table if not exists public.fr_allowed_emails (
  email     text        primary key check (email = lower(email) and position('@' in email) > 1),
  is_admin  boolean     not null default false,
  added_by  text,
  added_at  timestamptz not null default now()
);
alter table public.fr_allowed_emails enable row level security;

create or replace function public.fr_my_email() returns text
language sql stable set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;
create or replace function public.fr_is_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fr_allowed_emails where email = public.fr_my_email())
$$;
create or replace function public.fr_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fr_allowed_emails where email = public.fr_my_email() and is_admin)
$$;
-- Asked before a code is sent, so codes only go to people on the list
create or replace function public.fr_can_sign_in(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fr_allowed_emails where email = lower(trim(p_email)))
$$;
revoke all on function public.fr_is_allowed(), public.fr_is_admin(), public.fr_can_sign_in(text) from public;
grant execute on function public.fr_is_allowed(), public.fr_is_admin() to authenticated;
grant execute on function public.fr_can_sign_in(text) to anon, authenticated;

-- Admins see and change the whole list; everyone else sees only their own row. Admins can't remove themselves.
drop policy if exists "fr read list" on public.fr_allowed_emails;
create policy "fr read list" on public.fr_allowed_emails for select to authenticated
  using (email = (select public.fr_my_email()) or (select public.fr_is_admin()));
drop policy if exists "fr admins add" on public.fr_allowed_emails;
create policy "fr admins add" on public.fr_allowed_emails for insert to authenticated
  with check ((select public.fr_is_admin()));
drop policy if exists "fr admins change" on public.fr_allowed_emails;
create policy "fr admins change" on public.fr_allowed_emails for update to authenticated
  using ((select public.fr_is_admin()) and email <> (select public.fr_my_email()))
  with check ((select public.fr_is_admin()));
drop policy if exists "fr admins remove" on public.fr_allowed_emails;
create policy "fr admins remove" on public.fr_allowed_emails for delete to authenticated
  using ((select public.fr_is_admin()) and email <> (select public.fr_my_email()));
grant select, insert, update, delete on public.fr_allowed_emails to authenticated;

-- The first admin: replace your.email@example.com with the email you'll sign in with, before you press Run.
insert into public.fr_allowed_emails (email, is_admin, added_by)
values (lower('your.email@example.com'), true, 'setup')
on conflict (email) do update set is_admin = true;
