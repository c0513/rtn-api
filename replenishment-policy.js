'use strict';

// Catalog-backed starting estimates, not individualized medical or consumption advice.
// Daily means one serving every day. Training means one on four training days/week.
// Three days of product left is the default notification window.
const PRODUCTS = Object.freeze([
  { id:'whey-pro', name:'WHEY PRO', pattern:/\bWHEY\b|ВЕЙ ПРО/i, portions:30, usesPerWeek:7, image:'/images/Whey/salted caramel.png' },
  { id:'mass-gainer', name:'MASS GAINER', pattern:/\bGAINER\b|ГЕЙНЕР/i, portions:60, usesPerWeek:7, image:'/images/Gainer/chocolate.png' },
  { id:'bcaa', name:'BCAA', pattern:/\bBCAA\b|БЦАА/i, portions:30, usesPerWeek:4, image:'/images/BCAA/wildberries.png' },
  { id:'aakg', name:'AAKG', pattern:/\bAAKG\b|АРГИНИН/i, portions:30, usesPerWeek:4, image:'/images/AAKG/wildberries.png' },
  { id:'creatine', name:'КРЕАТИН', pattern:/\bCREATINE\b|КРЕАТИН/i, portions:60, usesPerWeek:7, image:'/images/Creatine/orange.png' },
  { id:'amylopectin', name:'АМИЛОПЕКТИН', pattern:/\bAMYLOPECTIN\b|АМИЛОПЕКТИН/i, portions:30, usesPerWeek:4, image:'/images/Amylopectin.png' },
  { id:'magnesium-glycinate', name:'MAGNESIUM GLYCINATE', pattern:/\bMAGNESIUM\b|МАГНИЙ/i, portions:30, usesPerWeek:7, image:'/images/Magnesium.png' },
  { id:'rhino-fury', name:'RHINO FURY', pattern:/\bRHINO FURY\b|ПРЕДТРЕН/i, portions:null, usesPerWeek:4, image:'/images/Rage/orange.png', needs:'Проверить массу упаковки и порцию на этикетке' },
  { id:'joint-support', name:'JOINT SUPPORT', pattern:/\bJOINT SUPPORT\b|ХОНДРОПРОТЕКТОР/i, portions:null, usesPerWeek:7, image:'/images/Joint Support.png', needs:'Указана доза 6 капсул, но не подтверждено количество капсул в банке' },
  { id:'omega-3-35', name:'OMEGA-3 35%', pattern:/\bOMEGA.?3\b|ОМЕГА/i, portions:null, usesPerWeek:7, image:'/images/Omega 3.png', needs:'Проверить число капсул и капсул на приём' },
]);
function policyForItem(item) {
  const name=String(item?.name||'');
  const id=String(item?.externalId||item?.productId||item?.id||'').toLowerCase();
  return PRODUCTS.find(p=>id.includes(p.id) || p.pattern.test(name))||null;
}
function estimateDays(product,quantity=1,perWeek=product.usesPerWeek){
  if(!product.portions || perWeek<=0 || perWeek>21)return null;
  // Multiply by actual jar quantity, assume daily or 4 workouts per week by policy.
  return Math.max(1,Math.ceil(product.portions*Math.max(1,Math.floor(Number(quantity)||1))*7/perWeek)-3);
}
function addDays(iso,days){
  const d=new Date(iso);
  if(!Number.isFinite(d.getTime()))return null;
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}
function getReplenishmentPlan(orders){
  const rows=[];
  for(const order of Array.isArray(orders)?orders:[]) {
    if(!(order?.paid===true || order?.paymentStatus==='succeeded'))continue;
    const orderId=String(order.orderId||order.publicOrderNumber||order.id||'').slice(0,120);
    const email=String(order.customer?.email||'').toLowerCase();
    if(!orderId || !email || !Array.isArray(order.items))continue;
    const purchasedAt=String(order.paidAt||order.createdAt||'');
    if(!purchasedAt)continue;
    // Fulfillment date where reliable, otherwise estimate delivery three days after payment.
    const deliveryKnown=Boolean(order.deliveredAt);
    const startDate=deliveryKnown?String(order.deliveredAt):addDays(purchasedAt,3);
    for(const item of order.items) {
      const policy=policyForItem(item);
      if(!policy)continue;
      const quantity=Math.min(100,Math.max(1,Math.floor(Number(item.quantity)||1)));
      const days=estimateDays(policy,quantity);
      rows.push({
        key:orderId+':'+policy.id+':'+String(item.flavor||'').slice(0,60),
        orderId,email,productId:policy.id,productName:policy.name,flavor:String(item.flavor||''),
        quantity,servingsPerPack:policy.portions,usesPerWeek:policy.usesPerWeek,
        intervalDays:days,notificationDate:days===null||!startDate?null:addDays(startDate,days),
        deliveryDateEstimated:!deliveryKnown,needs:policy.needs||null,
        status:days===null?'needs_product_data':'estimated'
      });
    }
  }
  return rows.sort((a,b)=>String(a.notificationDate||'9999').localeCompare(String(b.notificationDate||'9999'))).slice(0,1000);
}
module.exports={PRODUCTS,policyForItem,estimateDays,getReplenishmentPlan};
