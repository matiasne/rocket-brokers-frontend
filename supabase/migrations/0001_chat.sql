-- The chat of each signed-in user: its sessions and the turns in them, so that a browser
-- refresh brings back the thread and whatever was still in progress.
-- Run once in the Supabase SQL editor (or with `supabase db push`).

create table if not exists public.chat_sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The A2A context of the session: what the router keys its memory and background tasks on.
  context_id uuid not null,
  title text,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_turns (
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  id text not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- a2a: a loan-officer turn; pap: a borrower's-agent conversation; background: a delegation that outlived its turn.
  kind text not null check (kind in ('a2a', 'pap', 'background')),
  -- The turn as the page holds it (src/app/page.tsx: RouterTask or PapConversation).
  data jsonb not null,
  started_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (session_id, id)
);

create index if not exists chat_sessions_user on public.chat_sessions (user_id, created_at);
create index if not exists chat_turns_user on public.chat_turns (user_id);

alter table public.chat_sessions enable row level security;
alter table public.chat_turns enable row level security;

-- Each user reads and writes only their own rows.
drop policy if exists "own sessions" on public.chat_sessions;
create policy "own sessions" on public.chat_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own turns" on public.chat_turns;
create policy "own turns" on public.chat_turns for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.chat_sessions, public.chat_turns to authenticated;
