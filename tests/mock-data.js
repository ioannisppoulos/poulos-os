// Synthetic test fixture only. No production authentication or data access.
const now = new Date().toISOString();
const day = now.slice(0, 10);
const wsA = '11111111-1111-4111-8111-111111111111';
const wsB = '22222222-2222-4222-8222-222222222222';
const taskA = 'aaaaaaaa-1111-4111-8111-111111111111';
const taskB = 'bbbbbbbb-2222-4222-8222-222222222222';
const workspaces = [
  {id:wsA,slug:'synthetic-alpha',name:'Synthetic Alpha',kind:'business',open_tasks:2,pending_memory:0,pending_skills:0,new_items:2,last_summary:null,last_job_ok:now},
  {id:wsB,slug:'synthetic-beta',name:'Synthetic Beta',kind:'personal',open_tasks:1,pending_memory:0,pending_skills:0,new_items:1,last_summary:null,last_job_ok:null}
];
const tasks = [
  {id:taskA,workspace_id:wsA,title:'Synthetic Alpha priority',notes:'ALPHA_ONLY_CONTEXT',status:'todo',priority:3,due_date:day,assignee:'codex',version:1,created_at:now,updated_at:now,completed_at:null},
  {id:'aaaaaaaa-3333-4333-8333-333333333333',workspace_id:wsA,title:'<img src=x onerror="window.__xss=1">',notes:'Synthetic escaped title',status:'todo',priority:0,due_date:null,assignee:'me',version:1,created_at:now,updated_at:now,completed_at:null},
  {id:taskB,workspace_id:wsB,title:'BETA_PRIVATE_MARKER',notes:'BETA_SECRET_CONTEXT',status:'todo',priority:1,due_date:null,assignee:'claude',version:1,created_at:now,updated_at:now,completed_at:null}
];
const events = [
  {id:'eeeeeeee-1111-4111-8111-111111111111',workspace_id:wsA,workspace_name:'Synthetic Alpha',workspace_kind:'business',provider:'gmail',category:'message',title:'Synthetic incoming',summary:'ALPHA_INBOX',url:'https://example.test/inbox',status:'new',occurred_at:now,via:'synthetic'},
  {id:'eeeeeeee-3333-4333-8333-333333333333',workspace_id:wsA,workspace_name:'Synthetic Alpha',workspace_kind:'business',provider:'other',category:'note',title:'<svg onload="window.__xss=2">',summary:'Synthetic unsafe source',url:'javascript:window.__xss=3',status:'new',occurred_at:now,via:'synthetic'},
  {id:'eeeeeeee-2222-4222-8222-222222222222',workspace_id:wsB,workspace_name:'Synthetic Beta',workspace_kind:'personal',provider:'other',category:'note',title:'BETA_PRIVATE_EVENT',summary:'BETA_PRIVATE_FEED',url:'https://example.test/beta',status:'new',occurred_at:now,via:'synthetic'}
];
const connections = [
  {id:'cccccccc-1111-4111-8111-111111111111',workspace_id:wsA,provider:'gmail',label:'Synthetic Mail',url:'https://example.test/mail',agent_status:'verified',sync_status:'not_configured',verified_at:now,last_synced_at:null,details:{note:'Synthetic verified assistant access only'},created_at:now,updated_at:now},
  {id:'cccccccc-3333-4333-8333-333333333333',workspace_id:wsA,provider:'notion',label:'Synthetic Notes',url:'https://example.test/notes',agent_status:'verified',sync_status:'snapshot',verified_at:now,last_synced_at:now,details:{},created_at:now,updated_at:now},
  {id:'cccccccc-4444-4444-8444-444444444444',workspace_id:wsA,provider:'calendar',label:'Synthetic Calendar',url:'https://example.test/calendar',agent_status:'unverified',sync_status:'not_configured',verified_at:null,last_synced_at:null,details:{},created_at:now,updated_at:now},
  {id:'cccccccc-5555-4555-8555-555555555555',workspace_id:wsA,provider:'slack',label:'Synthetic Reauth App',url:'https://example.test/reauth',agent_status:'reauth_required',sync_status:'error',verified_at:null,last_synced_at:null,details:{},created_at:now,updated_at:now},
  {id:'cccccccc-2222-4222-8222-222222222222',workspace_id:wsB,provider:'other',label:'BETA_PRIVATE_APP',url:'https://example.test/beta-app',agent_status:'unverified',sync_status:'not_configured',verified_at:null,last_synced_at:null,details:{},created_at:now,updated_at:now}
];
let currentData = {
  workspaces,tasks,events,connections,
  logs:[{id:'log-alpha',workspace_id:wsA,at:now,day,kind:'note',actor:'codex',text:'Synthetic Alpha activity',via:'synthetic'},{id:'log-beta',workspace_id:wsB,at:now,day,kind:'note',actor:'user',text:'BETA_PRIVATE_LOG',via:'synthetic'}],
  jobs:[{id:1,job:'synthetic-sync',workspace_id:wsA,status:'ok',started_at:now,finished_at:now,details:{},via:'synthetic'}],
  loadedAt:now
};
let session = null;
let authCallback = () => {};
let changeCallback = () => {};
window.__mock = {calls:[], failNextUpdate:false, data:currentData, wsA, wsB, taskA, taskB,
  expireSession:()=>{session=null;authCallback(null,'SIGNED_OUT');},
  refresh:()=>changeCallback()
};
const record = (name, value) => window.__mock.calls.push({name,value:structuredClone(value)});
export async function getSession() { return session; }
export function onAuthChange(callback) { authCallback=callback; return ()=>{authCallback=()=>{}}; }
export async function signIn(email,password) {
  record('signIn',{email});
  if(password!=='synthetic-password') throw new Error('Synthetic invalid login credentials');
  session={user:{id:'99999999-9999-4999-8999-999999999999',email}};
  setTimeout(()=>authCallback(session,'SIGNED_IN'),0);
  return {session,user:session.user};
}
export async function signOut() { record('signOut',{});session=null;authCallback(null,'SIGNED_OUT'); }
export async function loadDashboard() {
  record('loadDashboard',{});
  if(!session) throw new Error('Synthetic session required');
  return structuredClone(currentData);
}
export async function createTask(input) {
  record('createTask',input);
  const task={...input,id:crypto.randomUUID(),version:1,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),completed_at:null};
  currentData.tasks.push(task);
  return structuredClone(task);
}
export async function updateTask(task,patch) {
  record('updateTask',{id:task.id,version:task.version,patch});
  const found=currentData.tasks.find(t=>t.id===task.id);
  if(window.__mock.failNextUpdate || found?.version!==task.version) {
    window.__mock.failNextUpdate=false;
    throw new Error('Η εργασία άλλαξε από άλλη συνεδρία. Κάνε ανανέωση πριν αποθηκεύσεις ξανά.');
  }
  Object.assign(found,patch,{version:found.version+1,updated_at:new Date().toISOString()});
  found.completed_at=found.status==='done' ? new Date().toISOString() : null;
  return structuredClone(found);
}
export async function triageEvent(id,status) {
  record('triageEvent',{id,status});
  if(!['new','triaged','archived'].includes(status)) throw new Error('Μη έγκυρη κατάσταση.');
  const found=currentData.events.find(e=>e.id===id);found.status=status;
  return {id,status};
}
export async function saveConnection(input) {
  record('saveConnection',input);
  const connection={...input,id:crypto.randomUUID(),agent_status:'unverified',sync_status:'not_configured',verified_at:null,last_synced_at:null,details:{},created_at:now,updated_at:now};
  currentData.connections.push(connection);
  return structuredClone(connection);
}
export function subscribe(callback) { changeCallback=callback;return()=>{changeCallback=()=>{}}; }
/*ACTUAL_HANDOFF*/
