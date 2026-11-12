// Derma: unlock and show an encrypted page. The password never leaves the device;
// only the derived AES key is remembered (localStorage 'derma-key').
(function(){
  const D=window.DERMA, KEY='derma-key';
  const $=id=>document.getElementById(id);
  const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const toB64=buf=>btoa(String.fromCharCode(...new Uint8Array(buf)));

  if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(r=>r.update()).catch(()=>{})}

  async function derive(pw){
    const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:b64(D.salt),iterations:D.iter},base,256);
    return toB64(bits);
  }
  async function decrypt(rawB64,buf){
    const key=await crypto.subtle.importKey('raw',b64(rawB64),'AES-GCM',false,['decrypt']);
    const data=new Uint8Array(buf);
    let plain;
    try{plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:data.slice(0,12)},key,data.slice(12))}catch(e){throw new Error('pw')}
    if(typeof DecompressionStream!=='undefined'){
      try{const stream=new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));return await new Response(stream).text()}catch(e){}
    }
    // older browsers (iOS before 16.4, some in-app browsers): unzip with fflate, loaded only when needed
    if(!window.fflate)await new Promise((ok,no)=>{const s=document.createElement('script');s.src='fflate.js';s.onload=ok;s.onerror=()=>no(new Error('fetch'));document.head.appendChild(s)});
    return new TextDecoder().decode(window.fflate.gunzipSync(new Uint8Array(plain)));
  }
  let payload=null;
  async function getPayload(){
    if(payload)return payload;
    const r=await fetch('data/'+D.page+'.bin',{cache:'no-cache'});
    if(!r.ok)throw new Error('fetch');
    return payload=await r.arrayBuffer();
  }
  function show(html){const fx='<style>[hidden]{display:none!important}</style>';const dt=/^\s*<!doctype[^>]*>/i;html=dt.test(html)?html.replace(dt,m=>m+fx):fx+html;document.open();document.write(html);document.close()}
  function gate(msg){
    $('loading').hidden=true;$('gate').hidden=false;$('err').textContent=msg||'';
    setTimeout(()=>$('pw').focus(),50);
  }

  $('f').addEventListener('submit',async e=>{
    e.preventDefault();$('go').disabled=true;$('err').textContent='';
    try{
      if(!window.crypto||!crypto.subtle){$('err').textContent='הדפדפן הזה לא יכול לפתוח את האתר. פתחו את הקישור ב-Safari או ב-Chrome (לא מתוך WhatsApp או Instagram).';$('go').disabled=false;return}
      const raw=await derive($('pw').value.trim());
      let html;
      try{html=await decrypt(raw,await getPayload())}
      catch(err){if(err&&err.message==='fetch')throw err;
        $('err').textContent=(err&&err.message==='pw')?'הסיסמה לא נכונה. נסו שוב (אותיות קטנות באנגלית, בלי רווחים).':'הדפדפן לא הצליח לפתוח את העמוד. נסו לעדכן אותו או לפתוח ב-Safari או ב-Chrome.';$('go').disabled=false;return}
      try{localStorage.setItem(KEY,raw)}catch(_){}
      show(html);
    }catch(err){$('err').textContent='אין חיבור לאינטרנט כרגע. נסי שוב כשיש חיבור.';$('go').disabled=false}
  });

  (async()=>{
    let raw=null;try{raw=localStorage.getItem(KEY)}catch(_){}
    if(!raw){gate();return}
    let buf;
    try{buf=await getPayload()}catch(_){$('lmsg').textContent='אין חיבור לאינטרנט, והעמוד הזה עוד לא נשמר במכשיר. נסי שוב כשיש חיבור.';return}
    try{show(await decrypt(raw,buf))}
    catch(_){try{localStorage.removeItem(KEY)}catch(e){}gate('הסיסמה השתנתה. הקלידי את הסיסמה החדשה.')}
  })();
})();
