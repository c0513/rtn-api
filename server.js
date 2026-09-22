const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '12mb' }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const CDEK_ACCOUNT = process.env.CDEK_ACCOUNT;
const CDEK_SECRET = process.env.CDEK_SECRET;

function normalizeEnvValue(value) {
    let result = String(value || '')
        .replace(/^\uFEFF/, '')
        .trim();

    if (
        result.length >= 2 &&
        (
            (result.startsWith('"') && result.endsWith('"')) ||
            (result.startsWith("'") && result.endsWith("'"))
        )
    ) {
        result = result.slice(1, -1).trim();
    }

    return result;
}

const RAW_YOOKASSA_SHOP_ID =
    process.env.YOOKASSA_SHOP_ID ||
    process.env.SHOP_ID ||
    '';

const RAW_YOOKASSA_SECRET_KEY =
    process.env.YOOKASSA_SECRET_KEY ||
    process.env.SECRET_KEY ||
    '';

const YOOKASSA_SHOP_ID =
    normalizeEnvValue(
        RAW_YOOKASSA_SHOP_ID
    );

const YOOKASSA_SECRET_KEY =
    normalizeEnvValue(
        RAW_YOOKASSA_SECRET_KEY
    );


const TELEGRAM_BOT_TOKEN =
    normalizeEnvValue(
        process.env.RTN_TELEGRAM_BOT_TOKEN ||
        process.env.TELEGRAM_BOT_TOKEN ||
        process.env.TG_BOT_TOKEN ||
        ''
    );

const TELEGRAM_CHAT_ID =
    normalizeEnvValue(
        process.env.RTN_TELEGRAM_CHAT_ID ||
        process.env.TELEGRAM_CHAT_ID ||
        process.env.TG_CHAT_ID ||
        ''
    );

const PLENOSHNAYA_TG_BOT_TOKEN =
    normalizeEnvValue(
        process.env.PLENOSHNAYA_TG_BOT_TOKEN ||
        ''
    );

const PLENOSHNAYA_TG_CHAT_ID =
    normalizeEnvValue(
        process.env.PLENOSHNAYA_TG_CHAT_ID ||
        ''
    );

const PLENOSHNAYA_IDENTITY_SECRET =
    normalizeEnvValue(
        process.env.PLENOSHNAYA_IDENTITY_SECRET ||
        PLENOSHNAYA_TG_BOT_TOKEN ||
        ''
    );

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rtn.pro';
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || 'https://rhino-api-yrfq.onrender.com').replace(/\/$/, '');

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

const YCP_ACCESS_TOKEN =
    normalizeEnvValue(
        process.env.YCP_ACCESS_TOKEN ||
        ''
    );

const BLOG_ADMIN_TOKEN = normalizeEnvValue(process.env.BLOG_ADMIN_TOKEN || '');
const BLOG_DATA_FILE = process.env.BLOG_DATA_FILE || path.join(__dirname, 'data', 'articles.json');
const ORDER_DATA_FILE = process.env.ORDER_DATA_FILE || path.join(path.dirname(BLOG_DATA_FILE), 'orders.json');

function readBlogArticles() {
    try {
        if (!fs.existsSync(BLOG_DATA_FILE)) return [];
        const parsed = JSON.parse(fs.readFileSync(BLOG_DATA_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('Blog articles read error:', error.message);
        return [];
    }
}

function writeBlogArticles(articles) {
    fs.mkdirSync(path.dirname(BLOG_DATA_FILE), { recursive: true });
    const temporaryFile = `${BLOG_DATA_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(articles, null, 2), 'utf8');
    fs.renameSync(temporaryFile, BLOG_DATA_FILE);
}

function readOrders() {
    try {
        if (!fs.existsSync(ORDER_DATA_FILE)) return [];
        const parsed = JSON.parse(fs.readFileSync(ORDER_DATA_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('Orders read error:', error.message);
        return [];
    }
}

function writeOrders(orders) {
    fs.mkdirSync(path.dirname(ORDER_DATA_FILE), { recursive: true });
    const temporaryFile = `${ORDER_DATA_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(orders, null, 2), 'utf8');
    fs.renameSync(temporaryFile, ORDER_DATA_FILE);
}

function cleanOrderValue(value, max = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function upsertLocalOrder(update) {
    const orders = readOrders();
    const orderId = cleanOrderValue(update.orderId, 100);
    const paymentId = cleanOrderValue(update.paymentId, 100);
    const index = orders.findIndex(order =>
        (orderId && order.orderId === orderId) ||
        (paymentId && order.paymentId === paymentId)
    );
    const existing = index >= 0 ? orders[index] : {};
    const definedUpdate = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
    const now = new Date().toISOString();
    const next = {
        id: existing.id || crypto.randomUUID(),
        fulfillmentStatus: existing.fulfillmentStatus || 'new',
        paymentStatus: existing.paymentStatus || 'pending',
        createdAt: existing.createdAt || now,
        ...existing,
        ...definedUpdate,
        orderId: orderId || existing.orderId || '',
        paymentId: paymentId || existing.paymentId || '',
        updatedAt: now
    };
    if (index >= 0) orders[index] = next;
    else orders.push(next);
    writeOrders(orders);
    return next;
}

function orderFromCheckout({ orderId, amount, items, customer, delivery, comment, promoCode }) {
    return {
        orderId: cleanOrderValue(orderId, 100),
        publicOrderNumber: getPublicOrderNumber(orderId),
        amount: Math.max(0, Number(amount || 0)),
        customer: {
            name: cleanOrderValue(customer?.name, 256),
            phone: cleanOrderValue(customer?.phone, 40),
            email: cleanOrderValue(customer?.email, 254).toLowerCase()
        },
        delivery: {
            method: cleanOrderValue(delivery?.method, 100),
            address: cleanOrderValue(delivery?.address, 1000),
            city: cleanOrderValue(delivery?.city, 200),
            price: Math.max(0, Number(delivery?.price || 0))
        },
        items: (Array.isArray(items) ? items : []).map(item => ({
            externalId: cleanOrderValue(item?.externalId || item?.id, 150),
            name: cleanOrderValue(item?.name || item?.productName, 300),
            flavor: cleanOrderValue(item?.flavor, 200),
            quantity: Math.max(1, Math.floor(Number(item?.quantity) || 1)),
            price: Math.max(0, Number(item?.price || item?.priceNum || 0))
        })),
        comment: cleanOrderValue(comment, 2000),
        promoCode: normalizePromoCode(promoCode),
        source: 'site'
    };
}

async function syncRecentYooKassaPayments() {
    if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) return;
    const response = await axios.get('https://api.yookassa.ru/v3/payments?limit=100', {
        auth: { username: YOOKASSA_SHOP_ID, password: YOOKASSA_SECRET_KEY },
        headers: { Accept: 'application/json' },
        timeout: 15000
    });
    for (const payment of response.data?.items || []) {
        const metadata = payment.metadata || {};
        upsertLocalOrder({
            orderId: metadata.orderId || payment.id,
            paymentId: payment.id,
            publicOrderNumber: metadata.orderId
                ? getPublicOrderNumber(metadata.orderId)
                : String(payment.id || '').slice(-8).toUpperCase(),
            amount: Number(payment.amount?.value || 0),
            paymentStatus: payment.status || 'unknown',
            fulfillmentStatus: payment.status === 'canceled' ? 'cancelled' : undefined,
            paid: payment.paid === true,
            paidAt: payment.status === 'succeeded' ? payment.captured_at || payment.created_at : undefined,
            createdAt: payment.created_at,
            description: cleanOrderValue(payment.description, 500),
            customer: {
                name: cleanOrderValue(metadata.customerName, 256),
                phone: cleanOrderValue(metadata.customerPhone, 40),
                email: cleanOrderValue(metadata.customerEmail, 254).toLowerCase()
            },
            delivery: {
                method: cleanOrderValue(metadata.deliveryMethod, 100),
                address: cleanOrderValue(metadata.deliveryAddress, 1000),
                city: cleanOrderValue(metadata.deliveryCity, 200),
                price: 0
            },
            promoCode: normalizePromoCode(metadata.promoCode),
            source: 'yookassa'
        });
    }
}

function requireBlogAdmin(req, res, next) {
    if (!BLOG_ADMIN_TOKEN) {
        return res.status(503).json({ error: 'BLOG_ADMIN_TOKEN не настроен на сервере' });
    }
    const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const expected = Buffer.from(BLOG_ADMIN_TOKEN);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return res.status(401).json({ error: 'Неверный ключ администратора' });
    }
    next();
}

function normalizeBlogArticle(input, existing = {}) {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const slug = clean(input.slug).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        throw new Error('Slug должен состоять из латинских букв, цифр и дефисов');
    }
    const title = clean(input.title);
    const excerpt = clean(input.excerpt);
    const imageUrl = clean(input.imageUrl);
    const content = (Array.isArray(input.content) ? input.content : [])
        .map(item => clean(item))
        .filter(Boolean);
    if (!title || !excerpt || !imageUrl || content.length === 0) {
        throw new Error('Заполните заголовок, описание, изображение и текст статьи');
    }
    const now = new Date().toISOString();
    const status = input.status === 'published' ? 'published' : 'draft';
    return {
        ...existing,
        id: existing.id || `article-${Date.now()}`,
        slug,
        category: clean(input.category) || 'НОВОСТИ',
        categoryColor: /^#[0-9a-f]{6}$/i.test(input.categoryColor || '') ? input.categoryColor : '#00F0FF',
        title,
        excerpt,
        readTime: clean(input.readTime) || `${Math.max(1, Math.ceil(content.join(' ').split(/\s+/).length / 180))} МИН`,
        date: clean(input.date) || new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Moscow' }).format(new Date()).toUpperCase(),
        datePublished: existing.datePublished || (status === 'published' ? now : ''),
        dateModified: now,
        imageUrl,
        tags: (Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(','))
            .map(item => clean(item).toUpperCase()).filter(Boolean).slice(0, 10),
        content,
        status
    };
}

const YCP_API_TOKEN =
    normalizeEnvValue(
        process.env.YCP_API_TOKEN ||
        ''
    );

const YCP_WAREHOUSE_ID =
    normalizeEnvValue(
        process.env.YCP_WAREHOUSE_ID ||
        'rtn-main'
    );

const YCP_WAREHOUSE_TITLE =
    normalizeEnvValue(
        process.env.YCP_WAREHOUSE_TITLE ||
        'RTN.PRO / SuppStore'
    );

const YCP_WAREHOUSE_ADDRESS =
    normalizeEnvValue(
        process.env.YCP_WAREHOUSE_ADDRESS ||
        'Санкт-Петербург, улица Маршала Казакова, 58'
    );

const YCP_DEFAULT_STOCK =
    Math.max(
        0,
        Number(
            process.env.YCP_DEFAULT_STOCK ||
            0
        ) || 0
    );

const {
    YCP_PRODUCTS,
    YCP_PRODUCTS_BY_ID
} = require('./ycp-catalog');


// ============================================================
// BITRIX24
// ============================================================

function isBitrixConfigured() {
    return Boolean(BITRIX_WEBHOOK_URL);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableBitrixError(error) {
    const status = Number(error?.response?.status || 0);

    return (
        error?.code === 'ECONNABORTED' ||
        error?.code === 'ECONNRESET' ||
        error?.code === 'ETIMEDOUT' ||
        status === 429 ||
        status >= 500
    );
}

async function bitrixCall(method, params = {}) {
    if (!isBitrixConfigured()) {
        throw new Error('BITRIX_WEBHOOK_URL не настроен');
    }

    const isSlowUserFieldMethod =
        /\.userfield\.(add|update)$/.test(method);

    const timeout =
        isSlowUserFieldMethod
            ? 60000
            : 30000;

    // add может успеть выполниться в Bitrix, даже если ответ потерялся.
    // Для таких методов автоматический повтор способен создать дубль.
    const canRetry =
        !method.endsWith('.add') &&
        !/\.userfield\.update$/.test(method);

    const maxAttempts =
        canRetry ? 3 : 1;

    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await axios.post(
                `${BITRIX_WEBHOOK_URL}/${method}.json`,
                params,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout
                }
            );

            if (response.data?.error) {
                const description =
                    response.data?.error_description ||
                    response.data?.error ||
                    'Bitrix24 API error';

                const error =
                    new Error(description);

                error.bitrixError =
                    response.data?.error;

                throw error;
            }

            return response.data?.result;

        } catch (error) {
            lastError = error;

            if (
                attempt >= maxAttempts ||
                !isRetryableBitrixError(error)
            ) {
                throw error;
            }

            const waitMs =
                1200 * attempt;

            console.warn(
                `Bitrix24 ${method}: временная ошибка, повтор ${attempt + 1}/${maxAttempts} через ${waitMs}ms`
            );

            await sleep(waitMs);
        }
    }

    throw lastError;
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

            // Не перегружаем Bitrix серией запросов подряд.
            await sleep(250);
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


const BITRIX_PROMO_FIELDS = {
    dealPromo: 'UF_CRM_RTN_PROMO_CODE',
    dealAmbassador: 'UF_CRM_RTN_AMBASSADOR',
    contactPromoHistory: 'UF_CRM_RTN_PROMO_HISTORY',
    contactAmbassadorHistory: 'UF_CRM_RTN_AMBASSADOR_HISTORY'
};

const BITRIX_ORDER_FIELDS = {
    orderNumber: 'UF_CRM_RTN_ORDER_NUMBER',
    amountBeforeDiscount: 'UF_CRM_RTN_AMOUNT_BEFORE_DISCOUNT',
    discountAmount: 'UF_CRM_RTN_DISCOUNT_AMOUNT',
    deliveryType: 'UF_CRM_RTN_DELIVERY_TYPE',
    deliveryAddress: 'UF_CRM_RTN_DELIVERY_ADDRESS',
    deliveryCost: 'UF_CRM_RTN_DELIVERY_COST',
    clientComment: 'UF_CRM_RTN_CLIENT_COMMENT',
    paymentStatus: 'UF_CRM_RTN_PAYMENT_STATUS'
};

const RTN_DELIVERY_TYPES = [
    'ПВЗ',
    'КУРЬЕР'
];

const RTN_PAYMENT_STATUSES = [
    'Ожидает оплаты',
    'Оплачен'
];

const RTN_PROMO_AMBASSADORS = {
    RHINO: 'Роман Халиулин — Носорог',
    BIGGY: 'Вячеслав Коростелев — Бегемот',
    BATR: 'Александр Батраков — Сибирский Медведь',
    DOC: 'Богдан Душин — Доктор',
    VEPR: 'Протокол Вепрь',
    SJ10: 'Протокол SJ'
};

const RTN_KNOWN_PROMO_CODES = [
    'RTN2026',
    'RHINO',
    'BIGGY',
    'BATR',
    'DOC',
    'TOPLIVO10',
    'LION',
    'PANTERA',
    'VEPR',
    'SJ10'
];

const bitrixEnumOptionPromises = new Map();
const bitrixEnumOptionIdCache = new Map();
let bitrixPromoFieldsBootstrapPromise = null;
let bitrixPromoFieldsReady = false;
let bitrixOrderFieldsBootstrapPromise = null;
let bitrixOrderFieldsReady = false;

function getPublicOrderNumber(orderId) {
    const raw =
        String(orderId || '').trim();

    const timestampPart =
        raw.split('-')[0];

    let timestamp =
        Number(timestampPart);

    if (
        !Number.isFinite(timestamp) ||
        timestamp < 1000000000000
    ) {
        timestamp = Date.now();
    }

    // Москва в 2026 году = UTC+3 без перехода на летнее время.
    const moscowDate =
        new Date(
            timestamp +
            3 * 60 * 60 * 1000
        );

    const pad = value =>
        String(value).padStart(2, '0');

    const day =
        pad(moscowDate.getUTCDate());

    const month =
        pad(moscowDate.getUTCMonth() + 1);

    const year =
        String(
            moscowDate.getUTCFullYear()
        );

    const hour =
        pad(moscowDate.getUTCHours());

    const minute =
        pad(moscowDate.getUTCMinutes());

    return `${day}${month}${year}${hour}${minute}`;
}

function getOrderFinancials({
    items,
    delivery,
    amount
}) {
    const goodsBeforeDiscount =
        (Array.isArray(items) ? items : [])
            .reduce(
                (sum, item) =>
                    sum +
                    Number(item?.price || 0) *
                    Math.max(
                        1,
                        Number(item?.quantity || 1)
                    ),
                0
            );

    const deliveryCost =
        Math.max(
            0,
            Number(delivery?.price || 0)
        );

    const amountBeforeDiscount =
        goodsBeforeDiscount +
        deliveryCost;

    const finalAmount =
        Math.max(
            0,
            Number(amount || 0)
        );

    const discountAmount =
        Math.max(
            0,
            amountBeforeDiscount -
            finalAmount
        );

    return {
        goodsBeforeDiscount,
        deliveryCost,
        amountBeforeDiscount,
        finalAmount,
        discountAmount
    };
}

function normalizeDeliveryType(delivery) {
    const method =
        String(
            delivery?.method || ''
        )
            .trim()
            .toUpperCase();

    if (
        method.includes('КУРЬЕР') ||
        method.includes('COURIER')
    ) {
        return 'КУРЬЕР';
    }

    if (
        method.includes('ПВЗ') ||
        method.includes('PICKUP') ||
        method.includes('СДЭК')
    ) {
        return 'ПВЗ';
    }

    return '';
}

function normalizePromoCode(value) {
    return String(value || '')
        .trim()
        .toUpperCase();
}

function getPromoAmbassador(promoCode) {
    return RTN_PROMO_AMBASSADORS[
        normalizePromoCode(promoCode)
    ] || '';
}

function makeEnumXmlId(prefix, value) {
    const hex = Buffer
        .from(String(value || ''), 'utf8')
        .toString('hex')
        .slice(0, 60);

    return `${prefix}_${hex}`;
}

function getUserFieldApi(entity, action) {
    if (!['deal', 'contact'].includes(entity)) {
        throw new Error(`Unsupported CRM entity: ${entity}`);
    }

    return `crm.${entity}.userfield.${action}`;
}

async function getBitrixUserField(entity, fieldName) {
    const result = await bitrixCall(
        getUserFieldApi(entity, 'list'),
        {
            filter: {
                FIELD_NAME: fieldName
            }
        }
    );

    return Array.isArray(result)
        ? (result[0] || null)
        : null;
}


async function ensureBitrixSimpleField({
    entity,
    fieldName,
    label,
    userTypeId = 'string',
    multiple = false,
    sort = 3000,
    settings = {}
}) {
    let field =
        await getBitrixUserField(
            entity,
            fieldName
        );

    if (!field) {
        await bitrixCall(
            getUserFieldApi(entity, 'add'),
            {
                fields: {
                    FIELD_NAME:
                        fieldName,

                    USER_TYPE_ID:
                        userTypeId,

                    MULTIPLE:
                        multiple ? 'Y' : 'N',

                    MANDATORY:
                        'N',

                    SHOW_FILTER:
                        'Y',

                    SHOW_IN_LIST:
                        'Y',

                    EDIT_IN_LIST:
                        'Y',

                    EDIT_FORM_LABEL: {
                        ru: label,
                        en: label
                    },

                    LIST_COLUMN_LABEL: {
                        ru: label,
                        en: label
                    },

                    LIST_FILTER_LABEL: {
                        ru: label,
                        en: label
                    },

                    SETTINGS:
                        settings,

                    SORT:
                        sort
                }
            }
        );

        field =
            await getBitrixUserField(
                entity,
                fieldName
            );
    }

    if (!field) {
        throw new Error(
            `Не удалось создать/получить поле ${fieldName}`
        );
    }

    return field;
}

async function ensureBitrixEnumerationField({
    entity,
    fieldName,
    label,
    multiple,
    initialValues = [],
    sort = 3000
}) {
    let field =
        await getBitrixUserField(
            entity,
            fieldName
        );

    if (!field) {
        await bitrixCall(
            getUserFieldApi(entity, 'add'),
            {
                fields: {
                    FIELD_NAME:
                        fieldName,

                    USER_TYPE_ID:
                        'enumeration',

                    MULTIPLE:
                        multiple ? 'Y' : 'N',

                    MANDATORY:
                        'N',

                    SHOW_FILTER:
                        'Y',

                    EDIT_FORM_LABEL: {
                        ru: label,
                        en: label
                    },

                    LIST_FILTER_LABEL: {
                        ru: label,
                        en: label
                    },

                    LIST: initialValues.map(
                        (value, index) => ({
                            VALUE:
                                value,

                            XML_ID:
                                makeEnumXmlId(
                                    `RTN_${fieldName}`,
                                    value
                                ),

                            SORT:
                                (index + 1) * 100
                        })
                    ),

                    SETTINGS: {
                        DISPLAY:
                            'UI',

                        LIST_HEIGHT:
                            Math.max(
                                5,
                                initialValues.length
                            )
                    },

                    SORT:
                        sort
                }
            }
        );

        field =
            await getBitrixUserField(
                entity,
                fieldName
            );
    }

    if (!field) {
        throw new Error(
            `Не удалось создать/получить поле ${fieldName}`
        );
    }

    return field;
}

async function ensureBitrixEnumOption({
    entity,
    fieldName,
    value,
    xmlPrefix = 'RTN_ENUM'
}) {
    const normalizedValue =
        String(value || '').trim();

    if (!normalizedValue) {
        return null;
    }

    const cacheKey =
        `${entity}:${fieldName}:${normalizedValue.toUpperCase()}`;

    if (bitrixEnumOptionIdCache.has(cacheKey)) {
        return bitrixEnumOptionIdCache.get(cacheKey);
    }

    if (bitrixEnumOptionPromises.has(cacheKey)) {
        return bitrixEnumOptionPromises.get(cacheKey);
    }

    const promise = (async () => {
        let field =
            await getBitrixUserField(
                entity,
                fieldName
            );

        if (!field) {
            throw new Error(
                `Поле ${fieldName} ещё не создано`
            );
        }

        const findOption = currentField =>
            (Array.isArray(currentField?.LIST)
                ? currentField.LIST
                : []
            ).find(
                item =>
                    String(item?.VALUE || '')
                        .trim()
                        .toUpperCase() ===
                    normalizedValue.toUpperCase()
            );

        let option = findOption(field);

        if (option?.ID) {
            const optionId =
                Number(option.ID);

            bitrixEnumOptionIdCache.set(
                cacheKey,
                optionId
            );

            return optionId;
        }

        await bitrixCall(
            getUserFieldApi(entity, 'update'),
            {
                id: Number(field.ID),
                fields: {
                    LIST: [
                        {
                            VALUE: normalizedValue,
                            XML_ID:
                                makeEnumXmlId(
                                    xmlPrefix,
                                    normalizedValue
                                )
                        }
                    ]
                }
            }
        );

        field =
            await getBitrixUserField(
                entity,
                fieldName
            );

        option = findOption(field);

        if (!option?.ID) {
            throw new Error(
                `Bitrix24 не вернул ID значения "${normalizedValue}" для ${fieldName}`
            );
        }

        const optionId =
            Number(option.ID);

        bitrixEnumOptionIdCache.set(
            cacheKey,
            optionId
        );

        return optionId;
    })().finally(() => {
        bitrixEnumOptionPromises.delete(cacheKey);
    });

    bitrixEnumOptionPromises.set(
        cacheKey,
        promise
    );

    return promise;
}

async function ensureBitrixEnumOptionsBatch({
    entity,
    fieldName,
    values,
    xmlPrefix
}) {
    let field =
        await getBitrixUserField(
            entity,
            fieldName
        );

    if (!field) {
        throw new Error(
            `Поле ${fieldName} ещё не создано`
        );
    }

    const list =
        Array.isArray(field.LIST)
            ? field.LIST
            : [];

    const existing =
        new Map(
            list.map(item => [
                String(item?.VALUE || '')
                    .trim()
                    .toUpperCase(),
                Number(item?.ID || 0)
            ])
        );

    const uniqueValues =
        Array.from(
            new Set(
                (values || [])
                    .map(value =>
                        String(value || '').trim()
                    )
                    .filter(Boolean)
            )
        );

    const missing =
        uniqueValues.filter(
            value =>
                !existing.has(
                    value.toUpperCase()
                )
        );

    if (missing.length) {
        await bitrixCall(
            getUserFieldApi(entity, 'update'),
            {
                id: Number(field.ID),
                fields: {
                    LIST: missing.map(
                        value => ({
                            VALUE: value,
                            XML_ID:
                                makeEnumXmlId(
                                    xmlPrefix,
                                    value
                                )
                        })
                    )
                }
            }
        );

        field =
            await getBitrixUserField(
                entity,
                fieldName
            );
    }

    for (const item of (field.LIST || [])) {
        const value =
            String(item?.VALUE || '')
                .trim();

        const id =
            Number(item?.ID || 0);

        if (!value || !id) continue;

        bitrixEnumOptionIdCache.set(
            `${entity}:${fieldName}:${value.toUpperCase()}`,
            id
        );
    }

    return field;
}

async function syncPromoFieldsToBitrix() {
    if (!isBitrixConfigured()) {
        return false;
    }

    if (bitrixPromoFieldsReady) {
        return true;
    }

    if (bitrixPromoFieldsBootstrapPromise) {
        return bitrixPromoFieldsBootstrapPromise;
    }

    bitrixPromoFieldsBootstrapPromise =
        (async () => {
            const knownAmbassadors =
                Array.from(
                    new Set(
                        Object.values(
                            RTN_PROMO_AMBASSADORS
                        )
                    )
                );

            await ensureBitrixEnumerationField({
                entity: 'deal',
                fieldName: BITRIX_PROMO_FIELDS.dealPromo,
                label: 'Промокод RTN',
                multiple: false,
                initialValues: RTN_KNOWN_PROMO_CODES,
                sort: 3100
            });

            await ensureBitrixEnumerationField({
                entity: 'deal',
                fieldName: BITRIX_PROMO_FIELDS.dealAmbassador,
                label: 'Амбассадор RTN',
                multiple: false,
                initialValues: knownAmbassadors,
                sort: 3110
            });

            await ensureBitrixEnumerationField({
                entity: 'contact',
                fieldName: BITRIX_PROMO_FIELDS.contactPromoHistory,
                label: 'Промокоды RTN (история)',
                multiple: true,
                initialValues: RTN_KNOWN_PROMO_CODES,
                sort: 3100
            });

            await ensureBitrixEnumerationField({
                entity: 'contact',
                fieldName: BITRIX_PROMO_FIELDS.contactAmbassadorHistory,
                label: 'Амбассадоры RTN (история)',
                multiple: true,
                initialValues: knownAmbassadors,
                sort: 3110
            });

            // Проверяем варианты списков пакетно, а не десятками REST-запросов.
            await ensureBitrixEnumOptionsBatch({
                entity: 'deal',
                fieldName: BITRIX_PROMO_FIELDS.dealPromo,
                values: RTN_KNOWN_PROMO_CODES,
                xmlPrefix: 'RTN_PROMO_DEAL'
            });

            await ensureBitrixEnumOptionsBatch({
                entity: 'contact',
                fieldName: BITRIX_PROMO_FIELDS.contactPromoHistory,
                values: RTN_KNOWN_PROMO_CODES,
                xmlPrefix: 'RTN_PROMO_CONTACT'
            });

            await ensureBitrixEnumOptionsBatch({
                entity: 'deal',
                fieldName: BITRIX_PROMO_FIELDS.dealAmbassador,
                values: knownAmbassadors,
                xmlPrefix: 'RTN_AMB_DEAL'
            });

            await ensureBitrixEnumOptionsBatch({
                entity: 'contact',
                fieldName: BITRIX_PROMO_FIELDS.contactAmbassadorHistory,
                values: knownAmbassadors,
                xmlPrefix: 'RTN_AMB_CONTACT'
            });

            bitrixPromoFieldsReady = true;

            console.log(
                'Bitrix24 promo fields sync finished'
            );

            return true;
        })().catch(error => {
            bitrixPromoFieldsReady = false;
            throw error;
        }).finally(() => {
            bitrixPromoFieldsBootstrapPromise = null;
        });

    return bitrixPromoFieldsBootstrapPromise;
}


async function syncOrderFieldsToBitrix() {
    if (!isBitrixConfigured()) {
        return false;
    }

    if (bitrixOrderFieldsReady) {
        return true;
    }

    if (bitrixOrderFieldsBootstrapPromise) {
        return bitrixOrderFieldsBootstrapPromise;
    }

    bitrixOrderFieldsBootstrapPromise =
        (async () => {
            await ensureBitrixSimpleField({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.orderNumber,

                label:
                    'Номер заказа RTN',

                userTypeId:
                    'string',

                sort:
                    3200
            });

            await ensureBitrixSimpleField({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.amountBeforeDiscount,

                label:
                    'Сумма до скидки',

                userTypeId:
                    'double',

                sort:
                    3210
            });

            await ensureBitrixSimpleField({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.discountAmount,

                label:
                    'Скидка',

                userTypeId:
                    'double',

                sort:
                    3220
            });

            await ensureBitrixEnumerationField({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.deliveryType,

                label:
                    'Тип доставки',

                multiple:
                    false,

                initialValues:
                    RTN_DELIVERY_TYPES,

                sort:
                    3230
            });

            await ensureBitrixSimpleField({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.deliveryAddress,

                label:
                    'Адрес доставки / ПВЗ',

                userTypeId:
                    'string',

                sort:
                    3240,

                settings: {
                    ROWS:
                        3
                }
            });

            await ensureBitrixSimpleField({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.deliveryCost,

                label:
                    'Стоимость доставки',

                userTypeId:
                    'double',

                sort:
                    3250
            });

            await ensureBitrixSimpleField({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.clientComment,

                label:
                    'Комментарий клиента',

                userTypeId:
                    'string',

                sort:
                    3260,

                settings: {
                    ROWS:
                        4
                }
            });

            await ensureBitrixEnumerationField({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.paymentStatus,

                label:
                    'Статус оплаты',

                multiple:
                    false,

                initialValues:
                    RTN_PAYMENT_STATUSES,

                sort:
                    3270
            });

            await ensureBitrixEnumOptionsBatch({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.deliveryType,

                values:
                    RTN_DELIVERY_TYPES,

                xmlPrefix:
                    'RTN_DELIVERY_TYPE'
            });

            await ensureBitrixEnumOptionsBatch({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.paymentStatus,

                values:
                    RTN_PAYMENT_STATUSES,

                xmlPrefix:
                    'RTN_PAYMENT_STATUS'
            });

            bitrixOrderFieldsReady = true;

            console.log(
                'Bitrix24 order fields sync finished'
            );

            return true;
        })().catch(error => {
            bitrixOrderFieldsReady = false;
            throw error;
        }).finally(() => {
            bitrixOrderFieldsBootstrapPromise =
                null;
        });

    return bitrixOrderFieldsBootstrapPromise;
}

async function applyOrderFieldsToBitrixDeal({
    dealId,
    orderId,
    amount,
    items,
    delivery,
    comment
}) {
    if (!dealId) {
        return;
    }

    await syncOrderFieldsToBitrix();

    const financials =
        getOrderFinancials({
            items,
            delivery,
            amount
        });

    const deliveryType =
        normalizeDeliveryType(
            delivery
        );

    const deliveryTypeId =
        deliveryType
            ? await ensureBitrixEnumOption({
                entity:
                    'deal',

                fieldName:
                    BITRIX_ORDER_FIELDS.deliveryType,

                value:
                    deliveryType,

                xmlPrefix:
                    'RTN_DELIVERY_TYPE'
            })
            : null;

    const paymentStatusId =
        await ensureBitrixEnumOption({
            entity:
                'deal',

            fieldName:
                BITRIX_ORDER_FIELDS.paymentStatus,

            value:
                'Ожидает оплаты',

            xmlPrefix:
                'RTN_PAYMENT_STATUS'
        });

    const fields = {
        TITLE:
            `RTN.PRO заказ #${getPublicOrderNumber(orderId)}`,

        COMMENTS:
            buildBitrixDealComment({
                items
            }),

        OPPORTUNITY:
            financials.finalAmount,

        IS_MANUAL_OPPORTUNITY:
            'Y',

        [BITRIX_ORDER_FIELDS.orderNumber]:
            getPublicOrderNumber(orderId),

        [BITRIX_ORDER_FIELDS.amountBeforeDiscount]:
            financials.amountBeforeDiscount,

        [BITRIX_ORDER_FIELDS.discountAmount]:
            financials.discountAmount,

        [BITRIX_ORDER_FIELDS.deliveryAddress]:
            String(
                delivery?.address || ''
            ).trim(),

        [BITRIX_ORDER_FIELDS.deliveryCost]:
            financials.deliveryCost,

        [BITRIX_ORDER_FIELDS.clientComment]:
            String(
                comment || ''
            ).trim()
    };

    if (deliveryTypeId) {
        fields[
            BITRIX_ORDER_FIELDS.deliveryType
        ] = Number(deliveryTypeId);
    }

    if (paymentStatusId) {
        fields[
            BITRIX_ORDER_FIELDS.paymentStatus
        ] = Number(paymentStatusId);
    }

    await bitrixCall(
        'crm.deal.update',
        {
            id:
                Number(dealId),

            fields
        }
    );
}

async function markBitrixPaymentStatus(
    dealId,
    status
) {
    if (!dealId || !status) {
        return;
    }

    await syncOrderFieldsToBitrix();

    const statusId =
        await ensureBitrixEnumOption({
            entity:
                'deal',

            fieldName:
                BITRIX_ORDER_FIELDS.paymentStatus,

            value:
                status,

            xmlPrefix:
                'RTN_PAYMENT_STATUS'
        });

    if (!statusId) {
        return;
    }

    await bitrixCall(
        'crm.deal.update',
        {
            id:
                Number(dealId),

            fields: {
                [BITRIX_ORDER_FIELDS.paymentStatus]:
                    Number(statusId)
            }
        }
    );
}

function toNumericIdArray(value) {
    const source =
        Array.isArray(value)
            ? value
            : (
                value === null ||
                value === undefined ||
                value === ''
                    ? []
                    : [value]
            );

    return Array.from(
        new Set(
            source
                .map(item => Number(item))
                .filter(
                    item =>
                        Number.isFinite(item) &&
                        item > 0
                )
        )
    );
}

async function applyPromoToBitrixContact(
    contactId,
    promoCode
) {
    const normalizedPromo =
        normalizePromoCode(promoCode);

    if (!contactId || !normalizedPromo) {
        return;
    }

    await syncPromoFieldsToBitrix();

    const promoOptionId =
        await ensureBitrixEnumOption({
            entity: 'contact',
            fieldName: BITRIX_PROMO_FIELDS.contactPromoHistory,
            value: normalizedPromo,
            xmlPrefix: 'RTN_PROMO_CONTACT'
        });

    const ambassador =
        getPromoAmbassador(
            normalizedPromo
        );

    const ambassadorOptionId =
        ambassador
            ? await ensureBitrixEnumOption({
                entity: 'contact',
                fieldName: BITRIX_PROMO_FIELDS.contactAmbassadorHistory,
                value: ambassador,
                xmlPrefix: 'RTN_AMB_CONTACT'
            })
            : null;

    const contact =
        await bitrixCall(
            'crm.contact.get',
            {
                id: Number(contactId)
            }
        );

    const currentPromoIds =
        toNumericIdArray(
            contact?.[
                BITRIX_PROMO_FIELDS
                    .contactPromoHistory
            ]
        );

    const currentAmbassadorIds =
        toNumericIdArray(
            contact?.[
                BITRIX_PROMO_FIELDS
                    .contactAmbassadorHistory
            ]
        );

    const fields = {};

    if (promoOptionId) {
        fields[
            BITRIX_PROMO_FIELDS
                .contactPromoHistory
        ] = Array.from(
            new Set([
                ...currentPromoIds,
                Number(promoOptionId)
            ])
        );
    }

    if (ambassadorOptionId) {
        fields[
            BITRIX_PROMO_FIELDS
                .contactAmbassadorHistory
        ] = Array.from(
            new Set([
                ...currentAmbassadorIds,
                Number(ambassadorOptionId)
            ])
        );
    }

    if (Object.keys(fields).length) {
        await bitrixCall(
            'crm.contact.update',
            {
                id: Number(contactId),
                fields
            }
        );
    }
}

async function applyPromoToBitrixDeal(
    dealId,
    promoCode
) {
    const normalizedPromo =
        normalizePromoCode(promoCode);

    if (!dealId || !normalizedPromo) {
        return;
    }

    await syncPromoFieldsToBitrix();

    const promoOptionId =
        await ensureBitrixEnumOption({
            entity: 'deal',
            fieldName: BITRIX_PROMO_FIELDS.dealPromo,
            value: normalizedPromo,
            xmlPrefix: 'RTN_PROMO_DEAL'
        });

    const ambassador =
        getPromoAmbassador(
            normalizedPromo
        );

    const ambassadorOptionId =
        ambassador
            ? await ensureBitrixEnumOption({
                entity: 'deal',
                fieldName: BITRIX_PROMO_FIELDS.dealAmbassador,
                value: ambassador,
                xmlPrefix: 'RTN_AMB_DEAL'
            })
            : null;

    const fields = {};

    if (promoOptionId) {
        fields[
            BITRIX_PROMO_FIELDS.dealPromo
        ] = Number(promoOptionId);
    }

    if (ambassadorOptionId) {
        fields[
            BITRIX_PROMO_FIELDS.dealAmbassador
        ] = Number(ambassadorOptionId);
    }

    if (Object.keys(fields).length) {
        await bitrixCall(
            'crm.deal.update',
            {
                id: Number(dealId),
                fields
            }
        );
    }
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
    items
}) {
    const lines = [
        'Состав заказа:'
    ];

    (Array.isArray(items) ? items : [])
        .forEach(
            (item, index) => {
                const quantity =
                    Math.max(
                        1,
                        Number(
                            item?.quantity || 1
                        )
                    );

                const unitPrice =
                    Number(
                        item?.price || 0
                    );

                lines.push(
                    `${index + 1}. ${item?.name || 'Товар'}${item?.flavor ? ` — ${item.flavor}` : ''} × ${quantity} = ${unitPrice.toLocaleString('ru-RU')} ₽/шт. до скидки`
                );
            }
        );

    return lines.join('\n');
}


async function buildBitrixProductRows(
    items,
    delivery,
    finalAmount
) {
    const rows = [];
    const sourceItems =
        Array.isArray(items)
            ? items
            : [];

    const deliveryPrice =
        Math.max(
            0,
            Number(delivery?.price || 0)
        );

    const targetGoodsCents =
        Math.max(
            0,
            Math.round(
                (
                    Number(finalAmount || 0) -
                    deliveryPrice
                ) * 100
            )
        );

    const baseRows =
        sourceItems.map(item => {
            const quantity =
                Math.max(
                    1,
                    Number(item?.quantity || 1)
                );

            const baseUnitPrice =
                Math.max(
                    0,
                    Number(item?.price || 0)
                );

            return {
                item,
                quantity,
                baseUnitPrice,
                baseRowCents:
                    Math.round(
                        baseUnitPrice *
                        quantity *
                        100
                    )
            };
        });

    const baseGoodsCents =
        baseRows.reduce(
            (sum, row) =>
                sum + row.baseRowCents,
            0
        );

    let distributedCents = 0;

    for (let index = 0; index < baseRows.length; index += 1) {
        const {
            item,
            quantity,
            baseUnitPrice,
            baseRowCents
        } = baseRows[index];

        let targetRowCents;

        if (
            index ===
            baseRows.length - 1
        ) {
            targetRowCents =
                Math.max(
                    0,
                    targetGoodsCents -
                    distributedCents
                );
        } else if (
            baseGoodsCents > 0
        ) {
            targetRowCents =
                Math.max(
                    0,
                    Math.floor(
                        targetGoodsCents *
                        baseRowCents /
                        baseGoodsCents
                    )
                );

            distributedCents +=
                targetRowCents;
        } else {
            targetRowCents = 0;
        }

        const discountedUnitPrice =
            quantity > 0
                ? targetRowCents /
                    100 /
                    quantity
                : 0;

        let productId = null;

        try {
            const rtnProduct =
                findRtnProductForOrderItem(item);

            if (rtnProduct) {
                productId =
                    await ensureBitrixCatalogProduct(
                        rtnProduct
                    );
            }
        } catch (error) {
            console.error(
                'Bitrix24 product binding error:',
                error.response?.data ||
                error.message
            );
        }

        const row = {
            // Bitrix трактует price как цену единицы уже с учетом скидки.
            price:
                Number(
                    discountedUnitPrice
                        .toFixed(4)
                ),

            quantity,

            sort:
                (index + 1) * 10
        };

        const discountPerUnit =
            Math.max(
                0,
                baseUnitPrice -
                discountedUnitPrice
            );

        if (discountPerUnit > 0.0001) {
            row.discountTypeId = 1;
            row.discountSum =
                Number(
                    discountPerUnit
                        .toFixed(4)
                );
        }

        if (productId) {
            row.productId = productId;
        } else {
            row.productName =
                `${item?.name || 'Товар'}${item?.flavor ? ` — ${item.flavor}` : ''}`;
        }

        rows.push(row);
    }

    if (deliveryPrice > 0) {
        rows.push({
            productName:
                `Доставка — ${delivery?.method || 'СДЭК'}`,
            price:
                deliveryPrice,
            quantity:
                1,
            sort:
                (rows.length + 1) * 10
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
    comment,
    promoCode
}) {
    if (!isBitrixConfigured()) {
        console.warn(
            'Bitrix24 integration skipped: BITRIX_WEBHOOK_URL is empty'
        );

        return null;
    }

    const normalizedPromoCode =
        normalizePromoCode(promoCode);

    const contactId =
        await getOrCreateBitrixContact(customer);

    if (contactId && normalizedPromoCode) {
        try {
            await applyPromoToBitrixContact(
                contactId,
                normalizedPromoCode
            );
        } catch (error) {
            console.error(
                'Bitrix24 contact promo attribution error:',
                error.response?.data || error.message
            );
        }
    }

    const existingDealId =
        await findExistingBitrixDeal(orderId);

    if (existingDealId) {
        if (normalizedPromoCode) {
            try {
                await applyPromoToBitrixDeal(
                    existingDealId,
                    normalizedPromoCode
                );
            } catch (error) {
                console.error(
                    'Bitrix24 existing deal promo attribution error:',
                    error.response?.data || error.message
                );
            }
        }

        try {
            await applyOrderFieldsToBitrixDeal({
                dealId:
                    existingDealId,

                orderId,
                amount,
                items,
                delivery,
                comment
            });
        } catch (error) {
            console.error(
                'Bitrix24 existing deal order fields error:',
                error.response?.data ||
                error.message
            );
        }

        try {
            const productRows =
                await buildBitrixProductRows(items, delivery, amount);

            if (productRows.length) {
                await bitrixCall(
                    'crm.item.productrow.set',
                    {
                        ownerType: 'D',
                        ownerId: existingDealId,
                        productRows
                    }
                );

                await bitrixCall(
                    'crm.deal.update',
                    {
                        id: Number(existingDealId),
                        fields: {
                            OPPORTUNITY:
                                Number(amount || 0),
                            IS_MANUAL_OPPORTUNITY:
                                'Y'
                        }
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

    const fields = {
        title:
            `RTN.PRO заказ #${getPublicOrderNumber(orderId)}`,

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
                items
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

    if (normalizedPromoCode) {
        try {
            await applyPromoToBitrixDeal(
                dealId,
                normalizedPromoCode
            );
        } catch (error) {
            console.error(
                'Bitrix24 deal promo attribution error:',
                error.response?.data || error.message
            );
        }
    }

    try {
        await applyOrderFieldsToBitrixDeal({
            dealId,
            orderId,
            amount,
            items,
            delivery,
            comment
        });
    } catch (error) {
        console.error(
            'Bitrix24 deal order fields error:',
            error.response?.data ||
            error.message
        );
    }

    const productRows =
        await buildBitrixProductRows(
            items,
            delivery,
            amount
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

            await bitrixCall(
                'crm.deal.update',
                {
                    id: Number(dealId),
                    fields: {
                        OPPORTUNITY:
                            Number(amount || 0),
                        IS_MANUAL_OPPORTUNITY:
                            'Y'
                    }
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

    try {
        await markBitrixPaymentStatus(
            dealId,
            'Оплачен'
        );
    } catch (error) {
        console.error(
            'Bitrix24 payment status field error:',
            error.response?.data ||
            error.message
        );
    }
}

app.post('/api/yookassa/webhook', async (req, res) => {
    try {
        const event = req.body?.event;
        const notifiedPayment = req.body?.object;

        console.log(
            `YooKassa webhook received: event=${event || 'UNKNOWN'}, payment=${notifiedPayment?.id || 'NO_ID'}`
        );

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

        upsertLocalOrder({
            orderId: payment?.metadata?.orderId,
            paymentId: payment?.id,
            paymentStatus: payment?.status,
            paid: true,
            paidAt: payment?.captured_at || new Date().toISOString()
        });

        // Сначала Telegram. Подтверждение уже перепроверено через API ЮKassa,
        // поэтому сообщение означает реальную успешную оплату.
        let telegramDeliveryError = null;

        try {
            const sent =
                await sendPaidOrderToTelegram(
                    payment
                );

            if (sent) {
                console.log(
                    `YooKassa payment ${paymentId}: paid notification sent to Telegram`
                );
            }
        } catch (telegramError) {
            telegramDeliveryError = telegramError;
            console.error(
                'RTN paid order Telegram error:',
                telegramError.response?.data ||
                telegramError.message
            );
        }

        // Bitrix24 сейчас может быть недоступен по тарифу.
        // CRM-синхронизацию оставляем best-effort и не ломаем webhook.
        try {
            let dealId =
                Number(
                    payment?.metadata?.bitrixDealId ||
                    0
                );

            if (!dealId) {
                const orderId =
                    payment?.metadata?.orderId;

                if (orderId) {
                    dealId =
                        await findExistingBitrixDeal(
                            orderId
                        );
                }
            }

            if (dealId) {
                await moveBitrixDealToPaid({
                    dealId,
                    payment
                });

                console.log(
                    `YooKassa payment ${paymentId}: Bitrix24 deal ${dealId} moved to ${BITRIX_STAGE_PAID}`
                );
            } else {
                console.warn(
                    `YooKassa payment ${paymentId}: Bitrix24 deal not found; Telegram notification already processed`
                );
            }
        } catch (bitrixError) {
            console.error(
                'YooKassa Bitrix24 paid sync error:',
                bitrixError.response?.data ||
                bitrixError.message
            );
        }

        // Если Telegram временно недоступен, не подтверждаем webhook как
        // обработанный: ЮKassa повторит доставку, и оплаченный заказ не потеряется.
        if (telegramDeliveryError) {
            return res.status(502).json({
                ok: false,
                retry: true,
                error: 'Telegram notification delivery failed'
            });
        }

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

app.get('/api/articles', (req, res) => {
    const articles = readBlogArticles()
        .filter(article => article.status === 'published')
        .sort((a, b) => String(b.datePublished).localeCompare(String(a.datePublished)));
    res.json(articles);
});

app.get('/api/articles/:slug', (req, res) => {
    const article = readBlogArticles().find(item =>
        item.status === 'published' && item.slug === String(req.params.slug || '').toLowerCase()
    );
    if (!article) return res.status(404).json({ error: 'Статья не найдена' });
    res.json(article);
});

app.get('/api/admin/articles', requireBlogAdmin, (req, res) => {
    res.json(readBlogArticles().sort((a, b) => String(b.dateModified).localeCompare(String(a.dateModified))));
});

app.get('/api/admin/orders', requireBlogAdmin, async (req, res) => {
    let syncError = '';
    if (String(req.query.refresh || '') === '1') {
        try {
            await syncRecentYooKassaPayments();
        } catch (error) {
            syncError = error.response?.data?.description || error.message;
            console.error('YooKassa orders sync error:', error.response?.data || error.message);
        }
    }
    const orders = readOrders().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ orders, syncError });
});

app.patch('/api/admin/orders/:id/status', requireBlogAdmin, (req, res) => {
    const allowed = ['new', 'processing', 'ready', 'shipped', 'completed', 'cancelled'];
    const fulfillmentStatus = String(req.body?.status || '').trim().toLowerCase();
    if (!allowed.includes(fulfillmentStatus)) {
        return res.status(400).json({ error: 'Некорректный статус заказа' });
    }
    const orders = readOrders();
    const index = orders.findIndex(order => String(order.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ error: 'Заказ не найден' });
    orders[index] = { ...orders[index], fulfillmentStatus, updatedAt: new Date().toISOString() };
    writeOrders(orders);
    res.json(orders[index]);
});

app.get('/api/blog-images/:filename', (req, res) => {
    const filename = path.basename(String(req.params.filename || ''));
    if (!/^[a-z0-9-]+\.(?:jpg|jpeg|png|webp)$/i.test(filename)) {
        return res.status(400).json({ error: 'Некорректное имя файла' });
    }
    const file = path.join(path.dirname(BLOG_DATA_FILE), 'images', filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Изображение не найдено' });
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(file);
});

app.post('/api/admin/article-images', requireBlogAdmin, (req, res) => {
    try {
        const match = String(req.body?.dataUrl || '').match(/^data:image\/(jpeg|png|webp);base64,([a-z0-9+/=]+)$/i);
        if (!match) return res.status(400).json({ error: 'Поддерживаются JPG, PNG и WEBP' });
        const buffer = Buffer.from(match[2], 'base64');
        if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
            return res.status(400).json({ error: 'Размер изображения должен быть не больше 8 МБ' });
        }
        const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
        const filename = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${extension}`;
        const directory = path.join(path.dirname(BLOG_DATA_FILE), 'images');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, filename), buffer);
        res.status(201).json({ url: `${PUBLIC_API_URL}/api/blog-images/${filename}` });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/admin/articles', requireBlogAdmin, (req, res) => {
    try {
        const articles = readBlogArticles();
        const article = normalizeBlogArticle(req.body || {});
        if (articles.some(item => item.slug === article.slug)) {
            return res.status(409).json({ error: 'Статья с таким slug уже существует' });
        }
        articles.push(article);
        writeBlogArticles(articles);
        res.status(201).json(article);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.put('/api/admin/articles/:id', requireBlogAdmin, (req, res) => {
    try {
        const articles = readBlogArticles();
        const index = articles.findIndex(item => String(item.id) === String(req.params.id));
        if (index < 0) return res.status(404).json({ error: 'Статья не найдена' });
        const article = normalizeBlogArticle(req.body || {}, articles[index]);
        if (articles.some((item, itemIndex) => itemIndex !== index && item.slug === article.slug)) {
            return res.status(409).json({ error: 'Статья с таким slug уже существует' });
        }
        if (article.status === 'published' && !article.datePublished) article.datePublished = new Date().toISOString();
        articles[index] = article;
        writeBlogArticles(articles);
        res.json(article);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/admin/articles/:id', requireBlogAdmin, (req, res) => {
    const articles = readBlogArticles();
    const filtered = articles.filter(item => String(item.id) !== String(req.params.id));
    if (filtered.length === articles.length) return res.status(404).json({ error: 'Статья не найдена' });
    writeBlogArticles(filtered);
    res.json({ ok: true });
});

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
        bitrixProductsCached: bitrixProductIdCache.size,
        bitrixPromoTracking: bitrixPromoFieldsReady,
        bitrixOrderFieldsReady: bitrixOrderFieldsReady,
        launchNotifyConfigured: Boolean(
            TELEGRAM_BOT_TOKEN &&
            TELEGRAM_CHAT_ID
        ),
        launchNotifyMode: 'telegram_only',
        launchNotifyTelegramConfigured: Boolean(
            TELEGRAM_BOT_TOKEN &&
            TELEGRAM_CHAT_ID
        ),
        orderTelegramNotificationsConfigured: Boolean(
            TELEGRAM_BOT_TOKEN &&
            TELEGRAM_CHAT_ID
        ),
        ycpAccessTokenConfigured: Boolean(
            YCP_ACCESS_TOKEN
        ),
        ycpApiTokenConfigured: Boolean(
            YCP_API_TOKEN
        ),
        ycpWarehouseId:
            YCP_WAREHOUSE_ID,
        ycpDefaultStock:
            YCP_DEFAULT_STOCK,
        ycpProducts:
            YCP_PRODUCTS.length,
        yookassaConfigured: Boolean(
            YOOKASSA_SHOP_ID &&
            YOOKASSA_SECRET_KEY
        ),
        yookassaShopIdMasked:
            YOOKASSA_SHOP_ID
                ? `***${String(YOOKASSA_SHOP_ID).slice(-4)}`
                : null,
        yookassaShopIdLength:
            YOOKASSA_SHOP_ID.length,
        yookassaSecretKeyLength:
            YOOKASSA_SECRET_KEY.length
    });
});

// ============================================================
// ПРЕДЗАПУСК 01.10.2026 — EMAIL-УВЕДОМЛЕНИЯ
// ============================================================

const launchNotifyRecent = new Map();
const LAUNCH_NOTIFY_TTL =
    5 * 60 * 1000;

function normalizeLaunchEmail(value) {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function isValidLaunchEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(value);
}

function cleanupLaunchNotifyRecent() {
    const now = Date.now();

    for (
        const [key, timestamp]
        of launchNotifyRecent.entries()
    ) {
        if (
            now - timestamp >
            LAUNCH_NOTIFY_TTL
        ) {
            launchNotifyRecent.delete(key);
        }
    }
}

function formatTelegramMoney(value) {
    const amount = Number(value);

    if (!Number.isFinite(amount)) {
        return '—';
    }

    return `${Math.round(amount).toLocaleString('ru-RU')} ₽`;
}

function compactTelegramValue(value, fallback = '—') {
    const text = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();

    return text || fallback;
}

function buildTelegramItemsSummary(items) {
    if (!Array.isArray(items) || !items.length) {
        return '—';
    }

    const lines = items
        .slice(0, 12)
        .map((item, index) => {
            const qty =
                Math.max(
                    1,
                    Number(item?.quantity) || 1
                );

            const name =
                compactTelegramValue(
                    item?.name ||
                    item?.productName ||
                    'Товар'
                );

            const flavor =
                compactTelegramValue(
                    item?.flavor,
                    ''
                );

            const price =
                Number(item?.price);

            const parts = [];

            if (flavor) {
                parts.push(flavor);
            }

            if (Number.isFinite(price)) {
                parts.push(
                    `${formatTelegramMoney(price)} × ${qty}`
                );
            } else {
                parts.push(`× ${qty}`);
            }

            return `${index + 1}. ${name} — ${parts.join(' · ')}`;
        });

    if (items.length > 12) {
        lines.push(
            `…ещё ${items.length - 12} поз.`
        );
    }

    return lines.join('\n');
}

async function sendTelegramText(text) {
    if (
        !TELEGRAM_BOT_TOKEN ||
        !TELEGRAM_CHAT_ID
    ) {
        throw new Error(
            'Telegram не настроен: нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID'
        );
    }

    await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
            chat_id:
                TELEGRAM_CHAT_ID,

            text:
                String(text || '')
                    .slice(0, 3900),

            disable_web_page_preview:
                true
        },
        {
            timeout:
                10000
        }
    );
}

async function sendOrderAttemptToTelegram({
    amount,
    items,
    customer,
    delivery,
    orderId,
    promoCode,
    comment
}) {
    const deliveryAddress =
        compactTelegramValue(
            delivery?.address ||
            delivery?.city
        );

    const text = [
        '🛒 RTN.PRO — ПОПЫТКА ЗАКАЗА',
        '',
        `Заказ: ${compactTelegramValue(orderId)}`,
        `Сумма: ${formatTelegramMoney(amount)}`,
        `Имя: ${compactTelegramValue(customer?.name)}`,
        `Телефон: ${compactTelegramValue(customer?.phone)}`,
        `Email: ${compactTelegramValue(customer?.email)}`,
        `Получение: ${compactTelegramValue(delivery?.method)}`,
        `Адрес: ${deliveryAddress}`,
        `Промокод: ${normalizePromoCode(promoCode) || 'НЕТ'}`,
        comment
            ? `Комментарий: ${compactTelegramValue(comment)}`
            : null,
        '',
        'Товары:',
        buildTelegramItemsSummary(items)
    ]
        .filter(Boolean)
        .join('\n');

    await sendTelegramText(text);
}

const paidTelegramNotifications =
    new Map();

const PAID_TELEGRAM_TTL =
    24 * 60 * 60 * 1000;

function cleanupPaidTelegramNotifications() {
    const now = Date.now();

    for (
        const [paymentId, timestamp]
        of paidTelegramNotifications.entries()
    ) {
        if (
            now - timestamp >
            PAID_TELEGRAM_TTL
        ) {
            paidTelegramNotifications.delete(
                paymentId
            );
        }
    }
}

async function sendPaidOrderToTelegram(payment) {
    const paymentId =
        compactTelegramValue(
            payment?.id
        );

    cleanupPaidTelegramNotifications();

    if (
        paymentId !== '—' &&
        paidTelegramNotifications.has(
            paymentId
        )
    ) {
        return false;
    }

    const metadata =
        payment?.metadata || {};

    const deliveryAddress = [
        metadata.deliveryCity,
        metadata.deliveryAddress
    ]
        .filter(Boolean)
        .join(', ');

    const text = [
        '✅ RTN.PRO — ЗАКАЗ ОПЛАЧЕН',
        '',
        `Заказ: ${compactTelegramValue(metadata.orderId)}`,
        `Платёж: ${paymentId}`,
        `Сумма: ${formatTelegramMoney(payment?.amount?.value)}`,
        `Имя: ${compactTelegramValue(metadata.customerName)}`,
        `Телефон: ${compactTelegramValue(metadata.customerPhone)}`,
        `Email: ${compactTelegramValue(metadata.customerEmail)}`,
        `Получение: ${compactTelegramValue(metadata.deliveryMethod)}`,
        `Адрес: ${compactTelegramValue(deliveryAddress)}`,
        `Промокод: ${normalizePromoCode(metadata.promoCode) || 'НЕТ'}`,
        '',
        'Статус ЮKassa: ОПЛАЧЕН ✓'
    ].join('\n');

    await sendTelegramText(text);

    if (paymentId !== '—') {
        paidTelegramNotifications.set(
            paymentId,
            Date.now()
        );
    }

    return true;
}

async function sendLaunchNotifyToTelegram({
    email,
    source
}) {
    if (
        !TELEGRAM_BOT_TOKEN ||
        !TELEGRAM_CHAT_ID
    ) {
        throw new Error(
            'Telegram не настроен: нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID'
        );
    }

    const text = [
        '🦏 RTN.PRO — новая подписка на старт продаж',
        '',
        `Email: ${email}`,
        'Старт: 01.10.2026 00:00 МСК',
        `Источник: ${source || 'preloader rtn.pro'}`
    ].join('\n');

    await sendTelegramText(text);
}

app.post(
    '/api/launch-notify',
    async (req, res) => {
        const email =
            normalizeLaunchEmail(
                req.body?.email
            );

        const source =
            String(
                req.body?.source ||
                'preloader rtn.pro'
            ).trim();

        if (!isValidLaunchEmail(email)) {
            return res
                .status(400)
                .json({
                    ok: false,
                    error:
                        'Укажите корректный email'
                });
        }

        cleanupLaunchNotifyRecent();

        const ip =
            String(
                req.headers[
                    'x-forwarded-for'
                ] ||
                req.socket?.remoteAddress ||
                ''
            )
                .split(',')[0]
                .trim();

        const dedupeKey =
            `${email}|${ip}`;

        const recentAt =
            launchNotifyRecent.get(
                dedupeKey
            );

        if (
            recentAt &&
            Date.now() - recentAt <
            LAUNCH_NOTIFY_TTL
        ) {
            return res.json({
                ok: true,
                duplicate: true,
                telegramSent: true
            });
        }

        try {
            await sendLaunchNotifyToTelegram({
                email,
                source
            });

            launchNotifyRecent.set(
                dedupeKey,
                Date.now()
            );

            console.log(
                `RTN launch notify sent to Telegram: ${email}`
            );

            return res.json({
                ok: true,
                telegramSent: true,
                mode: 'telegram_only'
            });

        } catch (error) {
            console.error(
                'RTN launch notify Telegram error:',
                error.response?.data ||
                error.message
            );

            return res
                .status(503)
                .json({
                    ok: false,
                    error:
                        'Не удалось отправить уведомление в Telegram. Проверьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.'
                });
        }
    }
);

// ============================================================
// ПЛЁНОШНАЯ — ЛИДЫ С САЙТА
// ============================================================

const PLENOSHNAYA_ALLOWED_ORIGINS = new Set([
    'https://plenoshnaya.ru',
    'https://www.plenoshnaya.ru'
]);

function cleanPlenoshnayaLeadValue(value, max = 1000) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function isPlenoshnayaOriginAllowed(req) {
    const origin = String(req.get('origin') || '')
        .trim()
        .replace(/\/$/, '');

    // No Origin is allowed for server-side/manual diagnostics.
    return !origin || PLENOSHNAYA_ALLOWED_ORIGINS.has(origin);
}

const PLENOSHNAYA_IDENTITY_TTL_MS =
    365 * 24 * 60 * 60 * 1000;

const plenoshnayaIdentifyRecent =
    new Map();

function plenoshnayaIdentityKey() {
    if (!PLENOSHNAYA_IDENTITY_SECRET) {
        return null;
    }

    return crypto
        .createHash('sha256')
        .update(
            PLENOSHNAYA_IDENTITY_SECRET,
            'utf8'
        )
        .digest();
}

function sealPlenoshnayaIdentity(payload = {}) {
    const key =
        plenoshnayaIdentityKey();

    if (!key) {
        return '';
    }

    const iv =
        crypto.randomBytes(12);

    const cipher =
        crypto.createCipheriv(
            'aes-256-gcm',
            key,
            iv
        );

    const data =
        Buffer.from(
            JSON.stringify({
                v: 1,
                createdAt:
                    Date.now(),
                name:
                    cleanPlenoshnayaLeadValue(
                        payload.name,
                        160
                    ),
                phone:
                    cleanPlenoshnayaLeadValue(
                        payload.phone,
                        80
                    ),
                email:
                    cleanPlenoshnayaLeadValue(
                        payload.email,
                        254
                    )
            }),
            'utf8'
        );

    const encrypted =
        Buffer.concat([
            cipher.update(data),
            cipher.final()
        ]);

    const tag =
        cipher.getAuthTag();

    return [
        iv.toString('base64url'),
        tag.toString('base64url'),
        encrypted.toString('base64url')
    ].join('.');
}

function openPlenoshnayaIdentity(token) {
    const key =
        plenoshnayaIdentityKey();

    if (
        !key ||
        !token
    ) {
        return null;
    }

    try {
        const parts =
            String(token)
                .split('.');

        if (parts.length !== 3) {
            return null;
        }

        const iv =
            Buffer.from(
                parts[0],
                'base64url'
            );

        const tag =
            Buffer.from(
                parts[1],
                'base64url'
            );

        const encrypted =
            Buffer.from(
                parts[2],
                'base64url'
            );

        const decipher =
            crypto.createDecipheriv(
                'aes-256-gcm',
                key,
                iv
            );

        decipher.setAuthTag(tag);

        const decoded =
            Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ])
                .toString('utf8');

        const identity =
            JSON.parse(decoded);

        if (
            !identity ||
            identity.v !== 1 ||
            !identity.createdAt ||
            Date.now() -
                Number(identity.createdAt) >
                PLENOSHNAYA_IDENTITY_TTL_MS
        ) {
            return null;
        }

        return {
            name:
                cleanPlenoshnayaLeadValue(
                    identity.name,
                    160
                ),
            phone:
                cleanPlenoshnayaLeadValue(
                    identity.phone,
                    80
                ),
            email:
                cleanPlenoshnayaLeadValue(
                    identity.email,
                    254
                )
        };

    } catch (error) {
        return null;
    }
}

function cleanupPlenoshnayaIdentifyRecent() {
    const now =
        Date.now();

    for (
        const [key, timestamp]
        of plenoshnayaIdentifyRecent.entries()
    ) {
        if (
            now - timestamp >
            6 * 60 * 60 * 1000
        ) {
            plenoshnayaIdentifyRecent.delete(key);
        }
    }
}

const PLENOSHNAYA_IP_CACHE_TTL_MS =
    6 * 60 * 60 * 1000;

const plenoshnayaIpCache =
    new Map();

function isPublicIpForLookup(ip) {
    const value =
        String(ip || '')
            .trim()
            .replace(/^::ffff:/, '');

    if (!value) {
        return false;
    }

    if (
        value === '::1' ||
        value === '127.0.0.1' ||
        /^10\./.test(value) ||
        /^192\.168\./.test(value) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(value) ||
        /^169\.254\./.test(value) ||
        /^fc/i.test(value) ||
        /^fd/i.test(value) ||
        /^fe80:/i.test(value)
    ) {
        return false;
    }

    return true;
}

async function getPlenoshnayaIpInfo(ip) {
    const cleanIp =
        String(ip || '')
            .trim()
            .replace(/^::ffff:/, '');

    if (!isPublicIpForLookup(cleanIp)) {
        return null;
    }

    const cached =
        plenoshnayaIpCache.get(cleanIp);

    if (
        cached &&
        Date.now() - cached.savedAt <
            PLENOSHNAYA_IP_CACHE_TTL_MS
    ) {
        return cached.data;
    }

    try {
        const response =
            await axios.get(
                `https://ipapi.co/${encodeURIComponent(cleanIp)}/json/`,
                {
                    timeout: 1800,
                    headers: {
                        Accept: 'application/json',
                        'User-Agent':
                            'Plenoshnaya/1.0'
                    }
                }
            );

        const data =
            response.data || {};

        if (
            data.error ||
            !data.ip
        ) {
            return null;
        }

        const normalized = {
            city:
                cleanPlenoshnayaLeadValue(
                    data.city,
                    120
                ),
            region:
                cleanPlenoshnayaLeadValue(
                    data.region,
                    160
                ),
            country:
                cleanPlenoshnayaLeadValue(
                    data.country_name ||
                    data.country_code ||
                    data.country,
                    120
                ),
            countryCode:
                cleanPlenoshnayaLeadValue(
                    data.country_code ||
                    data.country,
                    20
                ),
            timezone:
                cleanPlenoshnayaLeadValue(
                    data.timezone,
                    120
                ),
            asn:
                cleanPlenoshnayaLeadValue(
                    data.asn,
                    80
                ),
            org:
                cleanPlenoshnayaLeadValue(
                    data.org,
                    200
                )
        };

        if (
            plenoshnayaIpCache.size >
            1000
        ) {
            const oldestKey =
                plenoshnayaIpCache
                    .keys()
                    .next()
                    .value;

            if (oldestKey) {
                plenoshnayaIpCache.delete(
                    oldestKey
                );
            }
        }

        plenoshnayaIpCache.set(
            cleanIp,
            {
                savedAt:
                    Date.now(),
                data:
                    normalized
            }
        );

        return normalized;

    } catch (error) {
        console.warn(
            'Plenoshnaya IP lookup skipped:',
            error.response?.status ||
            error.code ||
            error.message
        );

        return null;
    }
}

// ============================================================
// ПЛЁНОШНАЯ — LIVE-КАРТОЧКА ВИЗИТА В TELEGRAM
// ============================================================

const PLENOSHNAYA_VISIT_CARD_TTL_MS =
    12 * 60 * 60 * 1000;

const plenoshnayaVisitCards =
    new Map();

function cleanupPlenoshnayaVisitCards() {
    const now =
        Date.now();

    for (
        const [key, card]
        of plenoshnayaVisitCards.entries()
    ) {
        if (
            !card ||
            now - Number(card.lastSeenAt || card.startedAt || 0) >
                PLENOSHNAYA_VISIT_CARD_TTL_MS
        ) {
            plenoshnayaVisitCards.delete(key);
        }
    }
}

function formatPlenoshnayaMoscowTime(value) {
    try {
        return new Intl.DateTimeFormat(
            'ru-RU',
            {
                timeZone: 'Europe/Moscow',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }
        ).format(
            new Date(value || Date.now())
        );
    } catch (error) {
        return new Date(
            value || Date.now()
        ).toISOString().slice(11, 19);
    }
}

function formatPlenoshnayaVisitDuration(startedAt, lastSeenAt) {
    const seconds =
        Math.max(
            0,
            Math.round(
                (
                    Number(lastSeenAt || Date.now()) -
                    Number(startedAt || Date.now())
                ) / 1000
            )
        );

    const minutes =
        Math.floor(seconds / 60);

    const rest =
        seconds % 60;

    if (minutes >= 60) {
        const hours =
            Math.floor(minutes / 60);

        const minuteRest =
            minutes % 60;

        return `${hours} ч ${minuteRest} мин`;
    }

    if (minutes > 0) {
        return `${minutes} мин ${rest} сек`;
    }

    return `${rest} сек`;
}

function shortPlenoshnayaVisitId(value) {
    const clean =
        cleanPlenoshnayaLeadValue(
            value,
            120
        );

    if (!clean) {
        return '—';
    }

    return clean
        .replace(/[^a-z0-9]/gi, '')
        .slice(-8)
        .toUpperCase() || clean.slice(-8);
}

function getPlenoshnayaVisitCardKey(payload = {}) {
    const sessionId =
        cleanPlenoshnayaLeadValue(
            payload.sessionId ||
            payload.session_id,
            120
        );

    if (sessionId) {
        return `session:${sessionId}`;
    }

    const visitorId =
        cleanPlenoshnayaLeadValue(
            payload.visitorId ||
            payload.visitor_id,
            120
        );

    if (visitorId) {
        return `visitor:${visitorId}`;
    }

    const visitorIp =
        cleanPlenoshnayaLeadValue(
            payload.visitorIp ||
            payload.visitor_ip,
            120
        );

    if (visitorIp) {
        return `ip:${visitorIp}`;
    }

    return '';
}

function buildPlenoshnayaVisitEventLabel(
    eventType,
    payload = {}
) {
    const pageTitle =
        cleanPlenoshnayaLeadValue(
            payload.pageTitle ||
            payload.page_title,
            120
        );

    const page =
        cleanPlenoshnayaLeadValue(
            payload.page,
            220
        );

    const placement =
        cleanPlenoshnayaLeadValue(
            payload.placement,
            120
        );

    const calculatorSelection =
        cleanPlenoshnayaLeadValue(
            payload.calculatorSelection ||
            payload.calculator_selection,
            260
        );

    const labels = {
        visit_start:
            'зашёл на сайт',
        page_view:
            `открыл: ${pageTitle || page || 'страницу'}`,
        visit_end:
            'завершил визит',
        form_open:
            `открыл форму записи${placement ? ` · ${placement}` : ''}`,
        phone_click:
            'нажал на телефон',
        whatsapp_click:
            'открыл WhatsApp',
        telegram_click:
            'открыл Telegram',
        contact_share:
            'поделился контактами',
        consent_accept:
            'принял cookies',
        consent_necessary:
            'оставил только необходимые cookies',
        calculator_action:
            calculatorSelection
                ? `калькулятор: ${calculatorSelection}`
                : 'изменил расчёт в калькуляторе'
    };

    return cleanPlenoshnayaLeadValue(
        labels[eventType] || eventType,
        320
    );
}

async function callPlenoshnayaTelegram(
    method,
    payload
) {
    if (
        !PLENOSHNAYA_TG_BOT_TOKEN ||
        !PLENOSHNAYA_TG_CHAT_ID
    ) {
        throw new Error(
            'Plenoshnaya Telegram is not configured'
        );
    }

    const response =
        await axios.post(
            `https://api.telegram.org/bot${PLENOSHNAYA_TG_BOT_TOKEN}/${method}`,
            payload,
            {
                timeout:
                    10000
            }
        );

    if (!response.data?.ok) {
        throw new Error(
            response.data?.description ||
            'Telegram returned ok=false'
        );
    }

    return response.data.result;
}

function buildPlenoshnayaVisitCardText(card) {
    const status =
        card.hasLead
            ? '🔥 ЗАЯВКА'
            : (
                card.ended
                    ? '⚫ ВИЗИТ ЗАВЕРШЁН'
                    : '🟢 НА САЙТЕ'
            );

    const source =
        [
            card.utmSource,
            card.utmMedium
        ]
            .filter(Boolean)
            .join(' / ');

    const location =
        [
            card.city,
            card.region,
            card.country
        ]
            .filter(Boolean)
            .join(', ');

    const currentPage =
        card.pageTitle ||
        card.page ||
        '—';

    const actions =
        Array.isArray(card.events)
            ? card.events.slice(-8)
            : [];

    const lines = [
        `👤 ПЛЁНОШНАЯ — ВИЗИТ #${shortPlenoshnayaVisitId(card.sessionId || card.visitorId || card.key)}`,
        `Статус: ${status}`,
        `⏱ На сайте: ${formatPlenoshnayaVisitDuration(card.startedAt, card.lastSeenAt)}`,
        card.visitCount
            ? `🔁 Визит пользователя: ${card.visitCount}`
            : null,
        card.pageCount
            ? `📚 Страниц в сессии: ${card.pageCount}`
            : null,
        '',
        card.hasLead && card.name
            ? `👤 Имя: ${card.name}`
            : null,
        card.hasLead && card.phone
            ? `📞 Телефон: ${card.phone}`
            : null,
        card.hasLead && card.service
            ? `🚘 Заявка: ${card.service}`
            : null,
        `📍 Сейчас: ${currentPage}`,
        source
            ? `📣 Источник: ${source}`
            : null,
        card.utmCampaign
            ? `🎯 Кампания: ${card.utmCampaign}`
            : null,
        card.searchPhrase
            ? `🔍 Поиск: ${card.searchPhrase}`
            : null,
        card.yclid
            ? `🟡 yclid: ${card.yclid}`
            : null,
        card.metrikaClientId
            ? `📊 Метрика ClientID: ${card.metrikaClientId}`
            : null,
        card.referrer
            ? `↩️ Referrer: ${card.referrer}`
            : null,
        location
            ? `🌍 Гео по сети: ${location}`
            : null,
        card.device || card.browser
            ? `📱 ${[card.device, card.browser].filter(Boolean).join(' · ')}`
            : null,
        card.calculatorSelection
            ? `🧮 Калькулятор: ${card.calculatorSelection}`
            : null,
        card.pageHistory
            ? `🧭 Маршрут: ${card.pageHistory}`
            : null,
        '',
        actions.length
            ? 'Последние действия:'
            : null,
        ...actions.map(
            event =>
                `${event.time} — ${event.label}`
        )
    ];

    return lines
        .filter(
            value =>
                value !== null &&
                value !== undefined
        )
        .join('\n')
        .slice(0, 3900);
}

async function upsertPlenoshnayaVisitCard(
    payload = {}
) {
    const key =
        getPlenoshnayaVisitCardKey(
            payload
        );

    if (!key) {
        return {
            updated: false,
            reason: 'no_visit_key'
        };
    }

    cleanupPlenoshnayaVisitCards();

    const now =
        Date.now();

    let card =
        plenoshnayaVisitCards.get(key);

    if (!card) {
        card = {
            key,
            messageId: null,
            startedAt: now,
            lastSeenAt: now,
            events: [],
            hasLead: false,
            ended: false
        };
    }

    const assign = (
        field,
        value
    ) => {
        const clean =
            cleanPlenoshnayaLeadValue(
                value,
                field === 'pageHistory' ||
                field === 'calculatorSelection'
                    ? 1400
                    : 1000
            );

        if (clean) {
            card[field] = clean;
        }
    };

    assign(
        'sessionId',
        payload.sessionId ||
        payload.session_id
    );

    assign(
        'visitorId',
        payload.visitorId ||
        payload.visitor_id
    );

    assign(
        'visitCount',
        payload.visitCount ||
        payload.visit_count
    );

    assign(
        'page',
        payload.page
    );

    assign(
        'pageTitle',
        payload.pageTitle ||
        payload.page_title
    );

    assign(
        'referrer',
        payload.referrer
    );

    assign(
        'utmSource',
        payload.utmSource ||
        payload.utm_source
    );

    assign(
        'utmMedium',
        payload.utmMedium ||
        payload.utm_medium
    );

    assign(
        'utmCampaign',
        payload.utmCampaign ||
        payload.utm_campaign
    );

    assign(
        'searchPhrase',
        payload.searchPhrase ||
        payload.search_phrase
    );

    assign(
        'yclid',
        payload.yclid
    );

    assign(
        'metrikaClientId',
        payload.metrikaClientId ||
        payload.metrika_client_id ||
        payload.client_id
    );

    assign(
        'device',
        payload.device
    );

    assign(
        'browser',
        payload.browser
    );

    assign(
        'pageCount',
        payload.pageCount ||
        payload.page_count
    );

    assign(
        'pageHistory',
        payload.pageHistory ||
        payload.page_history
    );

    assign(
        'calculatorSelection',
        payload.calculatorSelection ||
        payload.calculator_selection
    );

    assign(
        'name',
        payload.name
    );

    assign(
        'phone',
        payload.phone
    );

    assign(
        'service',
        payload.service
    );

    const ipInfo =
        payload.ipInfo ||
        payload.ip_info ||
        null;

    if (ipInfo) {
        assign(
            'city',
            ipInfo.city
        );
        assign(
            'region',
            ipInfo.region
        );
        assign(
            'country',
            ipInfo.country
        );
    }

    card.lastSeenAt =
        now;

    const eventType =
        cleanPlenoshnayaLeadValue(
            payload.eventType ||
            payload.event_type ||
            payload.type,
            80
        );

    if (eventType === 'visit_end') {
        card.ended = true;
    } else if (
        eventType &&
        eventType !== 'heartbeat'
    ) {
        card.ended = false;
    }

    if (
        payload.hasLead === true ||
        payload.has_lead === true ||
        eventType === 'lead'
    ) {
        card.hasLead = true;
        card.ended = false;
    }

    if (
        eventType &&
        eventType !== 'heartbeat'
    ) {
        const label =
            cleanPlenoshnayaLeadValue(
                payload.eventLabel ||
                payload.event_label,
                320
            ) ||
            buildPlenoshnayaVisitEventLabel(
                eventType,
                payload
            );

        if (label) {
            const previous =
                card.events[
                    card.events.length - 1
                ];

            if (
                !previous ||
                previous.label !== label ||
                now - previous.at > 2500
            ) {
                card.events.push({
                    at: now,
                    time:
                        formatPlenoshnayaMoscowTime(
                            now
                        ),
                    label
                });
            }

            if (card.events.length > 20) {
                card.events =
                    card.events.slice(-20);
            }
        }
    }

    const text =
        buildPlenoshnayaVisitCardText(
            card
        );

    if (card.messageId) {
        try {
            await callPlenoshnayaTelegram(
                'editMessageText',
                {
                    chat_id:
                        PLENOSHNAYA_TG_CHAT_ID,
                    message_id:
                        card.messageId,
                    text,
                    disable_web_page_preview:
                        true
                }
            );

            plenoshnayaVisitCards.set(
                key,
                card
            );

            return {
                updated: true,
                created: false,
                messageId:
                    card.messageId
            };

        } catch (error) {
            const description =
                String(
                    error.response?.data?.description ||
                    error.message ||
                    ''
                );

            if (
                /message is not modified/i
                    .test(description)
            ) {
                plenoshnayaVisitCards.set(
                    key,
                    card
                );

                return {
                    updated: true,
                    created: false,
                    messageId:
                        card.messageId,
                    unchanged: true
                };
            }

            console.warn(
                'Plenoshnaya visit card edit failed, creating a new card:',
                description
            );

            card.messageId = null;
        }
    }

    const result =
        await callPlenoshnayaTelegram(
            'sendMessage',
            {
                chat_id:
                    PLENOSHNAYA_TG_CHAT_ID,
                text,
                disable_web_page_preview:
                    true
            }
        );

    card.messageId =
        result?.message_id ||
        null;

    plenoshnayaVisitCards.set(
        key,
        card
    );

    return {
        updated: true,
        created: true,
        messageId:
            card.messageId
    };
}

app.get('/api/plenoshnaya/health', (req, res) => {
    return res.json({
        ok: true,
        service: 'plenoshnaya-leads',
        telegramConfigured: Boolean(
            PLENOSHNAYA_TG_BOT_TOKEN &&
            PLENOSHNAYA_TG_CHAT_ID
        ),
        identityConfigured: Boolean(
            PLENOSHNAYA_IDENTITY_SECRET
        ),
        liveVisitCards:
            plenoshnayaVisitCards.size
    });
});

app.post('/api/plenoshnaya/lead', async (req, res) => {
    if (!isPlenoshnayaOriginAllowed(req)) {
        return res.status(403).json({
            ok: false,
            error: 'Origin not allowed'
        });
    }

    if (
        !PLENOSHNAYA_TG_BOT_TOKEN ||
        !PLENOSHNAYA_TG_CHAT_ID
    ) {
        console.error(
            'Plenoshnaya Telegram is not configured'
        );

        return res.status(503).json({
            ok: false,
            error: 'Telegram is not configured'
        });
    }

    const body = req.body || {};

    // Honeypot: real users never fill this field.
    if (cleanPlenoshnayaLeadValue(body.website, 200)) {
        return res.json({ ok: true });
    }

    const name =
        cleanPlenoshnayaLeadValue(
            body.name,
            160
        );

    const phone =
        cleanPlenoshnayaLeadValue(
            body.phone,
            60
        );

    const phoneDigits =
        phone.replace(/\D/g, '');

    if (
        !name ||
        phoneDigits.length < 10 ||
        phoneDigits.length > 15
    ) {
        return res.status(400).json({
            ok: false,
            error: 'Введите имя и корректный телефон'
        });
    }

    const service =
        cleanPlenoshnayaLeadValue(
            body.service,
            1200
        ) || 'Не указана';

    const page =
        cleanPlenoshnayaLeadValue(
            body.page,
            1000
        );

    const pageTitle =
        cleanPlenoshnayaLeadValue(
            body.page_title ||
            body.pageTitle,
            300
        );

    const referrer =
        cleanPlenoshnayaLeadValue(
            body.referrer,
            1000
        );

    const utmSource =
        cleanPlenoshnayaLeadValue(
            body.utm_source,
            200
        );

    const utmMedium =
        cleanPlenoshnayaLeadValue(
            body.utm_medium,
            200
        );

    const utmCampaign =
        cleanPlenoshnayaLeadValue(
            body.utm_campaign,
            300
        );

    const utmContent =
        cleanPlenoshnayaLeadValue(
            body.utm_content,
            300
        );

    const utmTerm =
        cleanPlenoshnayaLeadValue(
            body.utm_term,
            300
        );

    const searchPhrase =
        cleanPlenoshnayaLeadValue(
            body.search_phrase ||
            body.searchPhrase,
            500
        );

    const adPhrase =
        cleanPlenoshnayaLeadValue(
            body.ad_phrase ||
            body.adPhrase,
            500
        );

    const yclid =
        cleanPlenoshnayaLeadValue(
            body.yclid,
            500
        );

    const leadId =
        cleanPlenoshnayaLeadValue(
            body.lead_id ||
            body.leadId,
            100
        );

    const visitorId =
        cleanPlenoshnayaLeadValue(
            body.visitor_id ||
            body.visitorId,
            120
        );

    const sessionId =
        cleanPlenoshnayaLeadValue(
            body.session_id ||
            body.sessionId,
            120
        );

    const visitCount =
        cleanPlenoshnayaLeadValue(
            body.visit_count ||
            body.visitCount,
            20
        );

    const pageCount =
        cleanPlenoshnayaLeadValue(
            body.page_count ||
            body.pageCount,
            40
        );

    const pageHistory =
        cleanPlenoshnayaLeadValue(
            body.page_history ||
            body.pageHistory,
            1400
        );

    const calculatorSelection =
        cleanPlenoshnayaLeadValue(
            body.calculator_selection ||
            body.calculatorSelection,
            1400
        );

    const metrikaClientId =
        cleanPlenoshnayaLeadValue(
            body.metrika_client_id ||
            body.metrikaClientId ||
            body.client_id,
            120
        );

    const device =
        cleanPlenoshnayaLeadValue(
            body.device,
            240
        );

    const browser =
        cleanPlenoshnayaLeadValue(
            body.browser,
            240
        );

    const forwardedFor =
        cleanPlenoshnayaLeadValue(
            req.get('x-forwarded-for'),
            300
        );

    const visitorIp =
        cleanPlenoshnayaLeadValue(
            forwardedFor
                ? forwardedFor.split(',')[0]
                : req.ip,
            120
        );

    const source =
        [utmSource, utmMedium]
            .filter(Boolean)
            .join(' / ');

    const text = [
        '🔥 ПЛЁНОШНАЯ — НОВАЯ ЗАЯВКА',
        '',
        `👤 Имя: ${name}`,
        `📞 Телефон: ${phone}`,
        `🚘 Услуга: ${service}`,
        '',
        pageTitle
            ? `📄 Страница: ${pageTitle}`
            : null,
        page
            ? `🔗 ${page}`
            : null,
        referrer
            ? `↩️ Referrer: ${referrer}`
            : null,
        source
            ? `📣 Источник: ${source}`
            : null,
        utmCampaign
            ? `🎯 Кампания: ${utmCampaign}`
            : null,
        utmContent
            ? `🧩 UTM content: ${utmContent}`
            : null,
        utmTerm
            ? `🔎 UTM term: ${utmTerm}`
            : null,
        searchPhrase
            ? `🔍 Поисковая фраза: ${searchPhrase}`
            : null,
        adPhrase
            ? `📢 Рекламная фраза: ${adPhrase}`
            : null,
        yclid
            ? `🟡 yclid: ${yclid}`
            : null,
        leadId
            ? `🆔 Lead ID: ${leadId}`
            : null
    ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 3900);

    try {
        const telegramResponse =
            await axios.post(
                `https://api.telegram.org/bot${PLENOSHNAYA_TG_BOT_TOKEN}/sendMessage`,
                {
                    chat_id:
                        PLENOSHNAYA_TG_CHAT_ID,

                    text,

                    disable_web_page_preview:
                        true
                },
                {
                    timeout:
                        10000
                }
            );

        if (!telegramResponse.data?.ok) {
            throw new Error(
                telegramResponse.data?.description ||
                'Telegram returned ok=false'
            );
        }

        console.log(
            `Plenoshnaya lead sent to Telegram: ${phoneDigits.slice(-4)}`
        );

        try {
            const ipInfo =
                await getPlenoshnayaIpInfo(
                    visitorIp
                );

            await upsertPlenoshnayaVisitCard({
                eventType: 'lead',
                eventLabel:
                    `🔥 отправил заявку: ${service}`,
                hasLead: true,
                name,
                phone,
                service,
                visitorId,
                sessionId,
                visitCount,
                pageCount,
                pageHistory,
                calculatorSelection,
                metrikaClientId,
                page,
                pageTitle,
                referrer,
                utmSource,
                utmMedium,
                utmCampaign,
                searchPhrase,
                yclid,
                device,
                browser,
                visitorIp,
                ipInfo
            });
        } catch (visitCardError) {
            console.warn(
                'Plenoshnaya lead visit card update skipped:',
                visitCardError.response?.data ||
                visitCardError.message
            );
        }

        const identityToken =
            sealPlenoshnayaIdentity({
                name,
                phone,
                email:
                    cleanPlenoshnayaLeadValue(
                        body.email,
                        254
                    )
            });

        return res.json({
            ok: true,
            telegramSent: true,
            identityToken:
                identityToken || undefined
        });

    } catch (error) {
        console.error(
            'Plenoshnaya Telegram error:',
            error.response?.data ||
            error.message
        );

        return res.status(502).json({
            ok: false,
            error:
                'Не удалось отправить заявку'
        });
    }
});

// ============================================================
// ПЛЁНОШНАЯ — FIRST-PARTY IDENTITY RESOLUTION
// ============================================================

app.post('/api/plenoshnaya/identify', async (req, res) => {
    if (!isPlenoshnayaOriginAllowed(req)) {
        return res.status(403).json({
            ok: false,
            error: 'Origin not allowed'
        });
    }

    const body =
        req.body || {};

    const identity =
        openPlenoshnayaIdentity(
            cleanPlenoshnayaLeadValue(
                body.identity_token ||
                body.identityToken,
                5000
            )
        );

    if (!identity) {
        return res.json({
            ok: true,
            identified: false
        });
    }

    const visitorId =
        cleanPlenoshnayaLeadValue(
            body.visitor_id ||
            body.visitorId,
            120
        );

    const sessionId =
        cleanPlenoshnayaLeadValue(
            body.session_id ||
            body.sessionId,
            120
        );

    const visitCount =
        cleanPlenoshnayaLeadValue(
            body.visit_count ||
            body.visitCount,
            20
        );

    const page =
        cleanPlenoshnayaLeadValue(
            body.page,
            1000
        );

    const pageTitle =
        cleanPlenoshnayaLeadValue(
            body.page_title ||
            body.pageTitle,
            300
        );

    const referrer =
        cleanPlenoshnayaLeadValue(
            body.referrer,
            1000
        );

    const utmSource =
        cleanPlenoshnayaLeadValue(
            body.utm_source,
            200
        );

    const utmMedium =
        cleanPlenoshnayaLeadValue(
            body.utm_medium,
            200
        );

    const utmCampaign =
        cleanPlenoshnayaLeadValue(
            body.utm_campaign,
            300
        );

    const utmContent =
        cleanPlenoshnayaLeadValue(
            body.utm_content,
            300
        );

    const utmTerm =
        cleanPlenoshnayaLeadValue(
            body.utm_term,
            300
        );

    const searchPhrase =
        cleanPlenoshnayaLeadValue(
            body.search_phrase ||
            body.searchPhrase,
            500
        );

    const adPhrase =
        cleanPlenoshnayaLeadValue(
            body.ad_phrase ||
            body.adPhrase,
            500
        );

    const yclid =
        cleanPlenoshnayaLeadValue(
            body.yclid,
            500
        );

    const device =
        cleanPlenoshnayaLeadValue(
            body.device,
            240
        );

    const browser =
        cleanPlenoshnayaLeadValue(
            body.browser,
            240
        );

    const timezone =
        cleanPlenoshnayaLeadValue(
            body.timezone,
            120
        );

    const screen =
        cleanPlenoshnayaLeadValue(
            body.screen,
            80
        );

    const forwardedFor =
        cleanPlenoshnayaLeadValue(
            req.get('x-forwarded-for'),
            300
        );

    const visitorIp =
        cleanPlenoshnayaLeadValue(
            (
                forwardedFor
                    ? forwardedFor.split(',')[0]
                    : req.ip
            ),
            120
        );

    cleanupPlenoshnayaIdentifyRecent();

    const dedupeKey =
        [
            sessionId ||
                visitorId ||
                visitorIp,
            identity.phone ||
                identity.email ||
                identity.name
        ]
            .filter(Boolean)
            .join('|');

    if (
        dedupeKey &&
        plenoshnayaIdentifyRecent.has(
            dedupeKey
        )
    ) {
        return res.json({
            ok: true,
            identified: true,
            duplicate: true
        });
    }

    const source =
        [utmSource, utmMedium]
            .filter(Boolean)
            .join(' / ');

    const text = [
        '🎯 ПЛЁНОШНАЯ — УЗНАН ПОВТОРНЫЙ ПОСЕТИТЕЛЬ',
        '',
        identity.name
            ? `👤 Имя: ${identity.name}`
            : null,
        identity.phone
            ? `📞 Телефон: ${identity.phone}`
            : null,
        identity.email
            ? `✉️ Email: ${identity.email}`
            : null,
        visitCount
            ? `🔁 Визит: ${visitCount}`
            : null,
        pageTitle
            ? `📄 Страница: ${pageTitle}`
            : null,
        page
            ? `🔗 ${page}`
            : null,
        referrer
            ? `↩️ Referrer: ${referrer}`
            : null,
        source
            ? `📣 Источник: ${source}`
            : null,
        utmCampaign
            ? `🎯 Кампания: ${utmCampaign}`
            : null,
        utmContent
            ? `🧩 UTM content: ${utmContent}`
            : null,
        utmTerm
            ? `🔎 UTM term: ${utmTerm}`
            : null,
        searchPhrase
            ? `🔍 Поисковая фраза: ${searchPhrase}`
            : null,
        adPhrase
            ? `📢 Рекламная фраза: ${adPhrase}`
            : null,
        yclid
            ? `🟡 yclid: ${yclid}`
            : null,
        visitorId
            ? `👣 Visitor ID: ${visitorId}`
            : null,
        sessionId
            ? `🧭 Session ID: ${sessionId}`
            : null,
        visitorIp
            ? `🌐 IP: ${visitorIp}`
            : null,
        device
            ? `📱 Устройство: ${device}`
            : null,
        browser
            ? `🌐 Браузер: ${browser}`
            : null,
        timezone
            ? `🕒 Часовой пояс: ${timezone}`
            : null,
        screen
            ? `🖥 Экран: ${screen}`
            : null
    ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 3900);

    if (
        PLENOSHNAYA_TG_BOT_TOKEN &&
        PLENOSHNAYA_TG_CHAT_ID
    ) {
        try {
            const telegramResponse =
                await axios.post(
                    `https://api.telegram.org/bot${PLENOSHNAYA_TG_BOT_TOKEN}/sendMessage`,
                    {
                        chat_id:
                            PLENOSHNAYA_TG_CHAT_ID,
                        text,
                        disable_web_page_preview:
                            true
                    },
                    {
                        timeout:
                            10000
                    }
                );

            if (!telegramResponse.data?.ok) {
                throw new Error(
                    telegramResponse.data?.description ||
                    'Telegram returned ok=false'
                );
            }

        } catch (error) {
            console.error(
                'Plenoshnaya identity Telegram error:',
                error.response?.data ||
                error.message
            );

            return res.status(502).json({
                ok: false,
                error:
                    'Не удалось отправить identity event'
            });
        }
    }

    if (dedupeKey) {
        plenoshnayaIdentifyRecent.set(
            dedupeKey,
            Date.now()
        );
    }

    return res.json({
        ok: true,
        identified: true
    });
});

// ============================================================
// ПЛЁНОШНАЯ — СОБЫТИЯ С САЙТА
// ============================================================

app.post(
    '/api/plenoshnaya/event',
    express.text({
        type: 'text/plain',
        limit: '32kb'
    }),
    async (req, res) => {
        if (!isPlenoshnayaOriginAllowed(req)) {
            return res.status(403).json({
                ok: false,
                error: 'Origin not allowed'
            });
        }

        if (
            !PLENOSHNAYA_TG_BOT_TOKEN ||
            !PLENOSHNAYA_TG_CHAT_ID
        ) {
            return res.status(503).json({
                ok: false,
                error: 'Telegram is not configured'
            });
        }

        let body = req.body || {};

        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch (error) {
                return res.status(400).json({
                    ok: false,
                    error: 'Invalid event payload'
                });
            }
        }

        const eventType =
            cleanPlenoshnayaLeadValue(
                body.type,
                80
            );

        const supportedEvents = new Set([
            'visit_start',
            'page_view',
            'heartbeat',
            'visit_end',
            'form_open',
            'phone_click',
            'whatsapp_click',
            'telegram_click',
            'calculator_action',
            'consent_accept',
            'consent_necessary',
            'contact_share'
        ]);

        if (!supportedEvents.has(eventType)) {
            return res.status(400).json({
                ok: false,
                error: 'Unsupported event'
            });
        }

        const phone =
            cleanPlenoshnayaLeadValue(
                body.phone,
                80
            );

        const name =
            cleanPlenoshnayaLeadValue(
                body.name,
                160
            );

        const email =
            cleanPlenoshnayaLeadValue(
                body.email,
                254
            );

        const placement =
            cleanPlenoshnayaLeadValue(
                body.placement,
                120
            ) || 'page';

        const linkText =
            cleanPlenoshnayaLeadValue(
                body.link_text ||
                body.linkText,
                200
            );

        const page =
            cleanPlenoshnayaLeadValue(
                body.page,
                1000
            );

        const pageTitle =
            cleanPlenoshnayaLeadValue(
                body.page_title ||
                body.pageTitle,
                300
            );

        const referrer =
            cleanPlenoshnayaLeadValue(
                body.referrer,
                1000
            );

        const utmSource =
            cleanPlenoshnayaLeadValue(
                body.utm_source,
                200
            );

        const utmMedium =
            cleanPlenoshnayaLeadValue(
                body.utm_medium,
                200
            );

        const utmCampaign =
            cleanPlenoshnayaLeadValue(
                body.utm_campaign,
                300
            );

        const utmContent =
            cleanPlenoshnayaLeadValue(
                body.utm_content,
                300
            );

        const utmTerm =
            cleanPlenoshnayaLeadValue(
                body.utm_term,
                300
            );

        const searchPhrase =
            cleanPlenoshnayaLeadValue(
                body.search_phrase ||
                body.searchPhrase,
                500
            );

        const adPhrase =
            cleanPlenoshnayaLeadValue(
                body.ad_phrase ||
                body.adPhrase,
                500
            );

        const yclid =
            cleanPlenoshnayaLeadValue(
                body.yclid,
                500
            );

        const eventId =
            cleanPlenoshnayaLeadValue(
                body.event_id ||
                body.eventId,
                100
            );

        const visitorId =
            cleanPlenoshnayaLeadValue(
                body.visitor_id ||
                body.visitorId,
                120
            );

        const sessionId =
            cleanPlenoshnayaLeadValue(
                body.session_id ||
                body.sessionId,
                120
            );

        const visitCount =
            cleanPlenoshnayaLeadValue(
                body.visit_count ||
                body.visitCount,
                20
            );

        const device =
            cleanPlenoshnayaLeadValue(
                body.device,
                240
            );

        const browser =
            cleanPlenoshnayaLeadValue(
                body.browser,
                240
            );

        const language =
            cleanPlenoshnayaLeadValue(
                body.language,
                80
            );

        const timezone =
            cleanPlenoshnayaLeadValue(
                body.timezone,
                120
            );

        const screen =
            cleanPlenoshnayaLeadValue(
                body.screen,
                80
            );

        const knownLead =
            body.known_lead === true ||
            String(body.known_lead || '').toLowerCase() === 'true';

        const userAgent =
            cleanPlenoshnayaLeadValue(
                req.get('user-agent'),
                500
            );

        const acceptLanguage =
            cleanPlenoshnayaLeadValue(
                req.get('accept-language'),
                240
            );

        const clientHints =
            cleanPlenoshnayaLeadValue(
                req.get('sec-ch-ua'),
                300
            );

        const clientPlatform =
            cleanPlenoshnayaLeadValue(
                req.get('sec-ch-ua-platform'),
                120
            );

        const forwardedFor =
            cleanPlenoshnayaLeadValue(
                req.get('x-forwarded-for'),
                300
            );

        const visitorIp =
            cleanPlenoshnayaLeadValue(
                (forwardedFor
                    ? forwardedFor.split(',')[0]
                    : req.ip),
                120
            );

        const countryHeader =
            cleanPlenoshnayaLeadValue(
                req.get('cf-ipcountry') ||
                req.get('x-vercel-ip-country') ||
                req.get('x-country-code'),
                40
            );

        const deviceModel =
            cleanPlenoshnayaLeadValue(
                body.device_model ||
                body.deviceModel,
                160
            );

        const platformVersion =
            cleanPlenoshnayaLeadValue(
                body.platform_version ||
                body.platformVersion,
                160
            );

        const browserVersions =
            cleanPlenoshnayaLeadValue(
                body.browser_versions ||
                body.browserVersions,
                300
            );

        const cpu =
            cleanPlenoshnayaLeadValue(
                body.cpu,
                80
            );

        const memory =
            cleanPlenoshnayaLeadValue(
                body.memory,
                80
            );

        const connection =
            cleanPlenoshnayaLeadValue(
                body.connection,
                160
            );

        const viewport =
            cleanPlenoshnayaLeadValue(
                body.viewport,
                80
            );

        const devicePixelRatio =
            cleanPlenoshnayaLeadValue(
                body.device_pixel_ratio ||
                body.devicePixelRatio,
                40
            );

        const touchPoints =
            cleanPlenoshnayaLeadValue(
                body.touch_points ||
                body.touchPoints,
                40
            );

        const colorDepth =
            cleanPlenoshnayaLeadValue(
                body.color_depth ||
                body.colorDepth,
                40
            );

        const orientation =
            cleanPlenoshnayaLeadValue(
                body.orientation,
                80
            );

        const darkMode =
            cleanPlenoshnayaLeadValue(
                body.dark_mode ||
                body.darkMode,
                20
            );

        const reducedMotion =
            cleanPlenoshnayaLeadValue(
                body.reduced_motion ||
                body.reducedMotion,
                20
            );

        const cookiesEnabled =
            cleanPlenoshnayaLeadValue(
                body.cookies_enabled ||
                body.cookiesEnabled,
                20
            );

        const dnt =
            cleanPlenoshnayaLeadValue(
                body.dnt,
                40
            );

        const gpc =
            cleanPlenoshnayaLeadValue(
                body.gpc,
                40
            );

        const sessionSeconds =
            cleanPlenoshnayaLeadValue(
                body.session_seconds ||
                body.sessionSeconds,
                40
            );

        const pageCount =
            cleanPlenoshnayaLeadValue(
                body.page_count ||
                body.pageCount,
                40
            );

        const firstPage =
            cleanPlenoshnayaLeadValue(
                body.first_page ||
                body.firstPage,
                1000
            );

        const firstReferrer =
            cleanPlenoshnayaLeadValue(
                body.first_referrer ||
                body.firstReferrer,
                1000
            );

        const pageHistory =
            cleanPlenoshnayaLeadValue(
                body.page_history ||
                body.pageHistory,
                1400
            );

        const calculatorSelection =
            cleanPlenoshnayaLeadValue(
                body.calculator_selection ||
                body.calculatorSelection,
                1200
            );

        const metrikaClientId =
            cleanPlenoshnayaLeadValue(
                body.metrika_client_id ||
                body.metrikaClientId ||
                body.client_id,
                120
            );

        const eventLabel =
            cleanPlenoshnayaLeadValue(
                body.event_label ||
                body.eventLabel,
                320
            );

        const ipInfo =
            await getPlenoshnayaIpInfo(
                visitorIp
            );

        const source =
            [utmSource, utmMedium]
                .filter(Boolean)
                .join(' / ');

        let visitCardResult = null;

        try {
            visitCardResult =
                await upsertPlenoshnayaVisitCard({
                    eventType,
                    eventLabel,
                    visitorId,
                    sessionId,
                    visitCount,
                    pageCount,
                    pageHistory,
                    calculatorSelection,
                    metrikaClientId,
                    page,
                    pageTitle,
                    referrer,
                    utmSource,
                    utmMedium,
                    utmCampaign,
                    searchPhrase,
                    yclid,
                    device,
                    browser,
                    placement,
                    visitorIp,
                    ipInfo,
                    name,
                    phone
                });
        } catch (visitCardError) {
            console.warn(
                'Plenoshnaya visit card update skipped:',
                visitCardError.response?.data ||
                visitCardError.message
            );
        }

        const separateTelegramAlerts =
            new Set([
                'phone_click',
                'whatsapp_click',
                'telegram_click'
            ]);

        if (
            !separateTelegramAlerts.has(
                eventType
            )
        ) {
            return res.json({
                ok: true,
                telegramSent: false,
                visitCardUpdated:
                    Boolean(
                        visitCardResult?.updated
                    ),
                liveCard:
                    true
            });
        }

        const titles = {
            phone_click:
                '📞 ПЛЁНОШНАЯ — КЛИК ПО ТЕЛЕФОНУ',
            whatsapp_click:
                '🟢 ПЛЁНОШНАЯ — КЛИК WHATSAPP',
            telegram_click:
                '🔵 ПЛЁНОШНАЯ — КЛИК TELEGRAM',
            calculator_action:
                '🧮 ПЛЁНОШНАЯ — ДЕЙСТВИЕ В КАЛЬКУЛЯТОРЕ',
            consent_accept:
                '🍪 ПЛЁНОШНАЯ — COOKIE: ПРИНЯТО',
            consent_necessary:
                '🍪 ПЛЁНОШНАЯ — ТОЛЬКО НЕОБХОДИМЫЕ',
            contact_share:
                '👤 ПЛЁНОШНАЯ — ПОЛЬЗОВАТЕЛЬ ПОДЕЛИЛСЯ КОНТАКТОМ'
        };

        const text = [
            titles[eventType] || 'ПЛЁНОШНАЯ — СОБЫТИЕ',
            '',
            eventType === 'phone_click' && phone
                ? `Номер: ${phone}`
                : null,
            eventType === 'contact_share' && name
                ? `Имя: ${name}`
                : null,
            eventType === 'contact_share' && phone
                ? `Телефон: ${phone}`
                : null,
            eventType === 'contact_share' && email
                ? `Email: ${email}`
                : null,
            `Место: ${placement}`,
            linkText
                ? `Текст ссылки: ${linkText}`
                : null,
            pageTitle
                ? `Страница: ${pageTitle}`
                : null,
            page
                ? `🔗 ${page}`
                : null,
            referrer
                ? `↩️ Referrer: ${referrer}`
                : null,
            source
                ? `📣 Источник: ${source}`
                : null,
            utmCampaign
                ? `🎯 Кампания: ${utmCampaign}`
                : null,
            utmContent
                ? `🧩 UTM content: ${utmContent}`
                : null,
            utmTerm
                ? `🔎 UTM term: ${utmTerm}`
                : null,
            searchPhrase
                ? `🔍 Поисковая фраза: ${searchPhrase}`
                : null,
            adPhrase
                ? `📢 Рекламная фраза: ${adPhrase}`
                : null,
            yclid
                ? `🟡 yclid: ${yclid}`
                : null,
            visitorId
                ? `👣 Visitor ID: ${visitorId}`
                : null,
            sessionId
                ? `🧭 Session ID: ${sessionId}`
                : null,
            visitCount
                ? `🔁 Визит: ${visitCount}`
                : null,
            knownLead
                ? '✅ Ранее оставлял заявку'
                : null,
            device
                ? `📱 Устройство: ${device}`
                : null,
            browser
                ? `🌐 Браузер: ${browser}`
                : null,
            language
                ? `🗣 Язык: ${language}`
                : null,
            timezone
                ? `🕒 Часовой пояс: ${timezone}`
                : null,
            screen
                ? `🖥 Экран: ${screen}`
                : null,
            viewport
                ? `📐 Viewport: ${viewport}`
                : null,
            devicePixelRatio
                ? `🔎 Pixel ratio: ${devicePixelRatio}`
                : null,
            touchPoints
                ? `👆 Touch points: ${touchPoints}`
                : null,
            colorDepth
                ? `🎨 Color depth: ${colorDepth}`
                : null,
            orientation
                ? `↔️ Ориентация: ${orientation}`
                : null,
            darkMode
                ? `🌗 Тема: ${darkMode}`
                : null,
            reducedMotion
                ? `🎞 Reduced motion: ${reducedMotion}`
                : null,
            cookiesEnabled
                ? `🍪 Cookies enabled: ${cookiesEnabled}`
                : null,
            dnt
                ? `🛡 DNT: ${dnt}`
                : null,
            gpc
                ? `🔐 GPC: ${gpc}`
                : null,
            sessionSeconds
                ? `⏱ В сессии: ${sessionSeconds} сек.`
                : null,
            pageCount
                ? `📚 Страниц в сессии: ${pageCount}`
                : null,
            firstPage
                ? `🚪 Входная страница: ${firstPage}`
                : null,
            firstReferrer
                ? `↩️ Первый referrer: ${firstReferrer}`
                : null,
            pageHistory
                ? `🧭 Маршрут: ${pageHistory}`
                : null,
            calculatorSelection
                ? `🧮 Калькулятор: ${calculatorSelection}`
                : null,
            ipInfo && (
                ipInfo.city ||
                ipInfo.region ||
                ipInfo.country
            )
                ? `📍 Сеть: ${[
                    ipInfo.city,
                    ipInfo.region,
                    ipInfo.country
                ].filter(Boolean).join(', ')}`
                : null,
            ipInfo && (
                ipInfo.asn ||
                ipInfo.org
            )
                ? `🏢 ASN/провайдер: ${[
                    ipInfo.asn,
                    ipInfo.org
                ].filter(Boolean).join(' · ')}`
                : null,
            ipInfo && ipInfo.timezone
                ? `🌐 Часовой пояс сети: ${ipInfo.timezone}`
                : null,
            deviceModel
                ? `📲 Модель: ${deviceModel}`
                : null,
            platformVersion
                ? `⚙️ ОС: ${platformVersion}`
                : null,
            browserVersions
                ? `🧩 Версии браузера: ${browserVersions}`
                : null,
            cpu
                ? `🧠 CPU/ядра: ${cpu}`
                : null,
            memory
                ? `💾 Память: ${memory}`
                : null,
            connection
                ? `📶 Соединение: ${connection}`
                : null,
            visitorIp
                ? `🌐 IP: ${visitorIp}`
                : null,
            countryHeader
                ? `🌍 Страна по сети: ${countryHeader}`
                : null,
            clientPlatform
                ? `🖥 Client platform: ${clientPlatform}`
                : null,
            clientHints
                ? `🧭 Client hints: ${clientHints}`
                : null,
            acceptLanguage
                ? `🗣 Accept-Language: ${acceptLanguage}`
                : null,
            userAgent
                ? `🔧 User-Agent: ${userAgent}`
                : null,
            eventId
                ? `🆔 Event ID: ${eventId}`
                : null
        ]
            .filter(Boolean)
            .join('\n')
            .slice(0, 3900);

        try {
            const telegramResponse =
                await axios.post(
                    `https://api.telegram.org/bot${PLENOSHNAYA_TG_BOT_TOKEN}/sendMessage`,
                    {
                        chat_id:
                            PLENOSHNAYA_TG_CHAT_ID,

                        text,

                        disable_web_page_preview:
                            true
                    },
                    {
                        timeout:
                            10000
                    }
                );

            if (!telegramResponse.data?.ok) {
                throw new Error(
                    telegramResponse.data?.description ||
                    'Telegram returned ok=false'
                );
            }

            return res.json({
                ok: true,
                telegramSent: true
            });

        } catch (error) {
            console.error(
                `Plenoshnaya ${eventType} Telegram error:`,
                error.response?.data ||
                error.message
            );

            return res.status(502).json({
                ok: false,
                error:
                    'Не удалось отправить событие'
            });
        }
    }
);

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

function normalizeEmailForYooKassa(value) {
    const email =
        String(value || '')
            .trim()
            .toLowerCase();

    if (
        !email ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
            .test(email)
    ) {
        return '';
    }

    return email;
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


app.get('/api/yookassa/check', async (req, res) => {
    const rawShop =
        String(RAW_YOOKASSA_SHOP_ID || '');

    const rawKey =
        String(RAW_YOOKASSA_SECRET_KEY || '');

    const safeDiagnostics = {
        configured:
            Boolean(
                YOOKASSA_SHOP_ID &&
                YOOKASSA_SECRET_KEY
            ),

        shopIdMasked:
            YOOKASSA_SHOP_ID
                ? `***${YOOKASSA_SHOP_ID.slice(-4)}`
                : null,

        shopIdLength:
            YOOKASSA_SHOP_ID.length,

        secretKeyLength:
            YOOKASSA_SECRET_KEY.length,

        rawShopHadOuterWhitespace:
            rawShop !== rawShop.trim(),

        rawSecretHadOuterWhitespace:
            rawKey !== rawKey.trim(),

        rawShopHadQuotes:
            /^["'].*["']$/.test(
                rawShop.trim()
            ),

        rawSecretHadQuotes:
            /^["'].*["']$/.test(
                rawKey.trim()
            )
    };

    if (
        !YOOKASSA_SHOP_ID ||
        !YOOKASSA_SECRET_KEY
    ) {
        return res.status(500).json({
            ok: false,
            error:
                'YOOKASSA_SHOP_ID или YOOKASSA_SECRET_KEY отсутствует в Render',
            ...safeDiagnostics
        });
    }

    try {
        // Безопасный GET: ничего не создаёт и не списывает.
        // Проверяет именно ту пару shopId/key, которую реально видит Render.
        const response =
            await axios.get(
                'https://api.yookassa.ru/v3/payments?limit=1',
                {
                    auth: {
                        username:
                            YOOKASSA_SHOP_ID,

                        password:
                            YOOKASSA_SECRET_KEY
                    },

                    headers: {
                        'Accept':
                            'application/json'
                    },

                    timeout:
                        15000
                }
            );

        return res.status(200).json({
            ok: true,
            yookassaStatus:
                response.status,
            ...safeDiagnostics
        });

    } catch (error) {
        const yooError =
            error.response?.data;

        return res
            .status(
                error.response?.status ||
                500
            )
            .json({
                ok: false,

                yookassaStatus:
                    error.response?.status ||
                    null,

                code:
                    yooError?.code ||
                    null,

                description:
                    yooError?.description ||
                    error.message,

                ...safeDiagnostics
            });
    }
});

// ============================================================
// PAYMENT STATUS FALLBACK
// Клиент вызывает этот endpoint после возврата из ЮKassa.
// Это резервный путь для Telegram-уведомления, если webhook
// payment.succeeded по какой-либо причине не дошёл.
// ============================================================

app.get('/api/payment-status/:paymentId', async (req, res) => {
    try {
        const paymentId =
            String(req.params?.paymentId || '')
                .trim();

        if (!paymentId) {
            return res.status(400).json({
                ok: false,
                error: 'Не указан payment id'
            });
        }

        const payment =
            await getYooKassaPayment(
                paymentId
            );

        const succeeded =
            payment?.status === 'succeeded' &&
            payment?.paid === true;

        let notificationSent = true;

        if (succeeded) {
            upsertLocalOrder({
                orderId: payment?.metadata?.orderId,
                paymentId: payment?.id,
                paymentStatus: payment?.status,
                paid: true,
                paidAt: payment?.captured_at || new Date().toISOString()
            });
            try {
                const sent =
                    await sendPaidOrderToTelegram(
                        payment
                    );

                if (sent) {
                    console.log(
                        `YooKassa payment ${paymentId}: paid notification sent to Telegram by success-page fallback`
                    );
                }
            } catch (telegramError) {
                notificationSent = false;
                console.error(
                    'RTN paid order Telegram fallback error:',
                    telegramError.response?.data ||
                    telegramError.message
                );
            }
        }

        return res.json({
            ok: true,
            paymentId:
                payment?.id || paymentId,
            status:
                payment?.status || 'unknown',
            paid:
                payment?.paid === true,
            succeeded,
            notificationSent,
            orderId:
                payment?.metadata?.orderId || ''
        });

    } catch (error) {
        console.error(
            'YooKassa payment status check error:',
            error.response?.data ||
            error.message
        );

        return res.status(503).json({
            ok: false,
            error:
                'Не удалось проверить статус платежа'
        });
    }
});

app.post('/api/contact', async (req, res) => {
    try {
        const name = compactTelegramValue(req.body?.name, '—');
        const email = compactTelegramValue(req.body?.email, '—');
        const message = compactTelegramValue(req.body?.message, '—').slice(0, 2000);

        if (name === '—' || email === '—' || message === '—') {
            return res.status(400).json({ ok: false, error: 'Заполните все поля' });
        }

        await sendTelegramText([
            '📨 RTN.PRO — ОБРАТНАЯ СВЯЗЬ',
            '',
            `Имя: ${name}`,
            `Email: ${email}`,
            '',
            `Сообщение: ${message}`
        ].join('\n'));

        return res.json({ ok: true });
    } catch (error) {
        console.error('RTN contact Telegram error:', error.response?.data || error.message);
        return res.status(503).json({ ok: false, error: 'Не удалось отправить сообщение' });
    }
});

function buildPaymentDescription({ orderId, customerName, items }) {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const shorten = (value, max) => value.length <= max ? value : value.slice(0, max - 1) + '…';
    const order = shorten(clean(orderId), 40);
    const name = shorten(clean(customerName), 28);
    const summary = (Array.isArray(items) ? items : []).map(item => {
        const title = clean(item?.name || item?.productName) || 'Товар';
        const quantity = Math.max(1, Math.floor(Number(item?.quantity) || 1));
        return `${title} ×${quantity}`;
    }).join(', ');
    return shorten([
        'RTN.PRO',
        order ? `Заказ ${order}` : 'Заказ',
        name,
        summary
    ].filter(Boolean).join(' · '), 128);
}

app.post('/api/create-payment', async (req, res) => {
    let localOrderReference = '';
    try {
        const {
            amount,
            items,
            customer,
            delivery,
            orderId,
            comment,
            promoCode
        } = req.body;

        // Проверяем сумму
        const paymentAmount =
            Number(amount);

        console.log(
            `RTN checkout: promo=${normalizePromoCode(promoCode) || 'NONE'}, amount=${paymentAmount}`
        );

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

        // Для электронного чека ЮKassa нужен корректный email покупателя.
        const normalizedEmail =
            normalizeEmailForYooKassa(
                customer?.email
            );

        if (!normalizedEmail) {
            return res.status(400).json({
                error: 'Укажите корректный email для отправки электронного чека'
            });
        }

        const customerFullName =
            String(customer?.name || '')
                .trim()
                .slice(0, 256);

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

        localOrderReference = cleanOrderValue(orderId, 100);
        upsertLocalOrder({
            ...orderFromCheckout({ orderId, amount: paymentAmount, items, customer, delivery, comment, promoCode }),
            paymentStatus: 'creating',
            paid: false
        });

        console.log(
            `YooKassa receipt prepared: order=${String(orderId || 'NO_ID')}, email=yes, phone=yes, items=${receiptItems.length}`
        );

        // Сразу фиксируем попытку заказа в Telegram.
        // Ошибка Telegram НЕ должна ломать оплату.
        sendOrderAttemptToTelegram({
            amount: paymentAmount,
            items,
            customer,
            delivery,
            orderId,
            promoCode,
            comment
        }).catch(error => {
            console.error(
                'RTN order attempt Telegram error:',
                error.response?.data ||
                error.message
            );
        });

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
                    comment,
                    promoCode
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

            description: buildPaymentDescription({
                orderId,
                customerName: customerFullName,
                items
            }),

            metadata: {
                customerName:
                    customer?.name || '',

                customerPhone:
                    normalizedPhone,

                customerEmail:
                    normalizedEmail,

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
                        : '',

                promoCode:
                    normalizePromoCode(promoCode)
            },

            receipt: {
                customer: {
                    full_name:
                        customerFullName,

                    email:
                        normalizedEmail,

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

        upsertLocalOrder({
            orderId: localOrderReference,
            paymentId: response.data?.id,
            paymentStatus: response.data?.status || 'pending',
            paid: response.data?.paid === true,
            bitrixDealId: bitrixDealId || null
        });

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
        if (localOrderReference) {
            try {
                upsertLocalOrder({
                    orderId: localOrderReference,
                    paymentStatus: 'creation_failed',
                    paymentError: cleanOrderValue(error.response?.data?.description || error.message, 1000)
                });
            } catch (storageError) {
                console.error('Local order failure status error:', storageError.message);
            }
        }
        console.error(
            'YooKassa payment error:',
            error.response?.data ||
            error.message
        );

        const yooError =
            error.response?.data;

        const statusCode =
            error.response?.status ||
            500;

        const description =
            yooError?.description ||
            yooError?.parameter ||
            error.message ||
            'Неизвестная ошибка';

        if (
            statusCode === 401 ||
            yooError?.code === 'invalid_credentials'
        ) {
            return res.status(401).json({
                error:
                    'ЮKassa отклонила авторизацию. Проверьте, что YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY относятся к одному и тому же магазину ЮKassa.',

                details: {
                    code:
                        yooError?.code ||
                        'invalid_credentials',

                    description,

                    shopIdMasked:
                        YOOKASSA_SHOP_ID
                            ? `***${String(YOOKASSA_SHOP_ID).slice(-4)}`
                            : null
                }
            });
        }

        res.status(statusCode).json({
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
// YANDEX COMMERCE PROTOCOL (YCP) — БАЗОВЫЕ МЕТОДЫ
// ============================================================

const ycpSessions = new Map();
const ycpOrders = new Map();

const YCP_SESSION_TTL_MS =
    60 * 60 * 1000;

function secureStringEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(a, b);
}

function extractYcpIncomingToken(req) {
    const authorization =
        String(
            req.get('authorization') ||
            ''
        ).trim();

    const strippedAuthorization =
        authorization.replace(
            /^(Bearer|Token|Api-Key)\s+/i,
            ''
        ).trim();

    return (
        strippedAuthorization ||
        String(req.get('x-api-key') || '').trim() ||
        String(req.get('api-key') || '').trim() ||
        String(req.get('x-ycp-token') || '').trim() ||
        String(req.get('x-access-token') || '').trim()
    );
}

function requireYcpAuth(req, res, next) {
    if (!YCP_ACCESS_TOKEN) {
        return res.status(503).json({
            error:
                'YCP access token is not configured'
        });
    }

    const incomingToken =
        extractYcpIncomingToken(req);

    if (
        !incomingToken ||
        !secureStringEqual(
            incomingToken,
            YCP_ACCESS_TOKEN
        )
    ) {
        return res.status(401).json({
            error:
                'Не авторизован'
        });
    }

    return next();
}

function cleanupYcpSessions() {
    const now = Date.now();

    for (
        const [sessionId, session]
        of ycpSessions.entries()
    ) {
        if (
            now - session.createdAt >
            YCP_SESSION_TTL_MS
        ) {
            ycpSessions.delete(sessionId);
        }
    }
}

function ycpStockForProduct() {
    return YCP_DEFAULT_STOCK;
}

function ycpProductVariations(product) {
    if (!product) {
        return [];
    }

    return YCP_PRODUCTS
        .filter(candidate =>
            candidate.group === product.group &&
            candidate.id !== product.id
        )
        .map(candidate =>
            buildYcpBasketItem(
                candidate,
                false
            )
        );
}

function ycpProductCharacteristics(product) {
    if (!product?.flavor) {
        return [];
    }

    return [
        {
            display_type:
                'text',

            code:
                'FLAVOR',

            name:
                'Вкус',

            properties: {
                value:
                    product.flavor
            }
        }
    ];
}

function buildYcpBasketItem(
    product,
    includeVariations = true
) {
    const item = {
        id:
            product.id,

        name:
            product.name,

        regular_price:
            product.price,

        final_price:
            product.price,

        img:
            product.img,

        url:
            product.url,

        warehouses: [
            {
                id:
                    YCP_WAREHOUSE_ID,

                available_quantity:
                    ycpStockForProduct(
                        product
                    )
            }
        ],

        dimensions:
            product.dimensions,

        characteristics:
            ycpProductCharacteristics(
                product
            )
    };

    if (includeVariations) {
        item.variations =
            ycpProductVariations(
                product
            );
    }

    return item;
}

function ycpActualInventory(items) {
    return {
        items:
            (Array.isArray(items)
                ? items
                : []
            )
                .map(requested => {
                    const product =
                        YCP_PRODUCTS_BY_ID[
                            String(
                                requested?.id ||
                                ''
                            )
                        ];

                    if (!product) {
                        return null;
                    }

                    return {
                        id:
                            product.id,

                        regular_price:
                            product.price,

                        final_price:
                            product.price,

                        warehouses: [
                            {
                                id:
                                    YCP_WAREHOUSE_ID,

                                available_quantity:
                                    ycpStockForProduct(
                                        product
                                    )
                            }
                        ]
                    };
                })
                .filter(Boolean)
    };
}

function validateYcpCheckoutItems(items) {
    if (
        !Array.isArray(items) ||
        !items.length
    ) {
        return {
            ok: false,
            status: 400,
            error: 'Корзина пуста'
        };
    }

    for (const requested of items) {
        const id =
            String(
                requested?.id ||
                ''
            );

        const product =
            YCP_PRODUCTS_BY_ID[id];

        if (!product) {
            return {
                ok: false,
                status: 404,
                error:
                    `Товар ${id} не найден`
            };
        }

        const quantity =
            Number(
                requested?.quantity
            );

        if (
            !Number.isInteger(quantity) ||
            quantity < 1
        ) {
            return {
                ok: false,
                status: 400,
                error:
                    `Некорректное количество для ${id}`
            };
        }

        const regularPrice =
            Number(
                requested?.regular_price
            );

        const finalPrice =
            Number(
                requested?.final_price
            );

        const stock =
            ycpStockForProduct(
                product
            );

        if (
            regularPrice !== product.price ||
            finalPrice !== product.price ||
            quantity > stock
        ) {
            return {
                ok: false,
                status: 409,
                error:
                    'Цены изменились или товары закончились',

                actual_inventory:
                    ycpActualInventory(
                        items
                    )
            };
        }
    }

    return {
        ok: true
    };
}

function ycpMerchantOrderNumber(
    sessionId
) {
    const suffix =
        String(sessionId || '')
            .replace(
                /[^a-zA-Z0-9]/g,
                ''
            )
            .slice(-8)
            .toUpperCase();

    return (
        `RTN-YCP-${suffix || Date.now()}`
    );
}

// 1. Получить список складов и магазинов
app.get(
    '/api/v1/warehouses',
    requireYcpAuth,
    (req, res) => {
        const offset =
            Math.max(
                0,
                Number(req.query.offset || 0) || 0
            );

        const limit =
            Math.max(
                1,
                Math.min(
                    100,
                    Number(req.query.limit || 100) || 100
                )
            );

        const warehouses = [
            {
                id:
                    YCP_WAREHOUSE_ID,

                title:
                    YCP_WAREHOUSE_TITLE,

                address:
                    YCP_WAREHOUSE_ADDRESS,

                description:
                    'Основная точка отгрузки RTN.PRO',

                // Самовывоз на сайте RTN есть,
                // но для YCP не включаем его до внесения
                // реального графика работы.
                self_pickup_options: {
                    enabled:
                        false
                },

                ycp_delivery_options: {
                    enabled:
                        true
                }
            }
        ];

        return res.json({
            warehouses:
                warehouses.slice(
                    offset,
                    offset + limit
                ),

            total_count:
                warehouses.length
        });
    }
);

// 2. Проверить текущую корзину
app.post(
    '/api/v1/checkout/basket/check',
    requireYcpAuth,
    (req, res) => {
        const items =
            Array.isArray(req.body?.items)
                ? req.body.items
                : [];

        if (!items.length) {
            return res.status(400).json({
                error:
                    'Корзина пуста'
            });
        }

        const result = [];

        for (const requested of items) {
            const id =
                String(
                    requested?.id ||
                    ''
                );

            const product =
                YCP_PRODUCTS_BY_ID[id];

            if (!product) {
                return res.status(404).json({
                    error:
                        `Товар ${id} не найден`
                });
            }

            result.push(
                buildYcpBasketItem(
                    product,
                    true
                )
            );
        }

        return res.json({
            items:
                result
        });
    }
);

// 3. Создать новую сессию чекаута
app.post(
    '/api/v1/checkout',
    requireYcpAuth,
    (req, res) => {
        cleanupYcpSessions();

        const sessionId =
            String(
                req.body?.session_id ||
                ''
            ).trim();

        if (!sessionId) {
            return res.status(400).json({
                error:
                    'Не указан session_id'
            });
        }

        const existing =
            ycpSessions.get(
                sessionId
            );

        if (existing) {
            if (existing.canceled) {
                return res.status(409).json({
                    error:
                        'Сессия уже отменена',

                    checkout_canceled:
                        true,

                    actual_inventory:
                        ycpActualInventory(
                            req.body?.items
                        )
                });
            }

            return res.status(200).json({
                order_number:
                    existing.orderNumber
            });
        }

        if (
            String(
                req.body?.warehouse_id ||
                ''
            ) !== YCP_WAREHOUSE_ID
        ) {
            return res.status(400).json({
                error:
                    'Неизвестный склад'
            });
        }

        const validation =
            validateYcpCheckoutItems(
                req.body?.items
            );

        if (!validation.ok) {
            return res
                .status(validation.status)
                .json({
                    error:
                        validation.error,

                    ...(
                        validation.actual_inventory
                            ? {
                                actual_inventory:
                                    validation.actual_inventory
                            }
                            : {}
                    )
                });
        }

        const orderNumber =
            ycpMerchantOrderNumber(
                sessionId
            );

        ycpSessions.set(
            sessionId,
            {
                sessionId,
                orderNumber,
                warehouseId:
                    YCP_WAREHOUSE_ID,
                items:
                    req.body.items,
                customer:
                    req.body?.customer || {},
                delivery:
                    req.body?.delivery || {},
                canceled:
                    false,
                placed:
                    false,
                createdAt:
                    Date.now()
            }
        );

        console.log(
            `YCP checkout created: session=${sessionId}, order=${orderNumber}`
        );

        return res.status(201).json({
            order_number:
                orderNumber
        });
    }
);

// 4. Оформить заказ
app.post(
    '/api/v1/checkout/placed',
    requireYcpAuth,
    async (req, res) => {
        cleanupYcpSessions();

        const sessionId =
            String(
                req.body?.session_id ||
                req.query?.session_id ||
                ''
            ).trim();

        const orderId =
            String(
                req.body?.order_id ||
                req.query?.order_id ||
                ''
            ).trim();

        const paymentMethod =
            String(
                req.body?.payment_method ||
                req.query?.payment_method ||
                ''
            ).trim();

        const onlinePaymentMethod =
            String(
                req.body?.online_payment_method ||
                ''
            ).trim();

        const orderNumber =
            String(
                req.body?.order_number ||
                ''
            ).trim();

        if (
            !sessionId ||
            !orderId ||
            !['online', 'on_delivery']
                .includes(paymentMethod)
        ) {
            return res.status(400).json({
                error:
                    'Некорректные данные заказа'
            });
        }

        const session =
            ycpSessions.get(
                sessionId
            );

        if (!session) {
            return res.status(404).json({
                error:
                    'Сессия не найдена'
            });
        }

        if (session.canceled) {
            return res.status(409).json({
                error:
                    'Сессия уже отменена'
            });
        }

        const existingOrder =
            ycpOrders.get(
                orderId
            );

        if (
            existingOrder?.canceled
        ) {
            return res.status(409).json({
                error:
                    'Заказ уже отменен'
            });
        }

        session.placed =
            true;

        session.orderId =
            orderId;

        session.paymentMethod =
            paymentMethod;

        ycpOrders.set(
            orderId,
            {
                orderId,
                sessionId,
                orderNumber:
                    orderNumber ||
                    session.orderNumber,
                paymentMethod,
                onlinePaymentMethod,
                customer:
                    session.customer,
                delivery:
                    session.delivery,
                items:
                    session.items,
                canceled:
                    false,
                createdAt:
                    Date.now()
            }
        );

        try {
            const customer =
                session.customer || {};

            const delivery =
                session.delivery || {};

            const paymentText =
                paymentMethod === 'online'
                    ? `ОПЛАЧЕН ОНЛАЙН${onlinePaymentMethod ? ` (${onlinePaymentMethod})` : ''}`
                    : 'ОПЛАТА ПРИ ПОЛУЧЕНИИ';

            const total =
                session.items.reduce(
                    (sum, item) =>
                        sum +
                        (
                            Number(item.final_price) *
                            Number(item.quantity)
                        ),
                    0
                ) +
                Number(
                    delivery?.price ||
                    0
                );

            await sendTelegramText(
                [
                    '🟡 RTN.PRO — ЗАКАЗ ЧЕРЕЗ YCP',
                    '',
                    `Заказ: ${compactTelegramValue(orderNumber || session.orderNumber)}`,
                    `YCP order: ${compactTelegramValue(orderId)}`,
                    `Статус: ${paymentText}`,
                    `Сумма: ${formatTelegramMoney(total)}`,
                    `Имя: ${compactTelegramValue(customer?.full_name)}`,
                    `Телефон: ${compactTelegramValue(customer?.phone)}`,
                    `Email: ${compactTelegramValue(customer?.email)}`,
                    `Доставка: ${compactTelegramValue(delivery?.service_display_name || delivery?.delivery_method)}`,
                    `Адрес: ${compactTelegramValue(delivery?.address?.address || delivery?.address?.locality)}`,
                    '',
                    'Товары:',
                    session.items
                        .map(
                            (item, index) => {
                                const product =
                                    YCP_PRODUCTS_BY_ID[
                                        String(
                                            item.id
                                        )
                                    ];

                                return `${index + 1}. ${compactTelegramValue(product?.name || item.id)} × ${Number(item.quantity) || 1}`;
                            }
                        )
                        .join('\n')
                ].join('\n')
            );
        } catch (error) {
            console.error(
                'YCP order Telegram error:',
                error.response?.data ||
                error.message
            );
        }

        console.log(
            `YCP checkout placed: session=${sessionId}, order=${orderId}, payment=${paymentMethod}`
        );

        return res.status(200).end();
    }
);

// 5. Отменить сессию
app.post(
    '/api/v1/checkout/cancel',
    requireYcpAuth,
    (req, res) => {
        cleanupYcpSessions();

        const sessionId =
            String(
                req.query?.session_id ||
                req.body?.session_id ||
                ''
            ).trim();

        if (!sessionId) {
            return res.status(400).json({
                error:
                    'Не указан session_id'
            });
        }

        const session =
            ycpSessions.get(
                sessionId
            );

        if (!session) {
            return res.status(404).json({
                error:
                    'Сессия не найдена'
            });
        }

        session.canceled =
            true;

        console.log(
            `YCP checkout canceled: session=${sessionId}`
        );

        return res.status(200).end();
    }
);

// 6. Отменить заказ
app.post(
    '/api/v1/order/cancel',
    requireYcpAuth,
    (req, res) => {
        const orderId =
            String(
                req.query?.order_id ||
                req.body?.order_id ||
                ''
            ).trim();

        if (!orderId) {
            return res.status(400).json({
                error:
                    'Не указан order_id'
            });
        }

        const order =
            ycpOrders.get(
                orderId
            );

        if (!order) {
            return res.status(404).json({
                error:
                    'Заказ не найден'
            });
        }

        order.canceled =
            true;

        console.log(
            `YCP order canceled: order=${orderId}`
        );

        return res.status(200).end();
    }
);


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
        setTimeout(async () => {
            try {
                // Сначала критичные для заказов поля промокодов.
                await syncPromoFieldsToBitrix();
            } catch (error) {
                console.error(
                    'Bitrix24 startup promo fields sync error:',
                    error.response?.data ||
                    error.message
                );
            }

            await sleep(1500);

            try {
                await syncOrderFieldsToBitrix();
            } catch (error) {
                console.error(
                    'Bitrix24 startup order fields sync error:',
                    error.response?.data ||
                    error.message
                );
            }

            await sleep(2000);

            try {
                // Каталог синхронизируем уже после CRM-полей, чтобы не забивать REST параллельными запросами.
                await syncAllRtnProductsToBitrix();
            } catch (error) {
                console.error(
                    'Bitrix24 startup catalog sync error:',
                    error.response?.data ||
                    error.message
                );
            }
        }, 1500);
    }
});
