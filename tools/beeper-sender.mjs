import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import config from '../config.js';
const dir=join(homedir(),'.local','share','poulos-workstation');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function classifyReceipt(message){
  if(message?.sendStatus?.status==='SUCCESS')return 'sent';
  if(['FAIL_RETRIABLE','FAIL_PERMANENT'].includes(message?.sendStatus?.status))return 'failed';
  return 'submitted';
}
export async function dispatch(row,{getChat,send,finish}){
  // The database has already atomically claimed this exact owner-written payload.
  let chat;
  try{chat=await getChat(row.source_chat_id);}
  catch{await finish(row.id,'failed',null,'Δεν βρέθηκε η συνομιλία στο Beeper. Δεν έγινε αποστολή.');return;}
  if(chat.accountID!==row.account_id){await finish(row.id,'failed',null,'Η συνομιλία δεν αντιστοιχεί στον επιλεγμένο λογαριασμό. Δεν έγινε αποστολή.');return;}
  let result;
  try{result=await send(chat.id||row.source_chat_id,row.text);}
  catch(error){
    const status=error.beforeSend?'failed':'uncertain';
    await finish(row.id,status,null,status==='failed'?'Το Beeper απέρριψε το αίτημα αποστολής.':'Δεν επιβεβαιώθηκε η αποστολή. Έλεγξε το Beeper πριν στείλεις ξανά.');
    return;
  }
  if(!result?.pendingMessageID){await finish(row.id,'uncertain',null,'Το Beeper δεν επέστρεψε αναγνωριστικό. Έλεγξε τη συνομιλία πριν στείλεις ξανά.');return;}
  // If persistence fails, never replay POST. The claimed row becomes uncertain.
  await finish(row.id,'submitted',result.pendingMessageID,null);
}
async function main(){
  await mkdir(dir,{recursive:true,mode:0o700});
  if(process.argv.includes('--initialize')){
    let token;try{token=await readFile(join(dir,'sender-token'),'utf8');}catch{token=randomBytes(48).toString('base64url');await writeFile(join(dir,'sender-token'),token,{mode:0o600,flag:'wx'});}
    console.log('Bridge token SHA256: '+createHash('sha256').update(token).digest('hex'));return;
  }
  const token=await readFile(join(dir,'sender-token'),'utf8');
  const auth=JSON.parse(await readFile(join(dir,'beeper.json'),'utf8'));
  async function beeper(path,body){
    const r=await fetch('http://127.0.0.1:23373'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth.access_token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(!r.ok){const e=Error('Beeper HTTP '+r.status);e.beforeSend=[400,401,403,404,405,422].includes(r.status);throw e;}return r.json();
  }
  async function rpc(name,body){
    const r=await fetch(config.url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:config.anonKey,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw Error('Workstation HTTP '+r.status);
    const text=await r.text();return text?JSON.parse(text):null;
  }
  const finish=(id,status,messageID,error)=>rpc('finish_workstation_message',{p_token:token,p_id:id,p_status:status,p_message_id:messageID,p_error:error});
  if(process.argv.includes('--check')){
    const accounts=await beeper('/v1/accounts');
    console.log('Beeper API connected; account count: '+(Array.isArray(accounts)?accounts.length:accounts.items?.length??'available'));
    return;
  }
  let connected=false,lastCheck=0,lastError='';
  console.log('Poulos sender started. Only owner-approved outbox requests are sent; no AI calls.');
  while(true){
    try{
      if(Date.now()-lastCheck>15000){try{await beeper('/v1/accounts');connected=true;}catch{connected=false;}lastCheck=Date.now();}
      const data=await rpc('poll_workstation_outbox',{p_token:token,p_connected:connected});
      if(data?.claimed)await dispatch(data.claimed,{
        getChat:id=>beeper('/v1/chats/'+encodeURIComponent(id)),
        send:(id,text)=>beeper('/v1/chats/'+encodeURIComponent(id)+'/messages',{text}),finish
      });
      for(const row of data?.awaiting||[]){
        try{
          const message=await beeper('/v1/chats/'+encodeURIComponent(row.source_chat_id)+'/messages/'+encodeURIComponent(row.message_id));
          if(message.accountID!==row.account_id)continue;
          const status=classifyReceipt(message);
          if(status!=='submitted')await finish(row.id,status,message.id||row.message_id,status==='failed'?'Η εφαρμογή ανέφερε αποτυχία αποστολής.':null);
          else if(Date.now()-Date.parse(row.updated_at)>300000)await finish(row.id,'uncertain',row.message_id,'Δεν ήρθε επιβεβαίωση από το δίκτυο. Έλεγξε το Beeper.');
        }catch{if(Date.now()-Date.parse(row.updated_at)>300000)await finish(row.id,'uncertain',row.message_id,'Δεν ήταν δυνατός ο έλεγχος επιβεβαίωσης. Έλεγξε το Beeper.');}
      }
      lastError='';
    }catch(error){const safe=String(error.message).replace(/Bearer\s+\S+/g,'[redacted]');if(safe!==lastError){console.error('Sender temporarily unavailable: '+safe);lastError=safe;}await pause(5000);}
    await pause(2000);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Sender setup is incomplete. Authorize Beeper and configure the private sender credential.');process.exitCode=1;});
