-- 1:1 운빨 대전 전체 게임 구조
-- 기존 rooms 테이블이 이미 있다면 이 SQL을 그대로 한 번 더 실행하면 됩니다.

create table if not exists public.rooms (
  room_code varchar(4) primary key,
  player1_name text,
  player2_name text,
  player1_id text,
  player2_id text,
  status text not null default 'waiting',
  created_at timestamptz not null default now()
);

alter table public.rooms add column if not exists game_state jsonb;
alter table public.rooms add column if not exists turn integer not null default 1;
alter table public.rooms add column if not exists turn_started_at timestamptz;
alter table public.rooms add column if not exists winner_id text;
alter table public.rooms add column if not exists winner_name text;

create table if not exists public.game_actions (
  room_code varchar(4) not null references public.rooms(room_code) on delete cascade,
  turn integer not null,
  player_id text not null,
  action text not null,
  created_at timestamptz not null default now(),
  primary key (room_code, turn, player_id)
);

alter table public.rooms enable row level security;
alter table public.game_actions enable row level security;

drop policy if exists "rooms_select" on public.rooms;
drop policy if exists "rooms_insert" on public.rooms;
drop policy if exists "rooms_update" on public.rooms;
create policy "rooms_select" on public.rooms for select to anon using (true);
create policy "rooms_insert" on public.rooms for insert to anon with check (true);
create policy "rooms_update" on public.rooms for update to anon using (true) with check (true);

drop policy if exists "game_actions_select" on public.game_actions;
drop policy if exists "game_actions_insert" on public.game_actions;
create policy "game_actions_select" on public.game_actions for select to anon using (true);
create policy "game_actions_insert" on public.game_actions for insert to anon with check (true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'rooms'
  ) THEN
    EXECUTE 'alter publication supabase_realtime add table public.rooms';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'game_actions'
  ) THEN
    EXECUTE 'alter publication supabase_realtime add table public.game_actions';
  END IF;
END $$;
