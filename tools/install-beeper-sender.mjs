import {mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const label='gr.poulos.workstation-sender';
const dir=join(homedir(),'.local/share/poulos-workstation');
const agents=join(homedir(),'Library/LaunchAgents');
await mkdir(dir,{recursive:true,mode:0o700});await mkdir(agents,{recursive:true});
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const plist=join(agents,label+'.plist');
await writeFile(plist,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root,'tools/beeper-sender.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(join(dir,'sender.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dir,'sender-error.log'))}</string>
</dict></plist>`,{mode:0o600});
const domain='gui/'+process.getuid();
try{execFileSync('/bin/launchctl',['bootout',domain+'/'+label],{stdio:'ignore'});}catch{}
execFileSync('/bin/launchctl',['bootstrap',domain,plist],{stdio:'inherit'});
console.log('Sender installed and started for this Mac login.');
