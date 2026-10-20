'use strict';
const {cents,guid,validate,fromLocal}=require('./rtn-onec-orders');
const str=x=>String(x??'').trim();
// Resolve an unlinked Bitrix product only when its full name uniquely matches
// a confirmed 1C product. Never substitute a different flavour or SKU.
const normalizeProductName=x=>str(x).normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g,' ');
function verifiedProductByName(name, productMap) {
    const target=normalizeProductName(name);
    if(!target)return null;
    const matches=Object.values(productMap||{}).filter(item=>normalizeProductName(item.name)===target && guid(item.id));
    return matches.length===1?matches[0]:null;
}
const need=(ok,message)=>{if(!ok)throw new Error(message);};

// Only read methods: unlike the old paid exporter, this does not create/update
// Bitrix fields, enum options, contacts, orders, payments or receipts.
function createCollector({bitrixCall,readLocalOrders,config}) {
    return async function collect() {
        const enumFields=await bitrixCall('crm.deal.userfield.list',{filter:{FIELD_NAME:'UF_CRM_RTN_PROMO_CODE'}});
        need(Array.isArray(enumFields),'invalid_promo_fields');
        const promoCodes={...config.promoCodes};
        for(const field of enumFields)for(const value of field.LIST||[])promoCodes[str(value.ID)]=str(value.VALUE);
        const local=readLocalOrders();
        need(Array.isArray(local),'invalid_local_order_store');
        const deals=[];let lastId=0;
        for(;;){
            const page=await bitrixCall('crm.deal.list',{order:{ID:'ASC'},filter:{ORIGINATOR_ID:'RTN.PRO','>ID':lastId},select:['*','UF_*'],start:0});
            need(Array.isArray(page),'invalid_bitrix_page');
            if(!page.length)break;
            const next=Math.max(...page.map(d=>Number(d.ID)));
            need(Number.isSafeInteger(next)&&next>lastId,'invalid_bitrix_pagination');
            deals.push(...page);lastId=next;
        }
        const byId=new Map();const conflicts=new Set();
        for(const d of deals){const id=str(d.ORIGIN_ID);if(!id)continue;if(byId.has(id))conflicts.add(id);else byId.set(id,{deal:d});}
        for(const l of local){const id=str(l.orderId);if(!id)continue;const entry=byId.get(id)||{};if(entry.local)conflicts.add(id);entry.local=l;byId.set(id,entry);}
        const orders=[],skipped=[];const products=new Map(),contacts=new Map();
        for(const [orderId,entry] of byId){
            if(conflicts.has(orderId)){skipped.push({orderId,reason:'duplicate_source_identity'});continue;}
            try {
                // A complete local snapshot has original prices, comment and SafeRoute IDs.
                if(entry.local?.items?.length){
                    const order=fromLocal(entry.local,config);
                    if(entry.deal){
                        need(order.amount===cents(entry.deal.OPPORTUNITY),'local_bitrix_total_conflict');
                        need(!str(entry.deal.UF_CRM_RTN_ORDER_NUMBER)||order.publicNumber===str(entry.deal.UF_CRM_RTN_ORDER_NUMBER),'local_bitrix_number_conflict');
                    }
                    orders.push(order);continue;
                }
                const d=entry.deal;need(d,'incomplete_local_order');
                need(d.ORIGINATOR_ID==='RTN.PRO','foreign_order_source');
                need(str(d.UF_CRM_RTN_ORDER_NUMBER),'missing_public_number');
                need(!d.CURRENCY_ID||d.CURRENCY_ID==='RUB','unsupported_currency');
                const contactId=str(d.CONTACT_ID);need(contactId&&contactId!=='0','incomplete_customer');
                if(!contacts.has(contactId))contacts.set(contactId,await bitrixCall('crm.contact.get',{id:contactId}));
                const contact=contacts.get(contactId);
                const customer={name:[contact.LAST_NAME,contact.NAME,contact.SECOND_NAME].filter(Boolean).join(' '),phone:contact.PHONE?.[0]?.VALUE||'',email:contact.EMAIL?.[0]?.VALUE||'',address:str(d.UF_CRM_RTN_DELIVERY_ADDRESS),city:''};
                const rows=await bitrixCall('crm.deal.productrows.get',{id:d.ID});need(Array.isArray(rows)&&rows.length,'missing_items');
                let shipping=0,deliveryMethod='';const lines=[];
                for(const row of rows){
                    const quantity=Number(row.QUANTITY);need(Number.isInteger(quantity)&&quantity>0,'invalid_quantity');
                    const price=Number(row.PRICE);need(Number.isFinite(price)&&price>=0,'invalid_price');
                    const total=cents(price*quantity);
                    const discount=cents(Number(row.DISCOUNT_SUM||0)*quantity);
                    const name=str(row.PRODUCT_NAME);
                    if(/^ДОСТАВКА\s*[—-]/i.test(name)){
                        need(guid(config.deliveryId),'unknown_delivery_guid');
                        deliveryMethod=name.replace(/^ДОСТАВКА\s*[—-]\s*/i,'');shipping+=total;
                        lines.push({id:config.deliveryId,catalogId:config.deliveryCatalogId||config.catalogId,name,quantity,total,discount,type:'Услуга'});continue;
                    }
                    const productId=str(row.PRODUCT_ID);
                    let mapped;
                    if(!productId||productId==='0'){
                        mapped=verifiedProductByName(name,config.productMap);
                        need(mapped,'missing_product_reference');
                    }else{
                        if(!products.has(productId))products.set(productId,await bitrixCall('catalog.product.get',{id:productId}));
                        const data=products.get(productId);const product=data.product||data.item||data;
                        const externalId=str(product.xmlId||product.XML_ID).replace(/^RTN:/i,'');
                        mapped=config.productMap[externalId];
                        need(mapped&&guid(mapped.id),'unknown_product_guid');
                    }
                    lines.push({id:mapped.id,catalogId:config.catalogId,name:mapped.name,quantity,total,discount,type:'Товар'});
                }
                // The charged delivery row is part of OPPORTUNITY; this custom field
                // may contain a later carrier quote. Preserve both, never rewrite totals.
                const deliveryCostMetadata=str(d.UF_CRM_RTN_DELIVERY_COST)?cents(d.UF_CRM_RTN_DELIVERY_COST):null;
                // Enum IDs are not promo codes. Resolve only through a verified map.
                const rawPromo=d.UF_CRM_RTN_PROMO_CODE;
                let promoCode='';
                if(rawPromo && !(Array.isArray(rawPromo)&&!rawPromo.length)){
                    const values=Array.isArray(rawPromo)?rawPromo:[rawPromo];
                    promoCode=values.map(value=>{const mapped=promoCodes[str(value)];need(mapped,'unresolved_promo_code');return mapped;}).join(', ');
                }
                orders.push(validate({orderId,publicNumber:str(d.UF_CRM_RTN_ORDER_NUMBER),createdAt:d.DATE_CREATE,amount:cents(d.OPPORTUNITY),lines,customer,
                    deliveryMethod,shipping,deliveryCostMetadata,promoCode,comment:str(d.UF_CRM_RTN_CLIENT_COMMENT),
                    integrationComment:str(d.COMMENTS).replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,''),
                    trackingNumber:str(d.UF_CRM_DELIVERYTRACK),trackingUrl:str(d.UF_CRM_DELIVERYURL),
                    paymentStatus:'',fulfillment:config.fulfillment||{},saferouteOrderId:'',saferouteCabinetId:''}));
            }catch(error){skipped.push({orderId,reason:error.message});}
        }
        for(const d of deals)if(!str(d.ORIGIN_ID))skipped.push({reason:'missing_external_id'});
        for(const l of local)if(!str(l.orderId))skipped.push({reason:'missing_external_id'});
        return {orders,skipped,sourceCounts:{local:local.length,bitrix:deals.length,unique:byId.size}};
    };
}
module.exports={createCollector};
