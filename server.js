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

function normalizeAttributionValue(value, maxLength = 180) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function normalizeAttributionTouch(input = {}) {
    return {
        source:
            normalizeAttributionValue(
                input?.source,
                80
            ) || 'direct',

        medium:
            normalizeAttributionValue(
                input?.medium,
                80
            ) || 'direct',

        campaign:
            normalizeAttributionValue(
                input?.campaign,
                120
            ),

        content:
            normalizeAttributionValue(
                input?.content,
                120
            ),

        term:
            normalizeAttributionValue(
                input?.term,
                120
            ),

        startParam:
            normalizeAttributionValue(
                input?.startParam,
                120
            ),

        platform:
            normalizeAttributionValue(
                input?.platform,
                40
            ),

        chatType:
            normalizeAttributionValue(
                input?.chatType,
                40
            ),

        referrer:
            normalizeAttributionValue(
                input?.referrer,
                220
            ),

        landingPath:
            normalizeAttributionValue(
                input?.landingPath,
                260
            ),

        fbclid:
            normalizeAttributionValue(
                input?.fbclid,
                300
            ),

        yclid:
            normalizeAttributionValue(
                input?.yclid,
                300
            ),

        capturedAt:
            normalizeAttributionValue(
                input?.capturedAt,
                40
            )
    };
}

function normalizeAttribution(input = {}) {
    const firstRaw =
        input?.firstTouch ||
        input ||
        {};

    const lastRaw =
        input?.lastTouch ||
        input?.firstTouch ||
        input ||
        {};

    const firstTouch =
        normalizeAttributionTouch(
            firstRaw
        );

    const lastTouch =
        normalizeAttributionTouch(
            lastRaw
        );

    return {
        firstTouch,
        lastTouch,

        metrikaClientId:
            normalizeAttributionValue(
                input?.metrikaClientId,
                120
            ),

        yclid:
            normalizeAttributionValue(
                input?.yclid ||
                lastTouch.yclid ||
                firstTouch.yclid,
                300
            )
    };
}

function getPrimaryAttributionTouch(attribution) {
    return normalizeAttribution(
        attribution
    ).lastTouch;
}

function buildAttributionLines(attribution) {
    const normalized =
        normalizeAttribution(
            attribution
        );

    const current =
        normalized.lastTouch;

    const first =
        normalized.firstTouch;

    const source = [
        current.source,
        current.medium
    ]
        .filter(Boolean)
        .join(' / ');

    const firstSource = [
        first.source,
        first.medium
    ]
        .filter(Boolean)
        .join(' / ');

    return [
        source
            ? `Источник: ${source}`
            : null,

        current.campaign
            ? `Кампания: ${current.campaign}`
            : null,

        current.content
            ? `Контент: ${current.content}`
            : null,

        current.startParam
            ? `Telegram start: ${current.startParam}`
            : null,

        current.platform
            ? `Платформа: ${current.platform}`
            : null,

        current.chatType
            ? `Telegram context: ${current.chatType}`
            : null,

        current.referrer
            ? `Referrer: ${current.referrer}`
            : null,

        (
            firstSource &&
            firstSource !== source
        )
            ? `Первый источник: ${firstSource}`
            : null
    ]
        .filter(Boolean);
}

function buildBitrixSourceDescription(attribution) {
    const current =
        getPrimaryAttributionTouch(
            attribution
        );

    const parts = [
        current.source,
        current.medium,
        current.startParam,
        current.campaign,
        current.content
    ]
        .filter(Boolean);

    return normalizeAttributionValue(
        parts.length
            ? `RTN.PRO · ${parts.join(' · ')}`
            : 'Интернет-магазин RTN.PRO',
        250
    );
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

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rtn.pro';

const YANDEX_METRIKA_COUNTER_ID =
    normalizeEnvValue(
        process.env.YANDEX_METRIKA_COUNTER_ID ||
        '109277400'
    );

const YANDEX_METRIKA_OAUTH_TOKEN =
    normalizeEnvValue(
        process.env.YANDEX_METRIKA_OAUTH_TOKEN ||
        ''
    );

const YANDEX_METRIKA_PAID_GOAL =
    normalizeEnvValue(
        process.env.YANDEX_METRIKA_PAID_GOAL ||
        'order_paid'
    );

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

const {
    RTN_BITRIX_PRODUCTS_BY_ID
} = require('./rtn-bitrix-catalog');

const BITRIX_SYNC_PRODUCT_IMAGES =
    String(process.env.BITRIX_SYNC_PRODUCT_IMAGES || '1') !== '0';

const BITRIX_FORCE_PRODUCT_IMAGES =
    String(process.env.BITRIX_FORCE_PRODUCT_IMAGES || '') === '1';


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
            select: ['id', 'iblockId', 'name', 'xmlId', 'previewPicture', 'detailPicture'],
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

const RTN_BITRIX_PRODUCT_PROPERTY_DEFS = [
    {
        key: 'category',
        code: 'RTN_CATEGORY',
        name: 'RTN: категория',
        propertyType: 'S',
        rowCount: 1,
        searchable: 'Y',
        filtrable: 'Y'
    },
    {
        key: 'flavor',
        code: 'RTN_FLAVOR',
        name: 'RTN: вкус / вариант',
        propertyType: 'S',
        rowCount: 1,
        searchable: 'Y',
        filtrable: 'Y'
    },
    {
        key: 'labelTitle',
        code: 'RTN_LABEL_TITLE',
        name: 'RTN: официальное наименование с этикетки',
        propertyType: 'S',
        rowCount: 3,
        searchable: 'Y',
        filtrable: 'N'
    },
    {
        key: 'form',
        code: 'RTN_FORM',
        name: 'RTN: форма выпуска',
        propertyType: 'S',
        rowCount: 2,
        searchable: 'Y',
        filtrable: 'N'
    },
    {
        key: 'servingSize',
        code: 'RTN_SERVING_SIZE',
        name: 'RTN: размер порции',
        propertyType: 'S',
        rowCount: 1,
        searchable: 'N',
        filtrable: 'Y'
    },
    {
        key: 'servings',
        code: 'RTN_SERVINGS',
        name: 'RTN: количество порций',
        propertyType: 'N',
        rowCount: 1,
        searchable: 'N',
        filtrable: 'Y'
    },
    {
        key: 'shelfLife',
        code: 'RTN_SHELF_LIFE',
        name: 'RTN: срок годности',
        propertyType: 'S',
        rowCount: 1,
        searchable: 'N',
        filtrable: 'Y'
    },
    {
        key: 'packageInfo',
        code: 'RTN_PACKAGE',
        name: 'RTN: упаковка',
        propertyType: 'S',
        rowCount: 1,
        searchable: 'N',
        filtrable: 'Y'
    }
];

let bitrixCatalogPropertyIds = null;
let bitrixCatalogPropertySyncPromise = null;
const bitrixAssetCache = new Map();

function getRtnBitrixMeta(externalId) {
    return RTN_BITRIX_PRODUCTS_BY_ID[String(externalId || '').trim()] || null;
}

function joinBitrixProductDetailSections(meta) {
    if (!meta) return '';

    const sections = [
        ['ОФИЦИАЛЬНОЕ НАИМЕНОВАНИЕ', meta.labelTitle],
        ['ФОРМА ВЫПУСКА', meta.form],
        ['ОБЛАСТЬ ПРИМЕНЕНИЯ', meta.application],
        ['СОСТАВ', meta.composition],
        ['ПИЩЕВАЯ ЦЕННОСТЬ / АКТИВНЫЕ ВЕЩЕСТВА', meta.nutrition],
        ['РЕКОМЕНДАЦИИ ПО ПРИМЕНЕНИЮ', meta.usage],
        ['ПРОДОЛЖИТЕЛЬНОСТЬ ПРИЕМА', meta.duration],
        ['ПРОТИВОПОКАЗАНИЯ', meta.contraindications],
        ['УСЛОВИЯ ХРАНЕНИЯ', meta.storage],
        ['СРОК ГОДНОСТИ', meta.shelfLife]
    ].filter(([, value]) => String(value || '').trim());

    return sections
        .map(([title, value]) => `${title}\n${String(value).trim()}`)
        .join('\n\n');
}

function getRtnBitrixPreviewText(meta) {
    if (!meta) return '';

    return [
        meta.category,
        meta.flavor,
        meta.servingSize ? `Порция: ${meta.servingSize}` : '',
        Number.isFinite(Number(meta.servings)) ? `Порций: ${meta.servings}` : '',
        meta.packageInfo || ''
    ]
        .filter(Boolean)
        .join(' · ');
}

async function ensureRtnBitrixCatalogProperties(iblockId) {
    if (bitrixCatalogPropertyIds) {
        return bitrixCatalogPropertyIds;
    }

    if (bitrixCatalogPropertySyncPromise) {
        return bitrixCatalogPropertySyncPromise;
    }

    bitrixCatalogPropertySyncPromise = (async () => {
        const result = await bitrixCall(
            'catalog.productProperty.list',
            {
                select: [
                    'id',
                    'iblockId',
                    'name',
                    'code',
                    'propertyType',
                    'userType',
                    'multiple'
                ],
                filter: { iblockId },
                order: { id: 'asc' },
                start: 0
            }
        );

        const existing = result?.productProperties || [];
        const byCode = new Map(
            existing
                .filter(item => item?.code)
                .map(item => [String(item.code).toUpperCase(), item])
        );

        const ids = {};

        for (let index = 0; index < RTN_BITRIX_PRODUCT_PROPERTY_DEFS.length; index += 1) {
            const definition = RTN_BITRIX_PRODUCT_PROPERTY_DEFS[index];
            const found = byCode.get(definition.code);

            if (found?.id) {
                ids[definition.key] = Number(found.id);
                continue;
            }

            const added = await bitrixCall(
                'catalog.productProperty.add',
                {
                    fields: {
                        iblockId,
                        name: definition.name,
                        code: definition.code,
                        propertyType: definition.propertyType,
                        multiple: 'N',
                        isRequired: 'N',
                        active: 'Y',
                        sort: 7000 + index * 10,
                        rowCount: definition.rowCount || 1,
                        colCount: 60,
                        searchable: definition.searchable || 'N',
                        filtrable: definition.filtrable || 'N'
                    }
                }
            );

            const propertyId = Number(
                added?.productProperty?.id ||
                0
            );

            if (!propertyId) {
                throw new Error(
                    `Bitrix24 не вернул ID свойства ${definition.code}`
                );
            }

            ids[definition.key] = propertyId;
            await sleep(180);
        }

        bitrixCatalogPropertyIds = ids;
        return ids;
    })().finally(() => {
        bitrixCatalogPropertySyncPromise = null;
    });

    return bitrixCatalogPropertySyncPromise;
}

function buildRtnBitrixPropertyFields(meta, propertyIds) {
    const fields = {};
    if (!meta || !propertyIds) return fields;

    for (const definition of RTN_BITRIX_PRODUCT_PROPERTY_DEFS) {
        const propertyId = propertyIds[definition.key];
        if (!propertyId) continue;

        const rawValue = meta[definition.key];
        if (rawValue === undefined || rawValue === null || rawValue === '') {
            continue;
        }

        const value = definition.propertyType === 'N'
            ? Number(rawValue)
            : String(rawValue);

        if (definition.propertyType === 'N' && !Number.isFinite(value)) {
            continue;
        }

        // catalog.product.update ожидает объект { value } для пользовательских свойств.
        fields[`property${propertyId}`] = { value };
    }

    return fields;
}

function getAssetFileName(assetPath) {
    try {
        return decodeURIComponent(
            new URL(assetPath, FRONTEND_URL).pathname.split('/').pop() || 'image.jpg'
        );
    } catch {
        return String(assetPath || 'image.jpg').split('/').pop() || 'image.jpg';
    }
}

async function loadRtnAssetFileData(assetPath) {
    if (!assetPath) return null;

    const url = new URL(assetPath, `${FRONTEND_URL.replace(/\/+$/, '')}/`).toString();

    if (bitrixAssetCache.has(url)) {
        return bitrixAssetCache.get(url);
    }

    const response = await axios.get(
        url,
        {
            responseType: 'arraybuffer',
            timeout: 20000,
            maxContentLength: 12 * 1024 * 1024,
            maxBodyLength: 12 * 1024 * 1024
        }
    );

    const fileData = [
        getAssetFileName(assetPath),
        Buffer.from(response.data).toString('base64')
    ];

    bitrixAssetCache.set(url, fileData);
    return fileData;
}

async function syncRtnBitrixProductImages({ productId, existingProduct, meta }) {
    if (!BITRIX_SYNC_PRODUCT_IMAGES || !meta || !productId) {
        return;
    }

    const mainImageFields = {};
    const needPreview = BITRIX_FORCE_PRODUCT_IMAGES || !existingProduct?.previewPicture;
    const needDetail = BITRIX_FORCE_PRODUCT_IMAGES || !existingProduct?.detailPicture;

    if (meta.imageUrl && (needPreview || needDetail)) {
        const fileData = await loadRtnAssetFileData(meta.imageUrl);

        if (fileData) {
            if (needPreview) {
                mainImageFields.previewPicture = { fileData };
            }

            if (needDetail) {
                mainImageFields.detailPicture = { fileData };
            }
        }
    }

    if (Object.keys(mainImageFields).length) {
        await bitrixCall(
            'catalog.product.update',
            {
                id: productId,
                fields: mainImageFields
            }
        );
    }

    if (!meta.labelImageUrl) {
        return;
    }

    const imageListResult = await bitrixCall(
        'catalog.productImage.list',
        {
            productId,
            select: [
                'id',
                'name',
                'productId',
                'type'
            ],
            start: 0
        }
    );

    const expectedName = getAssetFileName(meta.labelImageUrl).toLowerCase();
    const existingImages = imageListResult?.productImages || [];
    const labelAlreadyUploaded = existingImages.some(image =>
        String(image?.type || '').toUpperCase() === 'MORE_PHOTO' &&
        String(image?.name || '').toLowerCase() === expectedName
    );

    if (!labelAlreadyUploaded) {
        const fileContent = await loadRtnAssetFileData(meta.labelImageUrl);

        if (fileContent) {
            await bitrixCall(
                'catalog.productImage.add',
                {
                    fields: {
                        productId,
                        type: 'MORE_PHOTO'
                    },
                    fileContent
                }
            );
        }
    }
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

    const meta =
        getRtnBitrixMeta(rtnProduct.externalId);

    const propertyIds =
        await ensureRtnBitrixCatalogProperties(iblockId);

    const existing =
        await findBitrixCatalogProductByExternalId(
            rtnProduct.externalId,
            iblockId
        );

    let productId = existing?.id ? Number(existing.id) : 0;

    const detailText =
        meta
            ? joinBitrixProductDetailSections(meta)
            : `Товар интернет-магазина RTN.PRO. ${rtnProduct.name}, вариант: ${rtnProduct.flavor}.`;

    const fields = {
        name: productDisplayName(rtnProduct),
        active: 'Y',
        code: productCode(rtnProduct.externalId),
        xmlId: productXmlId(rtnProduct.externalId),
        canBuyZero: 'Y',
        previewText: meta ? getRtnBitrixPreviewText(meta) : '',
        previewTextType: 'text',
        detailText,
        detailTextType: 'text',
        ...buildRtnBitrixPropertyFields(meta, propertyIds)
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

    if (meta) {
        try {
            await syncRtnBitrixProductImages({
                productId,
                existingProduct: existing,
                meta
            });
        } catch (error) {
            // Ошибка картинки не должна ломать товар или заказ.
            console.error(
                `Bitrix24 image sync failed [${rtnProduct.externalId}]:`,
                error.response?.data || error.message
            );
        }
    }

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
    DOC: 'Богдан Душин — Доктор'
};

const RTN_KNOWN_PROMO_CODES = [
    'RTN2026',
    'RHINO',
    'BIGGY',
    'BATR',
    'DOC'
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
    comment,
    attribution
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
                items,
                attribution
            }),

        SOURCE_DESCRIPTION:
            buildBitrixSourceDescription(
                attribution
            ),

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
    items,
    attribution
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

    const attributionLines =
        buildAttributionLines(
            attribution
        );

    if (attributionLines.length) {
        lines.push(
            '',
            'Источник заказа:',
            ...attributionLines
        );
    }

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
    promoCode,
    attribution
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
                comment,
                attribution
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
            buildBitrixSourceDescription(
                attribution
            ),

        originatorId:
            'RTN.PRO',

        originId:
            String(orderId || Date.now()),

        comments:
            buildBitrixDealComment({
                items,
                attribution
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
            comment,
            attribution
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

// ============================================================
// YANDEX METRIKA: OFFLINE PAID CONVERSION
// payment.succeeded -> order_paid
// ============================================================

const metrikaPaidConversions = new Map();
const METRIKA_PAID_DEDUPE_TTL = 7 * 24 * 60 * 60 * 1000;

function cleanupMetrikaPaidConversions() {
    const now = Date.now();

    for (const [paymentId, timestamp] of metrikaPaidConversions.entries()) {
        if (now - Number(timestamp || 0) > METRIKA_PAID_DEDUPE_TTL) {
            metrikaPaidConversions.delete(paymentId);
        }
    }
}

function csvCell(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function isRetryableMetrikaError(error) {
    const status = Number(error?.response?.status || 0);

    return (
        error?.code === 'ECONNABORTED' ||
        error?.code === 'ECONNRESET' ||
        error?.code === 'ETIMEDOUT' ||
        status === 429 ||
        status >= 500
    );
}

async function sendPaidConversionToMetrika(payment) {
    const paymentId =
        normalizeAttributionValue(
            payment?.id,
            120
        );

    cleanupMetrikaPaidConversions();

    if (
        paymentId &&
        metrikaPaidConversions.has(paymentId)
    ) {
        return {
            ok: true,
            deduped: true
        };
    }

    if (
        !YANDEX_METRIKA_COUNTER_ID ||
        !YANDEX_METRIKA_OAUTH_TOKEN
    ) {
        console.warn(
            'Yandex Metrika offline conversion skipped: YANDEX_METRIKA_COUNTER_ID or YANDEX_METRIKA_OAUTH_TOKEN is not configured'
        );

        return {
            ok: false,
            skipped: true,
            reason: 'not_configured'
        };
    }

    const metadata =
        payment?.metadata || {};

    const clientId =
        normalizeAttributionValue(
            metadata.metrikaClientId,
            120
        );

    const yclid =
        normalizeAttributionValue(
            metadata.yclid,
            300
        );

    const purchaseId =
        normalizeAttributionValue(
            metadata.orderId || paymentId,
            180
        );

    if (!clientId && !yclid && !purchaseId) {
        console.warn(
            `Yandex Metrika offline conversion skipped for payment ${paymentId || 'UNKNOWN'}: no ClientId, Yclid or PurchaseId`
        );

        return {
            ok: false,
            skipped: true,
            reason: 'no_identifier'
        };
    }

    const amount =
        Number(payment?.amount?.value || 0);

    const currency =
        normalizeAttributionValue(
            payment?.amount?.currency || 'RUB',
            3
        ).toUpperCase() || 'RUB';

    const rawDate =
        payment?.captured_at ||
        payment?.created_at ||
        '';

    const parsedTime =
        rawDate
            ? Math.floor(new Date(rawDate).getTime() / 1000)
            : 0;

    // Метрика не принимает DateTime из будущего. Оставляем минимум 1 секунду запаса.
    const nowSeconds =
        Math.floor(Date.now() / 1000) - 1;

    const dateTime =
        Number.isFinite(parsedTime) && parsedTime > 0
            ? Math.min(parsedTime, nowSeconds)
            : nowSeconds;

    const csv = [
        'ClientId,Yclid,PurchaseId,Target,DateTime,Price,Currency',
        [
            clientId,
            yclid,
            purchaseId,
            YANDEX_METRIKA_PAID_GOAL,
            dateTime,
            amount > 0 ? amount.toFixed(2) : '',
            currency
        ].map(csvCell).join(',')
    ].join('\n');

    const boundary =
        `----RTNMetrika${crypto.randomBytes(12).toString('hex')}`;

    const multipartBody =
        Buffer.concat([
            Buffer.from(
                `--${boundary}\r\n` +
                'Content-Disposition: form-data; name="file"; filename="offline-conversions.csv"\r\n' +
                'Content-Type: text/csv; charset=UTF-8\r\n\r\n',
                'utf8'
            ),
            Buffer.from(csv, 'utf8'),
            Buffer.from(
                `\r\n--${boundary}--\r\n`,
                'utf8'
            )
        ]);

    try {
        const response =
            await axios.post(
                `https://api-metrika.yandex.net/management/v1/counter/${encodeURIComponent(YANDEX_METRIKA_COUNTER_ID)}/offline_conversions/upload`,
                multipartBody,
                {
                    headers: {
                        Authorization:
                            `OAuth ${YANDEX_METRIKA_OAUTH_TOKEN}`,
                        'Content-Type':
                            `multipart/form-data; boundary=${boundary}`
                    },
                    timeout: 15000,
                    maxBodyLength: Infinity
                }
            );

        if (paymentId) {
            metrikaPaidConversions.set(
                paymentId,
                Date.now()
            );
        }

        const uploadId =
            response?.data?.uploading?.id ||
            response?.data?.id ||
            null;

        console.log(
            `Yandex Metrika order_paid uploaded: payment=${paymentId || 'UNKNOWN'}, order=${purchaseId || 'UNKNOWN'}, clientId=${clientId ? 'yes' : 'no'}, yclid=${yclid ? 'yes' : 'no'}, upload=${uploadId || 'UNKNOWN'}`
        );

        return {
            ok: true,
            uploadId
        };
    } catch (error) {
        error.metrikaRetryable =
            isRetryableMetrikaError(error);

        console.error(
            'Yandex Metrika offline conversion error:',
            error.response?.data ||
            error.message
        );

        throw error;
    }
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

        if (
            event !== 'payment.succeeded' &&
            event !== 'payment.canceled'
        ) {
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

        if (event === 'payment.canceled') {
            if (payment?.status !== 'canceled') {
                return res.status(409).json({
                    error: 'Статус отмены платежа не подтвержден ЮKassa'
                });
            }

            let telegramDeliveryError = null;

            try {
                const sent =
                    await sendCanceledOrderToTelegram(
                        payment
                    );

                if (sent) {
                    console.log(
                        `YooKassa payment ${paymentId}: canceled notification sent to Telegram`
                    );
                }
            } catch (telegramError) {
                telegramDeliveryError = telegramError;
                console.error(
                    'RTN canceled payment Telegram error:',
                    telegramError.response?.data ||
                    telegramError.message
                );
            }

            // Если Telegram временно недоступен, просим ЮKassa повторить webhook.
            if (telegramDeliveryError) {
                return res.status(502).json({
                    ok: false,
                    retry: true,
                    error: 'Telegram canceled notification delivery failed'
                });
            }

            return res.status(200).json({
                ok: true,
                canceled: true
            });
        }

        if (
            payment?.status !== 'succeeded' ||
            payment?.paid !== true
        ) {
            return res.status(409).json({
                error: 'Статус платежа не подтвержден ЮKassa'
            });
        }

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

        // Фиксируем реальную оплату как офлайн-конверсию order_paid.
        // Так цель попадёт в Метрику даже если покупатель закрыл ЮKassa
        // и не вернулся на rtn.pro.
        let metrikaDeliveryError = null;

        try {
            await sendPaidConversionToMetrika(
                payment
            );
        } catch (metrikaError) {
            metrikaDeliveryError = metrikaError;
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

        // При временной ошибке API Метрики просим ЮKassa повторить webhook.
        // 4xx (например, неверный OAuth) логируем, но не запускаем бесконечные повторы.
        if (metrikaDeliveryError?.metrikaRetryable) {
            return res.status(502).json({
                ok: false,
                retry: true,
                error: 'Yandex Metrika offline conversion delivery failed'
            });
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
        bitrixCatalogMetadataSku: Object.keys(RTN_BITRIX_PRODUCTS_BY_ID).length,
        bitrixCatalogPropertiesReady: Boolean(bitrixCatalogPropertyIds),
        bitrixProductImagesSync: BITRIX_SYNC_PRODUCT_IMAGES,
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
    comment,
    attribution
}) {
    const deliveryAddress =
        compactTelegramValue(
            delivery?.address ||
            delivery?.city
        );

    const attributionLines =
        buildAttributionLines(
            attribution
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
        ...(attributionLines.length
            ? ['', 'Источник:', ...attributionLines]
            : []),
        '',
        'Товары:',
        buildTelegramItemsSummary(items)
    ]
        .filter(Boolean)
        .join('\n');

    await sendTelegramText(text);
}


const orderAttemptTelegramNotifications =
    new Map();

const orderAttemptTelegramInFlight =
    new Set();

const ORDER_ATTEMPT_TELEGRAM_TTL =
    6 * 60 * 60 * 1000;

function cleanupOrderAttemptTelegramNotifications() {
    const now = Date.now();

    for (
        const [key, timestamp]
        of orderAttemptTelegramNotifications.entries()
    ) {
        if (
            now - timestamp >
            ORDER_ATTEMPT_TELEGRAM_TTL
        ) {
            orderAttemptTelegramNotifications.delete(
                key
            );
        }
    }
}

async function sendOrderAttemptToTelegramOnce({
    paymentId,
    ...payload
}) {
    cleanupOrderAttemptTelegramNotifications();

    const key =
        compactTelegramValue(
            payload?.orderId || paymentId
        );

    if (
        key !== '—' &&
        (
            orderAttemptTelegramNotifications.has(key) ||
            orderAttemptTelegramInFlight.has(key)
        )
    ) {
        return false;
    }

    if (key !== '—') {
        orderAttemptTelegramInFlight.add(key);
    }

    try {
        await sendOrderAttemptToTelegram(
            payload
        );

        if (key !== '—') {
            orderAttemptTelegramNotifications.set(
                key,
                Date.now()
            );
        }

        return true;
    } finally {
        if (key !== '—') {
            orderAttemptTelegramInFlight.delete(key);
        }
    }
}


const canceledTelegramNotifications =
    new Map();

const CANCELED_TELEGRAM_TTL =
    7 * 24 * 60 * 60 * 1000;

function cleanupCanceledTelegramNotifications() {
    const now = Date.now();

    for (
        const [paymentId, timestamp]
        of canceledTelegramNotifications.entries()
    ) {
        if (
            now - timestamp >
            CANCELED_TELEGRAM_TTL
        ) {
            canceledTelegramNotifications.delete(
                paymentId
            );
        }
    }
}

function describeYooKassaCancellationParty(value) {
    const party =
        String(value || '').trim();

    const labels = {
        merchant: 'Магазин RTN.PRO',
        yoo_money: 'ЮKassa',
        payment_network: 'Банк / платёжная сеть'
    };

    return labels[party] || party || 'Не указан';
}

function describeYooKassaCancellationReason(value) {
    const reason =
        String(value || '').trim();

    const labels = {
        '3d_secure_failed': 'Не пройдена проверка 3-D Secure',
        call_issuer: 'Банк отклонил оплату; клиенту нужно обратиться в банк',
        canceled_by_merchant: 'Платёж отменён магазином',
        card_expired: 'Истёк срок действия банковской карты',
        country_forbidden: 'Оплата картой из этой страны запрещена',
        deal_expired: 'Истёк срок действия сделки',
        expired_on_capture: 'Истёк срок подтверждения списания',
        expired_on_confirmation: 'Истёк срок оплаты; клиент не завершил платёж',
        fraud_suspected: 'Платёж отклонён из-за подозрения в мошенничестве',
        general_decline: 'Платёж отклонён без уточнения причины',
        identification_required: 'Для способа оплаты требуется идентификация',
        insufficient_funds: 'Недостаточно средств',
        internal_timeout: 'Технический таймаут на стороне ЮKassa',
        invalid_card_number: 'Неверно указан номер карты',
        invalid_csc: 'Неверно указан CVV/CVC',
        issuer_unavailable: 'Банк-эмитент временно недоступен',
        loan_application_expired: 'Истёк срок заполнения заявки на кредит/рассрочку',
        loan_declined: 'Банк отклонил заявку на кредит/рассрочку',
        loan_declined_by_payer: 'Клиент отказался от кредита/рассрочки',
        payment_method_limit_exceeded: 'Превышен лимит для способа оплаты',
        payment_method_restricted: 'Операции этим платёжным средством ограничены',
        permission_revoked: 'Отозвано разрешение на безакцептное списание',
        unsupported_mobile_operator: 'Мобильный оператор не поддерживается'
    };

    return labels[reason] || reason || 'ЮKassa не передала детальную причину';
}

async function sendCanceledOrderToTelegram(payment) {
    const paymentId =
        compactTelegramValue(
            payment?.id
        );

    cleanupCanceledTelegramNotifications();

    if (
        paymentId !== '—' &&
        canceledTelegramNotifications.has(
            paymentId
        )
    ) {
        return false;
    }

    const metadata =
        payment?.metadata || {};

    const details =
        payment?.cancellation_details || {};

    const reasonCode =
        String(details.reason || '').trim();

    const partyCode =
        String(details.party || '').trim();

    const deliveryAddress = [
        metadata.deliveryCity,
        metadata.deliveryAddress
    ]
        .filter(Boolean)
        .join(', ');

    const attributionLines = [
        metadata.trafficSource || metadata.trafficMedium
            ? `Источник: ${[
                metadata.trafficSource,
                metadata.trafficMedium
            ].filter(Boolean).join(' / ')}`
            : null,

        metadata.trafficCampaign
            ? `Кампания: ${metadata.trafficCampaign}`
            : null,

        metadata.trafficContent
            ? `Контент: ${metadata.trafficContent}`
            : null,

        metadata.telegramStart
            ? `Telegram start: ${metadata.telegramStart}`
            : null,

        metadata.trafficPlatform
            ? `Платформа: ${metadata.trafficPlatform}`
            : null
    ].filter(Boolean);

    const paymentMethod =
        compactTelegramValue(
            payment?.payment_method?.type
        );

    const text = [
        '🔴 RTN.PRO — ОПЛАТА НЕ СОСТОЯЛАСЬ',
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
        `Причина: ${describeYooKassaCancellationReason(reasonCode)}`,
        `Код причины: ${reasonCode || 'не указан'}`,
        `Инициатор: ${describeYooKassaCancellationParty(partyCode)}${partyCode ? ` (${partyCode})` : ''}`,
        `Способ оплаты: ${paymentMethod}`,
        ...(attributionLines.length
            ? ['', ...attributionLines]
            : []),
        '',
        'Статус ЮKassa: ОТМЕНЁН ✗'
    ].join('\n');

    await sendTelegramText(text);

    if (paymentId !== '—') {
        canceledTelegramNotifications.set(
            paymentId,
            Date.now()
        );
    }

    return true;
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

    const paidAttributionLines = [
        metadata.trafficSource || metadata.trafficMedium
            ? `Источник: ${[
                metadata.trafficSource,
                metadata.trafficMedium
            ].filter(Boolean).join(' / ')}`
            : null,

        metadata.trafficCampaign
            ? `Кампания: ${metadata.trafficCampaign}`
            : null,

        metadata.trafficContent
            ? `Контент: ${metadata.trafficContent}`
            : null,

        metadata.telegramStart
            ? `Telegram start: ${metadata.telegramStart}`
            : null,

        metadata.trafficPlatform
            ? `Платформа: ${metadata.trafficPlatform}`
            : null,

        metadata.telegramChatType
            ? `Telegram context: ${metadata.telegramChatType}`
            : null
    ].filter(Boolean);

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
        ...(paidAttributionLines.length
            ? ['', ...paidAttributionLines]
            : []),
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

            try {
                await sendPaidConversionToMetrika(
                    payment
                );
            } catch (metrikaError) {
                console.error(
                    'Yandex Metrika paid conversion fallback error:',
                    metrikaError.response?.data ||
                    metrikaError.message
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

const paymentCreationInFlight = new Map();
const paymentCreationCache = new Map();
const PAYMENT_CREATION_CACHE_TTL = 30 * 60 * 1000;

function cleanupPaymentCreationCache() {
    const now = Date.now();

    for (const [key, entry] of paymentCreationCache.entries()) {
        if (
            !entry ||
            now - Number(entry.createdAt || 0) > PAYMENT_CREATION_CACHE_TTL
        ) {
            paymentCreationCache.delete(key);
        }
    }
}

async function createYooKassaPaymentOnce(orderId, paymentData) {
    cleanupPaymentCreationCache();

    const orderKey =
        String(orderId || '')
            .trim()
            .slice(0, 120);

    if (orderKey) {
        const cached = paymentCreationCache.get(orderKey);
        if (cached?.data) {
            console.log(
                `YooKassa create-payment dedupe: cached order=${orderKey}, payment=${cached.data?.id || 'NO_ID'}`
            );
            return cached.data;
        }

        const inFlight = paymentCreationInFlight.get(orderKey);
        if (inFlight) {
            console.log(
                `YooKassa create-payment dedupe: waiting for in-flight order=${orderKey}`
            );
            return inFlight;
        }
    }

    const createPromise = (async () => {
        // ЮKassa рекомендует UUID v4 для каждого реально нового запроса.
        // Дубли одного orderId объединяем на нашей стороне, поэтому не
        // переиспользуем один Idempotence-Key для потенциально изменившегося тела.
        const idempotenceKey = crypto.randomUUID();

        const response = await axios.post(
            'https://api.yookassa.ru/v3/payments',
            paymentData,
            {
                auth: {
                    username: YOOKASSA_SHOP_ID,
                    password: YOOKASSA_SECRET_KEY
                },
                headers: {
                    'Idempotence-Key': idempotenceKey,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        return response.data;
    })();

    if (orderKey) {
        paymentCreationInFlight.set(orderKey, createPromise);
    }

    try {
        const data = await createPromise;

        if (orderKey && data?.id) {
            paymentCreationCache.set(orderKey, {
                data,
                createdAt: Date.now()
            });
        }

        return data;
    } finally {
        if (orderKey) {
            paymentCreationInFlight.delete(orderKey);
        }
    }
}


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
    try {
        const {
            amount,
            items,
            customer,
            delivery,
            orderId,
            comment,
            promoCode,
            attribution
        } = req.body;

        const normalizedAttribution =
            normalizeAttribution(
                attribution
            );

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

        console.log(
            `YooKassa receipt prepared: order=${String(orderId || 'NO_ID')}, email=yes, phone=yes, items=${receiptItems.length}`
        );

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
                    promoCode,
                    attribution:
                        normalizedAttribution
                });
        } catch (bitrixError) {
            // Ошибка CRM не должна блокировать оплату.
            console.error(
                'Bitrix24 order sync error:',
                bitrixError.response?.data ||
                bitrixError.message
            );
        }

        const rawPaymentMetadata = {
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
                normalizePromoCode(promoCode),

            trafficSource:
                normalizedAttribution.lastTouch.source,

            trafficMedium:
                normalizedAttribution.lastTouch.medium,

            trafficCampaign:
                normalizedAttribution.lastTouch.campaign,

            trafficContent:
                normalizedAttribution.lastTouch.content,

            telegramStart:
                normalizedAttribution.lastTouch.startParam,

            // В metadata ЮKassa допускается не более 16 пар ключ-значение.
            // Оставляем только поля, которые реально нужны после оплаты:
            // данные заказа, атрибуция и идентификаторы Метрики.
            metrikaClientId:
                normalizedAttribution.metrikaClientId,

            yclid:
                normalizedAttribution.yclid
        };

        const paymentMetadataEntries =
            Object.entries(rawPaymentMetadata)
                .map(([key, value]) => [
                    key,
                    String(value ?? '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 500)
                ])
                .filter(([, value]) => Boolean(value));

        // Жёсткая страховка от invalid_request по metadata:
        // максимум 16 ключей по требованиям ЮKassa.
        const paymentMetadata =
            Object.fromEntries(
                paymentMetadataEntries.slice(0, 16)
            );

        if (paymentMetadataEntries.length > 16) {
            console.warn(
                `YooKassa metadata trimmed: ${paymentMetadataEntries.length} -> 16 fields, order=${String(orderId || 'NO_ID')}`
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

            metadata:
                paymentMetadata,

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

        const yooPayment =
            await createYooKassaPaymentOnce(
                orderId,
                paymentData
            );

        const confirmationUrl =
            yooPayment
                ?.confirmation
                ?.confirmation_url;

        if (!confirmationUrl) {
            console.error(
                'YooKassa did not return confirmation_url:',
                yooPayment
            );

            return res.status(500).json({
                error:
                    'ЮKassa не вернула ссылку на оплату'
            });
        }

        // Уведомляем о попытке только после того, как ЮKassa
        // реально создала платеж и вернула confirmation_url.
        // Дедупликация идёт прежде всего по orderId, поэтому повторный запрос
        // одного заказа не создаст несколько сообщений.
        sendOrderAttemptToTelegramOnce({
            paymentId:
                yooPayment.id,
            amount:
                paymentAmount,
            items,
            customer,
            delivery,
            orderId,
            promoCode,
            comment,
            attribution:
                normalizedAttribution
        }).catch(error => {
            console.error(
                'RTN order attempt Telegram error:',
                error.response?.data ||
                error.message
            );
        });

        if (bitrixDealId) {
            markBitrixPaymentCreated(
                bitrixDealId,
                yooPayment
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
                yooPayment.id,

            status:
                yooPayment.status,

            confirmationUrl,

            confirmation:
                yooPayment.confirmation,

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

        const statusCode =
            error.response?.status ||
            500;

        const parameter =
            yooError?.parameter ||
            '';

        const description =
            yooError?.description ||
            error.message ||
            'Неизвестная ошибка';

        const diagnosticDescription =
            parameter
                ? `${description} (parameter: ${parameter})`
                : description;

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

                    description: diagnosticDescription,

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
                diagnosticDescription,

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
