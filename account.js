const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool, pingDatabase } = require('./db');

const SESSION_COOKIE = 'rtn_session';
const SESSION_DAYS = Math.max(1, Number(process.env.RTN_SESSION_DAYS || 30));
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

function cleanText(value, max = 255) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEmail(value) {
    const email = cleanText(value, 254).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function normalizePhone(value) {
    const raw = cleanText(value, 40);
    const digits = raw.replace(/\D/g, '');

    if (digits.length < 10 || digits.length > 15) {
        return '';
    }

    if (digits.length === 11 && digits.startsWith('8')) {
        return '+7' + digits.slice(1);
    }

    if (digits.length === 10) {
        return '+7' + digits;
    }

    return '+' + digits;
}

function hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest();
}

function parseCookies(req) {
    const header = String(req.headers.cookie || '');
    const cookies = {};

    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        if (key) {
            cookies[key] = decodeURIComponent(value);
        }
    }

    return cookies;
}

function getSessionToken(req) {
    const auth = String(req.get('authorization') || '').trim();

    if (/^Bearer\s+/i.test(auth)) {
        return auth.replace(/^Bearer\s+/i, '').trim();
    }

    return parseCookies(req)[SESSION_COOKIE] || '';
}

function setSessionCookie(res, token) {
    const parts = [
        `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        'Path=/api/account',
        'HttpOnly',
        'Secure',
        'SameSite=None',
        `Max-Age=${SESSION_MAX_AGE}`
    ];

    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=; Path=/api/account; HttpOnly; Secure; SameSite=None; Max-Age=0`
    );
}

function publicUser(row) {
    return {
        id: row.public_id,
        email: row.email || null,
        phone: row.phone || null,
        firstName: row.first_name || '',
        lastName: row.last_name || '',
        bitrixContactId: row.bitrix_contact_id || null,
        emailVerified: Boolean(row.email_verified_at),
        phoneVerified: Boolean(row.phone_verified_at),
        status: row.status,
        rhinoCoins: Number(row.rhino_coin_balance || 0),
        createdAt: row.created_at
    };
}

async function createSession(connection, userId, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(token);
    const userAgent = cleanText(req.get('user-agent'), 500);

    await connection.execute(
        `INSERT INTO sessions
            (user_id, token_hash, user_agent, expires_at)
         VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
        [userId, tokenHash, userAgent || null, SESSION_DAYS]
    );

    return token;
}

async function getAuthenticatedUser(req) {
    const token = getSessionToken(req);

    if (!token || token.length < 20) {
        return null;
    }

    const db = getPool();
    const tokenHash = hashSessionToken(token);

    const [rows] = await db.execute(
        `SELECT
            u.id,
            u.public_id,
            u.email,
            u.phone,
            u.first_name,
            u.last_name,
            u.bitrix_contact_id,
            u.email_verified_at,
            u.phone_verified_at,
            u.status,
            u.created_at,
            COALESCE(a.balance, 0) AS rhino_coin_balance,
            s.id AS session_id
         FROM sessions s
         INNER JOIN users u ON u.id = s.user_id
         LEFT JOIN rhino_coin_accounts a ON a.user_id = u.id
         WHERE s.token_hash = ?
           AND s.expires_at > NOW()
           AND u.status = 'active'
         LIMIT 1`,
        [tokenHash]
    );

    const user = rows[0] || null;

    if (user) {
        db.execute(
            'UPDATE sessions SET last_used_at = NOW() WHERE id = ?',
            [user.session_id]
        ).catch(() => {});
    }

    return user;
}

function createAccountRouter() {
    const router = express.Router();

    router.get('/health', async (req, res) => {
        try {
            const result = await pingDatabase();

            return res.json({
                ok: true,
                database: result?.db || null,
                serverTime: result?.serverTime || null
            });
        } catch (error) {
            console.error('RTN account database health error:', error.message);

            return res.status(503).json({
                ok: false,
                error: 'Database unavailable'
            });
        }
    });

    router.post('/register', async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const phone = normalizePhone(req.body?.phone);
        const password = String(req.body?.password || '');
        const firstName = cleanText(req.body?.firstName, 100);
        const lastName = cleanText(req.body?.lastName, 100);

        if (!email && !phone) {
            return res.status(400).json({
                error: 'Укажите корректный email или телефон'
            });
        }

        if (password.length < 8 || password.length > 200) {
            return res.status(400).json({
                error: 'Пароль должен содержать от 8 до 200 символов'
            });
        }

        const db = getPool();
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const conditions = [];
            const values = [];

            if (email) {
                conditions.push('email = ?');
                values.push(email);
            }

            if (phone) {
                conditions.push('phone = ?');
                values.push(phone);
            }

            const [existing] = await connection.execute(
                `SELECT id FROM users WHERE ${conditions.join(' OR ')} LIMIT 1`,
                values
            );

            if (existing.length) {
                await connection.rollback();

                return res.status(409).json({
                    error: 'Пользователь с таким email или телефоном уже существует'
                });
            }

            const publicId = crypto.randomUUID();
            const passwordHash = await bcrypt.hash(password, 12);

            const [result] = await connection.execute(
                `INSERT INTO users
                    (public_id, email, phone, password_hash, first_name, last_name)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    publicId,
                    email || null,
                    phone || null,
                    passwordHash,
                    firstName || null,
                    lastName || null
                ]
            );

            const userId = result.insertId;

            await connection.execute(
                'INSERT INTO rhino_coin_accounts (user_id) VALUES (?)',
                [userId]
            );

            const token = await createSession(connection, userId, req);

            await connection.commit();

            setSessionCookie(res, token);

            return res.status(201).json({
                ok: true,
                user: {
                    id: publicId,
                    email: email || null,
                    phone: phone || null,
                    firstName,
                    lastName,
                    bitrixContactId: null,
                    emailVerified: false,
                    phoneVerified: false,
                    status: 'active',
                    rhinoCoins: 0
                }
            });
        } catch (error) {
            try {
                await connection.rollback();
            } catch (_) {}

            console.error('RTN account register error:', error.message);

            if (error?.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({
                    error: 'Пользователь с таким email или телефоном уже существует'
                });
            }

            return res.status(500).json({
                error: 'Не удалось создать аккаунт'
            });
        } finally {
            connection.release();
        }
    });

    router.post('/login', async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const phone = normalizePhone(req.body?.phone);
        const password = String(req.body?.password || '');

        if ((!email && !phone) || !password) {
            return res.status(400).json({
                error: 'Укажите email/телефон и пароль'
            });
        }

        try {
            const db = getPool();
            const [rows] = await db.execute(
                `SELECT
                    u.*,
                    COALESCE(a.balance, 0) AS rhino_coin_balance
                 FROM users u
                 LEFT JOIN rhino_coin_accounts a ON a.user_id = u.id
                 WHERE ${email ? 'u.email = ?' : 'u.phone = ?'}
                 LIMIT 1`,
                [email || phone]
            );

            const user = rows[0];

            if (
                !user ||
                user.status !== 'active' ||
                !(await bcrypt.compare(password, user.password_hash))
            ) {
                return res.status(401).json({
                    error: 'Неверный email/телефон или пароль'
                });
            }

            const connection = await db.getConnection();

            try {
                const token = await createSession(connection, user.id, req);
                setSessionCookie(res, token);
            } finally {
                connection.release();
            }

            return res.json({
                ok: true,
                user: publicUser(user)
            });
        } catch (error) {
            console.error('RTN account login error:', error.message);

            return res.status(500).json({
                error: 'Не удалось выполнить вход'
            });
        }
    });

    router.get('/me', async (req, res) => {
        try {
            const user = await getAuthenticatedUser(req);

            if (!user) {
                return res.status(401).json({
                    error: 'Требуется вход'
                });
            }

            return res.json({
                ok: true,
                user: publicUser(user)
            });
        } catch (error) {
            console.error('RTN account me error:', error.message);

            return res.status(500).json({
                error: 'Не удалось получить профиль'
            });
        }
    });

    router.post('/logout', async (req, res) => {
        try {
            const token = getSessionToken(req);

            if (token) {
                const db = getPool();
                await db.execute(
                    'DELETE FROM sessions WHERE token_hash = ?',
                    [hashSessionToken(token)]
                );
            }

            clearSessionCookie(res);

            return res.json({ ok: true });
        } catch (error) {
            console.error('RTN account logout error:', error.message);
            clearSessionCookie(res);

            return res.json({ ok: true });
        }
    });

    return router;
}

module.exports = {
    createAccountRouter
};
