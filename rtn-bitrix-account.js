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

    // Чтение личного кабинета не должно каждый раз писать в Bitrix.
    // Поля контакта обновляются только через явное сохранение профиля.
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
const RTN_PERSONAL_PROMO_FIELD = 'UF_CRM_RTN_PERSONAL_PROMO';
let memberStatusCache = { expiresAt: 0, options: new Map() };

async function ensureContactSimpleField(fieldName, label) {
    const existing = await bitrixCall('crm.contact.userfield.list', {
        filter: {
            FIELD_NAME: fieldName
        }
    });

    const current = Array.isArray(existing) ? existing[0] : null;

    if (current) {
        try {
            await bitrixCall('crm.contact.userfield.update', {
                id: Number(current.ID || current.id || 0),
                fields: {
                    SHOW_FILTER: 'Y',
                    SHOW_IN_LIST: 'Y',
                    EDIT_IN_LIST: 'Y',
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
                    SORT: 3100
                }
            });
        } catch (error) {
            console.error(
                `RTN contact field editability sync error for ${fieldName}:`,
                error.message
            );
        }

        return current;
    }

    await bitrixCall('crm.contact.userfield.add', {
        fields: {
            FIELD_NAME: fieldName,
            USER_TYPE_ID: 'string',
            MULTIPLE: 'N',
            MANDATORY: 'N',
            SHOW_FILTER: 'Y',
            SHOW_IN_LIST: 'Y',
            EDIT_IN_LIST: 'Y',
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
            SORT: 3100
        }
    });

    const refreshed = await bitrixCall('crm.contact.userfield.list', {
        filter: {
            FIELD_NAME: fieldName
        }
    });

    return Array.isArray(refreshed) ? refreshed[0] || null : null;
}

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
                expiresAt: now + 5 * 60 * 1000,
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

async function getOrCreatePersonalPromo({
    contact,
    contactId,
    user
}) {
    const existing = clean(
        contact?.[RTN_PERSONAL_PROMO_FIELD],
        80
    ).toUpperCase();

    if (existing) {
        return existing;
    }

    const generated = referralCodeFromPublicId(user?.public_id);

    if (!generated || !contactId) {
        return generated;
    }

    try {
        await bitrixCall('crm.contact.update', {
            id: Number(contactId),
            fields: {
                [RTN_PERSONAL_PROMO_FIELD]: generated
            }
        });
    } catch (error) {
        console.error(
            `RTN personal promo save error for contact ${contactId}:`,
            error.message
        );
    }

    return generated;
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
    promoCode: 'UF_CRM_RTN_PROMO_CODE',
    referralReward: 'UF_CRM_RTN_REFERRAL_REWARD'
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
let catalogContextCache = {
    expiresAt: 0,
    iblockId: 0
};

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

async function getAccountCatalogIblockId() {
    const now = Date.now();

    if (
        catalogContextCache.iblockId > 0 &&
        catalogContextCache.expiresAt > now
    ) {
        return catalogContextCache.iblockId;
    }

    const result = await bitrixCall('catalog.catalog.list', {
        select: ['id', 'iblockId', 'name', 'productIblockId'],
        order: { id: 'asc' }
    });

    const catalogs =
        result?.catalogs ||
        (Array.isArray(result) ? result : []);

    if (!catalogs.length) {
        throw new Error('Bitrix24 не вернул торговый каталог');
    }

    const preferredIblockId = Number(
        process.env.BITRIX_CATALOG_IBLOCK_ID || 0
    );

    let catalog = preferredIblockId > 0
        ? catalogs.find(
            item => Number(item.iblockId) === preferredIblockId
        )
        : null;

    if (!catalog) {
        catalog =
            catalogs.find(item => !Number(item.productIblockId || 0)) ||
            catalogs[0];
    }

    const iblockId = Number(catalog?.iblockId || 0);

    if (!iblockId) {
        throw new Error('Не удалось определить iblockId каталога Bitrix24');
    }

    catalogContextCache = {
        iblockId,
        expiresAt: now + 10 * 60 * 1000
    };

    return iblockId;
}

async function getCatalogProductPresentation(productId) {
    const id = Number(productId || 0);
    if (!id) return null;

    if (catalogProductCache.has(id)) {
        return catalogProductCache.get(id);
    }

    try {
        const iblockId = await getAccountCatalogIblockId();

        const result = await bitrixCall('catalog.product.list', {
            select: ['id', 'iblockId', 'name', 'xmlId'],
            filter: {
                iblockId,
                id
            },
            order: { id: 'asc' },
            start: 0
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

        const fallback = {
            externalId: '',
            name: '',
            imageUrl: ''
        };

        catalogProductCache.set(id, fallback);

        return fallback;
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
    const personalPromoCode = await getOrCreatePersonalPromo({
        contact,
        contactId,
        user
    });

    const normalizedStatuses = memberStatuses.map(value =>
        String(value || '').toUpperCase()
    );
    const isAmbassador = normalizedStatuses.includes('AMBASSADOR');
    const isBoss = normalizedStatuses.includes('BOSS');

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
        memberStatuses,
        personalPromoCode,
        referralCode: personalPromoCode || referralCodeFromPublicId(user?.public_id),
        isAmbassador,
        isBoss
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

        const sourceRows = (Array.isArray(rows) ? rows : [])
            .filter(row => {
                const rawName = clean(
                    row.PRODUCT_NAME || row.productName || '',
                    300
                );

                return !/^ДОСТАВКА\s*[—-]/i.test(rawName);
            });

        const items = await Promise.all(
            sourceRows.map(async row => {
                const rawName = clean(
                    row.PRODUCT_NAME || row.productName || '',
                    300
                );

                const productId = String(
                    row.PRODUCT_ID || row.productId || ''
                );

                const product = productId
                    ? await getCatalogProductPresentation(productId)
                    : null;

                const parsed = splitProductName(
                    product?.name || rawName
                );

                const externalId = product?.externalId || '';

                return {
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
                        Number(
                            row.DISCOUNT_SUM ||
                            row.discountSum ||
                            0
                        ),
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
                };
            })
        );

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

function referralCodeFromPublicId(publicId) {
    const raw = String(publicId || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

    if (!raw) return '';

    const compact = raw.length > 16
        ? raw.slice(0, 8) + raw.slice(-8)
        : raw;

    return `RTN-${compact}`;
}

async function resolveReferralCode(code) {
    const normalized = clean(code, 80).toUpperCase();

    if (!/^[A-Z0-9][A-Z0-9._-]{2,79}$/.test(normalized)) {
        return null;
    }

    const db = getPool();

    if (/^RTN-[A-Z0-9]{8,32}$/.test(normalized)) {
        const [rows] = await db.execute(
            `SELECT
                id,
                public_id,
                email,
                phone,
                bitrix_contact_id
             FROM users
             WHERE status = 'active'
               AND CONCAT(
                    'RTN-',
                    LEFT(REPLACE(UPPER(public_id), '-', ''), 8),
                    RIGHT(REPLACE(UPPER(public_id), '-', ''), 8)
               ) = ?
             LIMIT 1`,
            [normalized]
        );

        if (rows[0]) {
            return rows[0];
        }
    }

    try {
        await ensureContactSimpleField(
            RTN_PERSONAL_PROMO_FIELD,
            'Персональный промокод'
        );

        const contacts = await bitrixCall('crm.contact.list', {
            order: {
                ID: 'ASC'
            },
            filter: {
                [RTN_PERSONAL_PROMO_FIELD]: normalized
            },
            select: [
                'ID',
                RTN_MEMBER_STATUS_FIELD,
                RTN_PERSONAL_PROMO_FIELD
            ],
            start: 0
        });

        for (const contact of Array.isArray(contacts) ? contacts : []) {
            const statuses = await getContactMemberStatuses(contact);

            if (
                !statuses.includes('AMBASSADOR') &&
                !statuses.includes('BOSS')
            ) {
                continue;
            }

            const contactId = Number(contact.ID || contact.id || 0);
            if (!contactId) continue;

            const [rows] = await db.execute(
                `SELECT
                    id,
                    public_id,
                    email,
                    phone,
                    bitrix_contact_id
                 FROM users
                 WHERE status = 'active'
                   AND bitrix_contact_id = ?
                 LIMIT 1`,
                [contactId]
            );

            if (rows[0]) {
                return rows[0];
            }
        }
    } catch (error) {
        console.error(
            `RTN personal promo resolve error for ${normalized}:`,
            error.message
        );
    }

    return null;
}

function referralLevelFromXp(xp, memberStatuses = []) {
    const set = new Set(
        (Array.isArray(memberStatuses) ? memberStatuses : [])
            .map(value => String(value || '').toUpperCase())
    );

    if (set.has('GOLD')) return 'gold';
    if (set.has('SILVER')) return 'silver';
    if (set.has('BRONZE')) return 'bronze';
    if (xp >= 50000) return 'gold';
    if (xp >= 15000) return 'silver';
    return 'bronze';
}

const referralRewardLocks = new Set();
let referralRewardTableReadyPromise = null;

async function ensureReferralRewardTable() {
    if (referralRewardTableReadyPromise) {
        return referralRewardTableReadyPromise;
    }

    referralRewardTableReadyPromise = (async () => {
        const db = getPool();

        await db.execute(
            `CREATE TABLE IF NOT EXISTS rtn_referral_rewards (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                payment_id VARCHAR(100) NOT NULL,
                deal_id BIGINT UNSIGNED NOT NULL,
                referrer_user_id BIGINT UNSIGNED NOT NULL,
                promo_code VARCHAR(80) NOT NULL,
                coins INT UNSIGNED NOT NULL DEFAULT 150,
                awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_rtn_referral_payment (payment_id),
                KEY idx_rtn_referral_user (referrer_user_id),
                KEY idx_rtn_referral_deal (deal_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );
    })().catch(error => {
        referralRewardTableReadyPromise = null;
        throw error;
    });

    return referralRewardTableReadyPromise;
}

async function awardReferralCoinsForPayment(payment, dealId) {
    const promoCode = clean(
        payment?.metadata?.promoCode,
        80
    ).toUpperCase();

    const paymentId = clean(payment?.id, 100);
    const paymentAmount = Math.max(
        0,
        Number(payment?.amount?.value || 0)
    );

    if (
        !promoCode ||
        !dealId ||
        !paymentId ||
        paymentAmount <= 0
    ) {
        return { ok: true, ignored: true };
    }

    if (referralRewardLocks.has(paymentId)) {
        return { ok: true, ignored: true, reason: 'locked' };
    }

    referralRewardLocks.add(paymentId);

    try {
        const referrer = await resolveReferralCode(promoCode);

        if (!referrer?.id) {
            return { ok: true, ignored: true, reason: 'unknown_code' };
        }

        const buyerEmail = normalizeEmail(
            payment?.metadata?.customerEmail
        );
        const buyerPhone = normalizePhone(
            payment?.metadata?.customerPhone
        );

        if (
            (buyerEmail &&
                normalizeEmail(referrer.email) === buyerEmail) ||
            (buyerPhone &&
                normalizePhone(referrer.phone) === buyerPhone)
        ) {
            return { ok: true, ignored: true, reason: 'self_referral' };
        }

        try {
            const referrerProfile = await getAccountBitrixProfile(referrer);
            const statuses = Array.isArray(referrerProfile?.memberStatuses)
                ? referrerProfile.memberStatuses.map(value =>
                    String(value || '').toUpperCase()
                )
                : [];

            if (
                statuses.includes('AMBASSADOR') ||
                statuses.includes('BOSS')
            ) {
                return {
                    ok: true,
                    ignored: true,
                    reason: 'partner_program'
                };
            }
        } catch (profileError) {
            console.error(
                'RTN referral status lookup error:',
                profileError.message
            );
        }

        const rewardCoins = Math.max(
            1,
            Math.round(paymentAmount * 0.05)
        );

        const deal = await bitrixCall('crm.deal.get', {
            id: Number(dealId)
        });

        const existingMarker = clean(
            deal?.[DEAL_FIELD_NAMES.referralReward],
            200
        );

        if (existingMarker) {
            return {
                ok: true,
                ignored: true,
                reason: 'already_awarded'
            };
        }

        await ensureReferralRewardTable();

        const db = getPool();
        const connection = await db.getConnection();
        let awarded = false;

        try {
            await connection.beginTransaction();

            const [rewardInsert] = await connection.execute(
                `INSERT IGNORE INTO rtn_referral_rewards
                    (
                        payment_id,
                        deal_id,
                        referrer_user_id,
                        promo_code,
                        coins
                    )
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    paymentId,
                    Number(dealId),
                    Number(referrer.id),
                    promoCode,
                    rewardCoins
                ]
            );

            if (Number(rewardInsert?.affectedRows || 0) > 0) {
                await connection.execute(
                    `INSERT INTO rhino_coin_accounts
                        (user_id, balance)
                     VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE
                        balance = COALESCE(balance, 0) + VALUES(balance)`,
                    [Number(referrer.id), rewardCoins]
                );

                awarded = true;
            }

            await connection.commit();
        } catch (error) {
            try {
                await connection.rollback();
            } catch {}

            throw error;
        } finally {
            connection.release();
        }

        if (!existingMarker) {
            try {
                await bitrixCall('crm.deal.update', {
                    id: Number(dealId),
                    fields: {
                        [DEAL_FIELD_NAMES.referralReward]:
                            `${rewardCoins} RC · 5% · ${paymentId}`
                    }
                });
            } catch (markerError) {
                console.error(
                    'RTN referral reward marker error:',
                    markerError.message
                );
            }
        }

        return {
            ok: true,
            ignored: !awarded,
            reason: awarded ? null : 'already_awarded',
            rewardCoins: awarded ? rewardCoins : 0,
            rewardPercent: 5,
            referrerUserId: Number(referrer.id)
        };
    } finally {
        referralRewardLocks.delete(paymentId);
    }
}

async function getReferralCodeForUser(user) {
    const fallback = referralCodeFromPublicId(user?.public_id);

    if (!user?.id) {
        return fallback;
    }

    try {
        const profile = await getAccountBitrixProfile(user);
        const personal = clean(profile?.personalPromoCode, 80).toUpperCase();

        return personal || fallback;
    } catch (error) {
        console.error(
            'RTN referral code profile lookup error:',
            error.message
        );

        return fallback;
    }
}

async function getContactXpSummary(contactId) {
    const result = await bitrixCall('crm.deal.list', {
        order: {
            DATE_CREATE: 'DESC'
        },
        filter: {
            CONTACT_ID: Number(contactId)
        },
        select: [
            'ID',
            'STAGE_ID',
            'OPPORTUNITY',
            'DATE_CREATE'
        ],
        start: 0
    });

    let xp = 0;
    let pendingXp = 0;

    for (const deal of Array.isArray(result) ? result : []) {
        const amount = Math.max(
            0,
            Math.round(Number(deal.OPPORTUNITY || 0))
        );

        const status = mapDealStatus(deal.STAGE_ID);

        if (status === 'completed') {
            xp += amount;
        } else if (status !== 'cancelled') {
            pendingXp += amount;
        }
    }

    return {
        xp,
        pendingXp
    };
}

async function getReferralFriends(user) {
    let ownerProfile = null;

    try {
        ownerProfile = await getAccountBitrixProfile(user);
    } catch (error) {
        console.error(
            'RTN referral owner profile error:',
            error.message
        );
    }

    const ownerStatuses = Array.isArray(ownerProfile?.memberStatuses)
        ? ownerProfile.memberStatuses.map(value =>
            String(value || '').toUpperCase()
        )
        : [];

    const ownerIsAmbassador = ownerStatuses.includes('AMBASSADOR');
    const ownerIsBoss = ownerStatuses.includes('BOSS');
    const referralCode =
        clean(ownerProfile?.personalPromoCode, 80).toUpperCase() ||
        referralCodeFromPublicId(user?.public_id);
    const rewardCoins =
        ownerIsAmbassador || ownerIsBoss
            ? 0
            : 150;

    if (!user?.id || !referralCode) {
        return {
            referralCode,
            discountPercent: 5,
            rewardCoins,
            friends: []
        };
    }

    const optionsByField = await getDealUserFieldOptions();
    const promoOptions = optionsByField.get(DEAL_FIELD_NAMES.promoCode);
    let promoOptionId = null;

    if (promoOptions) {
        for (const [id, value] of promoOptions.entries()) {
            if (String(value || '').toUpperCase() === referralCode) {
                promoOptionId = Number(id);
                break;
            }
        }
    }

    if (!promoOptionId) {
        return {
            referralCode,
            discountPercent: 5,
            rewardCoins,
            friends: []
        };
    }

    const deals = await bitrixCall('crm.deal.list', {
        order: { DATE_CREATE: 'DESC' },
        filter: {
            [DEAL_FIELD_NAMES.promoCode]: promoOptionId
        },
        select: [
            'ID',
            'CONTACT_ID',
            'STAGE_ID',
            'OPPORTUNITY',
            'DATE_CREATE',
            'CLOSEDATE',
            DEAL_FIELD_NAMES.promoCode,
            DEAL_FIELD_NAMES.referralReward
        ],
        start: 0
    });

    const byContact = new Map();

    for (const deal of Array.isArray(deals) ? deals : []) {
        const contactId = Number(deal.CONTACT_ID || deal.contactId || 0);

        if (!contactId) continue;
        if (Number(user.bitrix_contact_id || 0) === contactId) continue;

        const rewardAwarded = Boolean(
            clean(deal?.[DEAL_FIELD_NAMES.referralReward], 200)
        );

        if (!byContact.has(contactId)) {
            byContact.set(contactId, {
                firstDeal: deal,
                rewardAwarded
            });
        } else if (rewardAwarded) {
            byContact.get(contactId).rewardAwarded = true;
        }
    }

    const db = getPool();
    const friends = [];

    for (const [contactId, referralInfo] of byContact.entries()) {
        const firstDeal = referralInfo.firstDeal;
        const rewardAwarded = Boolean(referralInfo.rewardAwarded);
        const [rows] = await db.execute(
            `SELECT
                id,
                public_id,
                email,
                phone,
                first_name,
                last_name,
                bitrix_contact_id,
                created_at,
                status
             FROM users
             WHERE bitrix_contact_id = ?
               AND status = 'active'
             LIMIT 1`,
            [contactId]
        );

        const friendUser = rows[0] || null;

        if (!friendUser) {
            const contact = await bitrixCall('crm.contact.get', {
                id: contactId
            });

            friends.push({
                id: `crm-${contactId}`,
                displayName: clean(
                    [contact?.NAME, contact?.LAST_NAME]
                        .filter(Boolean)
                        .join(' ') || 'ДРУГ RTN',
                    180
                ),
                avatarUrl: '',
                level: 'bronze',
                memberStatuses: [],
                ambassador: false,
                xp: 0,
                pendingXp: 0,
                joinedAt: firstDeal?.DATE_CREATE || null,
                rewardCoins,
                rewardAwarded,
                accountLinked: false
            });

            continue;
        }

        let profile = null;
        let xpSummary = {
            xp: 0,
            pendingXp: 0
        };

        try {
            [profile, xpSummary] = await Promise.all([
                getAccountBitrixProfile(friendUser),
                getContactXpSummary(contactId)
            ]);
        } catch (error) {
            console.error(
                `RTN referral friend data error for ${contactId}:`,
                error.message
            );
        }

        const xp = Number(xpSummary?.xp || 0);
        const pendingXp = Number(xpSummary?.pendingXp || 0);

        const memberStatuses = Array.isArray(profile?.memberStatuses)
            ? profile.memberStatuses
            : [];

        const displayName = [
            friendUser.first_name,
            friendUser.last_name
                ? `${String(friendUser.last_name).slice(0, 1)}.`
                : ''
        ]
            .filter(Boolean)
            .join(' ')
            .trim() || 'ПОЛЬЗОВАТЕЛЬ RTN';

        friends.push({
            id: String(friendUser.public_id || friendUser.id),
            displayName,
            avatarUrl: '',
            level: referralLevelFromXp(xp, memberStatuses),
            memberStatuses,
            ambassador: memberStatuses.includes('AMBASSADOR'),
            xp,
            pendingXp,
            joinedAt: friendUser.created_at || firstDeal?.DATE_CREATE || null,
            rewardCoins,
            rewardAwarded,
            accountLinked: true
        });
    }

    return {
        referralCode,
        discountPercent: 5,
        rewardCoins,
        friends
    };
}


async function getSalesByPromoCode(personalPromoCode) {
    const normalizedPromo = clean(
        personalPromoCode,
        80
    ).toUpperCase();

    if (!normalizedPromo) {
        return {
            personalPromoCode: '',
            commissionRate: 0.10,
            totalSalesAmount: 0,
            totalCommission: 0,
            confirmedCommission: 0,
            pendingCommission: 0,
            sales: []
        };
    }

    const optionsByField = await getDealUserFieldOptions();
    const promoOptions = optionsByField.get(DEAL_FIELD_NAMES.promoCode);
    let promoOptionId = null;

    if (promoOptions) {
        for (const [id, value] of promoOptions.entries()) {
            if (
                String(value || '').trim().toUpperCase() ===
                normalizedPromo
            ) {
                promoOptionId = Number(id);
                break;
            }
        }
    }

    if (!promoOptionId) {
        return {
            personalPromoCode: normalizedPromo,
            commissionRate: 0.10,
            totalSalesAmount: 0,
            totalCommission: 0,
            confirmedCommission: 0,
            pendingCommission: 0,
            sales: []
        };
    }

    const result = await bitrixCall('crm.deal.list', {
        order: {
            DATE_CREATE: 'DESC'
        },
        filter: {
            [DEAL_FIELD_NAMES.promoCode]: promoOptionId
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
            'CLOSEDATE',
            'CONTACT_ID',
            'ORIGIN_ID',
            DEAL_FIELD_NAMES.orderNumber,
            DEAL_FIELD_NAMES.paymentStatus,
            DEAL_FIELD_NAMES.deliveryType
        ],
        start: 0
    });

    const sales = await Promise.all(
        (Array.isArray(result) ? result : []).slice(0, 100).map(async deal => {
            const id = Number(deal.ID || deal.id || 0);
            const amount = Math.max(0, Number(deal.OPPORTUNITY || 0));
            const status = mapDealStatus(deal.STAGE_ID);
            const stage = await getDealStagePresentation(deal.STAGE_ID);
            const commissionAmount =
                Math.round(amount * 0.10 * 100) / 100;
            const items = id ? await getDealProductRows(id) : [];

            const [paymentStatus, deliveryType] = await Promise.all([
                resolveDealFieldValue(
                    DEAL_FIELD_NAMES.paymentStatus,
                    deal[DEAL_FIELD_NAMES.paymentStatus]
                ),
                resolveDealFieldValue(
                    DEAL_FIELD_NAMES.deliveryType,
                    deal[DEAL_FIELD_NAMES.deliveryType]
                )
            ]);

            return {
                dealId: String(id || ''),
                orderNumber: clean(
                    deal[DEAL_FIELD_NAMES.orderNumber] ||
                    deal.ORIGIN_ID ||
                    id ||
                    '',
                    100
                ),
                title: clean(deal.TITLE || 'ЗАКАЗ RTN.PRO', 300),
                status,
                statusLabel: stage.label,
                stageId: clean(deal.STAGE_ID || '', 100),
                amount,
                currency: clean(deal.CURRENCY_ID || 'RUB', 10),
                commissionAmount,
                commissionRate: 0.10,
                commissionStatus:
                    status === 'completed'
                        ? 'confirmed'
                        : status === 'cancelled'
                            ? 'cancelled'
                            : 'pending',
                paymentStatus,
                deliveryType,
                createdAt: deal.DATE_CREATE || null,
                updatedAt: deal.DATE_MODIFY || null,
                closedAt: deal.CLOSEDATE || null,
                items
            };
        })
    );

    const activeSales = sales.filter(sale => sale.status !== 'cancelled');
    const totalSalesAmount = activeSales.reduce(
        (sum, sale) => sum + sale.amount,
        0
    );
    const confirmedCommission = activeSales
        .filter(sale => sale.commissionStatus === 'confirmed')
        .reduce((sum, sale) => sum + sale.commissionAmount, 0);
    const pendingCommission = activeSales
        .filter(sale => sale.commissionStatus === 'pending')
        .reduce((sum, sale) => sum + sale.commissionAmount, 0);

    return {
        personalPromoCode: normalizedPromo,
        commissionRate: 0.10,
        totalSalesAmount:
            Math.round(totalSalesAmount * 100) / 100,
        totalCommission:
            Math.round(
                (confirmedCommission + pendingCommission) * 100
            ) / 100,
        confirmedCommission:
            Math.round(confirmedCommission * 100) / 100,
        pendingCommission:
            Math.round(pendingCommission * 100) / 100,
        sales
    };
}

async function getAmbassadorSales(user) {
    const profile = await getAccountBitrixProfile(user);
    const memberStatuses = Array.isArray(profile?.memberStatuses)
        ? profile.memberStatuses.map(value =>
            String(value || '').toUpperCase()
        )
        : [];

    const isAmbassador = memberStatuses.includes('AMBASSADOR');
    const isBoss = memberStatuses.includes('BOSS');
    const personalPromoCode = clean(
        profile?.personalPromoCode,
        80
    ).toUpperCase();

    if (!isAmbassador && !isBoss) {
        return {
            isAmbassador: false,
            isBoss: false,
            personalPromoCode,
            commissionRate: 0.10,
            totalSalesAmount: 0,
            totalCommission: 0,
            confirmedCommission: 0,
            pendingCommission: 0,
            sales: []
        };
    }

    return {
        isAmbassador,
        isBoss,
        ...(await getSalesByPromoCode(personalPromoCode))
    };
}

async function getMemberStatusOptionId(statusName) {
    const target = String(statusName || '').trim().toUpperCase();
    if (!target) return null;

    await getContactMemberStatuses({
        [RTN_MEMBER_STATUS_FIELD]: []
    });

    const now = Date.now();

    if (
        memberStatusCache.expiresAt <= now ||
        !memberStatusCache.options.size
    ) {
        const fields = await bitrixCall('crm.contact.userfield.list', {
            filter: {
                FIELD_NAME: RTN_MEMBER_STATUS_FIELD
            }
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
    }

    for (const [id, value] of memberStatusCache.options.entries()) {
        if (String(value || '').toUpperCase() === target) {
            return Number(id);
        }
    }

    return null;
}

async function getBossSales(user, requestedPromo = '') {
    const profile = await getAccountBitrixProfile(user);
    const memberStatuses = Array.isArray(profile?.memberStatuses)
        ? profile.memberStatuses.map(value =>
            String(value || '').toUpperCase()
        )
        : [];

    const isBoss = memberStatuses.includes('BOSS');

    if (!isBoss) {
        return {
            isBoss: false,
            selectedPromoCode: '',
            totalSalesAmount: 0,
            totalCommission: 0,
            confirmedCommission: 0,
            pendingCommission: 0,
            ambassadors: [],
            sales: []
        };
    }

    const ambassadorOptionId =
        await getMemberStatusOptionId('AMBASSADOR');

    const contactsResult = ambassadorOptionId
        ? await bitrixCall('crm.contact.list', {
            order: {
                ID: 'ASC'
            },
            filter: {
                [RTN_MEMBER_STATUS_FIELD]: ambassadorOptionId
            },
            select: [
                'ID',
                'NAME',
                'LAST_NAME',
                RTN_MEMBER_STATUS_FIELD,
                RTN_PERSONAL_PROMO_FIELD
            ],
            start: 0
        })
        : [];

    const ambassadors = [];

    for (const contact of Array.isArray(contactsResult) ? contactsResult : []) {
        const contactId = Number(contact.ID || contact.id || 0);
        const promoCode = clean(
            contact?.[RTN_PERSONAL_PROMO_FIELD],
            80
        ).toUpperCase();

        if (!contactId || !promoCode) {
            continue;
        }

        ambassadors.push({
            contactId,
            displayName: clean(
                [contact.NAME, contact.LAST_NAME]
                    .filter(Boolean)
                    .join(' ') || `AMBASSADOR #${contactId}`,
                180
            ),
            promoCode
        });
    }

    // BOSS должен видеть не только контакты со статусом AMBASSADOR,
    // но вообще все промокоды, которые существуют в поле сделок.
    const promoOptionsByField = await getDealUserFieldOptions();
    const allPromoOptions = promoOptionsByField.get(
        DEAL_FIELD_NAMES.promoCode
    );

    const knownPromoCodes = new Set(
        ambassadors.map(item => item.promoCode)
    );

    if (allPromoOptions) {
        for (const [, rawCode] of allPromoOptions.entries()) {
            const promoCode = clean(rawCode, 80).toUpperCase();

            if (!promoCode || knownPromoCodes.has(promoCode)) {
                continue;
            }

            ambassadors.push({
                contactId: 0,
                displayName: promoCode,
                promoCode
            });

            knownPromoCodes.add(promoCode);
        }
    }

    const requested = clean(
        requestedPromo,
        80
    ).toUpperCase();

    const dashboards = await Promise.all(
        ambassadors.map(async ambassador => ({
            ...ambassador,
            ...(await getSalesByPromoCode(ambassador.promoCode))
        }))
    );

    const selectedDashboards = requested
        ? dashboards.filter(item => item.promoCode === requested)
        : dashboards;

    const allSales = selectedDashboards.flatMap(item =>
        item.sales.map(sale => ({
            ...sale,
            ambassadorContactId: item.contactId,
            ambassadorName: item.displayName,
            promoCode: item.promoCode
        }))
    ).sort((a, b) => {
        const aTime = new Date(a.createdAt || 0).getTime();
        const bTime = new Date(b.createdAt || 0).getTime();
        return bTime - aTime;
    });

    const decoratedAmbassadors = dashboards.map(item => ({
        contactId: item.contactId,
        displayName: item.displayName,
        promoCode: item.promoCode,
        totalSalesAmount: item.totalSalesAmount,
        totalCommission: item.totalCommission,
        confirmedCommission: item.confirmedCommission,
        pendingCommission: item.pendingCommission,
        ordersCount: item.sales.length
    }));

    return {
        isBoss: true,
        selectedPromoCode: requested,
        totalSalesAmount:
            Math.round(
                selectedDashboards.reduce(
                    (sum, item) => sum + item.totalSalesAmount,
                    0
                ) * 100
            ) / 100,
        totalCommission:
            Math.round(
                selectedDashboards.reduce(
                    (sum, item) => sum + item.totalCommission,
                    0
                ) * 100
            ) / 100,
        confirmedCommission:
            Math.round(
                selectedDashboards.reduce(
                    (sum, item) => sum + item.confirmedCommission,
                    0
                ) * 100
            ) / 100,
        pendingCommission:
            Math.round(
                selectedDashboards.reduce(
                    (sum, item) => sum + item.pendingCommission,
                    0
                ) * 100
            ) / 100,
        ambassadors: decoratedAmbassadors,
        sales: allSales
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
    getAccountOrderReference,
    referralCodeFromPublicId,
    resolveReferralCode,
    awardReferralCoinsForPayment,
    getReferralFriends,
    getAmbassadorSales,
    getBossSales
};
