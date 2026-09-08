-- Rollback-only integration test. No worker can see these uncommitted requests.
begin;
select set_config('request.jwt.claim.sub',(select wm.user_id::text from public.workspace_members wm join public.workstation_bridges b using(workspace_id) where wm.role='owner' limit 1),true);
select set_config('test.bridge',(select id::text from public.workstation_bridges limit 1),true);
select set_config('test.chat',(select c.id::text from public.workstation_chats c join public.workstation_bridges b using(workspace_id) where b.id=current_setting('test.bridge')::uuid limit 1),true);
select set_config('test.request',gen_random_uuid()::text,true);
update public.workstation_bridges set connected=true,last_seen_at=now() where id=current_setting('test.bridge')::uuid;
insert into workstation_private.bridge_credentials(token_hash,bridge_id) values(encode(sha256(convert_to('rollback-test-token','UTF8')),'hex'),current_setting('test.bridge')::uuid);
set local role authenticated;
do $$
declare rid uuid:=current_setting('test.request')::uuid; cid uuid:=current_setting('test.chat')::uuid; result jsonb;
begin
 if has_table_privilege('authenticated','public.workstation_outbox','INSERT') then raise exception 'Direct insert unexpectedly allowed'; end if;
 if has_table_privilege('anon','public.workstation_outbox','SELECT') then raise exception 'Anonymous read unexpectedly allowed'; end if;
 if has_function_privilege('anon','public.queue_workstation_message(uuid,uuid,text)','EXECUTE') then raise exception 'Anonymous queue unexpectedly allowed'; end if;
 perform public.queue_workstation_message(rid,cid,'Rollback test; never transmitted');
 perform public.queue_workstation_message(rid,cid,'Rollback test; never transmitted');
 if (select count(*) from public.workstation_outbox where id=rid)<>1 then raise exception 'Idempotency failed'; end if;
 begin
  perform public.queue_workstation_message(rid,cid,'Changed text');raise exception 'MUTATION ACCEPTED' using errcode='ZX001';
 exception when raise_exception then null; end;
 begin
  perform public.poll_workstation_outbox('wrong-token',true);raise exception 'TOKEN ACCEPTED' using errcode='ZX001';
 exception when insufficient_privilege then null; end;
 begin
  perform public.finish_workstation_message('rollback-test-token',rid,'sent','id',null);raise exception 'UNCLAIMED ACCEPTED' using errcode='ZX001';
 exception when insufficient_privilege then null; end;
 result:=public.poll_workstation_outbox('rollback-test-token',true);
 if result#>>'{claimed,id}' is distinct from rid::text then raise exception 'Claim missing'; end if;
 result:=public.poll_workstation_outbox('rollback-test-token',true);
 if result->'claimed'<>'null'::jsonb then raise exception 'Duplicate claim'; end if;
 perform public.finish_workstation_message('rollback-test-token',rid,'submitted','pending',null);
 perform public.finish_workstation_message('rollback-test-token',rid,'sent','final',null);
 perform public.finish_workstation_message('rollback-test-token',rid,'failed',null,'late failure');
 if (select status from public.workstation_outbox where id=rid)<>'sent' then raise exception 'Terminal state changed'; end if;
 perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 if exists(select 1 from public.workstation_outbox where id=rid) then raise exception 'Nonmember can read'; end if;
 begin
  perform public.queue_workstation_message(gen_random_uuid(),cid,'Unauthorized');raise exception 'NONOWNER ACCEPTED' using errcode='ZX001';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.workstation_outbox set status='queued',expires_at=now()-interval '1 second' where id=current_setting('test.request')::uuid;
select public.poll_workstation_outbox('rollback-test-token',false);
do $$ begin if (select status from public.workstation_outbox where id=current_setting('test.request')::uuid)<>'expired' then raise exception 'Expiry failed';end if;end $$;
update public.workstation_outbox set status='sending',updated_at=now()-interval '2 minutes' where id=current_setting('test.request')::uuid;
select public.poll_workstation_outbox('rollback-test-token',false);
do $$ begin if (select status from public.workstation_outbox where id=current_setting('test.request')::uuid)<>'uncertain' then raise exception 'Stale claim replay risk';end if;end $$;
rollback;
select 'PASS: owner-only enqueue, RLS, immutable idempotency, token authentication, atomic claim, terminal status, expiry and no replay; rolled back.' as result;
