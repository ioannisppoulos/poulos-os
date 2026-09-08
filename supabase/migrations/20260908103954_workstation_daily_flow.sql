-- Private daily workflow. No provider credentials or account numbers are stored.
alter table public.ingestion_events add column external_id text check(length(external_id)<=400);
alter table public.ingestion_events add column meta jsonb not null default '{}'::jsonb;
create unique index ingestion_external_unique on public.ingestion_events(workspace_id,provider,external_id) where external_id is not null;
alter table public.ingestion_events drop constraint ingestion_events_provider_check;
alter table public.ingestion_events add constraint ingestion_events_provider_check check(provider in ('gmail','slack','calendar','notion','drive','bank','health','other','beeper','imessage','messenger','instagram','telegram','whatsapp'));
create or replace view public.tool_feed with (security_invoker=true) as
select e.id,e.workspace_id,w.name workspace_name,w.kind workspace_kind,e.area,e.provider,e.category,e.title,e.summary,e.url,e.amount,e.currency,e.counterparty,e.occurred_at,e.status,e.raw_ref,e.via,e.external_id,e.meta,e.created_at
from public.ingestion_events e join public.workspaces w on w.id=e.workspace_id;

create table public.workstation_suggestions (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 area text check(length(area)<=60), source_event_id uuid references public.ingestion_events(id),
 external_key text not null check(length(external_key)<=400), title text not null check(length(title) between 1 and 500),
 reason text not null check(length(reason) between 1 and 2000), notes text check(length(notes)<=4000),
 priority smallint not null default 2 check(priority between 0 and 3), due_date date,
 status text not null default 'pending' check(status in ('pending','accepted','rejected')),
 task_id uuid references public.tasks(id), created_at timestamptz not null default now(),
 decided_at timestamptz, decided_by uuid references auth.users(id), via text not null default 'codex',
 unique(workspace_id,external_key)
);
create table public.workstation_requests (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id), area text check(length(area)<=60),
 kind text not null check(kind in ('calendar','sync')), task_id uuid references public.tasks(id),
 title text not null check(length(title) between 1 and 500), start_at timestamptz,end_at timestamptz,
 status text not null default 'queued' check(status in ('queued','processing','completed','error','needs_review')),
 requested_by uuid not null references auth.users(id), requested_at timestamptz not null default now(),
 processed_at timestamptz, result_url text check(length(result_url)<=1000), external_id text,
 error text check(length(error)<=2000),
 check(kind<>'calendar' or (start_at is not null and end_at>start_at and end_at<=start_at+interval '24 hours'))
);
create unique index workstation_calendar_block_unique on public.workstation_requests(task_id,start_at,end_at) where kind='calendar' and status not in ('error');
create table public.workstation_accounts (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 account_ref text not null check(length(account_ref)<=200), bank text not null check(length(bank)<=100),
 label text not null check(length(label)<=200),currency text not null check(currency ~ '^[A-Z]{3}$'),
 balance numeric(18,2),balance_kind text not null default 'available' check(balance_kind in ('available','booked')),
 observed_at timestamptz, source text not null check(source in ('bank_api','browser_snapshot','statement')),
 status text not null default 'unavailable' check(status in ('active','stale','unavailable')),
 unique(workspace_id,account_ref)
);
alter table public.workstation_suggestions enable row level security;
alter table public.workstation_requests enable row level security;
alter table public.workstation_accounts enable row level security;
revoke all on public.workstation_suggestions,public.workstation_requests,public.workstation_accounts from anon,authenticated;
grant select on public.workstation_suggestions,public.workstation_requests,public.workstation_accounts to authenticated;
grant all on public.workstation_suggestions,public.workstation_requests,public.workstation_accounts to service_role;
create policy suggestions_read on public.workstation_suggestions for select to authenticated using(public.is_member(workspace_id));
create policy requests_read on public.workstation_requests for select to authenticated using(public.is_member(workspace_id));
create policy accounts_read on public.workstation_accounts for select to authenticated using(public.is_member(workspace_id));

create function public.workstation_check_scope() returns trigger language plpgsql set search_path='' as $$
begin
 if new.area is not null and not exists(select 1 from public.workspaces where id=new.workspace_id and kind='personal') then
  raise exception 'Personal areas require a personal workspace';
 end if;
 if tg_table_name='workstation_suggestions' then
  if new.source_event_id is not null then
  if not exists(select 1 from public.ingestion_events where id=new.source_event_id and workspace_id=new.workspace_id and area is not distinct from new.area) then
   raise exception 'Source and suggestion must belong to the same workspace and area';
  end if;
  end if;
 end if;
 return new;
end $$;
create trigger suggestions_scope before insert or update on public.workstation_suggestions for each row execute function public.workstation_check_scope();
create trigger requests_scope before insert or update on public.workstation_requests for each row execute function public.workstation_check_scope();

-- Definer RPCs are the only client write path for immutable owner decisions.
create function public.decide_workstation_suggestion(p_id uuid,p_accept boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.workstation_suggestions; result_id uuid;
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
 select * into s from public.workstation_suggestions where id=p_id for update;
 if not found or not public.is_owner(s.workspace_id) then raise exception 'Owner access required' using errcode='42501'; end if;
 if s.status<>'pending' then return s.task_id; end if;
 if p_accept then
  insert into public.tasks(workspace_id,area,title,notes,priority,due_date,assignee,via,created_by)
  values(s.workspace_id,s.area,s.title,s.notes,s.priority,s.due_date,'me','app',auth.uid()) returning id into result_id;
 end if;
 update public.workstation_suggestions set status=case when p_accept then 'accepted' else 'rejected' end,task_id=result_id,decided_at=now(),decided_by=auth.uid() where id=p_id;
 insert into public.log_events(workspace_id,area,day,actor,kind,text,refs,via,created_by)
 values(s.workspace_id,s.area,(now() at time zone 'Europe/Athens')::date,'user','decision',case when p_accept then 'Αποδοχή πρότασης: ' else 'Απόρριψη πρότασης: ' end||s.title,jsonb_build_object('suggestion_id',s.id,'task_id',result_id),'app',auth.uid());
 return result_id;
end $$;
revoke all on function public.decide_workstation_suggestion(uuid,boolean) from public,anon;
grant execute on function public.decide_workstation_suggestion(uuid,boolean) to authenticated;

create function public.request_workstation_action(p_id uuid,p_workspace uuid,p_kind text,p_task uuid default null,p_start timestamptz default null,p_end timestamptz default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare t public.tasks; existing public.workstation_requests; result_id uuid; title_value text; area_value text;
begin
 if auth.uid() is null or not public.is_owner(p_workspace) then raise exception 'Owner access required' using errcode='42501'; end if;
 select * into existing from public.workstation_requests where id=p_id;
 if found then
  if existing.requested_by<>auth.uid() or existing.workspace_id<>p_workspace then raise exception 'Request conflict' using errcode='42501'; end if;
  return existing.id;
 end if;
 if p_kind='calendar' then
  select * into t from public.tasks where id=p_task and workspace_id=p_workspace;
  if not found then raise exception 'Task not found'; end if;
  if p_start is null or p_end is null or p_start<now() or p_end<=p_start or p_end>p_start+interval '24 hours' then raise exception 'Choose a future start and a valid duration'; end if;
  select id into result_id from public.workstation_requests where task_id=p_task and start_at=p_start and end_at=p_end and status<>'error';
  if found then return result_id; end if;
  title_value:=t.title; area_value:=t.area;
 elsif p_kind='sync' then
  if exists(select 1 from public.workstation_requests where workspace_id=p_workspace and kind='sync' and status in ('queued','processing')) then
   select id into result_id from public.workstation_requests where workspace_id=p_workspace and kind='sync' and status in ('queued','processing') order by requested_at limit 1; return result_id;
  end if;
  title_value:='Έλεγχος εισερχομένων';
 else raise exception 'Unsupported action'; end if;
 insert into public.workstation_requests(id,workspace_id,area,kind,task_id,title,start_at,end_at,requested_by)
 values(p_id,p_workspace,area_value,p_kind,p_task,title_value,p_start,p_end,auth.uid());
 return p_id;
end $$;
revoke all on function public.request_workstation_action(uuid,uuid,text,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.request_workstation_action(uuid,uuid,text,uuid,timestamptz,timestamptz) to authenticated;

create function public.workstation_task_audit() returns trigger language plpgsql security definer set search_path='' as $$
declare action_text text;
begin
 if tg_op='INSERT' then action_text:='Νέα εργασία: ';
 elsif new.status is distinct from old.status then action_text:=case when new.status='done' then 'Ολοκληρώθηκε: ' when new.status='doing' then 'Ξεκίνησε: ' when new.status='dropped' then 'Ακυρώθηκε: ' else 'Άνοιξε ξανά: ' end;
 elsif row(new.title,new.notes,new.due_date,new.priority,new.assignee) is distinct from row(old.title,old.notes,old.due_date,old.priority,old.assignee) then action_text:='Ενημερώθηκε εργασία: ';
 else return new; end if;
 insert into public.log_events(workspace_id,area,day,actor,kind,text,refs,via,created_by)
 values(new.workspace_id,new.area,(now() at time zone 'Europe/Athens')::date,case when auth.uid() is null then 'agent' else 'user' end,'task',action_text||new.title,jsonb_build_object('task_id',new.id,'task_status',new.status),coalesce(new.via,'app'),auth.uid());
 return new;
end $$;
revoke all on function public.workstation_task_audit() from public,anon,authenticated;
create trigger workstation_task_audit after insert or update on public.tasks for each row execute function public.workstation_task_audit();
notify pgrst,'reload schema';
