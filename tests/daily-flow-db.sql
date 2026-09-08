-- Run only after the approved migration. Everything is rolled back.
-- Test owner permissions, duplicate acceptance, rejection, and anon isolation.
begin;
select set_config('test.ws',(select workspace_id::text from public.workspace_members where role='owner' limit 1),true);
select set_config('test.owner',(select user_id::text from public.workspace_members where workspace_id=current_setting('test.ws')::uuid and role='owner' limit 1),true);
insert into public.workstation_suggestions(id,workspace_id,external_key,title,reason)
values('f1111111-1111-4111-8111-111111111111',current_setting('test.ws')::uuid,'test:accept','Synthetic acceptance test','Synthetic source'),
('f2222222-2222-4222-8222-222222222222',current_setting('test.ws')::uuid,'test:reject','Synthetic rejection test','Synthetic source');
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.owner'),'role','authenticated')::text,true);
set local role authenticated;
do $$ declare t1 uuid;t2 uuid; begin
 t1:=public.decide_workstation_suggestion('f1111111-1111-4111-8111-111111111111',true);
 t2:=public.decide_workstation_suggestion('f1111111-1111-4111-8111-111111111111',true);
 if t1 is null or t1<>t2 then raise exception 'Acceptance is not idempotent'; end if;
 if public.decide_workstation_suggestion('f2222222-2222-4222-8222-222222222222',false) is not null then raise exception 'Rejected suggestion created task'; end if;
 if not exists(select 1 from public.log_events where refs->>'task_id'=t1::text and kind='task') then raise exception 'Missing task audit'; end if;
 perform public.request_workstation_action('f3333333-3333-4333-8333-333333333333',current_setting('test.ws')::uuid,'calendar',t1,now()+interval '1 day',now()+interval '1 day 1 hour');
 begin
  insert into public.workstation_requests(id,workspace_id,kind,title,requested_by) values(gen_random_uuid(),current_setting('test.ws')::uuid,'sync','Forged request',auth.uid());
  raise exception 'Direct request insertion incorrectly allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','f9999999-9999-4999-8999-999999999999',true);
select set_config('request.jwt.claims','{"sub":"f9999999-9999-4999-8999-999999999999","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 if exists(select 1 from public.workstation_suggestions) then raise exception 'Non-member can read suggestions'; end if;
 begin perform public.decide_workstation_suggestion('f1111111-1111-4111-8111-111111111111',true);raise exception 'Non-owner decision allowed';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform 1 from public.workstation_accounts;raise exception 'Anonymous account access allowed';exception when insufficient_privilege then null;end;
 begin perform public.decide_workstation_suggestion('f1111111-1111-4111-8111-111111111111',true);raise exception 'Anonymous RPC allowed';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
