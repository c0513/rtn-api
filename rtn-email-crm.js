'use strict';
/**
 * CRM delivery audit for RTN.PRO mail. Never records OTP codes, message bodies,
 * authentication tokens, SMTP secrets or unsubscribe URLs.
 *
 * "Accepted" means that our SMTP relay accepted the message; it is NOT proof
 * that the recipient inbox received or opened the email.
 */
const { getPool } = require('./db');
const crypto = require('crypto');
let schemaPromise = null, running = false, timerStarted = false;
const safe = (s,n=220)=>String(s||'').replace(/\s+/g,' ').trim().slice(0,n);
const email = v=>safe(v,254).toLowerCase();
const validEmail = v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const types = Object.freeze({
  authorization:'Авторизация · код для входа',
  abandoned_cart:'Брошенная корзина · напоминание',
  replenishment:'Повторная покупка · пополнение запаса',
  order_paid:'Заказ · подтверждение оплаты',
  admin_preview:'Отправка владельцу · проверка оформления',
  other:'Письмо RTN.PRO'
});
async function ensure() {
 if(!schemaPromise) schemaPromise=getPool().query(
  'CREATE TABLE IF NOT EXISTS rtn_email_events ('+
  'id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,'+
  'message_id VARCHAR(254) NOT NULL UNIQUE,'+
  'recipient_email VARCHAR(254) NOT NULL,'+
  'subject VARCHAR(160) NOT NULL,'+
  "event_type VARCHAR(40) NOT NULL DEFAULT 'other',"+
  'accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,'+
  "crm_state VARCHAR(24) NOT NULL DEFAULT 'pending',"+
  'crm_attempts INT UNSIGNED NOT NULL DEFAULT 0,'+
  'crm_next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,'+
  'crm_attempt_at DATETIME NULL, crm_contact_id BIGINT UNSIGNED NULL,'+
  'crm_comment_id BIGINT UNSIGNED NULL, last_error VARCHAR(220) NULL,'+
  'INDEX idx_email_crm (crm_state,crm_next_attempt_at)'+
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
 ).catch(err=>{schemaPromise=null;throw err;});
 return schemaPromise;
}
async function recordAccepted({to,subject,messageId,eventType='other'}) {
 const address=email(to);
 if(!validEmail(address))return {skipped:true};
 await ensure();
 const kind=Object.hasOwn(types,eventType)?eventType:'other';
 // Email body and verification code NEVER go to this table or to Bitrix24.
 const id=safe(messageId,254)||'<'+crypto.randomUUID()+'@rtn.pro>';
 await getPool().execute('INSERT IGNORE INTO rtn_email_events(message_id,recipient_email,subject,event_type) VALUES (?,?,?,?)',
  [id,address,safe(subject,160),kind]);
 return {saved:true};
}
async function bitrixCall(method,params) {
 const base=String(process.env.BITRIX_WEBHOOK_URL||'').replace(/\/+$/,'');
 if(!base)throw Error('Bitrix webhook not configured');
 const c=new AbortController(),t=setTimeout(()=>c.abort(),9000);
 try{
  const r=await fetch(base+'/'+method+'.json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params),signal:c.signal});
  const json=await r.json().catch(()=>({}));
  if(!r.ok||json.error)throw Error('Bitrix: '+safe(json.error||r.status,100));
  return json.result;
 } finally{clearTimeout(t);}
}
async function contactFor(address) {
 const db=getPool();
 const [u]=await db.execute('SELECT bitrix_contact_id FROM users WHERE email=? AND status=? LIMIT 1',[address,'active']);
 const linked=Number(u[0]?.bitrix_contact_id||0);
 if(Number.isSafeInteger(linked)&&linked>0)return linked;
 const result=await bitrixCall('crm.duplicate.findbycomm',{type:'EMAIL',values:[address],entity_type:'CONTACT'});
 const raw=result?.CONTACT||result?.contact||[];
 // Do not guess in case several CRM records use the same email.
 const distinct=[...new Set((Array.isArray(raw)?raw:[]).map(Number).filter(v=>Number.isSafeInteger(v)&&v>0))];
 return distinct.length===1?distinct[0]:null;
}
function comment(event){
 return [
  '✉️ RTN.PRO · '+(types[event.event_type]||types.other),
  'Тема: '+event.subject,
  'Кому: '+event.recipient_email,
  'Состояние: принято почтовым сервером (не подтверждает доставку во «Входящие»)',
  'Время отправки: '+new Date(event.accepted_at).toISOString(),
  'ID письма: '+event.message_id
 ].join('\n');
}
async function retry(event,error){
 const attempts=Number(event.crm_attempts||0)+1;
 const mins=Math.min(360,Math.round(Math.pow(2,Math.min(8,attempts))*5));
 await getPool().execute(
  "UPDATE rtn_email_events SET crm_state='retry',crm_attempts=crm_attempts+1,"+
  'crm_next_attempt_at=DATE_ADD(NOW(),INTERVAL ? MINUTE),last_error=? WHERE id=?',
  [mins,safe(error?.message||error,220),event.id]
 );
}
async function flush() {
 if(running||!process.env.BITRIX_WEBHOOK_URL)return {skipped:true};
 running=true;
 let posted=0, retried=0;
 try {
  await ensure();
  const db=getPool();
  await db.query("UPDATE rtn_email_events SET crm_state='retry' WHERE crm_state='processing' AND crm_attempt_at<DATE_SUB(NOW(),INTERVAL 15 MINUTE)");
  const [pending]=await db.query("SELECT * FROM rtn_email_events WHERE crm_state IN ('pending','retry') AND crm_next_attempt_at<=NOW() ORDER BY id ASC LIMIT 12");
  for(const ev of pending){
   const [claimed]=await db.execute("UPDATE rtn_email_events SET crm_state='processing',crm_attempt_at=NOW() WHERE id=? AND crm_state IN ('pending','retry')",[ev.id]);
   if(!claimed.affectedRows)continue;
   try {
    const contactId=await contactFor(ev.recipient_email);
    if(!contactId)throw Error('Contact missing or ambiguous: waiting for CRM link');
    const commentId=await bitrixCall('crm.timeline.comment.add',{fields:{ENTITY_ID:contactId,ENTITY_TYPE:'contact',COMMENT:comment(ev)}});
    await db.execute("UPDATE rtn_email_events SET crm_state='synced',crm_contact_id=?,crm_comment_id=?,last_error=NULL WHERE id=?",[contactId,Number(commentId)||null,ev.id]);
    posted++;
   }catch(err){retried++;await retry(ev,err);}
  }
  return {posted,retried};
 }finally{running=false;}
}
function start() {
 if(timerStarted)return; timerStarted=true;
 setTimeout(()=>flush().catch(e=>console.error('RTN email CRM sync:',safe(e.message))),30000).unref();
 setInterval(()=>flush().catch(e=>console.error('RTN email CRM sync:',safe(e.message))),120000).unref();
}
module.exports={recordAccepted,flush,start,types,comment};
