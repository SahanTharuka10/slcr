create table if not exists public.players (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.teams (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.matches (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.tournaments (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.match_reports (
  id text primary key,
  match_id text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.players enable row level security;
alter table public.teams enable row level security;
alter table public.matches enable row level security;
alter table public.tournaments enable row level security;
alter table public.match_reports enable row level security;

-- Public browser access for the current no-login app.
-- Tighten these policies after adding Supabase Auth or admin-only scoring.
drop policy if exists "public read players" on public.players;
drop policy if exists "public write players" on public.players;
drop policy if exists "public update players" on public.players;
create policy "public read players" on public.players for select using (true);
create policy "public write players" on public.players for insert with check (true);
create policy "public update players" on public.players for update using (true);

drop policy if exists "public read teams" on public.teams;
drop policy if exists "public write teams" on public.teams;
drop policy if exists "public update teams" on public.teams;
create policy "public read teams" on public.teams for select using (true);
create policy "public write teams" on public.teams for insert with check (true);
create policy "public update teams" on public.teams for update using (true);

drop policy if exists "public read matches" on public.matches;
drop policy if exists "public write matches" on public.matches;
drop policy if exists "public update matches" on public.matches;
create policy "public read matches" on public.matches for select using (true);
create policy "public write matches" on public.matches for insert with check (true);
create policy "public update matches" on public.matches for update using (true);

drop policy if exists "public read tournaments" on public.tournaments;
drop policy if exists "public write tournaments" on public.tournaments;
drop policy if exists "public update tournaments" on public.tournaments;
create policy "public read tournaments" on public.tournaments for select using (true);
create policy "public write tournaments" on public.tournaments for insert with check (true);
create policy "public update tournaments" on public.tournaments for update using (true);

drop policy if exists "public read match_reports" on public.match_reports;
drop policy if exists "public write match_reports" on public.match_reports;
drop policy if exists "public update match_reports" on public.match_reports;
create policy "public read match_reports" on public.match_reports for select using (true);
create policy "public write match_reports" on public.match_reports for insert with check (true);
create policy "public update match_reports" on public.match_reports for update using (true);
