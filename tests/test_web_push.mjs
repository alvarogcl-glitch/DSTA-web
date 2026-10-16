// Independently decrypt with OpenSSL (node:crypto), and verify the VAPID signature.
import assert from 'node:assert/strict';
import {createECDH,randomBytes,hkdfSync,createDecipheriv,createPublicKey,verify} from 'node:crypto';
import {sendWebPush,validateSubscription,base64} from '../src/web-push.js';
const client=createECDH('prime256v1');client.generateKeys();const auth=randomBytes(16);
const s={endpoint:'https://fcm.googleapis.com/fcm/send/qa-synthetic',keys:{p256dh:client.getPublicKey().toString('base64url'),auth:auth.toString('base64url')}};
assert.ok(validateSubscription(s));
const vapid=createECDH('prime256v1');vapid.generateKeys();
const env={WEB_PUSH_PUBLIC_KEY:vapid.getPublicKey().toString('base64url'),WEB_PUSH_PRIVATE_KEY:vapid.getPrivateKey().toString('base64url'),WEB_PUSH_SUBJECT:'mailto:qa@example.test'};
const original=globalThis.fetch;let requests=0;
const payload={body:'Revisar entrega · QA ñ',eventId:'one',accountTag:'qa'};
try {
  globalThis.fetch=async(url,init)=>{
    requests++;assert.equal(url,s.endpoint);assert.equal(init.redirect,'error');assert.equal(init.headers['Content-Encoding'],'aes128gcm');
    const token=init.headers.Authorization.match(/t=([^,]+)/)[1], [h,c,sig]=token.split('.');
    const claims=JSON.parse(Buffer.from(c,'base64url'));assert.equal(claims.aud,'https://fcm.googleapis.com');assert.equal(claims.sub,env.WEB_PUSH_SUBJECT);
    const pub=vapid.getPublicKey(), key=createPublicKey({key:{kty:'EC',crv:'P-256',x:base64(pub.subarray(1,33)),y:base64(pub.subarray(33))},format:'jwk'});
    assert.ok(verify('sha256',Buffer.from(h+'.'+c),{key,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')));
    const body=Buffer.from(init.body),salt=body.subarray(0,16),rs=body.readUInt32BE(16),len=body[20],server=body.subarray(21,21+len),encrypted=body.subarray(21+len);
    assert.equal(rs,4096);assert.equal(len,65);
    const ikm=hkdfSync('sha256',client.computeSecret(server),auth,Buffer.concat([Buffer.from('WebPush: info\0'),client.getPublicKey(),server]),32);
    const cek=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16);
    const nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);
    const decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(encrypted.subarray(-16));
    const plain=Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]);assert.equal(plain.at(-1),2);assert.deepEqual(JSON.parse(plain.subarray(0,-1)),payload);
    return new Response(null,{status:201});
  };
  assert.equal(await sendWebPush(s,payload,env),201);assert.equal(requests,1);
  assert.equal(await sendWebPush(s,payload,env,()=>false),410);assert.equal(requests,1,'cancelled while encrypting never sends');
  await assert.rejects(()=>sendWebPush({...s,endpoint:'https://localhost/internal'},payload,env));assert.equal(requests,1);
  console.log('Web Push: independent AES-GCM decryption, ECDH/HKDF, VAPID signature, audience, SSRF and cancellation OK');
}finally{globalThis.fetch=original;}
