const crypto = require('crypto');
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

async function ensureAccountBitrixContact(user) {
    if (!user) return null;

    if (Number(user.bitrix_contact_id || 0) > 0) {
        return Number(user.bitrix_contact_id);
    }

    const contactId = await findContactId({
        email: user.email,
        phone: user.phone
    });

    if (!contactId) return null;

    const db = getPool();

    await db.execute(
        'UPDATE users SET bitrix_contact_id = ?, updated_at = NOW() WHERE id = ?',
        [contactId, user.id]
    );

    user.bitrix_contact_id = contactId;

    return contactId;
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
    ensureAccountBitrixContact,
    getAccountOrders
};
