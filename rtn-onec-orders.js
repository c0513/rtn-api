'use strict';

const crypto = require('node:crypto');
const text = value => String(value ?? '').trim();
const guid = value => /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}(?:#[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})?$/i.test(text(value));
function requireValue(condition, reason) { if (!condition) throw new Error(reason); }
function cents(value) {
    requireValue(value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0, 'invalid_money');
    const result = Math.round(Number(value) * 100);
    requireValue(Number.isSafeInteger(result), 'money_overflow');
    return result;
}
function xml(value) {
    const s = String(value ?? '');
    requireValue(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(s), 'invalid_xml_character');
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const tag = (name, value) => `<${name}>${xml(value)}</${name}>`;
const money = value => (value / 100).toFixed(2);
const requisite = (name, value) => '<ЗначениеРеквизита>' + tag('Наименование', name) + tag('Значение', value) + '</ЗначениеРеквизита>';
function fingerprint(order) { return crypto.createHash('sha256').update(JSON.stringify(order)).digest('hex'); }

// Local checkout prices are BEFORE discount in the existing RTN checkout contract.
// Allocate the actual paid/payable total in integer kopecks, keeping delivery unchanged.
function fromLocal(source, config) {
    requireValue(text(source.orderId) && text(source.publicOrderNumber), 'missing_order_identity');
    requireValue(Array.isArray(source.items) && source.items.length, 'missing_items');
    const delivery = source.delivery || {};
    const shipping = cents(delivery.price ?? 0);
    const amount = cents(source.amount);
    const lines = source.items.map(item => {
        const mapped = config.productMap[text(item.externalId)];
        requireValue(mapped && guid(mapped.id), 'unknown_product_guid');
        const quantity = Number(item.quantity);
        requireValue(Number.isInteger(quantity) && quantity > 0, 'invalid_quantity');
        return { id: mapped.id, catalogId: config.catalogId, name: mapped.name, quantity, gross: cents(item.price) * quantity, type: 'Товар' };
    });
    const gross = lines.reduce((sum, line) => sum + line.gross, 0);
    const target = amount - shipping;
    requireValue(target >= 0 && target <= gross && (gross > 0 || target === 0), 'inconsistent_checkout_total');
    let allocated = 0;
    lines.forEach(line => { line.total = gross ? Math.floor(target * line.gross / gross) : 0; allocated += line.total; });
    const remainderOrder = lines.map((line,index)=>({index,remainder:gross ? (target*line.gross)%gross : 0})).sort((a,b)=>b.remainder-a.remainder||a.index-b.index);
    for(let n=0;n<target-allocated;n++)lines[remainderOrder[n].index].total++;
    lines.forEach(line=>{line.discount=line.gross-line.total;});
    if (shipping) {
        requireValue(guid(config.deliveryId), 'unknown_delivery_guid');
        lines.push({ id: config.deliveryId, catalogId: config.deliveryCatalogId || config.catalogId, name: 'Доставка ' + text(delivery.method), quantity: 1, total: shipping, discount: 0, type: 'Услуга' });
    }
    return validate({ orderId: text(source.orderId), publicNumber: text(source.publicOrderNumber), createdAt: source.createdAt,
        amount, lines, customer: { ...source.customer, address: text(delivery.address), city: text(delivery.city) },
        deliveryMethod: text(delivery.method), shipping, promoCode: text(source.promoCode), comment: text(source.comment),
        paymentStatus: text(source.paymentStatus), fulfillment: { store: delivery.originStore, city: delivery.originCity, address: delivery.originAddress },
        saferouteOrderId: text(delivery.saferouteOrderId), saferouteCabinetId: text(delivery.saferouteCabinetId) });
}

function validate(order) {
    requireValue(text(order.orderId) && text(order.publicNumber), 'missing_order_identity');
    requireValue(Number.isFinite(Date.parse(order.createdAt)), 'invalid_order_date');
    requireValue(text(order.customer?.name) && (text(order.customer?.phone) || text(order.customer?.email)), 'incomplete_customer');
    requireValue(Array.isArray(order.lines) && order.lines.length, 'missing_items');
    requireValue(Number.isSafeInteger(order.amount) && order.amount >= 0, 'invalid_total');
    let sum = 0;
    for (const line of order.lines) {
        requireValue(guid(line.id) && (!line.catalogId || guid(line.catalogId)), 'unknown_product_guid');
        requireValue(text(line.name) && ['Товар', 'Услуга'].includes(line.type), 'invalid_product');
        requireValue(Number.isInteger(line.quantity) && line.quantity > 0, 'invalid_quantity');
        requireValue(Number.isSafeInteger(line.total) && line.total >= 0, 'invalid_line_total');
        requireValue(Number.isSafeInteger(line.discount || 0) && (line.discount || 0) >= 0, 'invalid_discount');
        sum += line.total;
    }
    requireValue(sum === order.amount, 'line_document_total_mismatch');
    return order;
}

// Splitting a kopeck remainder into two lines avoids 3 * 33.33 != 100.00.
function exactPriceLines(line) {
    const low = Math.floor(line.total / line.quantity);
    const highCount = line.total % line.quantity;
    return [{ ...line, quantity: line.quantity - highCount, price: low }, { ...line, quantity: highCount, price: low + 1 }].filter(x => x.quantity);
}
function documentXml(order, config = {}) {
    validate(order);
    const localDate = new Date(Date.parse(order.createdAt) + 3 * 3600000).toISOString();
    const customer = order.customer;
    requireValue(!config.retailEnabled || guid(config.retailId), 'retail_customer_guid_required');
    const customerId = config.retailEnabled ? config.retailId : 'RTN-CUSTOMER-' + crypto.createHash('sha256').update(order.orderId).digest('hex').slice(0,32);
    const customerName = config.retailEnabled ? 'Розничный покупатель' : customer.name;
    const recipient = ['ФИО: '+customer.name, 'Телефон: '+text(customer.phone), 'Email: '+text(customer.email), 'Адрес: '+text(customer.address), 'Город: '+text(customer.city)].join('; ');
    const details = [
        ['Проведен', 'false'], ['RTN orderId', order.orderId], ['Номер заказа на сайте', order.publicNumber],
        ['ФИО получателя',customer.name], ['Телефон получателя',customer.phone], ['Email получателя',customer.email],
        ['Адрес доставки',customer.address], ['Способ доставки',order.deliveryMethod], ['Стоимость доставки',money(order.shipping || 0)],
        ['Промокод',order.promoCode], ['Сумма скидки',money(order.lines.reduce((n,l)=>n+(l.discount||0),0))],
        ['Статус оплаты на сайте (справочно)',order.paymentStatus],
        ['SafeRoute заказ',order.saferouteOrderId], ['SafeRoute кабинет',order.saferouteCabinetId],
        ['Стоимость доставки в CRM (справочно)',order.deliveryCostMetadata==null?'':money(order.deliveryCostMetadata)],
        ['Трек отправления',order.trackingNumber], ['Ссылка отслеживания',order.trackingUrl],
        ['Склад отгрузки',order.fulfillment?.store], ['Город отгрузки',order.fulfillment?.city], ['Адрес отгрузки',order.fulfillment?.address]
    ].filter(([,v])=>text(v)).map(([n,v])=>requisite(n,v)).join('');
    const lines = order.lines.flatMap(exactPriceLines).map(line => '<Товар>' + tag('Ид',line.id) + (line.catalogId?tag('ИдКаталога',line.catalogId):'') + tag('Наименование',line.name)
        + '<БазоваяЕдиница Код="796" НаименованиеПолное="Штука" МеждународноеСокращение="PCE">шт</БазоваяЕдиница>'
        + tag('ЦенаЗаЕдиницу',money(line.price)) + tag('Количество',line.quantity.toFixed(3)) + tag('Сумма',money(line.price*line.quantity))
        + '<ЗначенияРеквизитов>' + requisite('ВидНоменклатуры',line.type) + requisite('ТипНоменклатуры',line.type) + '</ЗначенияРеквизитов></Товар>').join('');
    const contacts = [['Телефон мобильный',customer.phone],['Почта',customer.email]].filter(([,v])=>text(v)).map(([n,v])=>'<Контакт>'+tag('Тип',n)+tag('Значение',v)+'</Контакт>').join('');
    return '<Документ>'+tag('Ид',order.orderId)+tag('Номер',order.publicNumber)+tag('Дата',localDate.slice(0,10))
        + '<ХозОперация>Заказ товара</ХозОперация><Роль>Продавец</Роль><Валюта>RUB</Валюта><Курс>1</Курс>'+tag('Сумма',money(order.amount))
        + '<Контрагенты><Контрагент>'+tag('Ид',customerId)+tag('Наименование',customerName)+'<Роль>Покупатель</Роль>'+tag('ПолноеНаименование',customerName)
        + (!config.retailEnabled && customer.address?'<Адрес>'+tag('Представление',customer.address)+'</Адрес>':'')
        + (!config.retailEnabled && contacts?'<Контакты>'+contacts+'</Контакты>':'')+'</Контрагент></Контрагенты>'
        + tag('Время',localDate.slice(11,19)) + tag('Комментарий',['Заказ RTN.PRO '+order.publicNumber,recipient,order.comment,order.integrationComment,order.promoCode?'Промокод: '+order.promoCode:'',order.deliveryMethod,order.saferouteOrderId?'SafeRoute: '+order.saferouteOrderId:''].filter(Boolean).join('; '))
        + '<Товары>'+lines+'</Товары><ЗначенияРеквизитов>'+details+'</ЗначенияРеквизитов></Документ>';
}
function commerceMl(orders, version='2.07', config={}) {
    requireValue(['2.07','2.08','2.10'].includes(version),'unsupported_commerceml_version');
    const namespace=version==='2.07'?'urn:1C.ru:commerceml_2':'urn:1C.ru:commerceml_210';
    return '<?xml version="1.0" encoding="UTF-8"?>\n<КоммерческаяИнформация xmlns="'+namespace+'" ВерсияСхемы="'+version+'" ДатаФормирования="'+new Date().toISOString().slice(0,19)+'">'+orders.map(o=>documentXml(o,config)).join('')+'</КоммерческаяИнформация>';
}

// Store.transaction must serialize across processes and commit before returning.
// A batch survives a restart and is replayed byte-for-byte until success.
function createExchange({store, collect, config={}}) {
    return {
        // One-time manually approved batch. Reuses the same durable acknowledgement
        // and never overrides an existing pending or delivered order.
        async queryApprovedManual(session, version, payload) {
            requireValue(payload && typeof payload.xml === 'string', 'manual_batch_missing');
            requireValue(Array.isArray(payload.orders) && payload.orders.length === 2, 'manual_batch_count_invalid');
            const pairs = [
                {orderId:'1791193530114-f5z3mx',publicNumber:'051020261245'},
                {orderId:'1792297958450-l30tlp',publicNumber:'181020260732'}
            ];
            requireValue(pairs.every((pair, i) => pair.orderId === payload.orders[i]?.orderId && pair.publicNumber === payload.orders[i]?.publicNumber),'manual_batch_identity_invalid');
            requireValue(payload.xml.includes('ВерсияСхемы="'+version+'"'),'manual_batch_version_invalid');
            for (const pair of pairs) {
                requireValue(payload.xml.includes('<Ид>'+pair.orderId+'</Ид>') && payload.xml.includes('<Номер>'+pair.publicNumber+'</Номер>'),'manual_batch_xml_identity_invalid');
            }
            const batch = await store.transaction(async state => {
                requireValue(state.version === 1 && state.reconciliation?.approved === true,'reconciliation_required');
                if (state.pending) {
                    requireValue(state.pending.orderIds.length===2 && pairs.every(p=>state.pending.orderIds.includes(p.orderId)),'another_exchange_pending');
                    return state.pending;
                }
                const completed = pairs.every(pair => Object.hasOwn(state.delivered||{},pair.orderId));
                if (completed) return {id:null,xml:commerceMl([],version,config),orderIds:[]};
                requireValue(pairs.every(pair => !Object.hasOwn(state.delivered||{},pair.orderId)),'manual_batch_partial_delivery');
                requireValue(pairs.every(pair => !Object.hasOwn(state.publicNumbers||{},pair.publicNumber)),'manual_batch_public_number_used');
                state.pending = {id:crypto.randomUUID(),xml:payload.xml,orderIds:pairs.map(p=>p.orderId),orderRefs:pairs,createdAt:new Date().toISOString()};
                return state.pending;
            });
            session.rtnOrderBatch = batch.id;
            return batch;
        },
        async recordVerifiedPayment(payment, checkout) {
            requireValue(payment?.status==='succeeded' && payment?.paid===true,'payment_not_succeeded');
            requireValue(payment?.amount?.currency==='RUB','payment_currency_invalid');
            const id=text(payment.metadata?.orderId);
            const pid=text(payment.id);
            requireValue(id && pid,'payment_identity_missing');
            const amount=cents(payment.amount.value);
            requireValue(amount>0,'payment_amount_invalid');
            requireValue(checkout && checkout.orderId===id,'verified_checkout_snapshot_missing');
            const order=fromLocal(checkout,config);
            requireValue(order.amount===amount,'verified_checkout_amount_mismatch');
            return store.transaction(async state=>{
                requireValue(state.version===1,'onec_state_not_initialized');
                state.verifiedSitePayments ||= {};
                const previous=state.verifiedSitePayments[id];
                requireValue(!previous || (previous.paymentId===pid && previous.amount===amount),'verified_payment_conflict');
                state.verifiedSitePayments[id]={paymentId:pid,amount,verifiedAt:new Date().toISOString()};
                state.verifiedOrders ||= {};
                state.verifiedOrders[id]=order;
                return true;
            });
        },
        async query(session,version) {
            const result=await store.transaction(async state=>{
                requireValue(state.version===1 && state.reconciliation?.approved===true,'reconciliation_required');
                if(state.pending)return state.pending;
                // Source is the site's durable paid-order ledger, never Bitrix24.
                const orders=Object.values(state.verifiedOrders||{});
                const skipped=[];
                const ready=[];const seen=new Set();const duplicate=new Set();
                for(const order of orders){if(seen.has(order.orderId))duplicate.add(order.orderId);seen.add(order.orderId);}
                const publicIds=new Map();
                for(const order of orders){const previous=publicIds.get(order.publicNumber);if(previous&&previous!==order.orderId){duplicate.add(previous);duplicate.add(order.orderId);}publicIds.set(order.publicNumber,order.orderId);}
                for(const order of orders){
                    const id=order.orderId;const decision=state.reconciliation.orders[id];
                    if(duplicate.has(id)){skipped.push({orderId:id,reason:'duplicate_source_identity'});continue;}
                    const prior=state.publicNumbers && Object.hasOwn(state.publicNumbers,order.publicNumber)?state.publicNumbers[order.publicNumber]:null;
                    if(prior&&prior!==id){skipped.push({orderId:id,reason:'public_number_identity_conflict'});continue;}
                    if(Object.hasOwn(state.delivered,id)||decision?.status==='existing'){skipped.push({orderId:id,reason:'already_present'});continue;}
                    const reviewed=decision?.status==='missing' && decision.fingerprint===fingerprint(order);
                    const cutoff = config.newPaidAfter && Date.parse(config.newPaidAfter);
                    const newOrder=!decision && ((state.reconciliation.allowNewAfter && Date.parse(order.createdAt)>Date.parse(state.reconciliation.allowNewAfter)) || (Number.isFinite(cutoff) && Date.parse(order.createdAt)>cutoff));
                    if(!reviewed&&!newOrder){skipped.push({orderId:id,reason:'manual_reconciliation_required'});continue;}
                    const proof=state.verifiedSitePayments?.[id];
                    if(!proof || proof.amount!==order.amount || !proof.paymentId){skipped.push({orderId:id,reason:'no_site_verified_payment_for_exact_amount'});continue;}
                    try{documentXml(order,config);ready.push(order);}catch(e){skipped.push({orderId:id,reason:e.message});}
                }
                state.lastReport={at:new Date().toISOString(),candidates:orders.length,exported:ready.length,skipped};
                if(!ready.length)return {id:null,xml:commerceMl([],version,config),orderIds:[]};
                state.pending={id:crypto.randomUUID(),xml:commerceMl(ready,version,config),orderIds:ready.map(o=>o.orderId),orderRefs:ready.map(o=>({orderId:o.orderId,publicNumber:o.publicNumber})),createdAt:new Date().toISOString()};
                return state.pending;
            });
            session.rtnOrderBatch=result.id;
            return result;
        },
        async success(session){
            const batchId=session.rtnOrderBatch;
            if(!batchId)return;
            await store.transaction(async state=>{
                if(state.lastAcknowledged===batchId)return;
                requireValue(state.pending?.id===batchId,'stale_exchange_acknowledgement');
                for(const id of state.pending.orderIds)Object.defineProperty(state.delivered,id,{value:{acknowledgedAt:new Date().toISOString(),batchId},enumerable:true,writable:true,configurable:true});
                state.publicNumbers ||= {};
                for(const ref of state.pending.orderRefs||[])Object.defineProperty(state.publicNumbers,ref.publicNumber,{value:ref.orderId,enumerable:true,writable:true,configurable:true});
                state.lastAcknowledged=batchId;state.pending=null;
            });
            delete session.rtnOrderBatch;
        }
    };
}
module.exports={cents,guid,validate,fromLocal,fingerprint,documentXml,commerceMl,createExchange};
