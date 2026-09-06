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
async function readAll(table, order, ascending=false) {
  const rows=[];
  for (let from=0; ; from+=1000) {
    const page=unwrap(await sb.from(table).select('*').order(order,{ascending}).order('id').range(from,from+999));
    rows.push(...page);
    if(page.length<1000) return rows;
    if(rows.length>=20000) throw new Error('Πάρα πολλές εγγραφές για μία προβολή. Άνοιξε τον επιμέρους χώρο.');
  }
}
export async function loadDashboard() {
  const generation=authGeneration;
  const [workspaces,tasks,events,logs,jobs,connections] = await Promise.all([
    readAll('workspace_overview','name',true),
    readAll('tasks','updated_at'),
    sb.from('tool_feed').select('*').order('occurred_at',{ascending:false}).limit(500).then(unwrap),
    sb.from('log_events').select('*').order('at',{ascending:false}).limit(80).then(unwrap),
    sb.from('job_runs').select('*').order('started_at',{ascending:false}).limit(30).then(unwrap),
    readAll('workstation_connections','label',true)
  ]);
  if (generation!==authGeneration) throw new Error('Η συνεδρία άλλαξε. Συνδέσου ξανά.');
  currentData={workspaces,tasks,events,logs,jobs,connections,loadedAt:new Date().toISOString()};
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
  return unwrap(await sb.from('tasks').insert({workspace_id:input.workspace_id,...taskPatch(input),via:'app'}).select().single());
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
export function subscribe(callback) {
  let pending;
  const update=()=>{clearTimeout(pending);pending=setTimeout(()=>{if(!document.hidden)callback();},350);};
  const channel=sb.channel('workstation-'+crypto.randomUUID());
  for(const table of ['tasks','ingestion_events','log_events']) channel.on('postgres_changes',{event:'*',schema:'public',table},update);
  channel.subscribe();
  const timer=setInterval(update,60000);
  const visible=()=>{if(!document.hidden)update();};
  document.addEventListener('visibilitychange',visible);
  return ()=>{clearInterval(timer);clearTimeout(pending);document.removeEventListener('visibilitychange',visible);sb.removeChannel(channel);};
}
