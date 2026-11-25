// Derma sync: keeps marks, notes, flags, reading position and study progress the same on all of the owner's devices.
// Storage: one secret GitHub gist on the owner's account, reached with a personal token (gist scope only) that is
// pasted once on each of her devices. The gist content is encrypted (AES-GCM) with a key derived from that token,
// so nobody without the token can read it. Anyone who uses the site without the token keeps working on local
// storage only: nothing of theirs reaches the gist, and nothing from the gist reaches them.
// Merge rule: every synced localStorage key carries the time it last changed; the newer version wins.
// When a device is linked for the first time, what it already had is merged into the shared copy (nothing is lost).
(function(){
'use strict';
const SP=Storage.prototype;
if(!window.__dsO)window.__dsO={set:SP.setItem,remove:SP.removeItem};
const O=window.__dsO;
const API='https://api.github.com',FILE='derma-sync.txt',CONF='derma-sync-conf',META='derma-sync-meta';
const EXC=/^(derma-key|derma-sync|derma-theme|derm-fs|derma-say-)/;
const isSync=k=>typeof k==='string'&&/^(ch\d|derm)/.test(k)&&!EXC.test(k);
let ls=null;try{ls=window.localStorage}catch(e){}
const rd=(k,d)=>{try{const v=ls.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}};
const wr=(k,v)=>{try{O.set.call(ls,k,JSON.stringify(v))}catch(e){}};
let conf=rd(CONF,null),meta=rd(META,{}),applying=false,dirty=!!(conf&&conf.dirty),pushT=0,busy=null,lastPull=0,errShown=0;
const linked=()=>!!(conf&&conf.token);
const saveConf=()=>{if(conf){conf.dirty=dirty;wr(CONF,conf)}};

// ---------- record every change to a synced key ----------
if(!window.__dsPatched&&ls){window.__dsPatched=true;
  SP.setItem=function(k,v){
    if(this!==ls||applying||!isSync(k))return O.set.call(this,k,v);
    let same=false;try{same=ls.getItem(k)===String(v)}catch(e){}
    O.set.call(this,k,v);if(!same)touch(k);
  };
  SP.removeItem=function(k){
    if(this!==ls||applying||!isSync(k))return O.remove.call(this,k);
    const had=ls.getItem(k)!=null;O.remove.call(this,k);if(had)touch(k);
  };
}
function touch(k){meta=rd(META,{});meta[k]=Date.now();wr(META,meta);if(!linked())return;dirty=true;saveConf();clearTimeout(pushT);pushT=setTimeout(()=>sync().catch(()=>{}),2500)}

// ---------- crypto + encoding ----------
const te=new TextEncoder(),td=new TextDecoder();
function b64(u8){let s='';for(let i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));return btoa(s)}
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function keyOf(token){
  if(conf&&conf.token===token&&conf.k)return crypto.subtle.importKey('raw',unb64(conf.k),'AES-GCM',false,['encrypt','decrypt']);
  const base=await crypto.subtle.importKey('raw',te.encode(token),'PBKDF2',false,['deriveBits']);
  const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:te.encode('derma-sync-v1'),iterations:150000},base,256));
  if(conf&&conf.token===token){conf.k=b64(bits);saveConf()}
  return crypto.subtle.importKey('raw',bits,'AES-GCM',false,['encrypt','decrypt']);
}
async function gz(u8,dir){
  const CS=dir?window.CompressionStream:window.DecompressionStream;
  if(CS){return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CS('gzip'))).arrayBuffer())}
  if(!window.fflate)await new Promise((ok,no)=>{const s=document.createElement('script');s.src='fflate.js';s.onload=ok;s.onerror=no;document.head.appendChild(s)});
  return dir?window.fflate.gzipSync(u8):window.fflate.gunzipSync(u8);
}
async function seal(obj,token){
  const key=await keyOf(token),iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,await gz(te.encode(JSON.stringify(obj)),true)));
  const out=new Uint8Array(12+ct.length);out.set(iv);out.set(ct,12);return 'derma1:'+b64(out);
}
async function open_(text,token){
  if(!text||text.indexOf('derma1:')!==0)return null;
  const d=unb64(text.slice(7).trim()),key=await keyOf(token);
  let p;try{p=await crypto.subtle.decrypt({name:'AES-GCM',iv:d.slice(0,12)},key,d.slice(12))}catch(e){throw new Error('key')}
  return JSON.parse(td.decode(await gz(new Uint8Array(p),false)));
}

// ---------- GitHub gist ----------
async function gh(path,opt,token){
  const r=await fetch(API+path,Object.assign({cache:'no-store'},opt||{},{headers:Object.assign({'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'},(opt&&opt.body)?{'Content-Type':'application/json'}:{})}));
  if(r.status===401){const e=new Error('auth');e.status=401;throw e}
  if(!r.ok){const e=new Error('http '+r.status);e.status=r.status;throw e}
  return r.status===204?null:r.json();
}
async function findGist(token){
  for(let page=1;page<=5;page++){
    const list=await gh('/gists?per_page=100&page='+page,null,token);
    const g=list.find(x=>x.files&&x.files[FILE]);if(g)return g.id;
    if(list.length<100)break;
  }
  return null;
}
async function fetchRemote(){
  const g=await gh('/gists/'+conf.gist,null,conf.token);
  const f=g.files&&g.files[FILE];if(!f)return {keys:{}};
  let text=f.content;
  if(f.truncated&&f.raw_url){const r=await fetch(f.raw_url,{cache:'no-store'});text=await r.text()}
  return (await open_(text,conf.token))||{keys:{}};
}
async function upload(doc){
  const body=JSON.stringify({files:{[FILE]:{content:await seal(doc,conf.token)}}});
  await gh('/gists/'+conf.gist,{method:'PATCH',body},conf.token);
}

// ---------- merge ----------
const localKeys=()=>{const a=[];try{for(let i=0;i<ls.length;i++){const k=ls.key(i);if(isSync(k))a.push(k)}}catch(e){}return a};
function setLocal(k,v){applying=true;try{v==null?O.remove.call(ls,k):O.set.call(ls,k,v)}catch(e){}applying=false}
// apply what is newer on the other devices; returns the keys that changed here
function applyRemote(doc){
  meta=rd(META,{});const changed=[];
  for(const[k,r] of Object.entries(doc.keys||{})){
    if(!isSync(k)||!r)continue;
    if((r.t||0)>(meta[k]||0)){const cur=ls.getItem(k);if(cur!==r.v){setLocal(k,r.v);changed.push(k)}meta[k]=r.t}
    else if((meta[k]||0)>(r.t||0))dirty=true;
  }
  for(const k of localKeys())if(!(doc.keys||{})[k]){if(!meta[k])meta[k]=Date.now();dirty=true}
  wr(META,meta);return changed;
}
function snapshot(doc){
  meta=rd(META,{});const keys=Object.assign({},doc.keys||{});
  for(const[k,t] of Object.entries(meta)){if(!isSync(k))continue;if(!keys[k]||(keys[k].t||0)<t)keys[k]={t,v:ls.getItem(k)}}
  // forget deletions older than 90 days so the file does not grow forever
  const old=Date.now()-90*864e5;for(const[k,r] of Object.entries(keys))if(r.v==null&&r.t<old)delete keys[k];
  return {v:1,updated:new Date().toISOString(),keys};
}
// first link of a device: keep both sides (objects merged, arrays joined, the shared copy wins on plain values)
function deep(a,b){
  if(Array.isArray(a)&&Array.isArray(b)){const seen=new Set(a.map(x=>JSON.stringify(x)));return a.concat(b.filter(x=>!seen.has(JSON.stringify(x))))}
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){const o=Object.assign({},a);for(const k of Object.keys(b))o[k]=(k in a)?deep(a[k],b[k]):b[k];return o}
  return b===undefined?a:b;
}
function mergeFirst(doc){
  const now=Date.now(),keys=doc.keys||{};meta=rd(META,{});const changed=[];
  for(const[k,r] of Object.entries(keys)){
    if(!isSync(k)||!r||r.v==null)continue;const cur=ls.getItem(k);let v=r.v;
    if(cur!=null&&cur!==r.v){try{v=JSON.stringify(deep(JSON.parse(cur),JSON.parse(r.v)))}catch(e){v=r.v}}
    if(v!==cur){setLocal(k,v);changed.push(k)}meta[k]=now;
  }
  for(const k of localKeys())meta[k]=meta[k]||now;
  wr(META,meta);return changed;
}

// ---------- public operations ----------
function run(fn){if(busy)return busy.then(()=>run(fn));busy=fn().finally(()=>{busy=null});return busy}
function fail(e){
  if(!conf)return;conf.err=(e&&e.status===401)?'auth':(e&&e.message==='key')?'key':'net';conf.errAt=Date.now();saveConf();
  if(document.body&&Date.now()-errShown>10*60e3){errShown=Date.now();
    toast(conf.err==='auth'?'⚠️ מפתח הסנכרון כבר לא תקף. אפשר לחבר מחדש מהספרייה.':conf.err==='key'?'⚠️ הסימונים בענן מוצפנים במפתח אחר. אפשר לחבר מחדש מהספרייה.':'⚠️ הסנכרון נכשל כרגע. הסימונים נשמרו במכשיר הזה ויעלו כשיהיה חיבור.',true)}
  updateUI();
}
function ok_(){conf.err='';conf.last=Date.now();saveConf();updateUI()}
function pull(){
  if(!linked())return Promise.resolve([]);
  return run(async()=>{try{const doc=await fetchRemote();const ch=applyRemote(doc);lastPull=Date.now();
    if(dirty){await upload(snapshot(doc));dirty=false}ok_();return ch}catch(e){fail(e);return []}});
}
function sync(){
  if(!linked())return Promise.resolve([]);
  return run(async()=>{try{const doc=await fetchRemote();const ch=applyRemote(doc);lastPull=Date.now();
    await upload(snapshot(doc));dirty=false;ok_();return ch}catch(e){fail(e);return []}});
}
async function link(token){
  token=(token||'').trim();if(!/^[A-Za-z0-9_]{20,255}$/.test(token))throw new Error('format');
  let gist=await findGist(token),doc=null;
  conf={token,gist,linkedAt:Date.now()};
  if(gist){doc=await fetchRemote()}            // throws 'key' if the gist was made with another token
  else{
    const body=JSON.stringify({description:'Derma: סנכרון סימונים (מוצפן)',public:false,files:{[FILE]:{content:await seal({v:1,keys:{}},token)}}});
    const g=await gh('/gists',{method:'POST',body},token);conf.gist=gist=g.id;doc={keys:{}};
  }
  const changed=mergeFirst(doc);saveConf();dirty=true;
  await run(async()=>{await upload(snapshot(doc));dirty=false;ok_()});
  return changed;
}
function unlink(){conf=null;dirty=false;try{O.remove.call(ls,CONF)}catch(e){}updateUI()}
const linkUrl=()=>linked()?location.origin+location.pathname.replace(/[^/]*$/,'')+'#sync='+conf.token:'';

// ---------- small UI: toast + settings panel ----------
function toast(msg,bad){
  let t=document.getElementById('ds-toast');
  if(!t){t=document.createElement('div');t.id='ds-toast';t.setAttribute('role','status');document.body.appendChild(t)}
  t.textContent=msg;t.className=bad?'bad':'';t.hidden=false;clearTimeout(t._h);t._h=setTimeout(()=>{t.hidden=true},bad?7000:3500);
}
const CSS='#ds-toast{position:fixed;z-index:2147483600;left:50%;transform:translateX(-50%);bottom:calc(max(22px,env(safe-area-inset-bottom,0px)) + 60px);max-width:min(92vw,28rem);background:#2a1f25;color:#fff;font:15px/1.45 system-ui,-apple-system,sans-serif;padding:10px 14px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.3);direction:rtl;text-align:right}#ds-toast.bad{background:#8a1c1c}#ds-toast[hidden]{display:none}'+
'#ds-panel{position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;direction:rtl}#ds-panel[hidden]{display:none}'+
'#ds-panel .ds-box{background:var(--surface,#fff);color:var(--fg,#2a1f25);border-radius:16px;max-width:30rem;width:100%;max-height:90vh;overflow:auto;padding:18px;font:16px/1.55 system-ui,-apple-system,sans-serif;text-align:right;box-shadow:0 10px 40px rgba(0,0,0,.35)}'+
'#ds-panel h3{margin:0 0 8px;font-size:1.15rem;text-decoration:underline;text-underline-offset:.3em}#ds-panel ol,#ds-panel ul{margin:6px 0;padding-inline-start:22px}#ds-panel li{margin:4px 0}'+
'#ds-panel input{font:14px ui-monospace,monospace;width:100%;padding:10px;border:1px solid var(--line,#ddd);border-radius:10px;background:var(--bg,#fff);color:inherit;direction:ltr;text-align:left}'+
'#ds-panel .ds-b{font:inherit;font-weight:600;border:1px solid var(--line,#ddd);background:var(--bg,#fafafa);color:inherit;border-radius:10px;padding:8px 14px;min-height:44px;cursor:pointer;margin:4px 0 4px 6px}'+
'#ds-panel .ds-b.pri{background:#c4497e;border-color:#c4497e;color:#fff}#ds-panel .ds-m{color:var(--muted,#7a6670);font-size:.9rem}#ds-panel .ds-e{color:#b3261e;font-size:.92rem;min-height:1.2em}'+
'#ds-panel .ds-qr{display:flex;justify-content:center;margin:10px 0}#ds-panel .ds-qr svg{width:220px;height:220px;background:#fff;padding:8px;border-radius:10px}#ds-panel a{color:#c4497e}'+
'@media print{#ds-toast,#ds-panel{display:none!important}}';
function css(){if(!document.getElementById('ds-css')&&document.head){const s=document.createElement('style');s.id='ds-css';s.textContent=CSS;document.head.appendChild(s)}}
const hm=t=>{const d=new Date(t);return d.toLocaleDateString('he-IL',{day:'numeric',month:'numeric'})+' '+d.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})};
function statusText(){
  if(!linked())return 'לא מחובר. הסימונים נשמרים רק במכשיר הזה.';
  if(conf.err==='auth')return '⚠️ המפתח כבר לא תקף. צריך לחבר מחדש.';
  if(conf.err)return '⚠️ הסנכרון האחרון נכשל'+(conf.last?'. סונכרן לאחרונה '+hm(conf.last):'')+'. ינסה שוב לבד.';
  return '✓ מסונכרן עם המכשירים שלך'+(conf.last?' · '+hm(conf.last):'');
}
function updateUI(){document.querySelectorAll('[data-ds-status]').forEach(e=>{e.textContent=statusText()})}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function panel(){
  css();let p=document.getElementById('ds-panel');
  if(!p){p=document.createElement('div');p.id='ds-panel';p.hidden=true;p.addEventListener('click',e=>{if(e.target===p)p.hidden=true});document.body.appendChild(p)}
  const NEW='https://github.com/settings/tokens/new?scopes=gist&description=Derma%20sync';
  if(!linked()){
    p.innerHTML='<div class="ds-box" role="dialog" aria-label="סנכרון בין המכשירים שלי"><h3>🔄 סנכרון בין המכשירים שלי</h3>'+
    '<p class="ds-m">מסנכרן מרקר, פתקים, דגלונים, מקום קריאה, חזרות ומבחנים. רק מכשיר שהודבק בו המפתח שלך מסתנכרן. מי שנכנס לאתר בלי המפתח ממשיך לעבוד רק על המכשיר שלו.</p>'+
    '<p><b>כבר חיברת מכשיר אחר?</b> שם, בספרייה, ללחוץ "🔄 סנכרון" ואז "חיבור מכשיר נוסף", ולסרוק את הקוד במצלמה של המכשיר הזה.</p>'+
    '<p><b>פעם ראשונה בכלל:</b></p><ol><li><a href="'+NEW+'" target="_blank" rel="noopener">ליצור מפתח בגיטהאב</a> (נפתח כבר מוכן). בשדה Expiration לבחור No expiration, ולמטה ללחוץ Generate token.</li><li>להעתיק את המפתח (מתחיל ב-ghp_) ולהדביק כאן:</li></ol>'+
    '<input id="ds-tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ghp_..."><div class="ds-e" id="ds-err"></div>'+
    '<button type="button" class="ds-b pri" id="ds-go">חיבור המכשיר</button><button type="button" class="ds-b" id="ds-x">סגירה</button></div>';
    p.querySelector('#ds-x').onclick=()=>{p.hidden=true};
    p.querySelector('#ds-go').onclick=async()=>{const b=p.querySelector('#ds-go'),er=p.querySelector('#ds-err');b.disabled=true;er.textContent='מתחבר…';
      try{await link(p.querySelector('#ds-tok').value);p.hidden=true;toast('✓ המכשיר מחובר. הסימונים מסונכרנים.');setTimeout(()=>location.reload(),900)}
      catch(e){conf=null;try{O.remove.call(ls,CONF)}catch(_){}b.disabled=false;
        er.textContent=e.message==='format'?'זה לא נראה כמו מפתח. צריך להדביק את כל המפתח שמתחיל ב-ghp_.':e.status===401?'גיטהאב לא מכיר את המפתח הזה. אולי הוא לא הועתק עד הסוף.':e.status===403||e.status===404?'למפתח אין הרשאת gist. צריך ליצור אותו מהקישור למעלה.':e.message==='key'?'בחשבון כבר יש סנכרון שנוצר עם מפתח אחר. צריך להשתמש באותו מפתח מהמכשיר הראשון.':'אין חיבור לגיטהאב כרגע. נסי שוב.'}};
  }else{
    p.innerHTML='<div class="ds-box" role="dialog" aria-label="סנכרון בין המכשירים שלי"><h3>🔄 סנכרון בין המכשירים שלי</h3><p data-ds-status></p>'+
    '<button type="button" class="ds-b pri" id="ds-now">לסנכרן עכשיו</button><button type="button" class="ds-b" id="ds-add">חיבור מכשיר נוסף</button><button type="button" class="ds-b" id="ds-off">ניתוק המכשיר הזה</button><button type="button" class="ds-b" id="ds-x">סגירה</button>'+
    '<div id="ds-more" hidden><p><b>במכשיר החדש:</b> לסרוק את הקוד במצלמה, להיכנס עם הסיסמה של האתר, וזהו. אפשר גם להעתיק את הקישור ולפתוח אותו שם.</p><div class="ds-qr" id="ds-qr"></div>'+
    '<button type="button" class="ds-b" id="ds-copy">העתקת קישור חיבור</button><p class="ds-m">הקוד והקישור הם המפתח האישי שלך. לא לשלוח אותם לאחרים.</p></div></div>';
    updateUI();
    p.querySelector('#ds-x').onclick=()=>{p.hidden=true};
    p.querySelector('#ds-now').onclick=async()=>{const ch=await sync();updateUI();if(!conf.err){toast(ch.length?'✓ עודכן ממכשיר אחר':'✓ הכול מסונכרן');if(ch.length)setTimeout(()=>location.reload(),900)}};
    p.querySelector('#ds-off').onclick=()=>{if(confirm('לנתק את המכשיר הזה מהסנכרון? הסימונים יישארו במכשיר, אבל לא יתעדכנו יותר משאר המכשירים.')){unlink();p.hidden=true;toast('המכשיר נותק מהסנכרון')}};
    p.querySelector('#ds-add').onclick=async()=>{const m=p.querySelector('#ds-more');m.hidden=!m.hidden;if(m.hidden)return;
      const box=p.querySelector('#ds-qr');box.textContent='';
      try{if(!window.qrcode)await new Promise((ok,no)=>{const s=document.createElement('script');s.src='qrcode.js';s.onload=ok;s.onerror=no;document.head.appendChild(s)});
        const q=window.qrcode(0,'M');q.addData(linkUrl());q.make();box.innerHTML=q.createSvgTag({cellSize:4,margin:2,scalable:true})}catch(e){box.textContent='לא הצלחתי להציג קוד. אפשר להעתיק את הקישור.'}};
    p.querySelector('#ds-copy').onclick=async()=>{try{await navigator.clipboard.writeText(linkUrl());toast('הקישור הועתק')}catch(e){prompt('להעתיק את הקישור:',linkUrl())}};
  }
  p.hidden=false;return p;
}

// ---------- page wiring (runs on the login shell and again on every decrypted page) ----------
function attach(){
  if(!document.body){document.addEventListener('DOMContentLoaded',attach,{once:true});return}
  css();updateUI();
  // link from a QR code / copied link: <site>/#sync=<token>
  const m=/[#&]sync=([A-Za-z0-9_]+)/.exec(location.hash||'');
  if(m&&window.crypto&&crypto.subtle&&!document.getElementById('gate')){
    try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}
    if(!linked()||conf.token!==m[1]){toast('מחבר את המכשיר לסנכרון…');
      link(m[1]).then(()=>{toast('✓ המכשיר מחובר. הסימונים מסונכרנים.');setTimeout(()=>location.reload(),900)})
      .catch(e=>{conf=null;try{O.remove.call(ls,CONF)}catch(_){}toast(e.message==='key'?'⚠️ הקישור שייך למפתח אחר מזה שבחשבון.':'⚠️ החיבור לסנכרון נכשל. נסי שוב מהספרייה.',true)})}
  }
  // back after an update from another device: return to the same place on the page
  try{const y=JSON.parse(sessionStorage.getItem('derma-sync-y')||'null');if(y&&y.p===location.pathname&&!document.getElementById('gate')){sessionStorage.removeItem('derma-sync-y');
    const go=()=>setTimeout(()=>scrollTo(0,y.y),400);document.readyState==='complete'?go():addEventListener('load',go,{once:true})}}catch(e){}
}
function onShow(){
  if(document.hidden||!linked()||document.getElementById('gate')||document.getElementById('loading'))return;
  if(Date.now()-lastPull<15000)return;
  pull().then(ch=>{if(ch.length&&!document.hidden){try{sessionStorage.setItem('derma-sync-y',JSON.stringify({p:location.pathname,y:scrollY}))}catch(e){}location.reload()}});
}
function bind(){
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(dirty&&linked()){clearTimeout(pushT);sync()}}else onShow()});
  addEventListener('pagehide',()=>{if(dirty&&linked())sync()});
  addEventListener('online',()=>{if(dirty&&linked())sync()});
}
if(!window.DermaSync){
  window.DermaSync={linked,pull,sync,link,unlink,panel,status:statusText,
    // the login shell waits for this (at most a few seconds) so the page opens with the newest marks
    ready(ms){if(!linked())return Promise.resolve();return Promise.race([pull(),new Promise(r=>setTimeout(r,ms||2500))])}};
  setInterval(onShow,60000);
}
bind();attach();
})();
