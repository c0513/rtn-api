'use strict';
// RTN.PRO: HTML email templates and SKU-based recommendations.
// Catalogue is a snapshot for visual matching; it is NOT an inventory feed.
const SITE = (process.env.RTN_MARKETING_SITE_URL || 'https://rtn.pro').replace(/\/$/,'');
const API = (process.env.RTN_PUBLIC_API_URL || 'https://rhino-api-yrfq.onrender.com').replace(/\/$/,'');
const rows = [
 ['whey-caramel','WHEY PRO','СОЛЕНАЯ КАРАМЕЛЬ','Whey/salted caramel.png'],
 ['whey-lemon','WHEY PRO','ЛИМОННЫЙ МУСС','Whey/lemon mousse.png'],
 ['whey-raspberry','WHEY PRO','МАЛИНА И БЕЛЫЙ ШОКОЛАД','Whey/white chocolate.png'],
 ['mass-choco','MASS GAINER','ШОКОЛАД','Gainer/chocolate.png'],
 ['mass-lemon','MASS GAINER','ЛИМОННЫЙ МУСС','Gainer/lemon mousse.png'],
 ['mass-caramel','MASS GAINER','СОЛЕНАЯ КАРАМЕЛЬ','Gainer/salted caramel.png'],
 ['mass-raspberry','MASS GAINER','МАЛИНА И БЕЛЫЙ ШОКОЛАД','Gainer/white chocolate.png'],
 ['bcaa-wildberries','BCAA','ЛЕСНЫЕ ЯГОДЫ','BCAA/wildberries.png'],
 ['bcaa-lime','BCAA','ЛИМОН-ЛАЙМ','BCAA/lemon lime.png'],
 ['bcaa-grapefruit','BCAA','ГРЕЙПФРУТ','BCAA/grapefruit.png'],
 ['bcaa-currant','BCAA','ЧЕРНАЯ СМОРОДИНА','BCAA/black currant.png'],
 ['arg-wildberries','AAKG','ЛЕСНЫЕ ЯГОДЫ','AAKG/wildberries.png'],
 ['arg-lime','AAKG','ЛИМОН-ЛАЙМ','AAKG/lemon lime.png'],
 ['arg-grapefruit','AAKG','ГРЕЙПФРУТ','AAKG/grapefruit.png'],
 ['arg-currant','AAKG','ЧЕРНАЯ СМОРОДИНА','AAKG/black currant.png'],
 ['pre-orange','RHINO FURY','АПЕЛЬСИН','Rage/orange.png'],
 ['pre-bubblegum','RHINO FURY','БАБЛ-ГАМ','Rage/bubble gum.png'],
 ['pre-cola','RHINO FURY','МАРМЕЛАДНАЯ КОЛА','Rage/marmalade.png'],
 ['creatine-orange','КРЕАТИН','АПЕЛЬСИН','Creatine/orange.png'],
 ['creatine-apple','КРЕАТИН','ЯБЛОКО','Creatine/apple.png'],
 ['creatine-wildberries','КРЕАТИН','ЛЕСНЫЕ ЯГОДЫ','Creatine/wildberries.png'],
 ['creatine-neutral','КРЕАТИН','БЕЗ ВКУСА','Creatine/neutral.png'],
 ['amylo-neutral','АМИЛОПЕКТИН','БЕЗ ВКУСА','Amylopectin.png'],
 ['magnesium-caps','MAGNESIUM GLYCINATE','120 КАПСУЛ','Magnesium.png'],
 ['chondro-caps','JOINT SUPPORT','120 КАПСУЛ','Joint Support.png'],
 ['omega3-caps','OMEGA-3 35%','90 КАПСУЛ','Omega 3.png']
];
const products = rows.map(([slug,name,flavor,src])=>({slug,name,flavor,image:'/images/'+src}));
const norm = s=>String(s||'').toUpperCase().replace(/Ё/g,'Е').replace(/\s+/g,' ').trim();
const esc = s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = v=>Number(v||0).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
function photo(path) {
 if (typeof path!=='string'||!path.startsWith('/images/')||!/\.(?:png|jpe?g|webp|avif)$/i.test(path))return '';
 const u=new URL(path,SITE+'/');
 return u.origin===new URL(SITE).origin ? u.href : '';
}
function image(path,alt,width) {
 const u=photo(path); return u?'<img src="'+esc(u)+'" alt="'+esc(alt)+'" width="'+width+'" style="max-width:100%;height:auto;display:block;margin:0 auto;border:0;object-fit:contain">':'';
}
function findProduct(item){
 if(!item)return null;
 if(item.slug) {const p=products.find(p=>p.slug===item.slug);if(p)return p;}
 const name=norm(item.name||item.product||'');
 const flavor=norm(item.flavor||'');
 // Exact catalog flavor must be supplied explicitly, or after the · separator.
 const parts=name.split(/\s*[·•]\s*/);
 const base=parts[0], variant=flavor||parts.slice(1).join(' ');
 if(!variant)return null;
 return products.find(p=>norm(p.name)===base&&norm(p.flavor)===variant)||null;
}
function family(s){
 const v=norm(s);
 if(/ЛИМОН|ЛАЙМ|АПЕЛЬСИН|ГРЕЙПФРУТ/.test(v))return 'цитрусовый';
 if(/ЯГОД|МАЛИН|СМОРОД/.test(v))return 'ягодный';
 if(/ШОКОЛАД|КАРАМЕЛ/.test(v))return 'десертный';
 return '';
}
function recommend({anchor,cart=[],history=[]}={}){
 const base=findProduct(anchor);if(!base)return [];
 const excluded=new Set([base.slug,...cart.map(x=>findProduct(x)?.slug),...history.map(x=>findProduct(x)?.slug)]);
 const alt=products.find(p=>p.name===base.name&&p.slug!==base.slug&&!excluded.has(p.slug));
 const exact=products.find(p=>p.name!==base.name&&p.flavor===base.flavor&&!excluded.has(p.slug)&&p.slug!==alt?.slug);
 const similar=products.find(p=>p.name==='RHINO FURY'&&p.name!==base.name&&family(p.flavor)&&family(p.flavor)===family(base.flavor)&&!excluded.has(p.slug)&&p.slug!==alt?.slug);
 const other=products.find(p=>p.name==='RHINO FURY'&&p.name!==base.name&&!excluded.has(p.slug)&&p.slug!==alt?.slug);
 const result=[];
 if(alt)result.push({...alt,label:'Попробуй другой вкус'});
 const complimentary=exact||similar||other;
 if(complimentary)result.push({...complimentary,label:exact?'Тот же вкус, другой продукт':similar?'Похожий вкусовой профиль':'Дополнение к тренировке'});
 return result;
}
function card(p){
 return '<td width="50%" valign="top" style="padding:6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #304858;background:#141e2a"><tr><td style="height:145px;padding:10px" align="center">'+image(p.image,p.name+' '+p.flavor,103)+'</td></tr><tr><td style="padding:8px 12px 15px"><div style="font-size:11px;color:#6feaff">'+esc(p.label)+'</div><div style="font-size:16px;color:#fff;font-weight:bold;margin-top:7px">'+esc(p.name)+'</div><div style="font-size:12px;color:#afc2cf;margin:7px 0 13px">'+esc(p.flavor)+'</div><a href="'+SITE+'/catalog?utm_source=email&amp;utm_medium=marketing" style="display:block;padding:11px 4px;background:#193945;border:1px solid #327587;color:#adf6fb;text-align:center;text-decoration:none;font-weight:bold;font-size:12px">ПОСМОТРЕТЬ</a></td></tr></table></td>';
}
function frame({title,preheader,intro,hero,choices,action,button,token,test}){
 const recommended=choices.length?'<tr><td style="padding:23px 20px 9px"><div style="font-size:11px;letter-spacing:2px;color:#73eaf3">ПОДОБРАЛИ ДЛЯ ТЕБЯ</div><h2 style="font-size:22px;color:white;margin:8px 0">ВКУСЫ И СОЧЕТАНИЯ</h2></td></tr><tr><td style="padding:0 13px 22px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>'+choices.map(card).join('')+'</tr></table></td></tr>':'';
 const unsub= test?'':'<a href="'+API+'/api/marketing/unsubscribe?token='+encodeURIComponent(token)+'" style="color:#9cc8d1">Отписаться от рассылки</a>';
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#070b12;color:#fff;margin:0;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden">'+esc(preheader)+'</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#070b12"><tr><td align="center" style="padding:25px 10px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;background:#101823;border:1px solid #2b4050"><tr><td align="center" style="padding:24px;border-bottom:1px solid #2a3a48"><a href="'+SITE+'">'+image('/images/logo-mail.png','Rhino Tech Nutrition',178)+'</a><div style="color:#69eaf8;letter-spacing:3px;font-size:10px;margin-top:12px">RHINO TECH NUTRITION</div></td></tr><tr><td style="padding:28px 24px 16px"><h1 style="font-size:28px;line-height:1.16;margin:0 0 14px;color:#fff">'+esc(title)+'</h1><p style="font-size:15px;line-height:1.65;color:#c8d8e2;margin:0">'+esc(intro)+'</p></td></tr>'+hero+'<tr><td style="padding:12px 24px 30px"><a href="'+esc(action)+'" style="display:block;padding:16px 8px;background:#6cecf6;color:#07141e;text-align:center;text-decoration:none;font-weight:900;letter-spacing:.5px">'+esc(button)+'</a></td></tr>'+recommended+'<tr><td style="padding:20px 24px;color:#a3b7c4;border-top:1px solid #2c4050;font-size:11px;line-height:1.8">RTN.PRO · Rhino Tech Nutrition<br>'+ (test?'Письмо сформировано по запросу администратора RTN.PRO.':'Ты получил письмо, потому что дал согласие на маркетинговые сообщения RTN.PRO.')+'<br>'+unsub+'<br>Наличие товаров и актуальные цены проверяй в каталоге.</td></tr></table></td></tr></table></body></html>';
}
function buildCartMail({email,items=[],total,token,test=false}){
 const anchor=items.find(i=>findProduct(i))||items[0];
 const choices=recommend({anchor,cart:items});
 const rows=items.map(i=>{const img=i.image||findProduct(i)?.image; const qty=Math.max(1,Math.floor(Number(i.quantity)||1));return '<tr><td width="92" valign="top" style="padding:10px 3px;border-bottom:1px solid #253848">'+image(img,i.name,78)+'</td><td valign="top" style="padding:13px 6px;border-bottom:1px solid #253848;color:#fff;font-size:14px"><b>'+esc(i.name)+'</b><div style="font-size:12px;color:#b4c4d1;margin-top:6px">'+esc(i.flavor||'')+' · '+qty+' шт.</div></td><td valign="top" align="right" style="white-space:nowrap;padding:13px 3px;color:#fff;font-size:13px;border-bottom:1px solid #253848">'+money(Number(i.price||0)*qty)+'</td></tr>'}).join('');
 const hero='<tr><td style="padding:0 20px 12px"><table role="presentation" width="100%">'+rows+'</table><div style="text-align:right;padding:13px 5px;color:#fff;font-size:19px;font-weight:bold">Итого: '+money(total)+'</div><div style="background:#15313b;border:1px solid #377486;padding:16px;text-align:center;color:#86f6ff;font-weight:bold">RTN2026 · СКИДКА 5% НА ЗАКАЗ</div></td></tr>';
 const action=SITE+'/?utm_source=email&utm_medium=abandoned_cart&utm_campaign=return_cart';
 const intro='Твои выбранные товары всё ещё ждут. Вернись к оформлению, когда будет удобно.';
 const html=frame({title:'ТВОЯ КОРЗИНА ЖДЁТ',preheader:'Вернись к своим товарам и используй промокод RTN2026.',intro,hero,choices,action,button:'ВЕРНУТЬСЯ К КОРЗИНЕ',token,test});
 return {to:email,subject:'Твоя корзина ждёт · RTN.PRO',text:intro+'\n'+items.map(i=>i.name+' '+(i.flavor||'')+' ×'+i.quantity).join('\n')+'\nИтого: '+money(total)+'\nПромокод RTN2026: −5%.\n'+action+(test?'':'\nОтписаться: '+API+'/api/marketing/unsubscribe?token='+token),html};
}
function buildRefillMail({product,flavor='',token,test=false}){
 const full=String(product||'');const segments=full.split(/\s*[·•]\s*/);const name=segments[0],variant=flavor||segments.slice(1).join(' ');
 const anchor=findProduct({name,flavor:variant});
 const choices=anchor?recommend({anchor}):products.filter(p=>norm(p.name)===norm(name)).slice(0,2).map(p=>({...p,label:'Вкус из каталога'}));
 const hero=anchor?'<tr><td align="center" style="padding:10px 20px 20px"><table role="presentation" cellpadding="0"><tr><td style="padding:0 15px">'+image(anchor.image,anchor.name+' '+anchor.flavor,165)+'</td><td valign="middle" style="text-align:left;color:#fff"><div style="font-size:11px;color:#75eaf6;letter-spacing:2px">ТВОЙ ПРОДУКТ</div><b style="font-size:20px">'+esc(anchor.name)+'</b><div style="font-size:13px;color:#bed0da;padding-top:8px">'+esc(anchor.flavor)+'</div></td></tr></table></td></tr>':'';
 const intro='По приблизительному расчёту '+name+(variant?' · '+variant:'')+' может скоро закончиться. Проверь остаток и при необходимости пополни запас.';
 const action=SITE+'/catalog?utm_source=email&utm_medium=replenishment&utm_campaign=repeat_purchase';
 const html=frame({title:'ПОРА ПОПОЛНИТЬ ЗАПАС?',preheader:'Проверь свой запас и открой новые вкусы.',intro,hero,choices,action,button:'ПОДОБРАТЬ СВОЙ ПРОДУКТ',token,test});
 return {subject:'Пора проверить запас · RTN.PRO',text:intro+'\n'+action+(test?'':'\nОтписаться: '+API+'/api/marketing/unsubscribe?token='+token),html};
}
module.exports={products,findProduct,recommend,buildCartMail,buildRefillMail,photo};