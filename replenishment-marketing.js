'use strict';
const crypto=require('crypto');
const { buildRefillMail } = require('./rtn-smart-mail');
const {getPool}=require('./db');
const {sendMarketingEmail,getMarketingMailStatus}=require('./rtn-mail');
const ENABLED=String(process.env.RTN_REPLENISHMENT_EMAIL_ENABLED||'').toLowerCase()==='true';
const SITE=(process.env.RTN_MARKETING_SITE_URL||'https://rtn.pro').replace(/\/$/,'');
const DEFAULTS=[
 ['WHEY PRO','WHEY PRO',30,1,3,true,'1 порция в день'],
 ['MASS GAINER','MASS GAINER',60,1,3,true,'1 порция в день'],
 ['BCAA','BCAA',30,1,3,true,'Частота зависит от тренировок: уточняется'],
 ['AAKG','AAKG',30,1,3,true,'Частота зависит от тренировок: уточняется'],
 ['КРЕАТИН','КРЕАТИН',60,1,3,true,'1 порция в день'],
 ['CREATINE','КРЕАТИН',60,1,3,true,'1 порция в день'],
 ['АМИЛОПЕКТИН','АМИЛОПЕКТИН',30,1,3,true,'Ориентир: 1 порция в день'],
 ['MAGNESIUM GLYCINATE','MAGNESIUM GLYCINATE',30,1,3,true,'120 капсул / 4 капсулы за приём'],
 ['JOINT SUPPORT','JOINT SUPPORT',20,1,3,true,'120 капсул / 6 капсул за приём'],
 ['RHINO FURY','RHINO FURY',0,0,3,false,'Нет подтверждённого количества порций'],
 ['OMEGA-3','OMEGA-3 35%',0,0,3,false,'90 капсул, но норма в день не подтверждена']
];
let initialized;
const esc=v=>String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function ensure(){
 if(!initialized)initialized=(async()=>{
  const db=getPool();
  await db.query("CREATE TABLE IF NOT EXISTS rtn_refill_rules (sku VARCHAR(80) PRIMARY KEY, name VARCHAR(150) NOT NULL, servings INT NOT NULL, per_day DECIMAL(6,2) NOT NULL, lead_days INT NOT NULL DEFAULT 3, active TINYINT NOT NULL DEFAULT 0, note VARCHAR(200) NOT NULL DEFAULT '') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  await db.query("CREATE TABLE IF NOT EXISTS rtn_refill_queue (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, payment_id VARCHAR(100) NOT NULL, user_id BIGINT UNSIGNED NOT NULL, sku VARCHAR(80) NOT NULL, product VARCHAR(180) NOT NULL, quantity INT NOT NULL, due_at DATETIME NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', sent_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_payment_product (payment_id,sku), KEY idx_due(status,due_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  for(const d of DEFAULTS)await db.execute("INSERT IGNORE INTO rtn_refill_rules (sku,name,servings,per_day,lead_days,active,note) VALUES (?,?,?,?,?,?,?)",d.map((x,i)=>i===5?(x?1:0):x));
 })().catch(e=>{initialized=null;throw e;});
 return initialized;
}
const normalize=s=>String(s||'').toUpperCase().replace(/Ё/g,'Е').replace(/\s+/g,' ').trim();
async function getRules(){
 await ensure();const [rows]=await getPool().query("SELECT sku,name,servings,per_day AS perDay,lead_days AS leadDays,active,note FROM rtn_refill_rules ORDER BY FIELD(sku,'WHEY PRO','MASS GAINER','BCAA','AAKG','КРЕАТИН','CREATINE','АМИЛОПЕКТИН','MAGNESIUM GLYCINATE','JOINT SUPPORT','RHINO FURY','OMEGA-3'),sku");
 return rows.map(r=>({...r,servings:Number(r.servings),perDay:Number(r.perDay),leadDays:Number(r.leadDays),active:Boolean(r.active)}));
}
async function recordPaidPurchase(payment,order){
 if(payment?.status!=='succeeded'||payment.paid!==true||!Array.isArray(order?.items))return {skipped:true};
 await ensure();
 const email=String(payment?.metadata?.customerEmail||order?.customer?.email||'').trim().toLowerCase();
 if(!email)return {skipped:true};
 const [[user]]=await getPool().execute("SELECT id FROM users WHERE email=? AND status='active' LIMIT 1",[email]);
 if(!user)return {skipped:true};
 const rules=(await getRules()).filter(r=>r.active&&r.servings>0&&r.perDay>0);
 let count=0;
 for(const item of order.items){
  const name=normalize(item.name||item.productName);
  // Prefer the longest matching prefix (e.g. MAGNESIUM GLYCINATE vs generic).
  const r=rules.filter(rule=>name.includes(normalize(rule.sku))).sort((a,b)=>b.sku.length-a.sku.length)[0];
  if(!r)continue;
  const quantity=Math.max(1,Math.min(100,Math.floor(Number(item.quantity)||1)));
  const duration=Math.ceil(r.servings*quantity/r.perDay);
  // Estimate: 3 days in transit, then begin taking the product.
  const days=Math.max(1,duration+3-r.leadDays);
  const paidAt=new Date(payment.captured_at||payment.created_at||Date.now());
  if(Number.isNaN(paidAt.getTime()))continue;
  const dueAt=new Date(paidAt.getTime()+days*86400000);
  await getPool().execute("INSERT IGNORE INTO rtn_refill_queue (payment_id,user_id,sku,product,quantity,due_at) VALUES (?,?,?,?,?,?)",
    [String(payment.id).slice(0,100),user.id,r.sku,String([item.name||r.name,item.flavor].filter(Boolean).join(' · ')).slice(0,180),quantity,dueAt]);
  count++;
 }
 return {recorded:count};
}
async function saveRules(rules){
 if(!Array.isArray(rules)||rules.length>30)throw Error('Неверный набор правил');
 await ensure();const db=getPool();
 for(const x of rules){
  const key=String(x.sku||'').slice(0,80);
  if(!DEFAULTS.some(d=>d[0]===key))continue;
  const servings=Number(x.servings),perDay=Number(x.perDay),leadDays=Number(x.leadDays);
  if(!Number.isInteger(servings)||servings<0||servings>1000||perDay<0||perDay>10||!Number.isFinite(perDay)||!Number.isInteger(leadDays)||leadDays<2||leadDays>3)throw Error('Проверьте количество порций и интервал');
  await db.execute('UPDATE rtn_refill_rules SET servings=?,per_day=?,lead_days=?,active=? WHERE sku=?',
    [servings,perDay,leadDays,x.active&&servings>0&&perDay>0?1:0,key]);
 }
 return getRules();
}
function refillMail({product,flavor='',token,test=false}) {
 return buildRefillMail({product,flavor,token,test});
}
let running=false;
async function sendDue(){
 if(running||!ENABLED||!getMarketingMailStatus().configured)return {skipped:true};
 running=true;
 try{
  await ensure();const db=getPool();
  const [rows]=await db.query("SELECT q.id,q.user_id,q.sku,q.product,q.payment_id,u.email FROM rtn_refill_queue q JOIN users u ON u.id=q.user_id JOIN rtn_marketing_consents mc ON mc.user_id=q.user_id WHERE q.status='pending' AND q.due_at<=NOW() AND mc.agreed_at IS NOT NULL AND mc.revoked_at IS NULL AND u.email_verified_at IS NOT NULL AND u.status='active' ORDER BY q.due_at LIMIT 10");
  let sent=0;
  for(const row of rows){
   const [claim]=await db.execute("UPDATE rtn_refill_queue SET status='sending' WHERE id=? AND status='pending'",[row.id]);
   if(!claim.affectedRows)continue;
   try{
    // A newer purchase of the same SKU makes this reminder unnecessary.
    const [[later]]=await db.execute("SELECT id FROM rtn_refill_queue WHERE user_id=? AND sku=? AND id>? LIMIT 1",[row.user_id,row.sku,row.id]);
    if(later){await db.execute("UPDATE rtn_refill_queue SET status='superseded' WHERE id=?",[row.id]);continue;}
    const [[consent]]=await db.execute("SELECT agreed_at,revoked_at FROM rtn_marketing_consents WHERE user_id=?",[row.user_id]);
    if(!consent?.agreed_at||consent.revoked_at){await db.execute("UPDATE rtn_refill_queue SET status='suppressed' WHERE id=?",[row.id]);continue;}
    const token=crypto.randomBytes(32).toString('hex');
    await db.execute('UPDATE rtn_marketing_consents SET optout_hash=? WHERE user_id=?',[crypto.createHash('sha256').update(token).digest('hex'),row.user_id]);
    await sendMarketingEmail({to:row.email,...refillMail({product:row.product,token})});
    await db.execute("UPDATE rtn_refill_queue SET status='sent',sent_at=NOW() WHERE id=?",[row.id]);sent++;
   }catch(e){console.error('RTN refill send:',e.message);await db.execute("UPDATE rtn_refill_queue SET status='failed' WHERE id=?",[row.id]);}
  }
  return {sent};
 }finally{running=false;}
}
function install(app,requireAdmin){
 app.get('/api/admin/replenishment',requireAdmin,async(req,res)=>{
  try{await ensure();const [q]=await getPool().query("SELECT q.id,u.email,q.product,q.quantity,q.due_at AS dueAt,q.status FROM rtn_refill_queue q JOIN users u ON u.id=q.user_id ORDER BY q.due_at DESC LIMIT 100");
   res.set('Cache-Control','no-store').json({rules:await getRules(),queue:q,enabled:ENABLED});}
  catch(e){console.error('Refill admin GET:',e.message);res.status(503).json({error:'Нет доступа к данным повторных покупок'});}
 });
 app.put('/api/admin/replenishment/rules',requireAdmin,async(req,res)=>{
  try{res.json({ok:true,rules:await saveRules(req.body?.rules)});}
  catch(e){res.status(400).json({error:e.message});}
 });
 setTimeout(()=>{sendDue().catch(e=>console.error('RTN refill scheduler:',e.message))},60000).unref();
 setInterval(()=>{sendDue().catch(e=>console.error('RTN refill scheduler:',e.message))},60*60*1000).unref();
}
module.exports={install,recordPaidPurchase,getRules,refillMail,sendDue};
