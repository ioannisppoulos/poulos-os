create schema if not exists workstation_private;
revoke all on schema workstation_private from public;
grant usage on schema workstation_private to anon,authenticated;

create table public.workstation_bridges (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 label text not null default 'Beeper στο Mac', connected boolean not null default false,last_seen_at timestamptz
);
create table workstation_private.bridge_credentials (
 token_hash text primary key,bridge_id uuid not null references public.workstation_bridges(id),
 active boolean not null default true,created_at timestamptz not null default now()
);
create table public.workstation_outbox (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id),
 chat_id uuid not null references public.workstation_chats(id),
 provider text not null,account_id text not null,source_chat_id text not null,chat_title text not null,
 text text not null check(length(btrim(text)) between 1 and 4000),
 status text not null default 'queued' check(status in ('queued','sending','submitted','sent','failed','uncertain','cancelled','expired')),
 requested_by uuid not null references auth.users(id),requested_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '2 minutes',updated_at timestamptz not null default now(),
 bridge_id uuid references public.workstation_bridges(id),message_id text,error text
);
alter table public.workstation_outbox enable row level security;
alter table public.workstation_bridges enable row level security;
alter table workstation_private.bridge_credentials enable row level security;
revoke all on public.workstation_outbox,public.workstation_bridges,workstation_private.bridge_credentials from anon,authenticated;
grant select on public.workstation_outbox,public.workstation_bridges to authenticated;
grant all on public.workstation_outbox,public.workstation_bridges,workstation_private.bridge_credentials to service_role;
create policy outbox_member_read on public.workstation_outbox for select to authenticated using(public.is_member(workspace_id));
create policy bridges_member_read on public.workstation_bridges for select to authenticated using(public.is_member(workspace_id));
create index outbox_pending on public.workstation_outbox(workspace_id,status,requested_at);

create function workstation_private.enqueue_message(p_id uuid,p_chat uuid,p_text text) returns uuid
language plpgsql security definer set search_path='' as $$
declare c public.workstation_chats; old public.workstation_outbox;
begin
 select * into c from public.workstation_chats where id=p_chat;
 if not found or auth.uid() is null or not public.is_owner(c.workspace_id) then raise exception 'Owner access required' using errcode='42501'; end if;
 if c.provider not in ('instagram','messenger','whatsapp','telegram','imessage','beeper') then raise exception 'Η αποστολή δεν υποστηρίζεται σε αυτή την εφαρμογή.'; end if;
 if p_text is null or length(btrim(p_text)) not between 1 and 4000 then raise exception 'Γράψε μήνυμα έως 4.000 χαρακτήρες.'; end if;
 select * into old from public.workstation_outbox where id=p_id;
 if found then
  if old.chat_id<>p_chat or old.text<>p_text or old.requested_by<>auth.uid() then raise exception 'Request conflict'; end if;
  return old.id;
 end if;
 if not exists(select 1 from public.workstation_bridges where workspace_id=c.workspace_id and connected and last_seen_at>now()-interval '45 seconds') then raise exception 'Η υπηρεσία αποστολής στο Mac δεν είναι συνδεδεμένη. Το μήνυμα παραμένει πρόχειρο.'; end if;
 insert into public.workstation_outbox(id,workspace_id,chat_id,provider,account_id,source_chat_id,chat_title,text,requested_by)
 values(p_id,c.workspace_id,c.id,c.provider,c.account_id,c.source_chat_id,c.title,p_text,auth.uid());
 return p_id;
end $$;
create function public.queue_workstation_message(p_id uuid,p_chat uuid,p_text text) returns uuid
language sql security invoker set search_path='' as $$ select workstation_private.enqueue_message(p_id,p_chat,p_text) $$;
revoke all on function workstation_private.enqueue_message(uuid,uuid,text),public.queue_workstation_message(uuid,uuid,text) from public,anon;
grant execute on function workstation_private.enqueue_message(uuid,uuid,text),public.queue_workstation_message(uuid,uuid,text) to authenticated;

create function workstation_private.bridge_poll(p_token text,p_connected boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.workstation_bridges; m public.workstation_outbox; waiting jsonb;
begin
 select br.* into b from workstation_private.bridge_credentials k join public.workstation_bridges br on br.id=k.bridge_id
 where k.active and k.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if not found then raise exception 'Invalid bridge authorization' using errcode='42501'; end if;
 update public.workstation_bridges set last_seen_at=now(),connected=p_connected where id=b.id;
 update public.workstation_outbox set status='expired',updated_at=now(),error='Δεν στάλθηκε εγκαίρως. Στείλε ξανά αν το θέλεις.'
 where workspace_id=b.workspace_id and status='queued' and expires_at<now();
 update public.workstation_outbox set status='uncertain',updated_at=now(),error='Η επιβεβαίωση διακόπηκε. Έλεγξε το Beeper πριν στείλεις ξανά.'
 where workspace_id=b.workspace_id and status='sending' and updated_at<now()-interval '90 seconds';
 if not p_connected then return jsonb_build_object('claimed',null,'awaiting','[]'::jsonb); end if;
 select * into m from public.workstation_outbox o where o.workspace_id=b.workspace_id and o.status='queued'
 and exists(select 1 from public.workspace_members wm where wm.workspace_id=o.workspace_id and wm.user_id=o.requested_by and wm.role='owner')
 order by requested_at for update skip locked limit 1;
 if found then update public.workstation_outbox set status='sending',bridge_id=b.id,updated_at=now() where id=m.id returning * into m; end if;
 select coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) into waiting from (select * from public.workstation_outbox
 where bridge_id=b.id and status='submitted' order by updated_at limit 20) o;
 return jsonb_build_object('claimed',case when m.id is null then null else to_jsonb(m) end,'awaiting',waiting);
end $$;
create function public.poll_workstation_outbox(p_token text,p_connected boolean) returns jsonb
language sql security invoker set search_path='' as $$ select workstation_private.bridge_poll(p_token,p_connected) $$;
revoke all on function workstation_private.bridge_poll(text,boolean),public.poll_workstation_outbox(text,boolean) from public;
grant execute on function workstation_private.bridge_poll(text,boolean),public.poll_workstation_outbox(text,boolean) to anon,authenticated;

create function workstation_private.bridge_finish(p_token text,p_id uuid,p_status text,p_message_id text,p_error text) returns void
language plpgsql security definer set search_path='' as $$
declare bid uuid; m public.workstation_outbox;
begin
 select bridge_id into bid from workstation_private.bridge_credentials where active and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if bid is null then raise exception 'Invalid bridge authorization' using errcode='42501'; end if;
 select * into m from public.workstation_outbox where id=p_id and bridge_id=bid for update;
 if not found then raise exception 'Request not claimed by this bridge' using errcode='42501'; end if;
 if m.status in ('sent','failed','uncertain','cancelled','expired') then return; end if;
 if m.status not in ('sending','submitted') or p_status not in ('submitted','sent','failed','uncertain') then raise exception 'Invalid send transition'; end if;
 if p_status in ('submitted','sent') and coalesce(p_message_id,m.message_id) is null then raise exception 'Message identifier required'; end if;
 update public.workstation_outbox set status=p_status,message_id=coalesce(p_message_id,message_id),error=left(p_error,500),updated_at=now() where id=p_id;
end $$;
create function public.finish_workstation_message(p_token text,p_id uuid,p_status text,p_message_id text default null,p_error text default null) returns void
language sql security invoker set search_path='' as $$ select workstation_private.bridge_finish(p_token,p_id,p_status,p_message_id,p_error) $$;
revoke all on function workstation_private.bridge_finish(text,uuid,text,text,text),public.finish_workstation_message(text,uuid,text,text,text) from public;
grant execute on function workstation_private.bridge_finish(text,uuid,text,text,text),public.finish_workstation_message(text,uuid,text,text,text) to anon,authenticated;
notify pgrst,'reload schema';
