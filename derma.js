// Derma: unlock and show an encrypted page. The password never leaves the device;
// only the derived AES key is remembered (localStorage 'derma-key').
(function(){
  const D=window.DERMA, KEY='derma-key';
  const $=id=>document.getElementById(id);
  const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const toB64=buf=>btoa(String.fromCharCode(...new Uint8Array(buf)));

  if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js').catch(()=>{})}

  async function derive(pw){
    const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:b64(D.salt),iterations:D.iter},base,256);
    return toB64(bits);
  }
  async function decrypt(rawB64,buf){
    const key=await crypto.subtle.importKey('raw',b64(rawB64),'AES-GCM',false,['decrypt']);
    const data=new Uint8Array(buf);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:data.slice(0,12)},key,data.slice(12));
    const stream=new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  let payload=null;
  async function getPayload(){
    if(payload)return payload;
    const r=await fetch('data/'+D.page+'.bin');
    if(!r.ok)throw new Error('fetch');
    return payload=await r.arrayBuffer();
  }
  function show(html){document.open();document.write(html);document.close()}
  function gate(msg){
    $('loading').hidden=true;$('gate').hidden=false;$('err').textContent=msg||'';
    setTimeout(()=>$('pw').focus(),50);
  }

  $('f').addEventListener('submit',async e=>{
    e.preventDefault();$('go').disabled=true;$('err').textContent='';
    try{
      const raw=await derive($('pw').value);
      let html;
      try{html=await decrypt(raw,await getPayload())}
      catch(err){if(err&&err.message==='fetch')throw err;$('err').textContent='הסיסמה לא נכונה. נסי שוב.';$('go').disabled=false;return}
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
