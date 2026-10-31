'use strict';
/* One accepted payment -> at most one transactional confirmation email.
   No automatic retry after uncertain SMTP result to prevent duplicate emails. */
const { getPool } = require('./db');
const { sendMarketingEmail, getMarketingMailStatus } = require('./rtn-mail');
const { findProduct, photo } = require('./rtn-smart-mail');
const SITE='https://rtn.pro';
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean=(s,n=200)=>String(s||'').replace(/\s+/g,' ').trim().slice(0,n);
const isEmail=s=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
let init;
async function ensure(){
 if(!init)init=getPool().query('CREATE TABLE IF NOT EXISTS rtn_paid_order_emails ('+
 'payment_id VARCHAR(100) NOT NULL PRIMARY KEY, recipient VARCHAR(254) NOT NULL,'+
 'order_id VARCHAR(100) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT "claimed",'+
 'message_id VARCHAR(254) NULL, claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,'+
 'sent_at DATETIME NULL, last_error VARCHAR(150) NULL'+
 ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4').catch(e=>{init=null;throw e;});
 return init;
}
function orderMail(payment,order){
 const id=clean(payment?.metadata?.orderId||order?.orderId||'заказ',80);
 const amount=Number(payment?.amount?.value);
 const money=Number.isFinite(amount)?amount.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽':'';
 const list=Array.isArray(order?.items)?order.items.slice(0,30):[];
 const rows=list.map(x=>{
  const name=clean(x.name||x.productName||'Товар');
  const flavor=clean(x.flavor||x.variant||'',80);
  const qty=Math.max(1,Math.floor(Number(x.quantity)||1));
  const candidate=String(x.imageUrl||x.image||findProduct({name,flavor})?.image||'');
  const src=photo(candidate);
  return '<tr><td style="width:72px;padding:12px 8px;border-bottom:1px solid #334351">'+(src?'<img src="'+esc(src)+'" width="65" alt="'+esc(name)+'" style="height:auto;max-width:65px">':'')+'</td>'+
   '<td style="padding:12px 8px;border-bottom:1px solid #334351;color:#fff">'+esc(name)+(flavor?'<br><span style="font-size:12px;color:#b5c5cf">'+esc(flavor)+'</span>':'')+'</td>'+
   '<td style="padding:12px 8px;border-bottom:1px solid #334351;color:#fff;white-space:nowrap">'+qty+' шт.</td></tr>';
 }).join('');
 const html='<!doctype html><html lang="ru"><meta charset="utf-8"><body style="margin:0;background:#070b12;color:white;font:15px Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:25px 12px"><table style="width:100%;max-width:580px;background:#101823;border:1px solid #2b4050" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:26px"><a href="'+SITE+'"><img src="'+SITE+'/images/logo-mail.png" alt="RTN.PRO" width="180" style="max-width:100%;height:auto;border:0"></a></td></tr><tr><td style="padding:18px 26px"><h1 style="font-size:27px;margin:0 0 15px">ОПЛАТА ПОДТВЕРЖДЕНА</h1><p style="line-height:1.7;color:#bfced7">Заказ № '+esc(id)+' успешно оплачен. Спасибо, что выбрал RTN.PRO!</p>'+
 (rows?'<table width="100%" cellpadding="0" cellspacing="0">'+rows+'</table>':'')+
 (money?'<p style="font-size:21px">Сумма оплаты: <b>'+money+'</b></p>':'')+
 '<p style="color:#a6c2d0;font-size:13px;line-height:1.6">Статус доставки можно отслеживать в личном кабинете. Это сообщение об оплате, а не подтверждение отгрузки.</p><a href="'+SITE+'/profile" style="display:block;text-align:center;padding:17px;background:#6cecf6;color:#0a1720;text-decoration:none;font-weight:bold">МОИ ЗАКАЗЫ</a></td></tr><tr><td style="padding:20px 26px;color:#93a9ba;font-size:11px;border-top:1px solid #2b4050">RTN.PRO · Информация об оплаченной покупке</td></tr></table></td></tr></table></body></html>';
 return {subject:'Заказ № '+id+' оплачен · RTN.PRO',text:'Оплата заказа № '+id+' подтверждена.'+(money?' Сумма оплаты: '+money+'.':'')+' Посмотреть заказ: '+SITE+'/profile',html};
}
async function sendPaidOrderConfirmation(payment,order){
 if(payment?.status!=='succeeded'||payment?.paid!==true)return {skipped:'unconfirmed'};
 if(!getMarketingMailStatus().configured)return {skipped:'relay_not_configured'};
 const address=clean(payment?.metadata?.customerEmail||order?.customer?.email||'',254).toLowerCase();
 const paymentId=clean(payment?.id,100),orderId=clean(payment?.metadata?.orderId||order?.orderId,100);
 if(!isEmail(address)||!paymentId)return {skipped:'missing_email_or_payment'};
 await ensure();
 const db=getPool();
 const [claimed]=await db.execute('INSERT IGNORE INTO rtn_paid_order_emails(payment_id,recipient,order_id,status) VALUES (?,?,?,?)',[paymentId,address,orderId,'claimed']);
 if(!claimed.affectedRows)return {skipped:'already_claimed'};
 try{
  const result=await sendMarketingEmail({to:address,...orderMail(payment,order),eventType:'order_paid'});
  await db.execute("UPDATE rtn_paid_order_emails SET status='sent',sent_at=NOW(),message_id=? WHERE payment_id=?",[result.messageId,paymentId]);
  return {sent:true};
 }catch(e){
  await db.execute("UPDATE rtn_paid_order_emails SET status='uncertain',last_error=? WHERE payment_id=?",[clean(e.code||e.message,150),paymentId]).catch(()=>{});
  throw e;
 }
}
module.exports={sendPaidOrderConfirmation,orderMail};
