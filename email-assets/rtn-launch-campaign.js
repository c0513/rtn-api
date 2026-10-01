const fs = require('fs');
const path = require('path');

const MODE = process.argv[2] || 'test';
const TEST_TO = 'perervamax@yandex.ru';
const SUBJECT = 'Старт продаж Rhino Tech Nutrition — преодолей свои пределы';
const IMAGE_URL = 'https://rtn.pro/images/rtn-launch.jpg';
const MAILER_URL = 'http://127.0.0.1:9085/send-email';
const LOG_FILE = '/opt/rtn-mailer/rtn-launch-20261001.sent.jsonl';
const RECIPIENTS = [
  "cosyine@gmail.com","naidihpo@gmail.com","chabanovi@mail.ru","toji776@mail.ru","egor2397@mail.ru","alekshaisarov80@gmail.com","inkognito_2007@inbox.ru","dmitry.vko@gmail.com","staslexus-tscorp@ya.ru","bolgovd@list.ru","samveld396@gmail.com","kan3970@yandex.ru","savitskiye92@gmail.com","serge-ev260381@yandex.ru","romachichka2001@mail.ru","fornothing910@gmail.com","tima.osetrov.10@mail.ru","alex.rucomunity@gmail.com","renton.oleg@yandex.ru","inkom-forest@mail.ru","dmitrii-kunaev@mail.ru","immortal_tattoo@icloud.com","stepanlebedev242@gmail.com","fhsfhff@mail.ru","nickita.sasin@yandex.ru","sak78@mail.ru","daniilbarysev1164@gmail.com","k.pyrko13@gmail.com","zamorpex336@rambler.ru","rayder2011@yandex.ru","dzurabaevaajsana@gmail.com","panda_hero@bk.ru","nikabulbula@gmail.com","arm903@yandex.ru","d1202@mail.ru","stepanorhov34@mail.ru","trushkin85@bk.ru","lyaufer@list.ru","kozorizmihail3@gmail.com","dkekhter97@mail.ru","ingirki@gmail.com","smirnov.86@list.ru","slychevskiy9228@gmail.com","a.baydin@yandex.ru","kochmarukd@mail.ru","oleg1solohin@yandex.ru","planeta_sn@mail.ru","261199kill@gmail.com","uekzlokomotiv@gmail.com","span4@bk.ru","boss.kaporulin@mail.ru","fackirgross@yandex.ru","muradmurzabekov1998@yandex.ru","5092391@mail.ru","dimonchik16.92@mail.ru","warik88@icloud.com","tyman-77@mail.ru","krupimur@gmail.com","2222@gmail.com","nikolya.saburov@internet.ru","dxabar@gmail.com","kucinya888@gmail.com","lavrosik.ru@mail.ru","belyaevsergei95@mail.ru","ivanuxta@gmail.com"
];

const HTML = "<!doctype html>\n<html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"dark\"><title>Rhino Tech Nutrition — старт продаж</title>\n<style>body{margin:0;padding:0}table{border-collapse:collapse}img{border:0;outline:none;text-decoration:none}a{color:inherit}@media only screen and (max-width:620px){.wrap{width:100%!important}.pad{padding-left:20px!important;padding-right:20px!important}}</style></head>\n<body style=\"margin:0;padding:0;background:#05090e;\">\n<div style=\"display:none;font-size:1px;color:#05090e;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;\">Старт продаж Rhino Tech Nutrition. Вход по коду амбассадора или rtn2026.</div>\n<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" bgcolor=\"#05090e\"><tr><td align=\"center\" style=\"padding:16px 0 24px;\">\n<!--[if mso]><table role=\"presentation\" width=\"600\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\"><tr><td><![endif]-->\n<table role=\"presentation\" class=\"wrap\" width=\"600\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" style=\"width:100%;max-width:600px;\">\n<tr><td><a href=\"https://rtn.pro/\" target=\"_blank\" style=\"text-decoration:none;\"><img src=\"https://rtn.pro/images/rtn-launch.jpg\" width=\"600\" alt=\"Rhino Tech Nutrition — старт продаж. Преодолей свои пределы. Перейти на rtn.pro.\" style=\"display:block;width:100%;max-width:600px;height:auto;color:#ffffff;font-family:Arial,sans-serif;font-size:18px;\"></a></td></tr>\n<tr><td height=\"20\" style=\"font-size:1px;line-height:20px;\">&nbsp;</td></tr>\n<tr><td><table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" bgcolor=\"#0b1016\" style=\"background:#0b1016;border-top:3px solid #00dce5;\">\n<tr><td class=\"pad\" style=\"padding:24px 32px 28px;font-family:Arial,Helvetica,sans-serif;color:#e8edf0;\">\n<p style=\"margin:0 0 12px;color:#00dce5;font-size:12px;font-weight:bold;letter-spacing:2px;\">ДОСТУП К САЙТУ</p>\n<h1 style=\"margin:0 0 14px;font-size:28px;line-height:34px;color:#ffffff;\">ТВОЙ КОД ВХОДА</h1>\n<p style=\"margin:0 0 24px;font-size:16px;line-height:24px;\">Для входа на <a href=\"https://rtn.pro/\" style=\"color:#e8edf0;text-decoration:underline;\">rtn.pro</a> введи код доступа.</p>\n<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" bgcolor=\"#151d26\" style=\"background:#151d26;border:1px solid #35404d;\"><tr><td style=\"padding:18px 16px;\">\n<p style=\"margin:0 0 10px;color:#ff8800;font-size:15px;line-height:21px;font-weight:bold;\">ПРИШЁЛ ОТ АМБАССАДОРА?</p>\n<p style=\"margin:0 0 8px;font-size:15px;line-height:23px;\">Введи его промокод — это и есть код доступа.</p>\n<p style=\"margin:0;font-size:15px;line-height:23px;\">Ищи промокод в каналах амбассадоров.</p></td></tr></table>\n<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\"><tr><td height=\"14\" style=\"font-size:1px;line-height:14px;\">&nbsp;</td></tr></table>\n<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" bgcolor=\"#151d26\" style=\"background:#151d26;border:1px solid #35404d;\"><tr><td style=\"padding:18px 16px;\">\n<p style=\"margin:0 0 10px;color:#ff8800;font-size:15px;line-height:21px;font-weight:bold;\">ПРИШЁЛ САМОСТОЯТЕЛЬНО?</p>\n<p style=\"margin:0 0 8px;font-size:15px;line-height:23px;\">Используй код:</p>\n<p style=\"margin:0;color:#00dce5;font-size:30px;line-height:36px;font-weight:bold;\">rtn2026</p></td></tr></table>\n<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" style=\"margin-top:24px;\"><tr><td align=\"center\" bgcolor=\"#00dce5\" style=\"background:#00dce5;\"><a href=\"https://rtn.pro/\" target=\"_blank\" style=\"display:block;padding:18px 12px;color:#071016;font-size:17px;line-height:22px;font-weight:bold;text-decoration:none;\">ПЕРЕЙТИ НА RTN.PRO</a></td></tr></table>\n</td></tr></table></td></tr></table>\n<!--[if mso]></td></tr></table><![endif]-->\n</td></tr></table></body></html>";
const TEXT = 'Старт продаж Rhino Tech Nutrition. Код самостоятельного доступа: rtn2026. https://rtn.pro/';

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const env = {...loadEnv('/opt/rtn-mailer/.env'), ...process.env};
const API_KEY = env.RTN_MAILER_API_KEY;
if (!API_KEY) throw new Error('RTN_MAILER_API_KEY not found');

function sentSet() {
  if (!fs.existsSync(LOG_FILE)) return new Set();
  const set = new Set();
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.ok && r.to) set.add(String(r.to).toLowerCase()); } catch {}
  }
  return set;
}
function appendLog(row) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({...row, at: new Date().toISOString()}) + '\n');
}
async function imageCheck() {
  const r = await fetch(IMAGE_URL, {method:'HEAD'});
  if (!r.ok) throw new Error(`Image check failed: HTTP ${r.status} ${IMAGE_URL}`);
  console.log(`image ok: ${r.status} ${r.headers.get('content-type') || ''}`);
}
async function send(to) {
  const r = await fetch(MAILER_URL, {
    method:'POST',
    headers:{'Authorization':`Bearer ${API_KEY}`,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({to,subject:SUBJECT,text:TEXT,html:HTML})
  });
  const raw = await r.text();
  let data; try { data = JSON.parse(raw); } catch { data = {raw}; }
  if (!r.ok || !data.ok) throw new Error(`send failed ${to}: HTTP ${r.status} ${raw.slice(0,300)}`);
  return data;
}
async function main() {
  await imageCheck();
  if (MODE === 'test') {
    const data = await send(TEST_TO);
    console.log(JSON.stringify({mode:'test',to:TEST_TO,...data}));
    return;
  }
  if (MODE !== 'campaign') throw new Error('Use: test or campaign');
  const sent = sentSet();
  let ok=0, skipped=0, failed=0;
  for (const to of RECIPIENTS) {
    if (sent.has(to)) { skipped++; console.log(`skip already sent: ${to}`); continue; }
    try {
      const data = await send(to);
      appendLog({ok:true,to,messageId:data.messageId || null});
      ok++; console.log(`sent ${ok}: ${to}`);
    } catch (e) {
      failed++; appendLog({ok:false,to,error:e.message}); console.error(e.message);
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(JSON.stringify({mode:'campaign',total:RECIPIENTS.length,ok,skipped,failed,log:LOG_FILE}));
}
main().catch(e => { console.error(e); process.exit(1); });
