import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

const origin='http://127.0.0.1:23373';
const dir=join(homedir(),'.local','share','poulos-workstation');
await mkdir(dir,{recursive:true,mode:0o700});
const callback='http://127.0.0.1:5178/callback';
const state=randomBytes(32).toString('base64url');
const verifier=randomBytes(48).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
async function request(path,body){
  const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error('Beeper registration failed ('+r.status+')');
  return r.json();
}
const client=await request('/oauth/register',{client_name:'ΠΟΥΛΟΣ Workstation — αποστολή μηνυμάτων',redirect_uris:[callback],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'});
const auth=new URL('/oauth/authorize',origin);
for(const [k,v] of Object.entries({client_id:client.client_id,redirect_uri:callback,response_type:'code',scope:'read write',state,code_challenge:challenge,code_challenge_method:'S256'}))auth.searchParams.set(k,v);
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.headers.host!=='127.0.0.1:5178'){res.writeHead(403);res.end();return;}
  const u=new URL(req.url,'http://127.0.0.1:5178');
  if(u.pathname==='/connect/'+state){res.writeHead(302,{Location:auth.href});res.end();return;}
  if(u.pathname!=='/callback'||u.searchParams.get('state')!==state){res.writeHead(403);res.end('Μη έγκυρη σύνδεση.');return;}
  if(!u.searchParams.get('code')){res.writeHead(400);res.end('Η σύνδεση δεν εγκρίθηκε.');return;}
  try{
    const r=await fetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:u.searchParams.get('code'),redirect_uri:callback,code_verifier:verifier}),signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw Error('Authorization exchange failed');
    const data=await r.json();if(!data.access_token)throw Error('No access token');
    await writeFile(join(dir,'beeper.json.tmp'),JSON.stringify({access_token:data.access_token,created_at:new Date().toISOString()}),{mode:0o600});
    await rename(join(dir,'beeper.json.tmp'),join(dir,'beeper.json'));
    res.end('<h1>Το Beeper συνδέθηκε με το ΠΟΥΛΟΣ.</h1><p>Μπορείς να επιστρέψεις στο workstation. Αποστολή θα γίνεται μόνο όταν πατάς το κουμπί της συνομιλίας.</p>');
    console.log('Beeper authorization saved locally. No credentials printed.');
    setTimeout(()=>server.close(),500);
  }catch{res.writeHead(502);res.end('Η σύνδεση δεν ολοκληρώθηκε. Δοκίμασε ξανά από το ΠΟΥΛΟΣ.');}
});
server.listen(5178,'127.0.0.1',()=>console.log('Open http://127.0.0.1:5178/connect/'+state));
setTimeout(()=>server.close(),15*60*1000).unref();
