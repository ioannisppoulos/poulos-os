begin;
-- Test fixtures and claims are transaction-local and are rolled back.
do $test$
declare v_owner uuid; v_ws uuid; v_other_ws uuid;
begin
  select user_id, workspace_id into v_owner, v_ws
  from public.workspace_members where role = 'owner' limit 1;
  if v_owner is null then raise exception 'owner fixture unavailable'; end if;
  select workspace_id into v_other_ws from public.workspace_members
  where user_id = v_owner and role = 'owner' and workspace_id <> v_ws limit 1;
  perform set_config('test.owner', v_owner::text, true);
  perform set_config('test.ws', v_ws::text, true);
  perform set_config('test.other_ws', coalesce(v_other_ws::text, ''), true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_owner,'role','authenticated')::text, true);
end $test$;

set local role authenticated;
do $test$
declare t public.tasks%rowtype; c public.workstation_connections%rowtype; v_delete uuid; v_count integer;
begin
  insert into public.tasks(workspace_id,title,notes,due_date)
  values(current_setting('test.ws')::uuid, 'Workstation transactional QA', 'original', current_date)
  returning * into t;
  if t.assignee <> 'me' or t.version <> 1 then raise exception 'task defaults failed'; end if;
  perform set_config('test.task', t.id::text, true);

  t := public.update_task(t.id, t.version,
    jsonb_build_object('assignee','codex','status','doing','title','QA assigned','priority',3,'notes','updated'));
  if t.assignee <> 'codex' or t.status <> 'doing' or t.version <> 2 or t.priority <> 3
     or t.notes <> 'updated' or t.title <> 'QA assigned' then
    raise exception 'task assignment/original patch fields failed';
  end if;
  begin
    perform public.update_task(t.id, 1, '{"assignee":"claude"}'::jsonb);
    raise exception 'stale version was accepted';
  exception when serialization_failure then null;
  end;
  begin
    perform public.update_task(t.id, 2, '{"assignee":"unknown"}'::jsonb);
    raise exception 'invalid assignee was accepted';
  exception when check_violation then null;
  end;
  t := public.update_task(t.id, 2, '{"assignee":"claude","status":"done","notes":null,"due_date":null}'::jsonb);
  if t.assignee <> 'claude' or t.version <> 3 or t.completed_at is null
     or t.notes is not null or t.due_date is not null then
    raise exception 'task completion/null patch failed';
  end if;

  insert into public.workstation_connections(workspace_id,provider,label,url)
  values(current_setting('test.ws')::uuid,'qa-provider','QA registry','https://example.com/')
  returning * into c;
  perform set_config('test.connection', c.id::text, true);
  if c.agent_status <> 'unverified' or c.sync_status <> 'not_configured'
     or c.verified_at is not null or c.last_synced_at is not null or c.details <> '{}'::jsonb then
    raise exception 'connection defaults failed';
  end if;
  update public.workstation_connections set label='QA updated', details='{"scope":"metadata"}'::jsonb
  where id=c.id returning * into c;
  if c.label <> 'QA updated' then raise exception 'owner connection update failed'; end if;

  if current_setting('test.other_ws') <> '' then
    begin
      update public.workstation_connections set workspace_id=current_setting('test.other_ws')::uuid where id=c.id;
      raise exception 'connection workspace reassignment accepted';
    exception when insufficient_privilege then null;
    end;
  end if;

  begin
    update public.workstation_connections set details='{"nested":{"access_token":"not-a-real-token"}}'::jsonb where id=c.id;
    raise exception 'nested credential field accepted';
  exception when check_violation then null;
  end;
  begin
    update public.workstation_connections set details='["invalid shape"]'::jsonb where id=c.id;
    raise exception 'non-object details accepted';
  exception when check_violation then null;
  end;
  begin
    update public.workstation_connections set url='javascript:alert(1)' where id=c.id;
    raise exception 'non-http URL accepted';
  exception when check_violation then null;
  end;
  begin
    update public.workstation_connections set url='https://user:pass@example.com/' where id=c.id;
    raise exception 'URL userinfo accepted';
  exception when check_violation then null;
  end;
  begin
    update public.workstation_connections set agent_status='connected' where id=c.id;
    raise exception 'invalid agent_status accepted';
  exception when check_violation then null;
  end;
  insert into public.workstation_connections(workspace_id,provider,label)
  values(current_setting('test.ws')::uuid,'qa-delete','QA delete')
  returning id into v_delete;
  delete from public.workstation_connections where id=v_delete;
  get diagnostics v_count=row_count;
  if v_count <> 1 then raise exception 'owner delete failed'; end if;
end $test$;

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
do $test$
declare v_count integer;
begin
  select count(*) into v_count from public.workstation_connections where id=current_setting('test.connection')::uuid;
  if v_count <> 0 then raise exception 'unrelated user saw a connection'; end if;
  select count(*) into v_count from public.tasks where id=current_setting('test.task')::uuid;
  if v_count <> 0 then raise exception 'unrelated user saw a task'; end if;
  begin
    insert into public.workstation_connections(workspace_id,provider,label)
    values(current_setting('test.ws')::uuid,'qa-intruder','Should fail');
    raise exception 'unrelated insert accepted';
  exception when insufficient_privilege then null;
  end;
  update public.workstation_connections set label='Should fail' where id=current_setting('test.connection')::uuid;
  get diagnostics v_count=row_count;
  if v_count <> 0 then raise exception 'unrelated update accepted'; end if;
  delete from public.workstation_connections where id=current_setting('test.connection')::uuid;
  get diagnostics v_count=row_count;
  if v_count <> 0 then raise exception 'unrelated delete accepted'; end if;
  begin
    perform public.update_task(current_setting('test.task')::uuid,3,'{"assignee":"me"}'::jsonb);
    raise exception 'unrelated task mutation accepted';
  exception when insufficient_privilege then null;
  end;
end $test$;

reset role;
set local role anon;
do $test$
begin
  begin
    perform count(*) from public.workstation_connections;
    raise exception 'anonymous read accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.workstation_connections(workspace_id,provider,label)
    values(current_setting('test.ws')::uuid,'qa-anon','Should fail');
    raise exception 'anonymous insert accepted';
  exception when insufficient_privilege then null;
  end;
end $test$;

reset role;
do $test$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema='public' and grantee in ('anon','authenticated')
      and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES')
  ) then raise exception 'unnecessary DDL grants remain'; end if;
  if (select prosecdef from pg_proc where oid='public.update_task(uuid,integer,jsonb)'::regprocedure)
  then raise exception 'task RPC became security definer'; end if;
end $test$;

select 'passed' as result,
  'owner CRUD; defaults; assignee patch; stale versions; completion; null patch; workspace pin; nested credential keys; URL guards; unrelated read/write deny; anonymous read/write deny; least-privilege grants' as checks;
rollback;
