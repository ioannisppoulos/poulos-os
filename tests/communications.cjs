const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync('app.js','utf8').replace(/boot\(\);\s*$/,'');
const c=vm.createContext({URL,URLSearchParams,Intl,Date,console,window:{location:{search:''}},document:{querySelector(){return null}}});
vm.runInContext(src,c);const run=s=>vm.runInContext(s,c);
for(const label of ['CATEGORY_SOCIAL','CATEGORY_PROMOTIONS','SPAM','TRASH']){
  assert.equal(run(`visibleEmail({meta:{gmail_labels:['IMPORTANT','${label}']}})`),false);
}
for(const label of ['IMPORTANT','CATEGORY_UPDATES','CATEGORY_PERSONAL','INBOX'])assert.equal(run(`visibleEmail({meta:{gmail_labels:['${label}']}})`),true);
assert.equal(run("visibleEmail({meta:{gmail_labels:['CATEGORY_FORUMS']}})"),false);
assert.equal(run("visibleEmail({meta:{is_promotion:true}})"),false);
run(`state.data.workspaces=[{id:'a',name:'Personal',kind:'personal'},{id:'b',name:'Business',kind:'project'}];state.scope='a';state.data.chats=[{id:'c',workspace_id:'a',provider:'instagram',account_id:'ig1',source_chat_id:'1',title:'<script>contact</script>',last_activity_at:'2026-09-08T10:00:00Z'},{id:'d',workspace_id:'b',provider:'instagram',account_id:'ig2',source_chat_id:'1',title:'PRIVATE',last_activity_at:'2026-09-08T11:00:00Z'}];state.data.events=[{id:'m',workspace_id:'a',provider:'instagram',summary:'<img src=x>',occurred_at:'2026-09-08T10:00:00Z',meta:{source_account:'ig1',source_thread_id:'1',direction:'received'}},{id:'n',workspace_id:'a',provider:'whatsapp',summary:'separate',occurred_at:'2026-09-08T10:00:00Z',meta:{source_account:'wa',source_thread_id:'1',direction:'received'}}];`);
assert.equal(run('conversationDirectory().length'),2);
let html=run('renderChats()');assert(!html.includes('PRIVATE'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('<img src=x>'));
run("state.selectedChat='c'");html=run('renderChats()');assert(html.includes('&lt;img src=x&gt;'));assert(!html.includes('PRIVATE'));
assert.equal(run("conversationMessages(conversationDirectory()[0]).length"),1);
assert.equal(run("newMessageCandidates(state.data.events,new Set(['m','n']),0,[]).length"),0);
assert.equal(run("newMessageCandidates(state.data.events,new Set(),Date.parse('2026-09-09'),[]).length"),0);
assert.equal(run("newMessageCandidates([{...state.data.events[0],meta:{...state.data.events[0].meta,direction:'sent'}}],new Set(),0,[]).length"),0);
assert.equal(run("newMessageCandidates([state.data.events[0]],new Set(),0,[{...state.data.chats[0],is_muted:true}]).length"),0);
assert.equal(run("newMessageCandidates([state.data.events[0]],new Set(),0,[]).length"),1);
run("resetCommunications()");assert.equal(run('state.notificationSeen'),null);assert.equal(run('state.chatMessages.length'),0);
console.log('PASS: email category exclusions, account/network/workspace identity, escaped messages, notification dedup/history/sent/mute and session reset.');
