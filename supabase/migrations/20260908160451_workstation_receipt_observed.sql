alter table public.workstation_outbox drop constraint workstation_outbox_status_check;
alter table public.workstation_outbox add constraint workstation_outbox_status_check check(status in ('queued','sending','submitted','sent','recorded','failed','uncertain','cancelled','expired'));
create or replace function workstation_private.bridge_finish(p_token text,p_id uuid,p_status text,p_message_id text,p_error text) returns void
language plpgsql security definer set search_path='' as $$
declare bid uuid; m public.workstation_outbox;
begin
 select bridge_id into bid from workstation_private.bridge_credentials where active and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if bid is null then raise exception 'Invalid bridge authorization' using errcode='42501'; end if;
 select * into m from public.workstation_outbox where id=p_id and bridge_id=bid for update;
 if not found then raise exception 'Request not claimed by this bridge' using errcode='42501'; end if;
 if m.status in ('sent','recorded','failed','uncertain','cancelled','expired') then return; end if;
 if m.status not in ('sending','submitted') or p_status not in ('submitted','sent','recorded','failed','uncertain') then raise exception 'Invalid send transition'; end if;
 if p_status in ('submitted','sent','recorded') and coalesce(p_message_id,m.message_id) is null then raise exception 'Message identifier required'; end if;
 update public.workstation_outbox set status=p_status,message_id=coalesce(p_message_id,message_id),error=left(p_error,500),updated_at=now() where id=p_id;
end $$;
