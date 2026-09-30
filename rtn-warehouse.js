const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { getPool } = require('./db');
const { getAuthenticatedUser, RTN_ADMIN_EMAIL } = require('./account');
const { bitrixCall } = require('./rtn-bitrix-account');

const PAYMENT_FIELD = 'UF_CRM_RTN_PAYMENT_STATUS';
const STAGE_PICKING = process.env.BITRIX_STAGE_PICKING || 'EXECUTING';
const STAGE_READY = process.env.BITRIX_STAGE_READY || 'FINAL_INVOICE';

let tablesReadyPromise = null;
let paymentOptionsCache = { expiresAt: 0, values: new Map() };

function clean(value, max = 500) {
    return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function safeJson(value, fallback) {
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed ?? fallback;
    } catch {
        return fallback;
    }
}

function secureEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeMarkCode(value) {
    let raw = String(value ?? '');
    raw = raw.replace(/^\]d2/i, '').replace(/[\r\n]+$/g, '');
    if (raw.length < 16 || raw.length > 1024) {
        const error = new Error('Некорректный DataMatrix');
        error.code = 'INVALID_MARK';
        throw error;
    }
    return raw;
}

function parseGtin(markCode) {
    const compact = String(markCode || '').replace(/\u001D/g, '');
    const match = compact.match(/01(\d{14})/);
    return match ? match[1] : '';
}

function publicScan(row) {
    return {
        id: Number(row.id),
        gtin: row.gtin || '',
        externalId: row.external_id || '',
        productName: row.product_name || '',
        status: row.status,
        onecStatus: row.onec_status || '',
        error: row.error_text || '',
        codeTail: row.code_value ? String(row.code_value).slice(-6) : '',
        scannedAt: row.scanned_at,
        validatedAt: row.validated_at
    };
}

async function ensureTables() {
    if (tablesReadyPromise) return tablesReadyPromise;

    tablesReadyPromise = (async () => {
        const db = getPool();

        await db.execute(`CREATE TABLE IF NOT EXISTS rtn_warehouse_sessions (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            order_id VARCHAR(100) NOT NULL,
            deal_id BIGINT UNSIGNED NOT NULL,
            status VARCHAR(40) NOT NULL DEFAULT 'new',
            operator_name VARCHAR(160) NULL,
            items_json MEDIUMTEXT NOT NULL,
            onec_document_id VARCHAR(180) NULL,
            saferoute_order_id VARCHAR(180) NULL,
            track_number VARCHAR(180) NULL,
            label_url TEXT NULL,
            error_text TEXT NULL,
            started_at DATETIME NULL,
            completed_at DATETIME NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_rtn_wh_order (order_id),
            KEY idx_rtn_wh_deal (deal_id),
            KEY idx_rtn_wh_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

        await db.execute(`CREATE TABLE IF NOT EXISTS rtn_warehouse_scans (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            session_id BIGINT UNSIGNED NOT NULL,
            code_hash CHAR(64) NOT NULL,
            code_value VARCHAR(1024) NOT NULL,
            gtin VARCHAR(14) NULL,
            external_id VARCHAR(180) NULL,
            product_name VARCHAR(300) NULL,
            status VARCHAR(40) NOT NULL DEFAULT 'pending_1c',
            onec_status VARCHAR(120) NULL,
            error_text TEXT NULL,
            scanned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            validated_at DATETIME NULL,
            UNIQUE KEY uq_rtn_wh_mark (code_hash),
            KEY idx_rtn_wh_scan_session (session_id),
            KEY idx_rtn_wh_scan_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

        await db.execute(`CREATE TABLE IF NOT EXISTS rtn_warehouse_jobs (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            session_id BIGINT UNSIGNED NOT NULL,
            scan_id BIGINT UNSIGNED NULL,
            job_type VARCHAR(40) NOT NULL,
            payload_json MEDIUMTEXT NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'pending',
            attempts INT UNSIGNED NOT NULL DEFAULT 0,
            result_json MEDIUMTEXT NULL,
            error_text TEXT NULL,
            claimed_at DATETIME NULL,
            completed_at DATETIME NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_rtn_wh_job_status (status, created_at),
            KEY idx_rtn_wh_job_session (session_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

        await db.execute(`CREATE TABLE IF NOT EXISTS rtn_warehouse_stock (
            external_id VARCHAR(180) NOT NULL PRIMARY KEY,
            product_name VARCHAR(300) NULL,
            gtin VARCHAR(14) NULL,
            quantity DECIMAL(16,3) NOT NULL DEFAULT 0,
            reserved DECIMAL(16,3) NOT NULL DEFAULT 0,
            available DECIMAL(16,3) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    })().catch(error => {
        tablesReadyPromise = null;
        throw error;
    });

    return tablesReadyPromise;
}


async function getWarehouseDealProductRows(dealId) {
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

        const productId = Number(
            row.PRODUCT_ID || row.productId || 0
        );

        let externalId = '';

        if (productId) {
            try {
                const productResult = await bitrixCall(
                    'catalog.product.get',
                    { id: productId }
                );

                const product =
                    productResult?.product ||
                    productResult?.item ||
                    productResult ||
                    {};

                externalId = clean(
                    product.xmlId ||
                    product.XML_ID ||
                    '',
                    180
                ).replace(/^RTN:/i, '');
            } catch (error) {
                console.warn(
                    `RTN warehouse catalog lookup warning for product ${productId}:`,
                    error.message
                );
            }
        }

        items.push({
            id: String(row.ID || row.id || ''),
            productId: productId || null,
            externalId,
            name: rawName || 'Товар RTN.PRO',
            quantity: Math.max(
                1,
                Number(row.QUANTITY || row.quantity || 1)
            ),
            price: Number(row.PRICE || row.price || 0)
        });
    }

    return items;
}

async function addTimelineComment(dealId, comment) {
    try {
        await bitrixCall('crm.timeline.comment.add', {
            fields: {
                ENTITY_ID: Number(dealId),
                ENTITY_TYPE: 'deal',
                COMMENT: clean(comment, 4000)
            }
        });
    } catch (error) {
        console.error('RTN warehouse timeline warning:', error.message);
    }
}

async function moveDeal(dealId, stageId) {
    if (!dealId || !stageId) return;
    await bitrixCall('crm.deal.update', {
        id: Number(dealId),
        fields: { STAGE_ID: stageId }
    });
}

async function getPaymentOptions() {
    const now = Date.now();
    if (paymentOptionsCache.expiresAt > now && paymentOptionsCache.values.size) {
        return paymentOptionsCache.values;
    }

    const rows = await bitrixCall('crm.deal.userfield.list', {
        filter: { FIELD_NAME: PAYMENT_FIELD }
    });

    const field = Array.isArray(rows) ? rows[0] : null;
    const values = new Map();

    for (const option of Array.isArray(field?.LIST) ? field.LIST : []) {
        values.set(String(option.ID || option.id || ''), clean(option.VALUE || option.value, 120));
    }

    paymentOptionsCache = {
        expiresAt: now + 60000,
        values
    };

    return values;
}

async function paymentLabelForDeal(deal) {
    const raw = deal?.[PAYMENT_FIELD];
    if (raw === undefined || raw === null || raw === '') return '';
    const options = await getPaymentOptions();
    return options.get(String(Array.isArray(raw) ? raw[0] : raw)) || clean(raw, 120);
}

async function requireWarehouse(req, res, next) {
    try {
        const configuredToken = clean(process.env.RTN_WAREHOUSE_TOKEN, 500);
        const supplied = clean(req.get('x-rtn-warehouse-token'), 500);

        if (configuredToken && supplied && secureEqual(configuredToken, supplied)) {
            req.warehouseOperator = 'warehouse-token';
            return next();
        }

        const user = await getAuthenticatedUser(req);
        if (user && String(user.email || '').toLowerCase() === String(RTN_ADMIN_EMAIL || '').toLowerCase()) {
            req.warehouseOperator = user.email;
            return next();
        }

        return res.status(401).json({ error: 'Требуется доступ склада RTN' });
    } catch (error) {
        console.error('RTN warehouse auth error:', error.message);
        return res.status(500).json({ error: 'Не удалось проверить доступ склада' });
    }
}

function oneCAuth(req, res, next) {
    const expectedLogin = clean(process.env.ONEC_EXCHANGE_LOGIN, 200);
    const expectedPassword = String(process.env.ONEC_EXCHANGE_PASSWORD || '');
    const header = String(req.get('authorization') || '');

    if (!expectedLogin || !expectedPassword || !/^Basic\s+/i.test(header)) {
        res.set('WWW-Authenticate', 'Basic realm="RTN Warehouse 1C"');
        return res.status(401).send('Unauthorized');
    }

    try {
        const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        const login = separator >= 0 ? decoded.slice(0, separator) : '';
        const password = separator >= 0 ? decoded.slice(separator + 1) : '';

        if (!secureEqual(login, expectedLogin) || !secureEqual(password, expectedPassword)) {
            res.set('WWW-Authenticate', 'Basic realm="RTN Warehouse 1C"');
            return res.status(401).send('Unauthorized');
        }

        return next();
    } catch {
        return res.status(401).send('Unauthorized');
    }
}

async function readSession(id) {
    await ensureTables();
    const db = getPool();
    const [[session]] = await db.execute(
        'SELECT * FROM rtn_warehouse_sessions WHERE id = ? LIMIT 1',
        [Number(id)]
    );
    if (!session) return null;

    const [scans] = await db.execute(
        'SELECT * FROM rtn_warehouse_scans WHERE session_id = ? ORDER BY id ASC',
        [Number(id)]
    );

    return {
        id: Number(session.id),
        orderId: session.order_id,
        dealId: Number(session.deal_id),
        status: session.status,
        operatorName: session.operator_name || '',
        items: safeJson(session.items_json, []),
        onecDocumentId: session.onec_document_id || '',
        saferouteOrderId: session.saferoute_order_id || '',
        trackNumber: session.track_number || '',
        labelUrl: session.label_url || '',
        error: session.error_text || '',
        startedAt: session.started_at,
        completedAt: session.completed_at,
        updatedAt: session.updated_at,
        scans: scans.map(publicScan)
    };
}

function mergePreparedItems(current, prepared) {
    const byExternalId = new Map(
        (Array.isArray(prepared) ? prepared : [])
            .filter(item => clean(item?.externalId, 180))
            .map(item => [clean(item.externalId, 180), item])
    );

    return (Array.isArray(current) ? current : []).map(item => {
        const externalId = clean(item.externalId, 180);
        const fromOneC = byExternalId.get(externalId) || {};
        return {
            ...item,
            requiresMarking: Boolean(fromOneC.requiresMarking),
            gtin: clean(fromOneC.gtin, 14),
            onecName: clean(fromOneC.name || fromOneC.productName, 300),
            stock: Number(fromOneC.stock ?? fromOneC.quantity ?? 0),
            reserved: Number(fromOneC.reserved ?? 0),
            available: Number(fromOneC.available ?? fromOneC.stock ?? 0)
        };
    });
}

async function createJob({ sessionId, scanId = null, type, payload }) {
    const db = getPool();
    const [result] = await db.execute(
        `INSERT INTO rtn_warehouse_jobs
            (session_id, scan_id, job_type, payload_json, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [Number(sessionId), scanId ? Number(scanId) : null, type, JSON.stringify(payload || {})]
    );
    return Number(result.insertId);
}

async function startSession(dealId, operatorName) {
    await ensureTables();

    const deal = await bitrixCall('crm.deal.get', { id: Number(dealId) });
    if (!deal) {
        const error = new Error('Сделка Bitrix24 не найдена');
        error.status = 404;
        throw error;
    }

    const paymentLabel = await paymentLabelForDeal(deal);
    const stageId = clean(deal.STAGE_ID || deal.stageId, 120);

    if (
        (paymentLabel && !/оплачен/i.test(paymentLabel)) ||
        (!paymentLabel && /(?:^|:)NEW$/i.test(stageId))
    ) {
        const error = new Error('Сборку можно начать только после подтверждённой оплаты');
        error.status = 409;
        throw error;
    }

    const items = await getWarehouseDealProductRows(Number(dealId));
    if (!items.length) {
        const error = new Error('В сделке нет товарных позиций');
        error.status = 409;
        throw error;
    }

    const orderId = clean(
        deal.ORIGIN_ID ||
        deal.originId ||
        deal.UF_CRM_RTN_ORDER_NUMBER ||
        deal.ID ||
        dealId,
        100
    );

    const db = getPool();
    await db.execute(
        `INSERT INTO rtn_warehouse_sessions
            (order_id, deal_id, status, operator_name, items_json, started_at)
         VALUES (?, ?, 'preparing_1c', ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            operator_name = VALUES(operator_name),
            items_json = VALUES(items_json),
            status = CASE
                WHEN status IN ('ready_for_label','completed') THEN status
                ELSE 'preparing_1c'
            END,
            started_at = COALESCE(started_at, NOW()),
            updated_at = CURRENT_TIMESTAMP`,
        [orderId, Number(dealId), clean(operatorName, 160), JSON.stringify(items)]
    );

    const [[session]] = await db.execute(
        'SELECT * FROM rtn_warehouse_sessions WHERE order_id = ? LIMIT 1',
        [orderId]
    );

    const [[pending]] = await db.execute(
        `SELECT id FROM rtn_warehouse_jobs
         WHERE session_id = ? AND job_type = 'prepare_order'
           AND status IN ('pending','processing')
         LIMIT 1`,
        [session.id]
    );

    if (!pending) {
        await createJob({
            sessionId: session.id,
            type: 'prepare_order',
            payload: {
                orderId,
                dealId: Number(dealId),
                items
            }
        });
    }

    await moveDeal(Number(dealId), STAGE_PICKING);
    await addTimelineComment(
        Number(dealId),
        '📦 RTN Warehouse: сборка начата. Заказ передан в очередь 1С для резерва и подготовки маркируемых позиций.'
    );

    return readSession(session.id);
}

function validateCompletion(session) {
    const items = Array.isArray(session.items) ? session.items : [];
    const scans = Array.isArray(session.scans) ? session.scans : [];

    if (session.status !== 'picking') {
        return { ok: false, error: '1С ещё не подготовила заказ к сборке' };
    }

    if (scans.some(scan => scan.status === 'pending_1c')) {
        return { ok: false, error: 'Есть DataMatrix, которые ещё проверяются в 1С' };
    }

    for (const item of items) {
        if (item.requiresMarking !== true) continue;
        const needed = Math.max(1, Math.ceil(Number(item.quantity || 1)));
        const scanned = scans.filter(scan =>
            scan.status === 'valid' &&
            clean(scan.externalId, 180) === clean(item.externalId, 180)
        ).length;

        if (scanned < needed) {
            return {
                ok: false,
                error: `Не хватает маркировки: ${item.name || item.externalId} — ${scanned}/${needed}`
            };
        }
    }

    return { ok: true };
}

function createWarehouseRouter() {
    const router = express.Router();

    router.get('/ui', (req, res) => {
        return res.sendFile(
            path.join(__dirname, 'warehouse-ui.html')
        );
    });

    router.get('/health', async (req, res) => {
        try {
            await ensureTables();
            return res.json({
                ok: true,
                onecConfigured: Boolean(process.env.ONEC_EXCHANGE_LOGIN && process.env.ONEC_EXCHANGE_PASSWORD),
                warehouseTokenConfigured: Boolean(process.env.RTN_WAREHOUSE_TOKEN),
                stages: { picking: STAGE_PICKING, ready: STAGE_READY }
            });
        } catch (error) {
            return res.status(503).json({ ok: false, error: error.message });
        }
    });

    router.get('/deal/:dealId', requireWarehouse, async (req, res) => {
        try {
            await ensureTables();
            const db = getPool();
            const [[row]] = await db.execute(
                'SELECT id FROM rtn_warehouse_sessions WHERE deal_id = ? LIMIT 1',
                [Number(req.params.dealId)]
            );
            if (!row) return res.json({ ok: true, session: null });
            return res.json({ ok: true, session: await readSession(row.id) });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    });

    router.post('/deal/:dealId/start', requireWarehouse, async (req, res) => {
        try {
            const session = await startSession(
                Number(req.params.dealId),
                req.warehouseOperator || req.body?.operator || ''
            );
            return res.json({ ok: true, session });
        } catch (error) {
            return res.status(Number(error.status || 500)).json({ error: error.message });
        }
    });

    router.get('/session/:id', requireWarehouse, async (req, res) => {
        const session = await readSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Сборка не найдена' });
        return res.json({ ok: true, session });
    });

    router.post('/session/:id/scan', requireWarehouse, async (req, res) => {
        try {
            const session = await readSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Сборка не найдена' });
            if (session.status !== 'picking') {
                return res.status(409).json({ error: 'Заказ ещё не готов к сканированию' });
            }

            const codeValue = normalizeMarkCode(req.body?.code);
            const codeHash = crypto.createHash('sha256').update(codeValue).digest('hex');
            const gtin = parseGtin(codeValue);
            const db = getPool();

            try {
                const [result] = await db.execute(
                    `INSERT INTO rtn_warehouse_scans
                        (session_id, code_hash, code_value, gtin, status)
                     VALUES (?, ?, ?, ?, 'pending_1c')`,
                    [session.id, codeHash, codeValue, gtin || null]
                );

                const scanId = Number(result.insertId);
                await createJob({
                    sessionId: session.id,
                    scanId,
                    type: 'validate_mark',
                    payload: {
                        orderId: session.orderId,
                        dealId: session.dealId,
                        gtin,
                        code: codeValue
                    }
                });

                return res.status(202).json({
                    ok: true,
                    scan: {
                        id: scanId,
                        gtin,
                        status: 'pending_1c',
                        codeTail: codeValue.slice(-6)
                    }
                });
            } catch (error) {
                if (error?.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ error: 'Этот DataMatrix уже был отсканирован' });
                }
                throw error;
            }
        } catch (error) {
            return res.status(error?.code === 'INVALID_MARK' ? 400 : 500).json({ error: error.message });
        }
    });

    router.delete('/session/:id/scan/:scanId', requireWarehouse, async (req, res) => {
        await ensureTables();
        const db = getPool();
        const [[scan]] = await db.execute(
            'SELECT * FROM rtn_warehouse_scans WHERE id = ? AND session_id = ? LIMIT 1',
            [Number(req.params.scanId), Number(req.params.id)]
        );
        if (!scan) return res.status(404).json({ error: 'Скан не найден' });
        if (scan.status === 'consumed') {
            return res.status(409).json({ error: 'Марка уже списана в 1С/ЧЗ и не может быть удалена' });
        }

        await db.execute('DELETE FROM rtn_warehouse_jobs WHERE scan_id = ?', [scan.id]);
        await db.execute('DELETE FROM rtn_warehouse_scans WHERE id = ?', [scan.id]);
        return res.json({ ok: true });
    });

    router.post('/session/:id/complete', requireWarehouse, async (req, res) => {
        const session = await readSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Сборка не найдена' });

        const validation = validateCompletion(session);
        if (!validation.ok) return res.status(409).json({ error: validation.error });

        const db = getPool();
        const [rawScans] = await db.execute(
            `SELECT code_value, gtin, external_id, product_name
             FROM rtn_warehouse_scans
             WHERE session_id = ? AND status = 'valid'
             ORDER BY id ASC`,
            [session.id]
        );

        await db.execute(
            `UPDATE rtn_warehouse_sessions
             SET status = 'finalizing_1c', error_text = NULL
             WHERE id = ?`,
            [session.id]
        );

        await createJob({
            sessionId: session.id,
            type: 'finalize_order',
            payload: {
                orderId: session.orderId,
                dealId: session.dealId,
                items: session.items,
                marks: rawScans.map(scan => ({
                    code: scan.code_value,
                    gtin: scan.gtin || '',
                    externalId: scan.external_id || '',
                    productName: scan.product_name || ''
                }))
            }
        });

        await addTimelineComment(
            session.dealId,
            '✅ RTN Warehouse: физическая сборка завершена. В 1С отправлена команда на оформление отгрузки и обработку кодов маркировки. Этикетка SafeRoute будет доступна после подтверждения 1С.'
        );

        return res.json({ ok: true, session: await readSession(session.id) });
    });

    router.post('/session/:id/shipping-document', requireWarehouse, async (req, res) => {
        await ensureTables();
        const db = getPool();
        const labelUrl = clean(req.body?.labelUrl, 2000);
        const trackNumber = clean(req.body?.trackNumber, 180);
        const saferouteOrderId = clean(req.body?.saferouteOrderId, 180);

        await db.execute(
            `UPDATE rtn_warehouse_sessions
             SET label_url = COALESCE(NULLIF(?, ''), label_url),
                 track_number = COALESCE(NULLIF(?, ''), track_number),
                 saferoute_order_id = COALESCE(NULLIF(?, ''), saferoute_order_id),
                 status = CASE WHEN ? <> '' THEN 'completed' ELSE status END,
                 completed_at = CASE WHEN ? <> '' THEN NOW() ELSE completed_at END
             WHERE id = ?`,
            [labelUrl, trackNumber, saferouteOrderId, labelUrl, labelUrl, Number(req.params.id)]
        );

        return res.json({ ok: true, session: await readSession(req.params.id) });
    });

    router.get('/stocks', requireWarehouse, async (req, res) => {
        await ensureTables();
        const db = getPool();
        const [rows] = await db.execute(
            'SELECT * FROM rtn_warehouse_stock ORDER BY product_name ASC, external_id ASC'
        );
        return res.json({ ok: true, items: rows });
    });

    router.get('/1c/jobs', oneCAuth, async (req, res) => {
        await ensureTables();
        const db = getPool();

        await db.execute(
            `UPDATE rtn_warehouse_jobs
             SET status = 'pending', claimed_at = NULL
             WHERE status = 'processing'
               AND claimed_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`
        );

        const [jobs] = await db.execute(
            `SELECT * FROM rtn_warehouse_jobs
             WHERE status = 'pending'
             ORDER BY id ASC
             LIMIT 20`
        );

        const ids = jobs.map(job => Number(job.id));
        if (ids.length) {
            await db.query(
                `UPDATE rtn_warehouse_jobs
                 SET status = 'processing', attempts = attempts + 1, claimed_at = NOW()
                 WHERE id IN (?)`,
                [ids]
            );
        }

        return res.json({
            ok: true,
            jobs: jobs.map(job => ({
                id: Number(job.id),
                sessionId: Number(job.session_id),
                type: job.job_type,
                payload: safeJson(job.payload_json, {})
            }))
        });
    });

    router.post('/1c/jobs/:id/result', oneCAuth, async (req, res) => {
        await ensureTables();
        const db = getPool();
        const [[job]] = await db.execute(
            'SELECT * FROM rtn_warehouse_jobs WHERE id = ? LIMIT 1',
            [Number(req.params.id)]
        );

        if (!job) return res.status(404).json({ error: 'Задание не найдено' });

        const ok = req.body?.ok === true;
        const result = req.body?.result || {};
        const errorText = clean(req.body?.error || result?.error, 2000);

        await db.execute(
            `UPDATE rtn_warehouse_jobs
             SET status = ?, result_json = ?, error_text = ?, completed_at = NOW()
             WHERE id = ?`,
            [ok ? 'done' : 'failed', JSON.stringify(result), errorText || null, job.id]
        );

        if (job.job_type === 'prepare_order') {
            const [[session]] = await db.execute(
                'SELECT * FROM rtn_warehouse_sessions WHERE id = ? LIMIT 1',
                [job.session_id]
            );

            if (session) {
                if (ok) {
                    const items = mergePreparedItems(
                        safeJson(session.items_json, []),
                        result.items
                    );
                    await db.execute(
                        `UPDATE rtn_warehouse_sessions
                         SET items_json = ?, status = 'picking',
                             onec_document_id = ?, error_text = NULL
                         WHERE id = ?`,
                        [JSON.stringify(items), clean(result.onecDocumentId, 180) || null, session.id]
                    );
                    await addTimelineComment(
                        session.deal_id,
                        '🧾 1С подтвердила резерв. Заказ готов к сканированию маркированных товаров.'
                    );
                } else {
                    await db.execute(
                        `UPDATE rtn_warehouse_sessions
                         SET status = 'onec_error', error_text = ?
                         WHERE id = ?`,
                        [errorText || '1С не подготовила заказ', session.id]
                    );
                }
            }
        }

        if (job.job_type === 'validate_mark' && job.scan_id) {
            const externalId = clean(result.externalId, 180);
            const productName = clean(result.productName || result.name, 300);
            const onecStatus = clean(result.status || result.markStatus, 120);

            await db.execute(
                `UPDATE rtn_warehouse_scans
                 SET status = ?, external_id = ?, product_name = ?,
                     onec_status = ?, error_text = ?, validated_at = NOW()
                 WHERE id = ?`,
                [
                    ok ? 'valid' : 'invalid',
                    externalId || null,
                    productName || null,
                    onecStatus || null,
                    ok ? null : (errorText || 'Марка отклонена 1С'),
                    job.scan_id
                ]
            );
        }

        if (job.job_type === 'finalize_order') {
            const [[session]] = await db.execute(
                'SELECT * FROM rtn_warehouse_sessions WHERE id = ? LIMIT 1',
                [job.session_id]
            );

            if (session) {
                if (ok) {
                    await db.execute(
                        `UPDATE rtn_warehouse_sessions
                         SET status = 'ready_for_label',
                             onec_document_id = COALESCE(NULLIF(?, ''), onec_document_id),
                             error_text = NULL
                         WHERE id = ?`,
                        [clean(result.onecDocumentId, 180), session.id]
                    );
                    await db.execute(
                        `UPDATE rtn_warehouse_scans
                         SET status = 'consumed'
                         WHERE session_id = ? AND status = 'valid'`,
                        [session.id]
                    );
                    await moveDeal(session.deal_id, STAGE_READY);
                    await addTimelineComment(
                        session.deal_id,
                        '✅ 1С подтвердила отгрузку и обработку маркировки. Заказ готов к получению и печати транспортной этикетки SafeRoute.'
                    );
                } else {
                    await db.execute(
                        `UPDATE rtn_warehouse_sessions
                         SET status = 'onec_error', error_text = ?
                         WHERE id = ?`,
                        [errorText || 'Ошибка завершения заказа в 1С', session.id]
                    );
                }
            }
        }

        return res.json({ ok: true });
    });

    router.post('/1c/stocks', oneCAuth, async (req, res) => {
        await ensureTables();
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        const db = getPool();
        let updated = 0;

        for (const item of items.slice(0, 5000)) {
            const externalId = clean(item?.externalId, 180);
            if (!externalId) continue;

            const quantity = Number(item?.quantity ?? item?.stock ?? 0) || 0;
            const reserved = Number(item?.reserved ?? 0) || 0;
            const available = Number(item?.available ?? Math.max(0, quantity - reserved)) || 0;

            await db.execute(
                `INSERT INTO rtn_warehouse_stock
                    (external_id, product_name, gtin, quantity, reserved, available)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    product_name = VALUES(product_name),
                    gtin = VALUES(gtin),
                    quantity = VALUES(quantity),
                    reserved = VALUES(reserved),
                    available = VALUES(available),
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    externalId,
                    clean(item?.productName || item?.name, 300) || null,
                    clean(item?.gtin, 14) || null,
                    quantity,
                    reserved,
                    available
                ]
            );
            updated += 1;
        }

        return res.json({ ok: true, updated });
    });

    return router;
}

module.exports = {
    createWarehouseRouter,
    ensureWarehouseTables: ensureTables
};
