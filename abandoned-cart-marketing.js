'use strict';

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const express = require('express');
const { getPool } = require('./db');

const SITE_URL = (process.env.RTN_MARKETING_SITE_URL || 'https://rtn.pro').replace(/\/$/, '');
const ENABLED = String(process.env.RTN_ABANDONED_EMAIL_ENABLED || '').toLowerCase() === 'true';
const CONSENT_TEXT = 'Согласен получать рекламные письма RTN.PRO, в том числе напоминания о товарах в корзине. Могу отписаться в любой момент.';
const DELAY_HOURS = 2;
let initPromise = null;
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const esc = value => String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

async function ensureTables() {
  if (!initPromise) initPromise = (async () => {
    const db = getPool();
    await db.query("CREATE TABLE IF NOT EXISTS rtn_marketing_consents (" +
      "user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, agreed_at DATETIME NULL, revoked_at DATETIME NULL, " +
      "source VARCHAR(64) NOT NULL DEFAULT 'cart', consent_version VARCHAR(32) NOT NULL DEFAULT 'v1', " +
      "consent_text VARCHAR(512) NOT NULL, optout_hash CHAR(64) NULL UNIQUE, " +
      "updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    await db.query("CREATE TABLE IF NOT EXISTS rtn_abandoned_carts (" +
      "user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, items_json TEXT NOT NULL, cart_hash CHAR(64) NOT NULL, " +
      "total DECIMAL(12,2) NOT NULL DEFAULT 0, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
      "converted_at DATETIME NULL, reminder_state VARCHAR(20) NOT NULL DEFAULT 'pending', " +
      "last_reminder_at DATETIME NULL, INDEX idx_reminder_due (reminder_state,updated_at)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  })().catch(error => {initPromise=null; throw error;});
  return initPromise;
}
function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0,40).map(item => {
    const id=String(item?.id||'').slice(0,90);
    const name=String(item?.name||'').slice(0,160);
    const flavor=String(item?.flavor||'').slice(0,100);
    const quantity=Math.max(1,Math.min(100,Math.floor(Number(item?.quantity)||1)));
    const price=Math.max(0,Math.min(1000000,Number(item?.priceNum)||0));
    return {id,name,flavor,quantity,price};
  }).filter(item => item.id && item.name && item.price > 0);
}
function smtpConfig() {
  return {
    host: String(process.env.RTN_MARKETING_SMTP_HOST||'').trim(),
    port: Number(process.env.RTN_MARKETING_SMTP_PORT||465),
    user: String(process.env.RTN_MARKETING_SMTP_USER||'').trim(),
    pass: String(process.env.RTN_MARKETING_SMTP_PASSWORD||''),
    from: String(process.env.RTN_MARKETING_FROM||'').trim()
  };
}
function mailReady(){
  const c=smtpConfig();
  return Boolean(c.host && c.port && c.user && c.pass && c.from);
}
async function saveCart(user, rawItems) {
  await ensureTables();
  const items=cleanItems(rawItems);
  const db=getPool();
  const total=Number(items.reduce((v,i)=>v+i.price*i.quantity,0).toFixed(2));
  const hash=sha(JSON.stringify(items));
  const [[existing]]=await db.execute('SELECT cart_hash, reminder_state FROM rtn_abandoned_carts WHERE user_id=?',[user.id]);
  if (existing?.cart_hash===hash) return {ok:true,changed:false,count:items.length};
  await db.execute(
    "INSERT INTO rtn_abandoned_carts (user_id,items_json,cart_hash,total,updated_at,converted_at,reminder_state,last_reminder_at) " +
    "VALUES (?,?,?,?,NOW(),NULL,?,NULL) ON DUPLICATE KEY UPDATE " +
    "items_json=VALUES(items_json),cart_hash=VALUES(cart_hash),total=VALUES(total),updated_at=NOW()," +
    "converted_at=NULL,reminder_state=VALUES(reminder_state),last_reminder_at=NULL",
    [user.id,JSON.stringify(items),hash,total,items.length?'pending':'empty']
  );
  return {ok:true,changed:true,count:items.length};
}
async function markCheckoutByEmail(email) {
  const normalized=normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return;
  await ensureTables();
  const db=getPool();
  await db.execute(
    "UPDATE rtn_abandoned_carts c JOIN users u ON u.id=c.user_id SET c.converted_at=NOW(),c.reminder_state='converted' " +
    "WHERE u.email=? AND c.reminder_state IN ('pending','failed','sending')",
    [normalized]
  );
}
function buildMail({email,items,total,token}) {
  const cartUrl=SITE_URL+'/?utm_source=email&utm_medium=abandoned_cart&utm_campaign=cart_reminder';
  const unsubUrl='https://rhino-api-yrfq.onrender.com/api/marketing/unsubscribe?token='+encodeURIComponent(token);
  const rows=items.map(i=>'<tr><td style="padding:9px;border-bottom:1px solid #333">'+esc(i.name)+(i.flavor?' · '+esc(i.flavor):'')+'</td>'+
    '<td style="padding:9px;border-bottom:1px solid #333">'+i.quantity+'</td>'+
    '<td style="padding:9px;border-bottom:1px solid #333">'+(i.price*i.quantity).toLocaleString('ru-RU')+' ₽</td></tr>').join('');
  const html='<!doctype html><html lang="ru"><head><meta charset="utf-8"></head>'+
    '<body style="margin:0;background:#101114;color:#fff;font-family:Arial,sans-serif;padding:30px 15px">'+
    '<div style="max-width:560px;margin:auto"><h1 style="font-size:24px">RHINO TECH NUTRITION</h1>'+
    '<h2>Товары остались в корзине</h2><p>Вы добавили товары в корзину, но не завершили оформление. Если они всё ещё нужны — возвращайтесь.</p>'+
    '<table style="border-collapse:collapse;width:100%;font-size:13px">'+rows+'</table>'+
    '<p style="font-size:19px"><b>Сумма товаров: '+Number(total).toLocaleString('ru-RU')+' ₽</b></p>'+
    '<p><a href="'+cartUrl+'" style="display:inline-block;background:#19b9e0;padding:14px 22px;color:#041015;font-weight:bold;text-decoration:none">Вернуться к покупкам</a></p>'+
    '<p style="color:#a7abb6;font-size:12px">RTN.PRO · Вы получили письмо, потому что подписались на рекламные сообщения RTN.PRO.</p>'+
    '<p><a style="color:#a7abb6;font-size:12px" href="'+unsubUrl+'">Отписаться от рассылки</a></p></div></body></html>';
  const plain=items.map(i=>'- '+i.name+' '+i.flavor+' ×'+i.quantity).join('\n');
  return {to:email,subject:'Вы оставили товары в корзине RTN.PRO',text:'Товары ждут вас в RTN.PRO:\n'+plain+'\n\nКорзина: '+cartUrl+'\n\nОтписаться: '+unsubUrl,html,
    headers:{'List-Unsubscribe':'<'+unsubUrl+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}};
}
let working=false;
async function runReminderBatch() {
  if (working || !ENABLED || !mailReady()) return {skipped:true,reason:!ENABLED?'disabled':'smtp_not_configured'};
  working=true;
  try {
    await ensureTables();
    const db=getPool();
    // Keep only 30 days of cart snapshots. Consent audit rows are kept separately.
    await db.query("DELETE FROM rtn_abandoned_carts WHERE updated_at < DATE_SUB(NOW(),INTERVAL 30 DAY)");
    const [rows]=await db.query(
      "SELECT c.user_id,c.items_json,c.total,c.cart_hash,u.email,mc.optout_hash " +
      "FROM rtn_abandoned_carts c JOIN users u ON u.id=c.user_id " +
      "JOIN rtn_marketing_consents mc ON mc.user_id=u.id " +
      "WHERE c.reminder_state='pending' AND c.total>0 " +
      "AND c.updated_at <= DATE_SUB(NOW(), INTERVAL "+DELAY_HOURS+" HOUR) " +
      "AND u.email_verified_at IS NOT NULL AND u.status='active' " +
      "AND mc.agreed_at IS NOT NULL AND mc.revoked_at IS NULL " +
      "ORDER BY c.updated_at ASC LIMIT 10"
    );
    const c=smtpConfig();
    const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.port===465,
      auth:{user:c.user,pass:c.pass},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
    let sent=0,failed=0;
    for(const row of rows) {
      const [claim]=await db.execute(
        "UPDATE rtn_abandoned_carts SET reminder_state='sending',last_reminder_at=NOW() " +
        "WHERE user_id=? AND cart_hash=? AND reminder_state='pending' " +
        "AND updated_at<=DATE_SUB(NOW(),INTERVAL "+DELAY_HOURS+" HOUR)",
        [row.user_id,row.cart_hash]
      );
      if(!claim.affectedRows) continue;
      try {
        // Recheck unsubscribe after the claim, immediately before connecting to SMTP.
        const [[permission]]=await db.execute(
          "SELECT agreed_at,revoked_at,optout_hash FROM rtn_marketing_consents WHERE user_id=?",
          [row.user_id]
        );
        if(!permission?.agreed_at || permission.revoked_at){await db.execute(
          "UPDATE rtn_abandoned_carts SET reminder_state='suppressed' WHERE user_id=? AND cart_hash=?",
          [row.user_id,row.cart_hash]);continue;}
        // Random unsubscribe credential is kept hashed at rest. Generate only once.
        let token=crypto.randomBytes(32).toString('hex');
        if(permission.optout_hash){
          // Existing token cannot be reversed: rotate to include the new one in this email.
        }
        await db.execute('UPDATE rtn_marketing_consents SET optout_hash=? WHERE user_id=?',
          [sha(token),row.user_id]);
        const items=JSON.parse(row.items_json);
        await transport.sendMail({...buildMail({email:row.email,items,total:row.total,token}),from:c.from});
        await db.execute("UPDATE rtn_abandoned_carts SET reminder_state='sent' WHERE user_id=? AND cart_hash=?",
          [row.user_id,row.cart_hash]);
        sent++;
      }catch(error){
        failed++;
        // No automatic retries: prevents duplicate sends after uncertain SMTP outcomes.
        await db.execute("UPDATE rtn_abandoned_carts SET reminder_state='failed' WHERE user_id=? AND cart_hash=?",
          [row.user_id,row.cart_hash]);
        console.error('RTN cart reminder send error:',error.code||error.message);
      }
    }
    return {sent,failed};
  }finally{working=false;}
}
function htmlMessage(res,title,message){
  res.type('html').send('<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="font:16px Arial;background:#101114;color:white;padding:45px 20px;max-width:560px;margin:auto"><h1>'+esc(title)+'</h1><p>'+esc(message)+'</p><a style="color:#21bdeb" href="'+SITE_URL+'">На сайт RTN.PRO</a></body></html>');
}
function installCartMarketingRoutes(app,{getAuthenticatedUser,requireAdmin}) {
  const login=async(req,res,next)=>{
    try {const user=await getAuthenticatedUser(req);
      if(!user || !user.email || !user.email_verified_at) return res.status(401).json({error:'Для рассылки нужен вход с подтверждённым email'});
      req.marketingUser=user;next();
    }catch(e){console.error('Marketing auth:',e.message);return res.status(503).json({error:'Ошибка проверки аккаунта'});}
  };
  app.get('/api/marketing/consent',login,async(req,res)=>{
    try {await ensureTables(); const [[c]]=await getPool().execute(
      'SELECT agreed_at,revoked_at FROM rtn_marketing_consents WHERE user_id=?',[req.marketingUser.id]);
      res.set('Cache-Control','no-store').json({subscribed:Boolean(c?.agreed_at && !c?.revoked_at),consentText:CONSENT_TEXT});
    }catch(e){res.status(503).json({error:'Подписка временно недоступна'});}
  });
  app.post('/api/marketing/consent',login,async(req,res)=>{
    try {if(typeof req.body?.subscribe!=='boolean')return res.status(400).json({error:'Требуется subscribe: true или false'});
      await ensureTables();const userId=req.marketingUser.id; const subscribe=req.body.subscribe;
      if(subscribe) {
        await getPool().execute(
          "INSERT INTO rtn_marketing_consents (user_id,agreed_at,revoked_at,source,consent_version,consent_text) "+
          "VALUES (?,NOW(),NULL,'cart','v1',?) ON DUPLICATE KEY UPDATE agreed_at=NOW(),revoked_at=NULL,source='cart',consent_version='v1',consent_text=VALUES(consent_text)",
          [userId,CONSENT_TEXT]
        );
        // New opt-in starts a fresh waiting period for a previously suppressed cart.
        await getPool().execute(
          "UPDATE rtn_abandoned_carts SET reminder_state='pending',updated_at=NOW() WHERE user_id=? AND reminder_state='suppressed' AND total>0",
          [userId]
        );
      } else {await getPool().execute(
        "INSERT INTO rtn_marketing_consents(user_id,agreed_at,revoked_at,source,consent_text) "+
        "VALUES (?,NULL,NOW(),'cart',?) ON DUPLICATE KEY UPDATE revoked_at=NOW()",
        [userId,CONSENT_TEXT]
      );await getPool().execute(
        "UPDATE rtn_abandoned_carts SET reminder_state='suppressed' WHERE user_id=? AND reminder_state='pending'",[userId]);}
      return res.json({ok:true,subscribed:subscribe});
    }catch(e){console.error('Marketing consent error:',e.message);return res.status(503).json({error:'Не удалось сохранить настройку рассылки'});}
  });
  app.post('/api/marketing/cart',login,async(req,res)=>{
    try {const result=await saveCart(req.marketingUser,req.body?.items);
      res.set('Cache-Control','no-store').json(result);
    }catch(e){console.error('Marketing cart sync error:',e.message);res.status(503).json({error:'Не удалось обновить корзину'});}
  });
  app.get('/api/marketing/unsubscribe',async(req,res)=>{
    const token=String(req.query?.token||'');
    if(!/^[a-f0-9]{64}$/.test(token))return htmlMessage(res,'Ссылка недействительна','Проверьте ссылку из письма.');
    res.type('html').send('<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="font:16px Arial;background:#101114;color:white;padding:45px 20px;max-width:560px;margin:auto"><h1>Отписаться от RTN.PRO?</h1><p>Больше не будем отправлять рекламные письма и напоминания о корзине.</p><form method="post" action="/api/marketing/unsubscribe"><input type="hidden" name="token" value="'+token+'"><button style="padding:14px 22px;cursor:pointer">Отписаться</button></form></body></html>');
  });
  app.post('/api/marketing/unsubscribe',express.urlencoded({extended:false}),async(req,res)=>{
    try{const token=String(req.body?.token||req.query?.token||'');
      if(!/^[a-f0-9]{64}$/.test(token))return res.status(400).send('Invalid unsubscribe token');
      await ensureTables();const db=getPool();const [result]=await db.execute(
        "UPDATE rtn_marketing_consents SET revoked_at=NOW(),optout_hash=NULL WHERE optout_hash=?",
        [sha(token)]);
      if(result.affectedRows)await db.execute(
        "UPDATE rtn_abandoned_carts c JOIN rtn_marketing_consents mc ON mc.user_id=c.user_id "+
        "SET c.reminder_state='suppressed' WHERE mc.revoked_at IS NOT NULL AND c.reminder_state='pending'");
      if(String(req.get('List-Unsubscribe')||'').includes('One-Click')) return res.status(200).end();
      return htmlMessage(res,'Вы отписались','Рекламные письма RTN.PRO больше не будут отправляться.');
    }catch(e){console.error('Unsubscribe failed:',e.message);return res.status(503).send('Unsubscribe temporarily unavailable');}
  });
  app.get('/api/admin/abandoned-carts',requireAdmin,async(_req,res)=>{
    try {await ensureTables();const [rows]=await getPool().query(
      "SELECT c.user_id,u.email,c.items_json,c.total,c.updated_at,c.reminder_state,c.last_reminder_at, "+
      "IF(mc.agreed_at IS NOT NULL AND mc.revoked_at IS NULL,1,0) AS subscribed "+
      "FROM rtn_abandoned_carts c JOIN users u ON u.id=c.user_id "+
      "LEFT JOIN rtn_marketing_consents mc ON mc.user_id=u.id ORDER BY c.updated_at DESC LIMIT 200");
      res.set('Cache-Control','no-store').json({ok:true,enabled:ENABLED,smtpConfigured:mailReady(),delayHours:DELAY_HOURS,carts:rows.map(row=>({
        ...row,items:JSON.parse(row.items_json||'[]'),items_json:undefined}))});
    }catch(e){console.error('Admin marketing cart error:',e.message);res.status(503).json({error:'Не удалось получить корзины'});}
  });
  // Periodic data minimization must also run while sending is disabled.
  async function pruneOldCarts() {
    try {
      await ensureTables();
      await getPool().query("DELETE FROM rtn_abandoned_carts WHERE updated_at < DATE_SUB(NOW(),INTERVAL 30 DAY)");
    } catch (error) { console.error('RTN cart retention error:',error.message); }
  }
  setTimeout(()=>{pruneOldCarts();runReminderBatch().catch(e=>console.error('RTN cart mailing job:',e.message));},30000).unref();
  setInterval(()=>{pruneOldCarts();},24*60*60*1000).unref();
  setInterval(()=>{runReminderBatch().catch(e=>console.error('RTN cart mailing job:',e.message));},10*60*1000).unref();
  console.log('RTN abandoned cart marketing:', ENABLED && mailReady() ? 'enabled' : 'disabled (requires consent + SMTP + enabled env)');
}
module.exports={installCartMarketingRoutes,markCheckoutByEmail,ensureTables,runReminderBatch};
