create table public.workstation_chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('beeper','imessage','messenger','instagram','telegram','whatsapp','viber','slack')),
  account_id text not null check (length(account_id) between 1 and 300),
  source_chat_id text not null check (length(source_chat_id) between 1 and 300),
  title text not null check (length(title) between 1 and 500),
  last_activity_at timestamptz,
  unread_count integer not null default 0 check (unread_count >= 0),
  is_muted boolean not null default false,
  synced_at timestamptz not null default now(),
  unique (workspace_id, provider, account_id, source_chat_id)
);
alter table public.workstation_chats enable row level security;
revoke all on public.workstation_chats from anon, authenticated;
grant select on public.workstation_chats to authenticated;
grant all on public.workstation_chats to service_role;
create policy workstation_chats_member_read on public.workstation_chats
  for select to authenticated using (public.is_member(workspace_id));
create index workstation_chats_activity on public.workstation_chats(workspace_id, last_activity_at desc);
