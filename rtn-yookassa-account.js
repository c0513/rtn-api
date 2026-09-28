function clean(value, max = 1000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function getCredentials() {
    const shopId = clean(
        process.env.YOOKASSA_SHOP_ID ||
        process.env.SHOP_ID ||
        '',
        200
    );

    const secretKey = clean(
        process.env.YOOKASSA_SECRET_KEY ||
        process.env.SECRET_KEY ||
        '',
        500
    );

    return {
        configured: Boolean(shopId && secretKey),
        shopId,
        secretKey
    };
}

async function yookassaGet(path, params = {}) {
    const credentials = getCredentials();

    if (!credentials.configured) {
        const error = new Error('YooKassa is not configured');
        error.code = 'YOOKASSA_NOT_CONFIGURED';
        throw error;
    }

    const url = new URL(
        `https://api.yookassa.ru/v3/${String(path || '').replace(/^\/+/, '')}`
    );

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const auth = Buffer.from(
            `${credentials.shopId}:${credentials.secretKey}`
        ).toString('base64');

        const response = await fetch(url, {
            headers: {
                Authorization: `Basic ${auth}`,
                Accept: 'application/json'
            },
            signal: controller.signal
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const error = new Error(
                data?.description ||
                data?.message ||
                `YooKassa HTTP ${response.status}`
            );
            error.status = response.status;
            throw error;
        }

        return data;
    } finally {
        clearTimeout(timeout);
    }
}

async function findPaymentByOrderId(orderId) {
    const target = clean(orderId, 100);

    if (!target) return null;

    let cursor = '';

    for (let page = 0; page < 8; page += 1) {
        const data = await yookassaGet('payments', {
            limit: 100,
            cursor
        });

        const items = Array.isArray(data?.items) ? data.items : [];

        const payment = items.find(item => {
            const metadataOrderId = clean(item?.metadata?.orderId, 100);

            return (
                metadataOrderId === target ||
                clean(item?.id, 100) === target
            );
        });

        if (payment) {
            return payment;
        }

        cursor = clean(data?.next_cursor, 300);

        if (!cursor) break;
    }

    return null;
}

async function getReceiptByPaymentId(paymentId) {
    const id = clean(paymentId, 100);

    if (!id) return null;

    const data = await yookassaGet('receipts', {
        payment_id: id,
        limit: 100
    });

    const items = Array.isArray(data?.items) ? data.items : [];

    return (
        items.find(
            item =>
                item?.type === 'payment' &&
                item?.status === 'succeeded'
        ) ||
        items.find(item => item?.type === 'payment') ||
        items[0] ||
        null
    );
}

function publicReceipt(payment, receipt) {
    if (!payment) return null;

    const receiptItems = Array.isArray(receipt?.items)
        ? receipt.items.map((item, index) => ({
            id: String(index + 1),
            description: clean(item?.description, 500),
            quantity: Number(item?.quantity || 0),
            amount: Number(item?.amount?.value || 0),
            currency: clean(item?.amount?.currency || 'RUB', 10),
            vatCode: Number(item?.vat_code || 0),
            paymentSubject: clean(item?.payment_subject, 100),
            paymentMode: clean(item?.payment_mode, 100)
        }))
        : [];

    return {
        paymentId: clean(payment?.id, 100),
        paymentStatus: clean(payment?.status, 100),
        paid: payment?.paid === true,
        amount: Number(payment?.amount?.value || 0),
        currency: clean(payment?.amount?.currency || 'RUB', 10),
        paidAt:
            payment?.captured_at ||
            payment?.created_at ||
            null,
        description: clean(payment?.description, 500),
        receipt: receipt
            ? {
                id: clean(receipt?.id, 100),
                status: clean(receipt?.status, 100),
                registeredAt: receipt?.registered_at || null,
                fiscalDocumentNumber: clean(
                    receipt?.fiscal_document_number,
                    100
                ),
                fiscalStorageNumber: clean(
                    receipt?.fiscal_storage_number,
                    100
                ),
                fiscalAttribute: clean(
                    receipt?.fiscal_attribute,
                    100
                ),
                fiscalProviderId: clean(
                    receipt?.fiscal_provider_id,
                    100
                ),
                items: receiptItems
            }
            : null
    };
}

async function getOrderReceipt(orderId) {
    const payment = await findPaymentByOrderId(orderId);

    if (!payment) {
        return null;
    }

    const receipt = await getReceiptByPaymentId(payment.id);

    return publicReceipt(payment, receipt);
}

module.exports = {
    getOrderReceipt
};
