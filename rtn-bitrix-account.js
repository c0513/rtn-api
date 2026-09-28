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

    fields.NAME =
        firstName ||
        (email ? email.split('@')[0] : '') ||
        'Покупатель RTN.PRO';

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

    const address = clean(
        pick(source, 'address', 'address_line1', 'addressLine1'),
        500
    );
    const address2 = clean(
        pick(source, 'address_2', 'address_line2', 'addressLine2'),
        500
    );
    const city = clean(
        pick(source, 'address_city', 'city'),
        150
    );
    const region = clean(
        pick(source, 'address_region', 'region'),
        150
    );
    const postalCode = clean(
        pick(source, 'address_postal_code', 'postalCode'),
        40
    );
    const country = clean(
        pick(source, 'address_country', 'country'),
        100
    );
    const birthDate = clean(
        pick(source, 'birth_date', 'birthDate'),
        40
    );

    if (address) fields.ADDRESS = address;
    if (address2) fields.ADDRESS_2 = address2;
    if (city) fields.ADDRESS_CITY = city;
    if (region) fields.ADDRESS_REGION = region;
    if (postalCode) fields.ADDRESS_POSTAL_CODE = postalCode;
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
    const result = await bitrixCall('crm.contact.add', {
        fields: buildStandardContactFields(user, extra),
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

    return {
        bitrixContactId: contactId,
        firstName: contact.NAME || '',
        lastName: contact.LAST_NAME || '',
        email: email || user.email || null,
        phone: phone || user.phone || null,
        address: contact.ADDRESS || '',
        address2: contact.ADDRESS_2 || '',
        city: contact.ADDRESS_CITY || '',
        region: contact.ADDRESS_REGION || '',
        postalCode: contact.ADDRESS_POSTAL_CODE || '',
        country: contact.ADDRESS_COUNTRY || '',
        birthDate: contact.BIRTHDATE || '',
        hasPhoto: Boolean(contact.HAS_PHONE || contact.PHOTO)
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

    if (stage === paidStage) return 'paid';
    if (stage === newStage) return 'new';
    if (/WON$/i.test(stage)) return 'completed';
    if (/LOSE|LOST|FAIL/i.test(stage)) return 'cancelled';

    return 'processing';
}

async function getDealProductRows(dealId) {
    try {
        const rows = await bitrixCall('crm.deal.productrows.get', {
            id: Number(dealId)
        });

        return (Array.isArray(rows) ? rows : []).map(row => ({
            id: String(row.ID || row.id || ''),
            productId: String(row.PRODUCT_ID || row.productId || ''),
            name: clean(row.PRODUCT_NAME || row.productName || '', 300),
            price: Number(row.PRICE || row.price || 0),
            quantity: Number(row.QUANTITY || row.quantity || 0),
            measureName: clean(row.MEASURE_NAME || row.measureName || '', 100),
            discountSum: Number(row.DISCOUNT_SUM || row.discountSum || 0)
        }));
    } catch (error) {
        console.error(
            `RTN account Bitrix product rows error for deal ${dealId}:`,
            error.message
        );

        return [];
    }
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
            'OPPORTUNITY',
            'CURRENCY_ID',
            'DATE_CREATE',
            'DATE_MODIFY',
            'BEGINDATE',
            'CLOSEDATE',
            'CONTACT_ID',
            'ORIGINATOR_ID',
            'ORIGIN_ID',
            'COMMENTS'
        ],
        start: 0
    });

    const deals = Array.isArray(result) ? result : [];
    const orders = [];

    for (const deal of deals.slice(0, 100)) {
        const id = Number(deal.ID || deal.id || 0);
        const items = id ? await getDealProductRows(id) : [];

        orders.push({
            id: String(id || ''),
            number: clean(deal.ORIGIN_ID || deal.ID || '', 100),
            title: clean(deal.TITLE || '', 300),
            status: mapDealStatus(deal.STAGE_ID),
            stageId: clean(deal.STAGE_ID || '', 100),
            amount: Number(deal.OPPORTUNITY || 0),
            currency: clean(deal.CURRENCY_ID || 'RUB', 10),
            createdAt: deal.DATE_CREATE || null,
            updatedAt: deal.DATE_MODIFY || null,
            closedAt: deal.CLOSEDATE || null,
            originatorId: clean(deal.ORIGINATOR_ID || '', 100),
            items
        });
    }

    return {
        contactId,
        orders
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
    getAccountOrders
};
