// RFC 8291 (aes128gcm) and RFC 8292 (VAPID), using only Web Crypto.
const enc=new TextEncoder();
const concat=(...arrays)=>{const result=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let at=0;for(const a of arrays){result.set(a,at);at+=a.length;}return result;};
export const unbase64=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
export const base64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export function validateSubscription(s) {
  try {
    const u=new URL(s.endpoint);
    // No arbitrary HTTP targets: subscriptions are untrusted input from the browser.
    const allowed=['fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com','web.push.apple.com'];
    return s.endpoint.length<=2048&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&allowed.includes(u.hostname)&&
      /^[A-Za-z0-9_-]+$/.test(s.keys.auth)&&/^[A-Za-z0-9_-]+$/.test(s.keys.p256dh)&&unbase64(s.keys.auth).length===16&&unbase64(s.keys.p256dh).length===65&&unbase64(s.keys.p256dh)[0]===4;
  } catch {return false;}
}
async function hkdf(ikm,salt,info,length) {
  const key=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8));
}
export async function encryptPayload(subscription,payload) {
  const receiver=unbase64(subscription.keys.p256dh),auth=unbase64(subscription.keys.auth);
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const sender=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
  const publicKey=await crypto.subtle.importKey('raw',receiver,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},pair.privateKey,256));
  const ikm=await hkdf(shared,auth,concat(enc.encode('WebPush: info\0'),receiver,sender),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const cek=await hkdf(ikm,salt,enc.encode('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdf(ikm,salt,enc.encode('Content-Encoding: nonce\0'),12);
  const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
  const data=enc.encode(JSON.stringify(payload));if(data.length>3000) throw new Error('Push demasiado grande');
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,concat(data,new Uint8Array([2]))));
  return concat(salt,new Uint8Array([0,0,16,0,65]),sender,ciphertext);
}
export async function sendWebPush(subscription,payload,env,stillActive=()=>true) {
  if(!validateSubscription(subscription)) throw new Error('Suscripción inválida');
  const pub=unbase64(env.WEB_PUSH_PUBLIC_KEY),priv=unbase64(env.WEB_PUSH_PRIVATE_KEY);
  if(pub.length!==65||priv.length!==32||!/^mailto:[^\s]+@[^\s]+$|^https:\/\/[^\s]+$/.test(env.WEB_PUSH_SUBJECT||'')) throw new Error('Configuración push inválida');
  const header=base64(enc.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const claims=base64(enc.encode(JSON.stringify({aud:new URL(subscription.endpoint).origin,exp:Math.floor(Date.now()/1000)+3600,sub:env.WEB_PUSH_SUBJECT})));
  const unsigned=header+'.'+claims;
  const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:base64(pub.slice(1,33)),y:base64(pub.slice(33)),d:base64(priv)}, {name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const signature=base64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,enc.encode(unsigned)));
  const body=await encryptPayload(subscription,payload);
  if(!stillActive()) return 410;
  const result=await fetch(subscription.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{TTL:'86400',Urgency:'normal','Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',Authorization:`vapid t=${unsigned}.${signature}, k=${env.WEB_PUSH_PUBLIC_KEY}`},body});
  await result.body?.cancel();return result.status;
}
