import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.115.0';
import config from './config.js';

const sb = createClient(config.url, config.anonKey);
let currentData = null;
let authGeneration = 0;
let currentUserId = null;
const unwrap = ({data, error}) => { if (error) throw error; return data; };
export async function getSession() { return unwrap(await sb.auth.getSession())?.session || null; }
export function onAuthChange(callback) {
  const {data:{subscription}} = sb.auth.onAuthStateChange((event, session) => {
    if ((session?.user?.id || null) !== currentUserId || event === 'SIGNED_OUT') {
      currentUserId=session?.user?.id || null;
      authGeneration++; currentData = null;
    }
    // Never perform awaited auth calls inside the auth state lock.
    setTimeout(() => callback(session, event), 0);
  });
  return () => subscription.unsubscribe();
}
export async function signIn(email, password) { return unwrap(await sb.auth.signInWithPassword({email,password})); }
export async function signOut() {
  unwrap(await sb.auth.signOut());
  authGeneration++; currentData = null;
}
async function readAll(table, order, ascending=false, filter=null) {
  const rows=[];
  for (let from=0; ; from+=1000) {
    let query=sb.from(table).select('*').order(order,{ascending}).order('id');
    if(filter) query=query.contains('refs',filter);
    const page=unwrap(await query.range(from,from+999));
    rows.push(...page);
    if(page.length<1000) return rows;
    if(rows.length>=20000) throw new Error('Πάρα πολλές εγγραφές για μία προβολή. Άνοιξε τον επιμέρους χώρο.');
  }
}
async function readWindow(table,order,configure) {
  const rows=[];
  for(let from=0;from<20000;from+=1000) {
    const page=unwrap(await configure(sb.from(table).select('*')).order(order,{ascending:false}).order('id').range(from,from+999));
    rows.push(...page);if(page.length<1000)return rows;
  }
  throw new Error('Το επιλεγμένο διάστημα έχει πάνω από 20.000 εγγραφές. Χρειάζεται μικρότερο εύρος.');
}
export async function loadDashboard(selectedDay) {
  const day=/^\d{4}-\d{2}-\d{2}$/.test(selectedDay||'')?selectedDay:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  // One-day padding includes Athens midnight; views apply the exact local date.
  const monthStart=new Date(day.slice(0,7)+'-01T00:00:00Z');
  const windowStart=new Date(monthStart.getTime()-86400000).toISOString();
  const windowEnd=new Date(Date.UTC(monthStart.getUTCFullYear(),monthStart.getUTCMonth()+1,2)).toISOString();
  const generation=authGeneration;
  const [workspaces,tasks,events,logs,jobs,connections,captures,metrics,suggestions,requests,accounts,chats,sending] = await Promise.all([
    readAll('workspace_overview','name',true),
    readAll('tasks','updated_at'),
    Promise.all([
      sb.from('tool_feed').select('*').order('occurred_at',{ascending:false}).limit(500).then(unwrap),
      readWindow('tool_feed','occurred_at',q=>q.gte('occurred_at',windowStart).lt('occurred_at',windowEnd))
    ]).then(pages=>[...new Map(pages.flat().map(e=>[e.id,e])).values()]),
    readWindow('log_events','at',q=>q.eq('day',day)),
    sb.from('job_runs').select('*').order('started_at',{ascending:false}).limit(30).then(unwrap),
    readAll('workstation_connections','label',true),
    readAll('log_events','at',false,{workstation_capture:true}),
    sb.from('log_events').select('*').contains('refs',{workstation_metrics:true}).order('at',{ascending:false}).limit(300).then(unwrap),
    readAll('workstation_suggestions','created_at'),
    readAll('workstation_requests','requested_at'),
    readAll('workstation_accounts','bank',true),
    readAll('workstation_chats','last_activity_at'),
    loadSendingState()
  ]);
  if (generation!==authGeneration) throw new Error('Η συνεδρία άλλαξε. Συνδέσου ξανά.');
  currentData={workspaces,tasks,events,logs,jobs,connections,captures,metrics,suggestions,requests,accounts,chats,...sending,loadedAt:new Date().toISOString()};
  return currentData;
}
const taskFields=['title','notes','status','priority','due_date','assignee'];
function taskPatch(input) {
  const patch=Object.fromEntries(taskFields.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]));
  if ('title' in patch) {
    patch.title=String(patch.title).trim();
    if (!patch.title || patch.title.length>500) throw new Error('Ο τίτλος χρειάζεται 1–500 χαρακτήρες.');
  }
  if(patch.notes?.length>4000) throw new Error('Οι σημειώσεις χωρούν έως 4.000 χαρακτήρες.');
  if ('due_date' in patch && !patch.due_date) patch.due_date=null;
  if ('priority' in patch) patch.priority=Number(patch.priority);
  return patch;
}
export async function createTask(input) {
  const ws=currentData?.workspaces.find(w=>w.id===input.workspace_id);
  if(!ws || (input.area && ws.kind!=='personal')) throw new Error('Έλεγξε τον χώρο της εργασίας.');
  return unwrap(await sb.from('tasks').insert({workspace_id:input.workspace_id,area:input.area||null,...taskPatch(input),via:'app'}).select().single());
}
export async function updateTask(task, input) {
  const result=await sb.rpc('update_task',{p_id:task.id,p_expected_version:task.version,p_patch:taskPatch(input)});
  if(result.error?.code==='40001') throw new Error('Η εργασία άλλαξε από άλλη συνεδρία. Κάνε ανανέωση πριν αποθηκεύσεις ξανά.');
  return unwrap(result);
}
export async function triageEvent(id,status) {
  if(!['new','triaged','archived'].includes(status)) throw new Error('Μη έγκυρη κατάσταση.');
  return unwrap(await sb.from('ingestion_events').update({status}).eq('id',id).select('id,status').single());
}
export async function saveConnection(input) {
  let url=null;
  if(input.url) {
    url=new URL(input.url);
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Χρησιμοποίησε σύνδεσμο http ή https χωρίς στοιχεία σύνδεσης.');
    if([...url.searchParams.keys()].some(k=>/^(access_token|refresh_token|token|api[_-]?key|password|secret|signature|authorization)$/i.test(k))) throw new Error('Ο σύνδεσμος περιέχει στοιχεία πρόσβασης. Πρόσθεσε μόνο τη βασική διεύθυνση της εφαρμογής.');
  }
  return unwrap(await sb.from('workstation_connections').insert({workspace_id:input.workspace_id,provider:input.provider||'custom',label:input.label.trim(),url:url?.href||null}).select().single());
}
export function getHandoff(task) {
  const ws=currentData?.workspaces.find(w=>w.id===task.workspace_id);
  const label=ws?.name || 'Επιλεγμένος χώρος';
  return [
    `Εργασία ΠΟΥΛΟΣ OS · ${label}`,
    `Task ID: ${task.id}`,
    `Workspace ID: ${task.workspace_id}`,
    `Στόχος: ${task.title}`,
    `Υπεύθυνος: ${task.assignee||'me'} · Κατάσταση: ${task.status}`,
    task.due_date ? `Προθεσμία: ${task.due_date}` : '',
    task.notes ? `Σημειώσεις / συνέχεια:\n${task.notes}` : '',
    '',
    'Δούλεψε μόνο στον παραπάνω χώρο. Διάβασε το αντίστοιχο router και ενεργό context πριν προχωρήσεις. Μην μεταφέρεις προσωπικές πληροφορίες σε επιχειρηματικούς χώρους.',
    'Στο τέλος δώσε: αποτέλεσμα, πηγές/παραδοτέα, αποφάσεις και επόμενο βήμα. Ενημέρωσε την ίδια εργασία μέσω της υπάρχουσας σύνδεσης Supabase αν είναι διαθέσιμη, διατηρώντας τον έλεγχο version· αλλιώς δώσε κείμενο για αποθήκευση στις σημειώσεις.',
    'Η ανάθεση δεν ξεκινά αυτόματα agent. Η εκτέλεση αρχίζει όταν σταλεί αυτό το μήνυμα.',
    'Dashboard: https://ioannisppoulos.github.io/poulos-os/'
  ].filter(Boolean).join('\n');
}
export async function loadConversation(chat) {
  const generation=authGeneration;
  const rows=unwrap(await sb.from('tool_feed').select('*').eq('workspace_id',chat.workspace_id).eq('provider',chat.provider).contains('meta',{source_account:chat.account_id,source_thread_id:chat.source_chat_id}).order('occurred_at',{ascending:false}).order('id').limit(250));
  if(generation!==authGeneration)throw new Error('Η συνεδρία άλλαξε.');
  return rows;
}
export async function loadSendingState() {
  const generation=authGeneration;
  const [outbox,bridges]=await Promise.all([
    sb.from('workstation_outbox').select('*').order('requested_at',{ascending:false}).limit(500).then(unwrap),
    sb.from('workstation_bridges').select('*').then(unwrap)
  ]);
  if(generation!==authGeneration)throw new Error('Η συνεδρία άλλαξε.');
  return {outbox,bridges};
}
export async function queueMessage(request) {
  return unwrap(await sb.rpc('queue_workstation_message',{p_id:request.id,p_chat:request.chat_id,p_text:request.text}));
}
export function subscribe(callback) {
  let pending;
  const update=()=>{clearTimeout(pending);pending=setTimeout(callback,350);};
  const channel=sb.channel('workstation-'+crypto.randomUUID());
  for(const table of ['tasks','ingestion_events','log_events','workstation_suggestions','workstation_requests','workstation_accounts','workstation_connections','workstation_chats']) channel.on('postgres_changes',{event:'*',schema:'public',table},update);
  channel.subscribe();
  const timer=setInterval(update,60000);
  const visible=()=>{if(!document.hidden)update();};
  document.addEventListener('visibilitychange',visible);
  return ()=>{clearInterval(timer);clearTimeout(pending);document.removeEventListener('visibilitychange',visible);sb.removeChannel(channel);};
}

export async function decideSuggestion(id,accept) {
  return unwrap(await sb.rpc('decide_workstation_suggestion',{p_id:id,p_accept:accept}));
}
export async function requestAction({id,workspace_id,kind,task_id,start_at,end_at}) {
  return unwrap(await sb.rpc('request_workstation_action',{p_id:id,p_workspace:workspace_id,p_kind:kind,p_task:task_id||null,p_start:start_at||null,p_end:end_at||null}));
}

export async function createCapture(input) {
  const title=String(input.title||'').trim(), text=String(input.text||'').trim();
  if(!title||title.length>200) throw new Error('Ο τίτλος χρειάζεται 1–200 χαρακτήρες.');
  if(!text||text.length>4000) throw new Error('Η καταγραφή χρειάζεται 1–4.000 χαρακτήρες.');
  const kinds=['note','call','meeting','decision'];
  if(!kinds.includes(input.capture_kind)) throw new Error('Μη έγκυρος τύπος καταγραφής.');
  const ws=currentData?.workspaces.find(w=>w.id===input.workspace_id);
  if(!ws) throw new Error('Διάλεξε έναν διαθέσιμο χώρο.');
  const areas=['Υγεία','Σχέσεις','Καριέρα','Οικονομικά','Σπίτι','Μάθηση'];
  if(input.area && (ws.kind!=='personal'||!areas.includes(input.area))) throw new Error('Οι προσωπικές περιοχές ανήκουν στον προσωπικό χώρο.');
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return unwrap(await sb.from('log_events').insert({workspace_id:ws.id,day,actor:'user',kind:input.capture_kind==='decision'?'decision':'note',text,area:input.area||null,via:'app',refs:{workstation_capture:true,title,capture_kind:input.capture_kind}}).select().single());
}
