const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// НАСТРОЙКИ
// ============================================================

const CDEK_ACCOUNT = process.env.CDEK_ACCOUNT;
const CDEK_SECRET = process.env.CDEK_SECRET;

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rtn.pro';

const BITRIX_WEBHOOK_URL =
    (process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');

const BITRIX_CATEGORY_ID =
    Number(process.env.BITRIX_CATEGORY_ID || 0);

const BITRIX_STAGE_NEW =
    process.env.BITRIX_STAGE_NEW || 'NEW';

const BITRIX_STAGE_PAID =
    process.env.BITRIX_STAGE_PAID || 'PREPARATION';

const BITRIX_CATALOG_IBLOCK_ID =
    Number(process.env.BITRIX_CATALOG_IBLOCK_ID || 0);

const BITRIX_ASSIGNED_BY_ID =
    Number(process.env.BITRIX_ASSIGNED_BY_ID || 0);

const CDEK_API = 'https://api.cdek.ru/v2';


// ============================================================
// BITRIX24
// ============================================================

function isBitrixConfigured() {
    return Boolean(BITRIX_WEBHOOK_URL);
}

async function bitrixCall(method, params = {}) {
    if (!isBitrixConfigured()) {
        throw new Error('BITRIX_WEBHOOK_URL не настроен');
    }

    const response = await axios.post(
        `${BITRIX_WEBHOOK_URL}/${method}.json`,
        params,
        {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000
        }
    );

    if (response.data?.error) {
        const description =
            response.data?.error_description ||
            response.data?.error ||
            'Bitrix24 API error';

        throw new Error(description);
    }

    return response.data?.result;
}


const RTN_PRODUCTS = [
    { externalId: 'whey-caramel', name: 'WHEY PRO', flavor: 'СОЛЁНАЯ КАРАМЕЛЬ', price: 2990 },
    { externalId: 'whey-lemon', name: 'WHEY PRO', flavor: 'ЛИМОННЫЙ МУСС', price: 2990 },
    { externalId: 'whey-raspberry', name: 'WHEY PRO', flavor: 'МАЛИНА В БЕЛОМ ШОКОЛАДЕ', price: 2990 },

    { externalId: 'mass-choco', name: 'MASS GAINER', flavor: 'ШОКОЛАД', price: 4190 },
    { externalId: 'mass-lemon', name: 'MASS GAINER', flavor: 'ЛИМОННЫЙ МУСС', price: 4190 },
    { externalId: 'mass-caramel', name: 'MASS GAINER', flavor: 'СОЛЁНАЯ КАРАМЕЛЬ', price: 4190 },
    { externalId: 'mass-raspberry', name: 'MASS GAINER', flavor: 'МАЛИНА В БЕЛОМ ШОКОЛАДЕ', price: 4190 },

    { externalId: 'pre-cola', name: 'PREWORKOUT', flavor: 'МАРМЕЛАДНАЯ КОЛА', price: 1990 },
    { externalId: 'pre-orange', name: 'PREWORKOUT', flavor: 'АПЕЛЬСИН', price: 1990 },
    { externalId: 'pre-bubblegum', name: 'PREWORKOUT', flavor: 'БАБЛ-ГАМ', price: 1990 },

    { externalId: 'creatine-orange', name: 'CREATINE', flavor: 'АПЕЛЬСИН', price: 1390 },
    { externalId: 'creatine-wildberries', name: 'CREATINE', flavor: 'ЛЕСНЫЕ ЯГОДЫ', price: 1390 },
    { externalId: 'creatine-apple', name: 'CREATINE', flavor: 'ЯБЛОКО', price: 1390 },
    { externalId: 'creatine-neutral', name: 'CREATINE', flavor: 'БЕЗ ВКУСА', price: 1390 },

    { externalId: 'bcaa-wildberries', name: 'BCAA', flavor: 'ЛЕСНЫЕ ЯГОДЫ', price: 1190 },
    { externalId: 'bcaa-lime', name: 'BCAA', flavor: 'ЛИМОН-ЛАЙМ', price: 1190 },
    { externalId: 'bcaa-grapefruit', name: 'BCAA', flavor: 'ГРЕЙПФРУТ', price: 1190 },
    { externalId: 'bcaa-currant', name: 'BCAA', flavor: 'ЧЁРНАЯ СМОРОДИНА', price: 1190 },

    { externalId: 'arg-wildberries', name: 'AAKG', flavor: 'ЛЕСНЫЕ ЯГОДЫ', price: 1090 },
    { externalId: 'arg-lime', name: 'AAKG', flavor: 'ЛИМОН-ЛАЙМ', price: 1090 },
    { externalId: 'arg-grapefruit', name: 'AAKG', flavor: 'ГРЕЙПФРУТ', price: 1090 },
    { externalId: 'arg-currant', name: 'AAKG', flavor: 'ЧЁРНАЯ СМОРОДИНА', price: 1090 },

    { externalId: 'amylo-neutral', name: 'AMYLOPECTIN', flavor: 'БЕЗ ВКУСА', price: 890 },
    { externalId: 'magnesium-caps', name: 'MAGNESIUM', flavor: 'ГЛИЦИНАТ, 120 КАПСУЛ', price: 890 },
    { externalId: 'chondro-caps', name: 'JOINT SUPPORT', flavor: '120 КАПСУЛ', price: 1590 },
    { externalId: 'omega3-caps', name: 'OMEGA-3', flavor: '90 КАПСУЛ', price: 790 }
];

const BITRIX_PRODUCT_XML_PREFIX = 'RTN:';
const bitrixProductIdCache = new Map();
let bitrixCatalogContextPromise = null;
let bitrixStartupSyncPromise = null;

function normalizeProductText(value) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/Ё/g, 'Е')
        .replace(/\s+/g, ' ');
}

function productDisplayName(product) {
    return `${product.name} — ${product.flavor}`;
}

function productXmlId(externalId) {
    return `${BITRIX_PRODUCT_XML_PREFIX}${externalId}`;
}

function productCode(externalId) {
    return `rtn-${String(externalId || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 90)}`;
}

function findRtnProductForOrderItem(item = {}) {
    const externalId = String(
        item.externalId ||
        item.productExternalId ||
        item.id ||
        ''
    ).trim();

    if (externalId) {
        const exact = RTN_PRODUCTS.find(
            product => product.externalId === externalId
        );
        if (exact) return exact;
    }

    const itemName = normalizeProductText(item.name);
    const itemFlavor = normalizeProductText(item.flavor);

    const aliases = {
        'ПРЕДТРЕН': 'PREWORKOUT',
        'ПРЕДТРЕН RAGE': 'PREWORKOUT',
        'КРЕАТИН': 'CREATINE',
        'БЦАА': 'BCAA',
        'АРГИНИН ААКГ': 'AAKG',
        'АРГИНИН': 'AAKG',
        'АМИЛОПЕКТИН': 'AMYLOPECTIN',
        'МАГНИЙ': 'MAGNESIUM',
        'ХОНДРОПРОТЕКТОР': 'JOINT SUPPORT',
        'ОМЕГА-3': 'OMEGA-3'
    };

    const normalizedName = aliases[itemName] || itemName;

    return RTN_PRODUCTS.find(product => {
        if (normalizeProductText(product.name) !== normalizedName) {
            return false;
        }

        if (!itemFlavor) {
            return true;
        }

        return normalizeProductText(product.flavor) === itemFlavor;
    }) || null;
}

async function getBitrixCatalogContext() {
    if (bitrixCatalogContextPromise) {
        return bitrixCatalogContextPromise;
    }

    bitrixCatalogContextPromise = (async () => {
        const catalogsResult = await bitrixCall(
            'catalog.catalog.list',
            {
                select: ['id', 'iblockId', 'name', 'productIblockId'],
                order: { id: 'asc' }
            }
        );

        const catalogs =
            catalogsResult?.catalogs ||
            (Array.isArray(catalogsResult) ? catalogsResult : []);

        if (!catalogs.length) {
            throw new Error('Bitrix24 не вернул торговый каталог');
        }

        let catalog = null;

        if (BITRIX_CATALOG_IBLOCK_ID > 0) {
            catalog = catalogs.find(
                item => Number(item.iblockId) === BITRIX_CATALOG_IBLOCK_ID
            );
        }

        if (!catalog) {
            catalog =
                catalogs.find(item => !Number(item.productIblockId || 0)) ||
                catalogs[0];
        }

        const iblockId = Number(catalog.iblockId);

        if (!iblockId) {
            throw new Error('Не удалось определить iblockId каталога Bitrix24');
        }

        const priceTypesResult = await bitrixCall(
            'catalog.priceType.list',
            {
                select: ['id', 'name', 'base'],
                order: { id: 'asc' }
            }
        );

        const priceTypes =
            priceTypesResult?.priceTypes ||
            (Array.isArray(priceTypesResult) ? priceTypesResult : []);

        if (!priceTypes.length) {
            throw new Error('В Bitrix24 не найден тип цены');
        }

        const priceType =
            priceTypes.find(item => item.base === 'Y') ||
            priceTypes[0];

        return {
            iblockId,
            catalogGroupId: Number(priceType.id),
            catalogName: catalog.name || '',
            priceTypeName: priceType.name || ''
        };
    })().catch(error => {
        bitrixCatalogContextPromise = null;
        throw error;
    });

    return bitrixCatalogContextPromise;
}

async function findBitrixCatalogProductByExternalId(externalId, iblockId) {
    const result = await bitrixCall(
        'catalog.product.list',
        {
            select: ['id', 'iblockId', 'name', 'xmlId'],
            filter: {
                iblockId,
                xmlId: productXmlId(externalId)
            },
            order: { id: 'asc' },
            start: 0
        }
    );

    const products = result?.products || [];
    return products[0] || null;
}

async function upsertBitrixProductPrice({ productId, catalogGroupId, price }) {
    const result = await bitrixCall(
        'catalog.price.list',
        {
            select: ['id', 'productId', 'catalogGroupId', 'price', 'currency'],
            filter: {
                productId,
                catalogGroupId
            },
            order: { id: 'asc' }
        }
    );

    const prices = result?.prices || [];
    const existing = prices[0];

    const fields = {
        productId,
        catalogGroupId,
        price: Number(price),
        currency: 'RUB'
    };

    if (existing?.id) {
        await bitrixCall(
            'catalog.price.update',
            {
                id: Number(existing.id),
                fields
            }
        );
        return Number(existing.id);
    }

    const added = await bitrixCall(
        'catalog.price.add',
        { fields }
    );

    return Number(added?.price?.id || added?.id || 0);
}

async function ensureBitrixCatalogProduct(rtnProduct) {
    if (!rtnProduct) return null;

    const cachedId = bitrixProductIdCache.get(rtnProduct.externalId);
    if (cachedId) return cachedId;

    const { iblockId, catalogGroupId } =
        await getBitrixCatalogContext();

    const existing =
        await findBitrixCatalogProductByExternalId(
            rtnProduct.externalId,
            iblockId
        );

    let productId = existing?.id ? Number(existing.id) : 0;

    const fields = {
        name: productDisplayName(rtnProduct),
        active: 'Y',
        code: productCode(rtnProduct.externalId),
        xmlId: productXmlId(rtnProduct.externalId),
        canBuyZero: 'Y',
        detailText:
            `Товар интернет-магазина RTN.PRO. ${rtnProduct.name}, вариант: ${rtnProduct.flavor}.`,
        detailTextType: 'text'
    };

    if (productId) {
        await bitrixCall(
            'catalog.product.update',
            {
                id: productId,
                fields
            }
        );
    } else {
        const added = await bitrixCall(
            'catalog.product.add',
            {
                fields: {
                    iblockId,
                    ...fields
                }
            }
        );

        productId = Number(
            added?.element?.id ||
            added?.product?.id ||
            0
        );

        if (!productId) {
            throw new Error(
                `Bitrix24 не вернул ID товара ${rtnProduct.externalId}`
            );
        }
    }

    await upsertBitrixProductPrice({
        productId,
        catalogGroupId,
        price: rtnProduct.price
    });

    bitrixProductIdCache.set(rtnProduct.externalId, productId);
    return productId;
}

async function syncAllRtnProductsToBitrix() {
    if (!isBitrixConfigured()) {
        return { createdOrUpdated: 0, failed: 0 };
    }

    if (bitrixStartupSyncPromise) {
        return bitrixStartupSyncPromise;
    }

    bitrixStartupSyncPromise = (async () => {
        const context = await getBitrixCatalogContext();

        console.log(
            `Bitrix24 catalog sync: iblock=${context.iblockId}, priceType=${context.catalogGroupId}`
        );

        let createdOrUpdated = 0;
        let failed = 0;

        for (const product of RTN_PRODUCTS) {
            try {
                await ensureBitrixCatalogProduct(product);
                createdOrUpdated += 1;
            } catch (error) {
                failed += 1;
                console.error(
                    `Bitrix24 product sync failed [${product.externalId}]:`,
                    error.response?.data || error.message
                );
            }
        }

        console.log(
            `Bitrix24 product sync finished: ${createdOrUpdated} ok, ${failed} failed`
        );

        return { createdOrUpdated, failed };
    })().finally(() => {
        bitrixStartupSyncPromise = null;
    });

    return bitrixStartupSyncPromise;
}

function normalizeBitrixPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');

    if (!digits) return '';

    if (digits.length === 11 && digits.startsWith('8')) {
        return `+7${digits.slice(1)}`;
    }

    if (digits.length === 11 && digits.startsWith('7')) {
        return `+${digits}`;
    }

    if (digits.length === 10) {
        return `+7${digits}`;
    }

    return value || '';
}

async function findBitrixContactId(phone, email) {
    const normalizedPhone = normalizeBitrixPhone(phone);

    if (normalizedPhone) {
        const byPhone = await bitrixCall(
            'crm.duplicate.findbycomm',
            {
                type: 'PHONE',
                values: [normalizedPhone],
                entity_type: 'CONTACT'
            }
        );

        const ids =
            byPhone?.CONTACT ||
            byPhone?.contact ||
            [];

        if (Array.isArray(ids) && ids.length) {
            return Number(ids[0]);
        }
    }

    if (email) {
        const byEmail = await bitrixCall(
            'crm.duplicate.findbycomm',
            {
                type: 'EMAIL',
                values: [email],
                entity_type: 'CONTACT'
            }
        );

        const ids =
            byEmail?.CONTACT ||
            byEmail?.contact ||
            [];

        if (Array.isArray(ids) && ids.length) {
            return Number(ids[0]);
        }
    }

    return null;
}

async function getOrCreateBitrixContact(customer = {}) {
    const existingId =
        await findBitrixContactId(
            customer.phone,
            customer.email
        );

    if (existingId) {
        return existingId;
    }

    const fm = [];

    const phone =
        normalizeBitrixPhone(customer.phone);

    if (phone) {
        fm.push({
            typeId: 'PHONE',
            valueType: 'MOBILE',
            value: phone
        });
    }

    if (customer.email) {
        fm.push({
            typeId: 'EMAIL',
            valueType: 'WORK',
            value: customer.email
        });
    }

    const result = await bitrixCall(
        'crm.item.add',
        {
            entityTypeId: 3,
            fields: {
                name:
                    customer.name ||
                    'Покупатель RTN.PRO',

                sourceId: 'WEB',

                sourceDescription:
                    'Интернет-магазин RTN.PRO',

                fm
            }
        }
    );

    return Number(result?.item?.id);
}

async function findExistingBitrixDeal(orderId) {
    if (!orderId) return null;

    const result = await bitrixCall(
        'crm.item.list',
        {
            entityTypeId: 2,
            select: ['id'],
            filter: {
                originatorId: 'RTN.PRO',
                originId: String(orderId)
            }
        }
    );

    const item =
        Array.isArray(result?.items)
            ? result.items[0]
            : null;

    return item?.id
        ? Number(item.id)
        : null;
}

function buildBitrixDealComment({
    orderId,
    customer,
    delivery,
    items,
    comment,
    amount
}) {
    const lines = [
        `Заказ с сайта RTN.PRO #${orderId || 'без номера'}`,
        '',
        `Сумма заказа: ${Number(amount || 0).toLocaleString('ru-RU')} ₽`,
        `Клиент: ${customer?.name || '—'}`,
        `Телефон: ${customer?.phone || '—'}`,
        `Email: ${customer?.email || '—'}`,
        '',
        `Доставка: ${delivery?.method || '—'}`,
        `Адрес / ПВЗ: ${delivery?.address || '—'}`,
        `Стоимость доставки: ${Number(delivery?.price || 0).toLocaleString('ru-RU')} ₽`,
        '',
        'Состав заказа:'
    ];

    (Array.isArray(items) ? items : []).forEach((item, index) => {
        lines.push(
            `${index + 1}. ${item?.name || 'Товар'}${item?.flavor ? ` — ${item.flavor}` : ''} × ${Number(item?.quantity || 1)} = ${Number(item?.price || 0).toLocaleString('ru-RU')} ₽/шт.`
        );
    });

    if (comment) {
        lines.push('', `Комментарий клиента: ${comment}`);
    }

    lines.push('', 'Статус оплаты: ожидает оплаты');

    return lines.join('\n');
}

async function buildBitrixProductRows(items, delivery) {
    const rows = [];
    const sourceItems = Array.isArray(items) ? items : [];

    for (let index = 0; index < sourceItems.length; index += 1) {
        const item = sourceItems[index];

        const price = Number(item?.price || 0);
        const quantity = Math.max(1, Number(item?.quantity || 1));

        if (!Number.isFinite(price) || price < 0) {
            continue;
        }

        let productId = null;

        try {
            const rtnProduct = findRtnProductForOrderItem(item);

            if (rtnProduct) {
                productId =
                    await ensureBitrixCatalogProduct(rtnProduct);
            }
        } catch (error) {
            console.error(
                'Bitrix24 product binding error:',
                error.response?.data || error.message
            );
        }

        const row = {
            price,
            quantity,
            sort: (index + 1) * 10
        };

        if (productId) {
            row.productId = productId;
        } else {
            row.productName =
                `${item?.name || 'Товар'}${item?.flavor ? ` — ${item.flavor}` : ''}`;
        }

        rows.push(row);
    }

    const deliveryPrice = Number(delivery?.price || 0);

    if (Number.isFinite(deliveryPrice) && deliveryPrice > 0) {
        rows.push({
            productName: `Доставка — ${delivery?.method || 'СДЭК'}`,
            price: deliveryPrice,
            quantity: 1,
            sort: (rows.length + 1) * 10
        });
    }

    return rows;
}

async function syncOrderToBitrix({
    orderId,
    amount,
    items,
    customer,
    delivery,
    comment
}) {
    if (!isBitrixConfigured()) {
        console.warn(
            'Bitrix24 integration skipped: BITRIX_WEBHOOK_URL is empty'
        );

        return null;
    }

    const existingDealId =
        await findExistingBitrixDeal(orderId);

    if (existingDealId) {
        try {
            const productRows =
                await buildBitrixProductRows(items, delivery);

            if (productRows.length) {
                await bitrixCall(
                    'crm.item.productrow.set',
                    {
                        ownerType: 'D',
                        ownerId: existingDealId,
                        productRows
                    }
                );
            }
        } catch (error) {
            console.error(
                'Bitrix24 retry product rows error:',
                error.response?.data || error.message
            );
        }

        return existingDealId;
    }

    const contactId =
        await getOrCreateBitrixContact(customer);

    const fields = {
        title:
            `RTN.PRO заказ #${orderId || Date.now()}`,

        categoryId:
            BITRIX_CATEGORY_ID,

        opportunity:
            Number(amount || 0),

        currencyId:
            'RUB',

        isManualOpportunity:
            'Y',

        sourceId:
            'WEB',

        sourceDescription:
            'Интернет-магазин RTN.PRO',

        originatorId:
            'RTN.PRO',

        originId:
            String(orderId || Date.now()),

        comments:
            buildBitrixDealComment({
                orderId,
                customer,
                delivery,
                items,
                comment,
                amount
            })
    };

    if (contactId) {
        fields.contactIds = [contactId];
    }

    if (BITRIX_STAGE_NEW) {
        fields.stageId =
            BITRIX_STAGE_NEW;
    }

    if (BITRIX_ASSIGNED_BY_ID > 0) {
        fields.assignedById =
            BITRIX_ASSIGNED_BY_ID;
    }

    const dealResult =
        await bitrixCall(
            'crm.item.add',
            {
                entityTypeId: 2,
                fields
            }
        );

    const dealId =
        Number(dealResult?.item?.id);

    if (!dealId) {
        throw new Error(
            'Bitrix24 не вернул ID сделки'
        );
    }

    const productRows =
        await buildBitrixProductRows(
            items,
            delivery
        );

    if (productRows.length) {
        try {
            await bitrixCall(
                'crm.item.productrow.set',
                {
                    ownerType: 'D',
                    ownerId: dealId,
                    productRows
                }
            );
        } catch (error) {
            // Сделку не удаляем, даже если товарные позиции не записались.
            console.error(
                'Bitrix24 product rows error:',
                error.message
            );
        }
    }

    return dealId;
}

async function markBitrixPaymentCreated(
    dealId,
    payment
) {
    if (!dealId || !payment) return;

    const confirmationUrl =
        payment?.confirmation
            ?.confirmation_url ||
        '';

    const info = [
        `ЮKassa payment ID: ${payment?.id || '—'}`,
        `Статус ЮKassa: ${payment?.status || '—'}`,
        confirmationUrl
            ? `Ссылка на оплату: ${confirmationUrl}`
            : ''
    ].filter(Boolean).join('\n');

    await bitrixCall(
        'crm.item.update',
        {
            entityTypeId: 2,
            id: dealId,
            fields: {
                additionalInfo: info
            }
        }
    );
}

async function getYooKassaPayment(paymentId) {
    if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
        throw new Error('ЮKassa credentials не настроены');
    }

    const response = await axios.get(
        `https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`,
        {
            auth: {
                username: YOOKASSA_SHOP_ID,
                password: YOOKASSA_SECRET_KEY
            },
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 12000
        }
    );

    return response.data;
}

async function moveBitrixDealToPaid({ dealId, payment }) {
    if (!dealId) {
        throw new Error('Не удалось определить сделку Bitrix24');
    }

    const info = [
        `ЮKassa payment ID: ${payment?.id || '—'}`,
        `Статус ЮKassa: ${payment?.status || '—'}`,
        `Оплачен: ${payment?.paid ? 'да' : 'нет'}`,
        `Сумма: ${payment?.amount?.value || '—'} ${payment?.amount?.currency || ''}`.trim()
    ].join('\n');

    const fields = {
        additionalInfo: info
    };

    if (BITRIX_STAGE_PAID) {
        fields.stageId = BITRIX_STAGE_PAID;
    }

    await bitrixCall(
        'crm.item.update',
        {
            entityTypeId: 2,
            id: Number(dealId),
            fields
        }
    );
}

app.post('/api/yookassa/webhook', async (req, res) => {
    try {
        const event = req.body?.event;
        const notifiedPayment = req.body?.object;

        if (event !== 'payment.succeeded') {
            return res.status(200).json({
                ok: true,
                ignored: true
            });
        }

        const paymentId = notifiedPayment?.id;

        if (!paymentId) {
            return res.status(400).json({
                error: 'В уведомлении нет payment id'
            });
        }

        // Проверяем платеж повторным запросом к ЮKassa,
        // а не доверяем одному только телу webhook.
        const payment =
            await getYooKassaPayment(paymentId);

        if (
            payment?.status !== 'succeeded' ||
            payment?.paid !== true
        ) {
            return res.status(409).json({
                error: 'Статус платежа не подтвержден ЮKassa'
            });
        }

        let dealId =
            Number(payment?.metadata?.bitrixDealId || 0);

        if (!dealId) {
            const orderId = payment?.metadata?.orderId;

            if (orderId) {
                dealId =
                    await findExistingBitrixDeal(orderId);
            }
        }

        if (!dealId) {
            throw new Error(
                'Сделка Bitrix24 для платежа не найдена'
            );
        }

        await moveBitrixDealToPaid({
            dealId,
            payment
        });

        console.log(
            `YooKassa payment ${paymentId}: Bitrix24 deal ${dealId} moved to ${BITRIX_STAGE_PAID}`
        );

        return res.status(200).json({
            ok: true
        });

    } catch (error) {
        console.error(
            'YooKassa webhook error:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            error: 'Не удалось обработать уведомление ЮKassa'
        });
    }
});


// ============================================================
// CDEK TOKEN
// ============================================================

let cdekToken = null;
let cdekTokenExpiresAt = 0;
let cdekTokenPromise = null;

async function getCdekToken() {
    const now = Date.now();

    if (cdekToken && now < cdekTokenExpiresAt - 60000) {
        return cdekToken;
    }

    // Не запускаем несколько OAuth-запросов одновременно:
    // health/search/calculate могут прийти почти в один момент после cold start Render.
    if (cdekTokenPromise) {
        return cdekTokenPromise;
    }

    cdekTokenPromise = axios.post(
        `${CDEK_API}/oauth/token`,
        new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: CDEK_ACCOUNT,
            client_secret: CDEK_SECRET
        }),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 7000
        }
    ).then(response => {
        cdekToken = response.data.access_token;
        cdekTokenExpiresAt =
            Date.now() + ((response.data.expires_in || 3600) * 1000);

        return cdekToken;
    }).finally(() => {
        cdekTokenPromise = null;
    });

    return cdekTokenPromise;
}

// ============================================================
// КЭШ
// ============================================================

const cityCache = new Map();
const CITY_CACHE_TTL = 10 * 60 * 1000;

function getCached(cache, key) {
    const value = cache.get(key);

    if (!value) return null;

    if (Date.now() - value.time > CITY_CACHE_TTL) {
        cache.delete(key);
        return null;
    }

    return value.data;
}

function setCached(cache, key, data) {
    cache.set(key, {
        time: Date.now(),
        data
    });
}


// ============================================================
// CDEK TARIFF META CACHE
// ============================================================

let tariffModeMap = new Map();
let tariffModeExpiresAt = 0;
let tariffModePromise = null;

async function getTariffModeMap(token) {
    const now = Date.now();

    if (tariffModeMap.size && now < tariffModeExpiresAt) {
        return tariffModeMap;
    }

    if (tariffModePromise) {
        return tariffModePromise;
    }

    tariffModePromise = axios.get(
        `${CDEK_API}/calculator/alltariffs`,
        {
            headers: {
                Authorization: `Bearer ${token}`
            },
            params: {
                lang: 'rus'
            },
            timeout: 6000
        }
    ).then(response => {
        const map = new Map();
        const tariffGroups = response.data?.tariff_codes || [];

        tariffGroups.forEach(group => {
            // Текущий формат alltariffs:
            // tariff -> delivery_modes[] -> tariff_code + delivery_mode.
            if (Array.isArray(group.delivery_modes)) {
                group.delivery_modes.forEach(mode => {
                    const code = Number(mode.tariff_code);
                    const deliveryMode = Number(mode.delivery_mode);

                    if (code && deliveryMode) {
                        map.set(code, deliveryMode);
                    }
                });
            }

            // Обратная совместимость со старым плоским форматом.
            const flatCode = Number(group.tariff_code);
            const flatMode = Number(group.delivery_mode);

            if (flatCode && flatMode) {
                map.set(flatCode, flatMode);
            }
        });

        tariffModeMap = map;
        tariffModeExpiresAt = Date.now() + 12 * 60 * 60 * 1000;

        return tariffModeMap;
    }).catch(error => {
        console.warn(
            'CDEK alltariffs warning:',
            error.response?.data || error.message
        );

        // Расчёт всё равно попробуем выполнить:
        // часть ответов tarifflist содержит delivery_mode непосредственно.
        return new Map();
    }).finally(() => {
        tariffModePromise = null;
    });

    return tariffModePromise;
}

const deliveryCache = new Map();
const DELIVERY_CACHE_TTL = 10 * 60 * 1000;

function getDeliveryCached(key) {
    const value = deliveryCache.get(key);

    if (!value) return null;

    if (Date.now() - value.time > DELIVERY_CACHE_TTL) {
        deliveryCache.delete(key);
        return null;
    }

    return value.data;
}

function setDeliveryCached(key, data) {
    deliveryCache.set(key, {
        time: Date.now(),
        data
    });
}

// ============================================================
// HEALTH
// ============================================================

app.get('/api/health', (req, res) => {
    // Возвращаем health сразу, а токен СДЭК прогреваем параллельно.
    // Поэтому открытие checkout будит Render и заодно готовит СДЭК к поиску.
    getCdekToken()
        .then(token => getTariffModeMap(token))
        .catch(error => {
            console.warn('CDEK warm-up failed:', error.response?.data || error.message);
        });

    res.json({
        ok: true,
        service: 'rhino-api',
        cdekTokenCached: Boolean(cdekToken && Date.now() < cdekTokenExpiresAt - 60000),
        bitrixConfigured: isBitrixConfigured(),
        bitrixCategoryId: BITRIX_CATEGORY_ID,
        bitrixStageNew: BITRIX_STAGE_NEW,
        bitrixStagePaid: BITRIX_STAGE_PAID,
        bitrixProductsCached: bitrixProductIdCache.size
    });
});

// ============================================================
// 1. ПОИСК ГОРОДОВ CDEK
// ============================================================

app.post('/api/search-cities', async (req, res) => {
    try {
        const query = String(req.body.query || '').trim();

        if (query.length < 2) {
            return res.json({ cities: [] });
        }

        const cacheKey = query.toLowerCase();
        const cached = getCached(cityCache, cacheKey);

        if (cached) {
            return res.json({ cities: cached, cached: true });
        }

        const token = await getCdekToken();

        // Специальный метод СДЭК для автодополнения.
        // В отличие от /location/cities он нормально работает по префиксу "Моск", "Санкт" и т.п.
        const response = await axios.get(
            `${CDEK_API}/location/suggest/cities`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                },
                params: {
                    name: query,
                    country_code: 'RU'
                },
                timeout: 6000
            }
        );

        const cities = (response.data || [])
            .map(item => {
                const fullName = String(item.full_name || '').trim();
                const parts = fullName
                    .split(',')
                    .map(part => part.trim())
                    .filter(Boolean);

                const name = parts[0] || fullName;
                const country = parts.length > 1 ? parts[parts.length - 1] : 'Россия';
                const region = parts.length > 2
                    ? parts.slice(1, -1).join(', ')
                    : (parts[1] || '');

                return {
                    code: Number(item.code),
                    name,
                    postalCode: '',
                    region,
                    country,
                    fullName
                };
            })
            .filter(city => city.code && city.name)
            .slice(0, 10);

        setCached(cityCache, cacheKey, cities);

        res.json({ cities });
    } catch (error) {
        console.error(
            'CDEK city suggest error:',
            error.response?.data || error.message
        );

        res.status(500).json({
            error: 'Ошибка поиска города',
            cities: []
        });
    }
});

// ============================================================
// 2. ПОИСК АДРЕСОВ
// ============================================================

app.post('/api/search-addresses', async (req, res) => {
    try {
        const query = String(req.body.query || '').trim();
        const city = String(
            req.body.cityName ||
            req.body.city ||
            ''
        ).trim();

        if (query.length < 2) {
            return res.json({
                addresses: []
            });
        }

        const searchQuery = city
            ? `${city}, ${query}`
            : query;

        const response = await axios.get(
            'https://nominatim.openstreetmap.org/search',
            {
                params: {
                    q: searchQuery,
                    format: 'jsonv2',
                    addressdetails: 1,
                    limit: 8,
                    countrycodes: 'ru'
                },
                headers: {
                    'User-Agent': 'RTN.PRO/1.0 (https://rtn.pro)',
                    'Accept-Language': 'ru'
                },
                timeout: 10000
            }
        );

        const addresses = (response.data || []).map((item, index) => {
            const road = String(
                item.address?.road ||
                item.address?.pedestrian ||
                item.address?.street ||
                item.address?.residential ||
                ''
            ).trim();

            const house = String(
                item.address?.house_number ||
                ''
            ).trim();

            const postcode = String(
                item.address?.postcode ||
                ''
            ).trim();

            const displayName = String(
                item.display_name ||
                ''
            ).trim();

            const label = [road, house]
                .filter(Boolean)
                .join(', ') || displayName;

            return {
                id: String(
                    item.place_id ||
                    `${index}-${item.lat || ''}-${item.lon || ''}`
                ),
                label,
                road,
                house,
                postcode,
                displayName,
                lat: Number(item.lat) || 0,
                lon: Number(item.lon) || 0
            };
        }).filter(item => item.label);

        res.json({
            addresses
        });

    } catch (error) {
        console.error(
            'Address search error:',
            error.response?.data || error.message
        );

        res.status(500).json({
            error: 'Ошибка поиска адреса',
            addresses: []
        });
    }
});

// ============================================================
// 3. ПУНКТЫ ВЫДАЧИ CDEK
// ============================================================

app.post('/api/get-pickup-points', async (req, res) => {
    try {
        const cityCode = Number(req.body.cityCode);

        if (!cityCode) {
            return res.status(400).json({
                error: 'Не указан код города',
                points: []
            });
        }

        const token = await getCdekToken();

        const response = await axios.get(
            `${CDEK_API}/deliverypoints`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                },
                params: {
                    city_code: cityCode,
                    type: 'PVZ'
                },
                timeout: 15000
            }
        );

        const points = (response.data || []).map(point => ({
            code: point.code,
            name: point.name || point.code,
            address: point.location?.address || point.location?.address_full || '',
            city: point.location?.city || '',
            workTime: point.work_time || '',
            phone: point.phones?.[0]?.number || '',
            lat: Number(point.location?.latitude || 0),
            lon: Number(point.location?.longitude || 0),
            nearestStation: point.nearest_station || '',
            metroStation: point.nearest_metro_station || '',
            weightLimit: Number(point.weight_max || 0),
            dimensions: Array.isArray(point.dimensions)
                ? point.dimensions.map(d => [d.width, d.height, d.depth].filter(Boolean).join('×')).filter(Boolean).join(', ')
                : ''
        }));

        res.json({
            points
        });

    } catch (error) {
        console.error(
            'CDEK pickup points error:',
            error.response?.data || error.message
        );

        res.status(500).json({
            error: 'Ошибка загрузки пунктов выдачи',
            points: []
        });
    }
});

// ============================================================
// 4. РАСЧЁТ ДОСТАВКИ CDEK
// ============================================================

app.post('/api/calculate-delivery', async (req, res) => {
    try {
        const {
            cityCode,
            deliveryType,
            deliveryMethod,

            packageWeight,
            packageLength,
            packageWidth,
            packageHeight,

            // Обратная совместимость.
            weight,
            length,
            width,
            height
        } = req.body;

        if (!cityCode) {
            return res.status(400).json({
                error: 'Не указан город доставки'
            });
        }

        const isCourier =
            deliveryType === 'courier' ||
            deliveryMethod === 'cdek_courier';

        /*
         * ВАЖНО:
         * Не берём "самый дешёвый" тариф из tarifflist.
         * Иначе СДЭК может вернуть служебные/фулфилмент-тарифы
         * вроде 358 "Фулфилмент. Выдача склад-склад".
         *
         * Для нашего интернет-магазина фиксируем:
         * 136 = Посылка склад-склад (до ПВЗ)
         * 137 = Посылка склад-дверь (курьер)
         */
        const tariffCode = isCourier ? 137 : 136;

        const normalizedWeight = Math.max(
            1,
            Number(packageWeight ?? weight) || 1000
        );

        const normalizedLength = Math.max(
            1,
            Number(packageLength ?? length) || 35
        );

        const normalizedWidth = Math.max(
            1,
            Number(packageWidth ?? width) || 25
        );

        const normalizedHeight = Math.max(
            1,
            Number(packageHeight ?? height) || 20
        );

        const cacheKey = [
            cityCode,
            tariffCode,
            normalizedWeight,
            normalizedLength,
            normalizedWidth,
            normalizedHeight
        ].join(':');

        const cached = getDeliveryCached(cacheKey);

        if (cached) {
            return res.json({
                ...cached,
                cached: true
            });
        }

        const token = await getCdekToken();

        const payload = {
            type: 1,
            currency: 1,
            lang: 'rus',
            tariff_code: tariffCode,

            // Москва — город отправления.
            from_location: {
                code: Number(process.env.CDEK_FROM_CITY_CODE || 44)
            },

            to_location: {
                code: Number(cityCode)
            },

            packages: [
                {
                    weight: normalizedWeight,
                    length: normalizedLength,
                    width: normalizedWidth,
                    height: normalizedHeight
                }
            ]
        };

        const response = await axios.post(
            `${CDEK_API}/calculator/tariff`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 9000
            }
        );

        const data = response.data || {};

        const deliveryPrice = Number(
            data.delivery_sum ??
            data.total_sum ??
            data.price ??
            0
        );

        if (!Number.isFinite(deliveryPrice) || deliveryPrice <= 0) {
            console.error(
                'CDEK tariff response without valid price:',
                JSON.stringify({
                    tariffCode,
                    cityCode,
                    response: data
                })
            );

            return res.status(422).json({
                error: 'СДЭК не вернул стоимость доставки',
                details: data.errors || data.message || null
            });
        }

        const result = {
            deliveryPrice,
            price: deliveryPrice,
            tariffCode,
            tariffName:
                data.tariff_name ||
                (isCourier
                    ? 'Посылка склад-дверь'
                    : 'Посылка склад-склад'),
            periodMin:
                data.period_min ??
                null,
            periodMax:
                data.period_max ??
                null,
            deliveryMode:
                isCourier ? 3 : 4
        };

        setDeliveryCached(cacheKey, result);

        return res.json(result);

    } catch (error) {
        const cdekData = error.response?.data;

        console.error(
            'CDEK delivery calculation error:',
            cdekData || error.message
        );

        const cdekMessage =
            cdekData?.errors?.[0]?.message ||
            cdekData?.message ||
            error.message ||
            'Неизвестная ошибка';

        return res.status(
            error.response?.status &&
            error.response.status >= 400 &&
            error.response.status < 500
                ? 422
                : 500
        ).json({
            error: 'Не удалось рассчитать доставку СДЭК',
            details: cdekMessage
        });
    }
});

// ============================================================
// ТЕЛЕФОН ДЛЯ ЮKASSA
// ============================================================

function normalizeRuPhoneForYooKassa(value) {
    let digits = String(value || '')
        .replace(/\D/g, '');

    if (
        digits.length === 11 &&
        digits.startsWith('8')
    ) {
        digits =
            '7' +
            digits.slice(1);

    } else if (digits.length === 10) {
        digits =
            '7' +
            digits;
    }

    if (!/^7\d{10}$/.test(digits)) {
        return '';
    }

    return '+' + digits;
}

// ============================================================
// ФОРМИРОВАНИЕ ЧЕКА ЮKASSA
// ============================================================

function buildReceiptItems(
    items,
    delivery,
    paymentAmount
) {
    const deliveryPrice =
        Number(delivery?.price || 0);

    const targetGoodsTotal = Math.max(
        0,
        Math.round(
            (paymentAmount - deliveryPrice) * 100
        )
    );

    const units = [];

    (items || []).forEach(item => {
        const qty = Math.max(
            1,
            Number(item.quantity || 1)
        );

        const unitPrice = Math.max(
            0,
            Number(item.price || 0)
        );

        for (let i = 0; i < qty; i += 1) {
            units.push({
                description:
                    item.name +
                    ' (' +
                    (item.flavor || 'стандарт') +
                    ')',

                baseCents:
                    Math.round(
                        unitPrice * 100
                    )
            });
        }
    });

    const baseGoodsTotal =
        units.reduce(
            (sum, unit) =>
                sum + unit.baseCents,
            0
        );

    let distributed = 0;

    const receiptItems =
        units.map((unit, index) => {
            let cents;

            if (
                index ===
                units.length - 1
            ) {
                cents = Math.max(
                    1,
                    targetGoodsTotal -
                        distributed
                );

            } else if (
                baseGoodsTotal > 0
            ) {
                cents = Math.max(
                    1,
                    Math.floor(
                        targetGoodsTotal *
                        unit.baseCents /
                        baseGoodsTotal
                    )
                );

                distributed += cents;

            } else {
                cents = 1;
                distributed += cents;
            }

            return {
                description:
                    unit.description.slice(
                        0,
                        128
                    ),

                quantity: 1,

                amount: {
                    value:
                        (
                            cents / 100
                        ).toFixed(2),

                    currency: 'RUB'
                },

                vat_code: 1,
                payment_mode: 'full_payment',
                payment_subject: 'commodity'
            };
        });

    // Доставка идёт отдельной услугой
    if (deliveryPrice > 0) {
        receiptItems.push({
            description:
                (
                    'Доставка (' +
                    (
                        delivery?.method ||
                        'СДЭК'
                    ) +
                    ')'
                ).slice(0, 128),

            quantity: 1,

            amount: {
                value:
                    deliveryPrice.toFixed(2),

                currency: 'RUB'
            },

            vat_code: 1,
            payment_mode: 'full_payment',
            payment_subject: 'service'
        });
    }

    return receiptItems;
}

// ============================================================
// 5. СОЗДАНИЕ ПЛАТЕЖА ЮKASSA
// ============================================================

app.post('/api/create-payment', async (req, res) => {
    try {
        const {
            amount,
            items,
            customer,
            delivery,
            orderId,
            comment
        } = req.body;

        // Проверяем сумму
        const paymentAmount =
            Number(amount);

        if (
            !Number.isFinite(paymentAmount) ||
            paymentAmount <= 0
        ) {
            return res.status(400).json({
                error: 'Некорректная сумма платежа'
            });
        }

        // Нормализуем телефон
        const normalizedPhone =
            normalizeRuPhoneForYooKassa(
                customer?.phone
            );

        if (!normalizedPhone) {
            return res.status(400).json({
                error: 'Некорректный номер телефона'
            });
        }

        // Формируем чек
        const receiptItems =
            buildReceiptItems(
                items,
                delivery,
                paymentAmount
            );

        if (!receiptItems.length) {
            return res.status(400).json({
                error: 'Корзина пуста'
            });
        }

        // Сначала фиксируем заказ в Bitrix24.
        // Даже если ЮKassa временно не работает, заявка не потеряется.
        let bitrixDealId = null;

        try {
            bitrixDealId =
                await syncOrderToBitrix({
                    orderId,
                    amount: paymentAmount,
                    items,
                    customer,
                    delivery,
                    comment
                });
        } catch (bitrixError) {
            // Ошибка CRM не должна блокировать оплату.
            console.error(
                'Bitrix24 order sync error:',
                bitrixError.response?.data ||
                bitrixError.message
            );
        }

        const paymentData = {
            amount: {
                value:
                    paymentAmount.toFixed(2),
                currency: 'RUB'
            },

            capture: true,

            confirmation: {
                type: 'redirect',
                return_url:
                    `${FRONTEND_URL}/?payment=success`
            },

            description: 'Заказ RTN.PRO',

            metadata: {
                customerName:
                    customer?.name || '',

                customerPhone:
                    normalizedPhone,

                deliveryMethod:
                    delivery?.method || '',

                deliveryCity:
                    delivery?.city || '',

                deliveryAddress:
                    delivery?.address || '',

                orderId:
                    String(orderId || ''),

                bitrixDealId:
                    bitrixDealId
                        ? String(bitrixDealId)
                        : ''
            },

            receipt: {
                customer: {
                    phone:
                        normalizedPhone
                },

                items:
                    receiptItems
            }
        };

        const idempotenceKey =
            crypto.randomUUID();

        const response =
            await axios.post(
                'https://api.yookassa.ru/v3/payments',

                paymentData,

                {
                    auth: {
                        username:
                            YOOKASSA_SHOP_ID,

                        password:
                            YOOKASSA_SECRET_KEY
                    },

                    headers: {
                        'Idempotence-Key':
                            idempotenceKey,

                        'Content-Type':
                            'application/json'
                    },

                    timeout: 15000
                }
            );

        const confirmationUrl =
            response.data
                ?.confirmation
                ?.confirmation_url;

        if (!confirmationUrl) {
            console.error(
                'YooKassa did not return confirmation_url:',
                response.data
            );

            return res.status(500).json({
                error:
                    'ЮKassa не вернула ссылку на оплату'
            });
        }

        if (bitrixDealId) {
            markBitrixPaymentCreated(
                bitrixDealId,
                response.data
            ).catch(error => {
                console.error(
                    'Bitrix24 payment update error:',
                    error.response?.data ||
                    error.message
                );
            });
        }

        res.json({
            id:
                response.data.id,

            status:
                response.data.status,

            confirmationUrl,

            confirmation:
                response.data.confirmation,

            bitrixDealId
        });

    } catch (error) {
        console.error(
            'YooKassa payment error:',
            error.response?.data ||
            error.message
        );

        const yooError =
            error.response?.data;

        const description =
            yooError?.description ||
            yooError?.parameter ||
            error.message ||
            'Неизвестная ошибка';

        res.status(
            error.response?.status ||
            500
        ).json({
            error:
                'Ошибка создания платежа: ' +
                description,

            details:
                yooError ||
                error.message
        });
    }
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found'
    });
});

// ============================================================
// START
// ============================================================

const PORT =
    process.env.PORT ||
    3000;

app.listen(PORT, () => {
    console.log(
        `RTN API запущен на порту ${PORT}`
    );

    if (isBitrixConfigured()) {
        setTimeout(() => {
            syncAllRtnProductsToBitrix()
                .catch(error => {
                    console.error(
                        'Bitrix24 startup catalog sync error:',
                        error.response?.data || error.message
                    );
                });
        }, 1500);
    }
});
