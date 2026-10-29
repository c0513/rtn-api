'use strict';
// SafeRoute read-only availability and invoice monitor.
// Does not create/confirm orders or alter SafeRoute account settings.
const { getPool } = require('./db');
const INTERVAL_MINUTES = Math.max(5, Math.min(60, Number(process.env.RTN_SAFEROUTE_MONITOR_MINUTES) || 15));
const BILL_CHECK_MS = 12 * 60 * 60 * 1000;
const BLOCK_RE = /(?:неопла|задолжен|долг|оплат[аыу]|не оплач|payment.required|overdue|billing|заблокирован|blocked|приостановлен)/i;
let setup = null, running = false, lastBillsAt = 0, stateCache = null;

function compactMessage(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, 190);
}
async function ensureTable() {
  await getPool().query(`CREATE TABLE IF NOT EXISTS rtn_saferoute_monitor (
    monitor_key VARCHAR(40) NOT NULL PRIMARY KEY,
    status VARCHAR(24) NOT NULL DEFAULT 'unknown',
    failure_count INT UNSIGNED NOT NULL DEFAULT 0,
    alert_status VARCHAR(24) NOT NULL DEFAULT '',
    last_error VARCHAR(240) NOT NULL DEFAULT '',
    last_checked DATETIME NULL,
    last_good DATETIME NULL,
    last_alert DATETIME NULL,
    last_bill_alert VARCHAR(128) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await getPool().execute("INSERT IGNORE INTO rtn_saferoute_monitor (monitor_key) VALUES ('shop')");
}
function decodeFailure(result, error) {
  const status = Number(result?.status || error?.response?.status || error?.status || 0);
  const raw = compactMessage(result?.error?.message || error?.response?.data?.message || error?.response?.data?.error || error?.message || '');
  const billing = status === 402 || BLOCK_RE.test(raw);
  const kind = billing ? 'payment' : ([401,403].includes(status) ? 'access' : 'unavailable');
  return {kind, status, raw: raw || 'Запрос не выполнился'};
}
function paymentState(bill) {
  if (bill?.paid === true || bill?.isPaid === true) return 'paid';
  const raw = String(bill?.paymentStatus || bill?.payment_status || bill?.status || '').toLowerCase();
  if (['paid','payed','оплачен','оплачено','completed','success'].includes(raw)) return 'paid';
  if (bill?.paid === false || bill?.isPaid === false || ['unpaid','not_paid','pending','не оплачен','неоплачен','overdue','просрочен'].includes(raw)) return 'unpaid';
  return 'unknown';
}
function dueDateOf(bill) {
  const raw = bill?.paymentDueDate || bill?.dueDate || bill?.due_date || bill?.payment_due_date || null;
  if (!raw || typeof raw !== 'string') return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}
async function checkBills(api, token, notify) {
  if (!api.reports?.getBills) return;
  const now = new Date();
  const from = new Date(now.getTime()-30*86400000).toISOString().slice(0,10);
  const to = new Date(now.getTime()+8*86400000).toISOString().slice(0,10);
  const result = await api.reports.getBills(token,{from,to});
  if (!(result?.status >= 200 && result?.status < 300)) return;
  const list = Array.isArray(result?.data) ? result.data : [];
  const db = getPool();
  for (const bill of list.slice(0,100)) {
    if (paymentState(bill) !== 'unpaid') continue;
    const due = dueDateOf(bill);
    if (!due || due.getTime() - Date.now() > 7*86400000) continue;
    const id = compactMessage(bill?.number || bill?.id || bill?.billNumber || '');
    if (!id) continue;
    const label = [id, due.toISOString().slice(0,10)].join(':').slice(0,128);
    const [[row]] = await db.query("SELECT last_bill_alert FROM rtn_saferoute_monitor WHERE monitor_key='shop'");
    if (row?.last_bill_alert === label) continue;
    const dueText = due.getTime() < Date.now() ? 'СРОК ПРОШЁЛ' : 'скоро срок оплаты';
    await notify(['🧾 RTN.PRO — SAFE ROUTE: СЧЁТ','', 'Счёт: '+id,'Дата оплаты: '+due.toISOString().slice(0,10),dueText,'', 'Проверьте оплату в личном кабинете SafeRoute.'].join('\n'));
    await db.execute("UPDATE rtn_saferoute_monitor SET last_bill_alert=? WHERE monitor_key='shop'",[label]);
    break; // never flood the operational chat with dozens of bills
  }
}
async function runCheck({apiProvider,token,shopId,notify,force=false}) {
  if (running) return stateCache || {status:'checking'};
  running = true;
  try {
    await ensureTable();
    const db=getPool();
    const [[last]] = await db.query("SELECT * FROM rtn_saferoute_monitor WHERE monitor_key='shop'");
    const api = await apiProvider();
    const res=await api.user.getData(token);
    const ok=Number(res?.status)>=200 && Number(res?.status)<300 && res?.data!=null;
    const detail=ok?null:decodeFailure(res,null);
    const next = ok ? 'ok' : detail.kind;
    const failures = ok ? 0 : Number(last?.failure_count||0)+1;
    const now = new Date().toISOString();
    const previousAlert = String(last?.alert_status||'');
    const lastAlertMs = last?.last_alert ? new Date(last.last_alert).getTime() : 0;
    const repeat = !ok && previousAlert === next && Number.isFinite(lastAlertMs) && Date.now()-lastAlertMs >= 6*60*60*1000;
    const threshold = detail?.kind==='payment' ? 1 : 2;
    const shouldAlert = !ok && failures >= threshold && (previousAlert !== next || repeat);
    const shouldRecover = ok && previousAlert && previousAlert!=='ok';
    if (shouldAlert) {
      const diagnosis = next==='payment' ? 'Проблема оплаты/блокировки (по ответу API)' :
        next==='access' ? 'Отказ в доступе к API — возможна блокировка или проблема токена' : 'API не отвечает корректно';
      await notify(['🚨 RTN.PRO — SAFEROUTE','',
        diagnosis,
        'HTTP: '+(detail.status||'нет ответа'),
        'Причина: '+detail.raw,
        'Подряд неудачных проверок: '+failures,
        'Проверка: '+now,
        '',
        'Проверьте счёт, токен и личный кабинет SafeRoute.'].join('\n'));
    } else if (shouldRecover) {
      await notify(['✅ RTN.PRO — SAFEROUTE ВОССТАНОВЛЕН','API снова отвечает по токену.','Проверка: '+now].join('\n'));
    }
    await db.execute(
      "UPDATE rtn_saferoute_monitor SET status=?, failure_count=?, last_error=?, last_checked=NOW(), "+
      "last_good=CASE WHEN ?='ok' THEN NOW() ELSE last_good END, "+
      "alert_status=CASE WHEN ? THEN ? WHEN ? THEN '' ELSE alert_status END, "+
      "last_alert=CASE WHEN ? OR ? THEN NOW() ELSE last_alert END WHERE monitor_key='shop'",
      [next,failures,ok?'':detail.raw.slice(0,240),next,shouldAlert,next,shouldRecover,shouldAlert,shouldRecover]
    );
    stateCache={status:next,checkedAt:now,failureCount:failures,lastError:ok?null:detail.raw};
    if(ok && (force || Date.now()-lastBillsAt >= BILL_CHECK_MS)){
      lastBillsAt=Date.now();
      try {await checkBills(api,token,notify);} catch(error){console.warn('SafeRoute invoices check unavailable:',compactMessage(error?.message));}
    }
    console.log('SafeRoute monitor check:',next, ok?'HTTP '+res.status:('HTTP '+detail.status));
    return stateCache;
  }catch(error){
    const d=decodeFailure(null,error);
    // Treat exceptions as observed failures too; do not silently interpret them as billing blocks.
    console.error('SafeRoute monitor error:', d.status, d.raw);
    try {
      const db=getPool();
      await ensureTable();
      const [[row]]=await db.query("SELECT * FROM rtn_saferoute_monitor WHERE monitor_key='shop'");
      const failures=Number(row?.failure_count||0)+1;
      const next=d.kind;
      const alertStatus=String(row?.alert_status||'');
      if(failures>= (next==='payment'?1:2) && alertStatus!==next){
        await setup.notify('🚨 RTN.PRO — SAFEROUTE\n'+(next==='payment'?'Возможная блокировка оплаты':'Проблема доступа/связи')+
        '\nHTTP: '+(d.status||'нет ответа')+'\nПричина: '+d.raw+'\nПроверьте SafeRoute.');
        await db.execute("UPDATE rtn_saferoute_monitor SET alert_status=?,last_alert=NOW() WHERE monitor_key='shop'",[next]);
      }
      await db.execute("UPDATE rtn_saferoute_monitor SET status=?,failure_count=?,last_error=?,last_checked=NOW() WHERE monitor_key='shop'",
        [next,failures,d.raw.slice(0,240)]);
      stateCache={status:next,failureCount:failures,checkedAt:new Date().toISOString(),lastError:d.raw};
    }catch(dbError){console.error('SafeRoute monitor state persistence error:',compactMessage(dbError?.message));}
    return stateCache||{status:'unknown'};
  }finally{running=false;}
}
function startMonitor(options){
  setup=options;
  if(!options.token || !options.shopId || !options.botReady){
    console.warn('SafeRoute monitor not started: incomplete SafeRoute or Telegram configuration');
    return;
  }
  const run=()=>runCheck(options).catch(e=>console.error('SafeRoute monitor loop:',e.message));
  setTimeout(run,10000).unref();
  setInterval(run,INTERVAL_MINUTES*60000).unref();
  console.log('SafeRoute monitor scheduled every',INTERVAL_MINUTES,'minutes');
}
async function getStatus(){
  await ensureTable();
  const [[r]]=await getPool().query("SELECT status,failure_count,last_checked,last_good,last_error,last_alert,last_bill_alert FROM rtn_saferoute_monitor WHERE monitor_key='shop'");
  return {status:r?.status||'unknown',failures:Number(r?.failure_count||0),lastChecked:r?.last_checked||null,lastGood:r?.last_good||null,lastError:r?.last_error||null,lastAlert:r?.last_alert||null,invoiceAlert:r?.last_bill_alert||null,frequencyMinutes:INTERVAL_MINUTES};
}
module.exports={startMonitor,getStatus};
