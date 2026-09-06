alter table public.tasks
  add column assignee text not null default 'me'
  constraint tasks_assignee_check check (assignee in ('me', 'codex', 'claude'));

create or replace function public.update_task(p_id uuid, p_expected_version integer, p_patch jsonb)
returns public.tasks
language plpgsql
security invoker
set search_path = public
as $function$
declare v public.tasks%rowtype;
begin
  update public.tasks set
    title    = coalesce(p_patch->>'title', title),
    notes    = case when p_patch ? 'notes' then p_patch->>'notes' else notes end,
    status   = coalesce((p_patch->>'status')::public.task_status, status),
    priority = coalesce((p_patch->>'priority')::smallint, priority),
    due_date = case when p_patch ? 'due_date' then (p_patch->>'due_date')::date else due_date end,
    assignee = coalesce(p_patch->>'assignee', assignee)
  where id = p_id and version = p_expected_version
  returning * into v;
  if v.id is null then
    if exists (select 1 from public.tasks where id = p_id and version <> p_expected_version) then
      raise exception 'task changed elsewhere — reload and retry' using errcode = '40001';
    end if;
    raise exception 'task not found or not editable' using errcode = '42501';
  end if;
  return v;
end
$function$;

create table public.workstation_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null
    constraint workstation_connections_provider_check
    check (length(provider) between 1 and 60 and provider ~ '^[a-z0-9][a-z0-9._-]*$'),
  label text not null
    constraint workstation_connections_label_check
    check (length(btrim(label)) between 1 and 120),
  url text
    constraint workstation_connections_url_check
    check (length(url) <= 1000 and url ~* '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'),
  agent_status text not null default 'unverified'
    constraint workstation_connections_agent_status_check
    check (agent_status in ('verified', 'reauth_required', 'unverified')),
  sync_status text not null default 'not_configured'
    constraint workstation_connections_sync_status_check
    check (sync_status in ('not_configured', 'snapshot', 'live', 'error')),
  verified_at timestamptz,
  last_synced_at timestamptz,
  details jsonb not null default '{}'::jsonb
    constraint workstation_connections_details_check
    check (
      jsonb_typeof(details) = 'object'
      and octet_length(details::text) <= 16384
      and details::text !~* '"[^"]*(token|password|secret|api[_-]?key|authorization|credential|cookie|private[_-]?key)[^"]*"[[:space:]]*:'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workstation_connections is
  'Workspace application registry and observed connection/sync status. No OAuth credentials; registration does not enable ingestion.';
comment on column public.workstation_connections.agent_status is
  'Access observed in an assistant environment; independent of dashboard ingestion.';
comment on column public.workstation_connections.sync_status is
  'Dashboard ingestion state; not_configured by default. A listed application is not automatically connected.';

create index workstation_connections_workspace_provider_idx
  on public.workstation_connections(workspace_id, provider);

alter table public.workstation_connections enable row level security;
revoke all on public.workstation_connections from public, anon, authenticated;
grant select, insert, update, delete on public.workstation_connections to authenticated, service_role;

create policy workstation_connections_select on public.workstation_connections
for select to authenticated using (public.is_member(workspace_id));
create policy workstation_connections_insert on public.workstation_connections
for insert to authenticated with check (public.is_owner(workspace_id));
create policy workstation_connections_update on public.workstation_connections
for update to authenticated
using (public.is_owner(workspace_id)) with check (public.is_owner(workspace_id));
create policy workstation_connections_delete on public.workstation_connections
for delete to authenticated using (public.is_owner(workspace_id));

create function public.tg_workstation_connections_update()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id is immutable' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$function$;
revoke all on function public.tg_workstation_connections_update() from public, anon, authenticated;
create trigger workstation_connections_update
before update on public.workstation_connections
for each row execute function public.tg_workstation_connections_update();

-- These DDL privileges are unnecessary for browser/API roles and are not covered by RLS.
-- Keep all pre-existing SELECT/INSERT/UPDATE/DELETE grants and membership policies intact.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
