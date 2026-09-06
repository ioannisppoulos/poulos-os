import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
// Static code only: authenticated data is fetched at runtime, never included here.
await mkdir('.build',{recursive:true});
const result=await build({entryPoints:['app.js'],bundle:true,format:'esm',write:false,external:['https://*'],target:['es2022'],minify:false});
const js=result.outputFiles[0].text.replaceAll('</script','<\\/script');
const css=await readFile('styles.css','utf8');
let html=await readFile('index.html','utf8');
html=html.replace(/<link\b[^>]*href=["']\.\/?styles\.css(?:\?[^"']*)?["'][^>]*>/,`<style>${css}</style>`);
html=html.replace(/<script\b[^>]*src=["']\.\/?app\.js(?:\?[^"']*)?["'][^>]*><\/script>/,`<script type="module">${js}</script>`);
html=html.replace('<head>','<head>\n<base href="https://ioannisppoulos.github.io/poulos-os/">');
if(/(?:src=["']\.\/app\.js|href=["']\.\/styles\.css)/.test(html))throw new Error('Bundle substitution failed');
await writeFile('.build/dashboard.html',html);
console.log('Built static .build/dashboard.html; no runtime data included.');
