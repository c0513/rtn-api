const { getPool } = require('./db');

function clean(value, max = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEmail(value) {
    return clean(value, 254).toLowerCase();
}

function normalizePhone(value) {
    const raw = clean(value, 40);
    const digits = raw.replace(/\D/g, '');

    if (!digits) return '';
    if (digits.length === 11 && digits.startsWith('8')) return '+7' + digits.slice(1);
    if (digits.length === 10) return '+7' + digits;
    if (digits.length === 11 && digits.startsWith('7')) return '+' + digits;

    return raw;
}

function getBitrixWebhookUrl() {
    return String(process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');
}

async function bitrixCall(method, params = {}) {
    const base = getBitrixWebhookUrl();

    if (!base) {
        const error = new Error('BITRIX_WEBHOOK_URL is not configured');
        error.code = 'BITRIX_NOT_CONFIGURED';
        throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(`${base}/${method}.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(params),
            signal: controller.signal
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || data?.error) {
            const error = new Error(
                data?.error_description ||
                data?.error ||
                `Bitrix HTTP ${response.status}`
            );
            error.status = response.status;
            error.bitrixError = data?.error || null;
            throw error;
        }

        return data?.result;
    } finally {
        clearTimeout(timeout);
    }
}

function pick(user, ...keys) {
    for (const key of keys) {
        const value = user?.[key];
        if (value !== undefined && value !== null && String(value).trim()) {
            return value;
        }
    }
    return '';
}

function buildStandardContactFields(user = {}, extra = {}) {
    const source = {
        ...user,
        ...extra
    };

    const firstName = clean(
        pick(source, 'first_name', 'firstName'),
        100
    );
    const lastName = clean(
        pick(source, 'last_name', 'lastName'),
        100
    );
    const email = normalizeEmail(
        pick(source, 'email')
    );
    const phone = normalizePhone(
        pick(source, 'phone')
    );

    const fields = {
        SOURCE_ID: 'WEB',
        SOURCE_DESCRIPTION: 'Личный кабинет RTN.PRO'
    };

    if (firstName) {
        fields.NAME = firstName;
    }

    if (lastName) {
        fields.LAST_NAME = lastName;
    }

    if (email) {
        fields.EMAIL = [{
            VALUE: email,
            VALUE_TYPE: 'WORK'
        }];
    }

    if (phone) {
        fields.PHONE = [{
            VALUE: phone,
            VALUE_TYPE: 'MOBILE'
        }];
    }

    const street = clean(
        pick(source, 'street', 'address', 'address_line1', 'addressLine1'),
        300
    );
    const house = clean(
        pick(source, 'house'),
        80
    );
    const apartmentOffice = clean(
        pick(source, 'apartmentOffice', 'address_2', 'address_line2', 'addressLine2'),
        120
    );
    const city = clean(
        pick(source, 'address_city', 'city'),
        150
    );
    const country = clean(
        pick(source, 'address_country', 'country'),
        100
    );
    const birthDate = clean(
        pick(source, 'birth_date', 'birthDate'),
        40
    );

    if (street) fields.ADDRESS = street;

    const address2Parts = [];
    if (house) address2Parts.push(`Дом: ${house}`);
    if (apartmentOffice) {
        address2Parts.push(`Квартира/офис: ${apartmentOffice}`);
    }
    if (address2Parts.length) {
        fields.ADDRESS_2 = address2Parts.join('; ');
    }

    if (city) fields.ADDRESS_CITY = city;
    if (country) fields.ADDRESS_COUNTRY = country;
    if (birthDate) fields.BIRTHDATE = birthDate;

    const photoBase64 = clean(
        pick(source, 'photo_base64', 'photoBase64'),
        20 * 1024 * 1024
    );

    if (photoBase64) {
        const filename = clean(
            pick(source, 'photo_filename', 'photoFilename') || 'rtn-profile.jpg',
            180
        );

        fields.PHOTO = {
            fileData: [
                filename,
                photoBase64.replace(/^data:[^;]+;base64,/, '')
            ]
        };
    }

    return fields;
}

async function findContactId({ email, phone }) {
    const normalizedPhone = normalizePhone(phone);

    if (normalizedPhone) {
        const byPhone = await bitrixCall('crm.duplicate.findbycomm', {
            type: 'PHONE',
            values: [normalizedPhone],
            entity_type: 'CONTACT'
        });

        const ids = byPhone?.CONTACT || byPhone?.contact || [];

        if (Array.isArray(ids) && ids.length) {
            return Number(ids[0]);
        }
    }

    const normalizedEmail = normalizeEmail(email);

    if (normalizedEmail) {
        const byEmail = await bitrixCall('crm.duplicate.findbycomm', {
            type: 'EMAIL',
            values: [normalizedEmail],
            entity_type: 'CONTACT'
        });

        const ids = byEmail?.CONTACT || byEmail?.contact || [];

        if (Array.isArray(ids) && ids.length) {
            return Number(ids[0]);
        }
    }

    return null;
}

async function createAccountContact(user, extra = {}) {
    const fields = buildStandardContactFields(user, extra);

    if (!fields.NAME) {
        const email = normalizeEmail(user?.email || extra?.email);
        fields.NAME =
            (email ? email.split('@')[0] : '') ||
            'Покупатель RTN.PRO';
    }

    const result = await bitrixCall('crm.contact.add', {
        fields,
        params: {
            REGISTER_SONET_EVENT: 'N'
        }
    });

    return Number(result || 0) || null;
}

async function syncAccountContactFields(contactId, user, extra = {}) {
    if (!contactId) return false;

    await bitrixCall('crm.contact.update', {
        id: Number(contactId),
        fields: buildStandardContactFields(user, extra),
        params: {
            REGISTER_SONET_EVENT: 'N'
        }
    });

    return true;
}

async function persistContactId(userId, contactId) {
    if (!userId || !contactId) return;

    const db = getPool();

    await db.execute(
        'UPDATE users SET bitrix_contact_id = ?, updated_at = NOW() WHERE id = ?',
        [Number(contactId), userId]
    );
}

async function ensureAccountBitrixContact(user, extra = {}) {
    if (!user) return null;

    let contactId = Number(user.bitrix_contact_id || 0) || null;

    if (!contactId) {
        contactId = await findContactId({
            email: user.email,
            phone: user.phone
        });
    }

    if (!contactId) {
        contactId = await createAccountContact(user, extra);
    }

    if (!contactId) {
        return null;
    }

    if (user.id) {
        await persistContactId(user.id, contactId);
    }

    user.bitrix_contact_id = contactId;

    // CRM-контакт является мастер-копией расширенного профиля.
    // Каждый успешный вход освежает стандартные поля теми данными,
    // которые уже есть у пользователя RTN.
    try {
        await syncAccountContactFields(contactId, user, extra);
    } catch (error) {
        console.error(
            `RTN account Bitrix contact sync error for ${contactId}:`,
            error.message
        );
    }

    return contactId;
}

function extractContactPhotoUrl(value) {
    if (!value) return '';

    const candidates = [];

    if (typeof value === 'string') {
        candidates.push(value);
    } else if (Array.isArray(value)) {
        candidates.push(...value);
    } else if (typeof value === 'object') {
        candidates.push(
            value.url,
            value.URL,
            value.downloadUrl,
            value.download_url,
            value.showUrl,
            value.show_url,
            value.src,
            value.SRC
        );
    }

    for (const candidate of candidates) {
        const photo = String(candidate || '').trim();

        if (/^https?:\/\//i.test(photo) || /^data:image\//i.test(photo)) {
            return photo;
        }
    }

    return '';
}

const RTN_MEMBER_STATUS_FIELD = 'UF_CRM_RTN_MEMBER_STATUS';
let memberStatusCache = { expiresAt: 0, options: new Map() };

async function getContactMemberStatuses(contact = {}) {
    const raw = contact[RTN_MEMBER_STATUS_FIELD];
    const ids = Array.isArray(raw)
        ? raw.map(String)
        : raw !== undefined && raw !== null && raw !== ''
            ? [String(raw)]
            : [];

    if (!ids.length) return [];

    const now = Date.now();

    if (memberStatusCache.expiresAt <= now) {
        try {
            const fields = await bitrixCall('crm.contact.userfield.list', {
                filter: { FIELD_NAME: RTN_MEMBER_STATUS_FIELD }
            });
            const field = Array.isArray(fields) ? fields[0] : null;
            const options = new Map();

            for (const option of Array.isArray(field?.LIST) ? field.LIST : []) {
                const id = String(option.ID || option.id || '');
                const value = clean(option.VALUE || option.value || '', 120);
                if (id) options.set(id, value || id);
            }

            memberStatusCache = {
                expiresAt: now + 15000,
                options
            };
        } catch (error) {
            console.error('RTN member status lookup error:', error.message);
        }
    }

    return ids
        .map(id => memberStatusCache.options.get(id) || clean(id, 120))
        .filter(Boolean)
        .map(value => String(value).toUpperCase());
}

function normalizeCrmDateOnly(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
}

function parseSecondaryAddress(value) {
    const text = clean(value, 500);
    const houseMatch = text.match(/(?:^|;\s*)Дом:\s*([^;]+)/i);
    const apartmentMatch = text.match(
        /(?:^|;\s*)Квартира\/офис:\s*([^;]+)/i
    );

    return {
        house: houseMatch ? clean(houseMatch[1], 80) : '',
        apartmentOffice: apartmentMatch
            ? clean(apartmentMatch[1], 120)
            : ''
    };
}

const ORDER_STAGE_SEQUENCE = [
    'NEW',
    'PREPARATION',
    'PREPAYMENT_INVOICE',
    'EXECUTING',
    'FINAL_INVOICE',
    'UC_QOL0Q0',
    'WON'
];

const DEAL_FIELD_NAMES = {
    orderNumber: 'UF_CRM_RTN_ORDER_NUMBER',
    amountBeforeDiscount: 'UF_CRM_RTN_AMOUNT_BEFORE_DISCOUNT',
    discountAmount: 'UF_CRM_RTN_DISCOUNT_AMOUNT',
    deliveryType: 'UF_CRM_RTN_DELIVERY_TYPE',
    deliveryAddress: 'UF_CRM_RTN_DELIVERY_ADDRESS',
    deliveryCost: 'UF_CRM_RTN_DELIVERY_COST',
    clientComment: 'UF_CRM_RTN_CLIENT_COMMENT',
    paymentStatus: 'UF_CRM_RTN_PAYMENT_STATUS',
    promoCode: 'UF_CRM_RTN_PROMO_CODE'
};

const PRODUCT_IMAGE_BY_EXTERNAL_ID = {
    'whey-caramel': '/images/Whey/salted caramel.png',
    'whey-lemon': '/images/Whey/lemon mousse.png',
    'whey-raspberry': '/images/Whey/white chocolate.png',
    'mass-choco': '/images/Gainer/chocolate.png',
    'mass-lemon': '/images/Gainer/lemon mousse.png',
    'mass-caramel': '/images/Gainer/salted caramel.png',
    'mass-raspberry': '/images/Gainer/white chocolate.png',
    'bcaa-wildberries': '/images/BCAA/wildberries.png',
    'bcaa-lime': '/images/BCAA/lemon lime.png',
    'bcaa-grapefruit': '/images/BCAA/grapefruit.png',
    'bcaa-currant': '/images/BCAA/black currant.png',
    'arg-wildberries': '/images/AAKG/wildberries.png',
    'arg-lime': '/images/AAKG/lemon lime.png',
    'arg-grapefruit': '/images/AAKG/grapefruit.png',
    'arg-currant': '/images/AAKG/black currant.png',
    'pre-cola': '/images/Rage/marmalade.png',
    'pre-orange': '/images/Rage/orange.png',
    'pre-bubblegum': '/images/Rage/bubble gum.png',
    'creatine-orange': '/images/Creatine/orange.png',
    'creatine-wildberries': '/images/Creatine/wildberries.png',
    'creatine-apple': '/images/Creatine/apple.png',
    'creatine-neutral': '/images/Creatine/neutral.png',
    'amylo-neutral': '/images/Amylopectin_1000.jpg',
    'magnesium-caps': '/images/Magnesium.png',
    'chondro-caps': '/images/Joint Support.png',
    'omega3-caps': '/images/Omega 3.png'
};

const stageCache = new Map();
const dealFieldOptionsCache = {
    expiresAt: 0,
    fields: new Map()
};
const catalogProductCache = new Map();

function stageEntityId(stageId) {
    const match = clean(stageId, 100).match(/^C(\d+):/i);
    return match ? `DEAL_STAGE_${match[1]}` : 'DEAL_STAGE';
}

async function getStageMap(stageId) {
    const entityId = stageEntityId(stageId);
    const cached = stageCache.get(entityId);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
        return cached.map;
    }

    try {
        const rows = await bitrixCall('crm.status.list', {
            order: {
                SORT: 'ASC'
            },
            filter: {
                ENTITY_ID: entityId
            }
        });

        const map = new Map();
        const categoryMatch = clean(stageId, 100).match(/^C(\d+):/i);

        for (const row of Array.isArray(rows) ? rows : []) {
            const rawId = clean(row.STATUS_ID || row.statusId || '', 100);
            const name = clean(row.NAME || row.name || '', 200);

            if (!rawId) continue;

            map.set(rawId, name || rawId);

            if (categoryMatch && !rawId.includes(':')) {
                map.set(`C${categoryMatch[1]}:${rawId}`, name || rawId);
            }
        }

        stageCache.set(entityId, {
            map,
            expiresAt: now + 15000
        });

        return map;
    } catch (error) {
        console.error(
            `RTN account Bitrix stage map error for ${entityId}:`,
            error.message
        );

        return cached?.map || new Map();
    }
}

async function getDealStagePresentation(stageId) {
    const stage = clean(stageId, 100);
    const map = await getStageMap(stage);
    const label = map.get(stage) || stage;

    const categoryMatch = stage.match(/^C(\d+):/i);
    const prefix = categoryMatch ? `C${categoryMatch[1]}:` : '';
    const sequence = ORDER_STAGE_SEQUENCE.map(id => `${prefix}${id}`);
    const steps = sequence.map((id, index) => ({
        id,
        label: map.get(id) || id,
        index
    }));

    return {
        label,
        steps,
        currentIndex: sequence.indexOf(stage)
    };
}

async function getDealUserFieldOptions() {
    const now = Date.now();

    if (
        dealFieldOptionsCache.expiresAt > now &&
        dealFieldOptionsCache.fields.size
    ) {
        return dealFieldOptionsCache.fields;
    }

    try {
        const rows = await bitrixCall('crm.deal.userfield.list', {
            order: {
                SORT: 'ASC'
            }
        });

        const fields = new Map();

        for (const field of Array.isArray(rows) ? rows : []) {
            const fieldName = clean(
                field.FIELD_NAME || field.fieldName || '',
                150
            );

            if (!fieldName) continue;

            const options = new Map();

            for (const option of Array.isArray(field.LIST) ? field.LIST : []) {
                const id = String(option.ID || option.id || '');
                const value = clean(option.VALUE || option.value || '', 300);

                if (id) {
                    options.set(id, value || id);
                }
            }

            fields.set(fieldName, options);
        }

        dealFieldOptionsCache.fields = fields;
        dealFieldOptionsCache.expiresAt = now + 60000;

        return fields;
    } catch (error) {
        console.error(
            'RTN account Bitrix deal user fields error:',
            error.message
        );

        return dealFieldOptionsCache.fields;
    }
}

async function resolveDealFieldValue(fieldName, value) {
    if (value === undefined || value === null || value === '') return '';

    const optionsByField = await getDealUserFieldOptions();
    const options = optionsByField.get(fieldName);

    if (!options || !options.size) {
        return clean(Array.isArray(value) ? value[0] : value, 300);
    }

    const values = Array.isArray(value) ? value : [value];

    return values
        .map(item => options.get(String(item)) || clean(item, 300))
        .filter(Boolean)
        .join(', ');
}

async function getCatalogProductPresentation(productId) {
    const id = Number(productId || 0);
    if (!id) return null;

    if (catalogProductCache.has(id)) {
        return catalogProductCache.get(id);
    }

    try {
        const result = await bitrixCall('catalog.product.list', {
            select: ['id', 'iblockId', 'name', 'xmlId'],
            filter: {
                id
            }
        });

        const products =
            result?.products ||
            result?.items ||
            (Array.isArray(result) ? result : []);

        const product =
            (Array.isArray(products) ? products[0] : null) ||
            {};

        const xmlId = clean(product.xmlId || product.XML_ID || '', 200);
        const externalId = xmlId.replace(/^RTN:/i, '');
        const name = clean(product.name || product.NAME || '', 300);

        const presentation = {
            externalId,
            name,
            imageUrl: PRODUCT_IMAGE_BY_EXTERNAL_ID[externalId] || ''
        };

        catalogProductCache.set(id, presentation);

        return presentation;
    } catch (error) {
        console.error(
            `RTN account Bitrix catalog product error for ${id}:`,
            error.message
        );

        return null;
    }
}

function splitProductName(value) {
    const text = clean(value, 300);
    const parts = text.split(/\s+[—-]\s+/);

    return {
        name: clean(parts.shift() || text, 200),
        flavor: clean(parts.join(' — '), 160)
    };
}


async function getAccountBitrixProfile(user) {
    const contactId = await ensureAccountBitrixContact(user);

    if (!contactId) {
        return null;
    }

    const contact = await bitrixCall('crm.contact.get', {
        id: Number(contactId)
    });

    if (!contact) return null;

    const email =
        Array.isArray(contact.EMAIL) && contact.EMAIL[0]
            ? contact.EMAIL[0].VALUE
            : null;

    const phone =
        Array.isArray(contact.PHONE) && contact.PHONE[0]
            ? contact.PHONE[0].VALUE
            : null;

    const secondaryAddress = parseSecondaryAddress(contact.ADDRESS_2 || '');
    const memberStatuses = await getContactMemberStatuses(contact);

    return {
        firstName: contact.NAME || '',
        lastName: contact.LAST_NAME || '',
        email: email || user.email || null,
        phone: phone || user.phone || null,
        street: contact.ADDRESS || '',
        house: secondaryAddress.house,
        apartmentOffice: secondaryAddress.apartmentOffice,
        city: contact.ADDRESS_CITY || '',
        country: contact.ADDRESS_COUNTRY || '',
        birthDate: normalizeCrmDateOnly(contact.BIRTHDATE),
        avatarUrl: '',
        hasPhoto: Boolean(contact.PHOTO),
        memberStatuses
    };
}

async function updateAccountBitrixProfile(user, profile = {}) {
    const contactId = await ensureAccountBitrixContact(user, profile);

    if (!contactId) {
        throw new Error('Не удалось создать контакт Bitrix24');
    }

    await syncAccountContactFields(contactId, user, profile);

    return getAccountBitrixProfile({
        ...user,
        bitrix_contact_id: contactId
    });
}

function mapDealStatus(stageId) {
    const stage = String(stageId || '');

    const paidStage = String(process.env.BITRIX_STAGE_PAID || 'PREPARATION');
    const newStage = String(process.env.BITRIX_STAGE_NEW || 'NEW');

    if (/WON$/i.test(stage)) return 'completed';
    if (/LOSE|LOST|FAIL|APOLOGY/i.test(stage)) return 'cancelled';
    if (stage === paidStage) return 'paid';
    if (stage === newStage) return 'new';

    return 'processing';
}

async function getDealProductRows(dealId) {
    try {
        const rows = await bitrixCall('crm.deal.productrows.get', {
            id: Number(dealId)
        });

        const items = [];

        for (const row of Array.isArray(rows) ? rows : []) {
            const rawName = clean(
                row.PRODUCT_NAME || row.productName || '',
                300
            );

            if (/^ДОСТАВКА\s*[—-]/i.test(rawName)) {
                continue;
            }

            const productId = String(row.PRODUCT_ID || row.productId || '');
            const product = productId
                ? await getCatalogProductPresentation(productId)
                : null;

            const parsed = splitProductName(product?.name || rawName);
            const externalId = product?.externalId || '';

            items.push({
                id: String(row.ID || row.id || ''),
                productId,
                externalId,
                name: parsed.name || rawName || 'Товар RTN.PRO',
                flavor: parsed.flavor,
                imageUrl:
                    product?.imageUrl ||
                    PRODUCT_IMAGE_BY_EXTERNAL_ID[externalId] ||
                    '',
                price: Number(row.PRICE || row.price || 0),
                originalPrice:
                    Number(row.PRICE || row.price || 0) +
                    Number(row.DISCOUNT_SUM || row.discountSum || 0),
                finalPrice: Number(row.PRICE || row.price || 0),
                quantity: Math.max(
                    1,
                    Number(row.QUANTITY || row.quantity || 1)
                ),
                measureName: clean(
                    row.MEASURE_NAME || row.measureName || '',
                    100
                ),
                discountSum: Number(
                    row.DISCOUNT_SUM || row.discountSum || 0
                )
            });
        }

        return items;
    } catch (error) {
        console.error(
            `RTN account Bitrix product rows error for deal ${dealId}:`,
            error.message
        );

        return [];
    }
}

async function getAccountDealForUser(user, dealId) {
    const contactId = await ensureAccountBitrixContact(user);
    const id = Number(dealId || 0);

    if (!contactId || !id) return null;

    const deal = await bitrixCall('crm.deal.get', {
        id
    });

    const dealContactId = Number(
        deal?.CONTACT_ID ||
        deal?.contactId ||
        0
    );

    if (!deal || dealContactId !== Number(contactId)) {
        return null;
    }

    return deal;
}

async function getAccountOrders(user) {
    const contactId = await ensureAccountBitrixContact(user);

    if (!contactId) {
        return {
            contactId: null,
            orders: []
        };
    }

    const result = await bitrixCall('crm.deal.list', {
        order: {
            DATE_CREATE: 'DESC'
        },
        filter: {
            CONTACT_ID: contactId
        },
        select: [
            'ID',
            'TITLE',
            'STAGE_ID',
            'CATEGORY_ID',
            'OPPORTUNITY',
            'CURRENCY_ID',
            'DATE_CREATE',
            'DATE_MODIFY',
            'BEGINDATE',
            'CLOSEDATE',
            'CONTACT_ID',
            'ORIGINATOR_ID',
            'ORIGIN_ID',
            'COMMENTS',
            DEAL_FIELD_NAMES.orderNumber,
            DEAL_FIELD_NAMES.amountBeforeDiscount,
            DEAL_FIELD_NAMES.discountAmount,
            DEAL_FIELD_NAMES.deliveryType,
            DEAL_FIELD_NAMES.deliveryAddress,
            DEAL_FIELD_NAMES.deliveryCost,
            DEAL_FIELD_NAMES.clientComment,
            DEAL_FIELD_NAMES.paymentStatus,
            DEAL_FIELD_NAMES.promoCode
        ],
        start: 0
    });

    const deals = Array.isArray(result) ? result : [];
    const orders = [];

    for (const deal of deals.slice(0, 100)) {
        const id = Number(deal.ID || deal.id || 0);
        const items = id ? await getDealProductRows(id) : [];
        const stage = await getDealStagePresentation(deal.STAGE_ID);
        const status = mapDealStatus(deal.STAGE_ID);
        const amount = Number(deal.OPPORTUNITY || 0);

        const [
            deliveryType,
            paymentStatus,
            promoCode
        ] = await Promise.all([
            resolveDealFieldValue(
                DEAL_FIELD_NAMES.deliveryType,
                deal[DEAL_FIELD_NAMES.deliveryType]
            ),
            resolveDealFieldValue(
                DEAL_FIELD_NAMES.paymentStatus,
                deal[DEAL_FIELD_NAMES.paymentStatus]
            ),
            resolveDealFieldValue(
                DEAL_FIELD_NAMES.promoCode,
                deal[DEAL_FIELD_NAMES.promoCode]
            )
        ]);

        orders.push({
            dealId: String(id || ''),
            id: String(id || ''),
            number: clean(
                deal[DEAL_FIELD_NAMES.orderNumber] ||
                deal.ORIGIN_ID ||
                '',
                100
            ),
            title: clean(deal.TITLE || '', 300),
            status,
            statusLabel: stage.label,
            stageId: clean(deal.STAGE_ID || '', 100),
            stageIndex: stage.currentIndex,
            stageSteps: stage.steps,
            amount,
            amountBeforeDiscount: Number(
                deal[DEAL_FIELD_NAMES.amountBeforeDiscount] || amount
            ),
            discountAmount: Number(
                deal[DEAL_FIELD_NAMES.discountAmount] || 0
            ),
            currency: clean(deal.CURRENCY_ID || 'RUB', 10),
            createdAt: deal.DATE_CREATE || null,
            updatedAt: deal.DATE_MODIFY || null,
            closedAt: deal.CLOSEDATE || null,
            originatorId: clean(deal.ORIGINATOR_ID || '', 100),
            deliveryType,
            deliveryAddress: clean(
                deal[DEAL_FIELD_NAMES.deliveryAddress] || '',
                1000
            ),
            deliveryCost: Number(
                deal[DEAL_FIELD_NAMES.deliveryCost] || 0
            ),
            paymentStatus,
            promoCode,
            clientComment: clean(
                deal[DEAL_FIELD_NAMES.clientComment] || '',
                1000
            ),
            xpEarned:
                status === 'completed'
                    ? Math.max(0, Math.round(amount))
                    : 0,
            xpPending:
                status !== 'completed' && status !== 'cancelled'
                    ? Math.max(0, Math.round(amount))
                    : 0,
            receiptAvailable:
                Boolean(
                    clean(
                        deal.ORIGIN_ID ||
                        '',
                        100
                    )
                ),
            items
        });
    }

    return {
        contactId,
        orders
    };
}

async function getAccountOrderReference(user, dealId) {
    const deal = await getAccountDealForUser(user, dealId);

    if (!deal) return null;

    return {
        dealId: String(deal.ID || deal.id || ''),
        orderId: clean(
            deal.ORIGIN_ID ||
            deal[DEAL_FIELD_NAMES.orderNumber] ||
            '',
            100
        ),
        title: clean(deal.TITLE || '', 300)
    };
}


module.exports = {
    bitrixCall,
    findContactId,
    buildStandardContactFields,
    createAccountContact,
    syncAccountContactFields,
    ensureAccountBitrixContact,
    getAccountBitrixProfile,
    updateAccountBitrixProfile,
    getAccountOrders,
    getAccountOrderReference
};
