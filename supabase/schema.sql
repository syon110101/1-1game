-- 1:1 운빨 대전 기본 대기실 구조
-- Supabase SQL Editor에서 실행하세요.

create table if not exists public.rooms (
  room_code varchar(4) primary key,
  player1_name text,
  player2_name text,
  player1_id text,
  player2_id text,
  status text not null default 'waiting',
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

create policy "rooms_select"
on public.rooms for select
using (true);

create policy "rooms_insert"
on public.rooms for insert
with check (true);

create policy "rooms_update"
on public.rooms for update
using (true)
with check (true);
