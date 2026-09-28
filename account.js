const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool, pingDatabase } = require('./db');
const { getMailStatus, verifyMailConnection, sendVerificationCodeEmail } = require('./rtn-mail');
const {
    getAccountOrders,
    ensureAccountBitrixContact,
    getAccountBitrixProfile,
    updateAccountBitrixProfile,
    getAccountOrderReference
} = require('./rtn-bitrix-account');
const { getOrderReceipt } = require('./rtn-yookassa-account');

const SESSION_COOKIE = 'rtn_session';
const RTN_ADMIN_EMAIL = normalizeEmail(process.env.RTN_ADMIN_EMAIL || 'perervamax@yandex.ru');
const SESSION_DAYS = Math.max(1, Number(process.env.RTN_SESSION_DAYS || 30));
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

function cleanText(value, max = 255) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEmail(value) {
    const email = cleanText(value, 254).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}


const EMAIL_CODE_TTL_MINUTES = 10;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_CODE_RESEND_SECONDS = 60;
const EMAIL_CODE_WINDOW_MINUTES = 10;
const EMAIL_CODE_WINDOW_LIMIT = 5;

const memoryRateLimits = new Map();

function getClientIp(req) {
    const forwarded = String(req.get('x-forwarded-for') || '')
        .split(',')[0]
        .trim();

    return cleanText(forwarded || req.ip || req.socket?.remoteAddress || 'unknown', 100);
}

function consumeMemoryRateLimit(key, limit, windowMs) {
    const now = Date.now();
    const current = memoryRateLimits.get(key);

    if (!current || current.resetAt <= now) {
        memoryRateLimits.set(key, {
            count: 1,
            resetAt: now + windowMs
        });
        return true;
    }

    if (current.count >= limit) {
        return false;
    }

    current.count += 1;
    return true;
}

function hashVerificationCode(code) {
    const pepper = String(
        process.env.RTN_OTP_PEPPER ||
        process.env.RTN_MAILER_API_KEY ||
        ''
    );

    if (!pepper) {
        const error = new Error('RTN OTP pepper is not configured');
        error.code = 'RTN_OTP_PEPPER_NOT_CONFIGURED';
        throw error;
    }

    return crypto
        .createHmac('sha256', pepper)
        .update(String(code))
        .digest();
}

function safeEqualBuffers(a, b) {
    const left = Buffer.from(a || []);
    const right = Buffer.from(b || []);

    return (
        left.length === right.length &&
        left.length > 0 &&
        crypto.timingSafeEqual(left, right)
    );
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

let profileMediaReadyPromise = null;

function normalizeDateOnly(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
}

function validateAvatarDataUrl(value) {
    const raw = String(value || '').trim();

    if (!raw) return '';

    if (
        raw.length > 8 * 1024 * 1024 ||
        !/^data:image\/(?:jpeg|jpg|png|webp);base64,[a-z0-9+/=\r\n]+$/i.test(raw)
    ) {
        const error = new Error('Некорректный формат фотографии');
        error.code = 'INVALID_AVATAR';
        throw error;
    }

    return raw;
}

async function ensureProfileMediaTable() {
    if (profileMediaReadyPromise) {
        return profileMediaReadyPromise;
    }

    profileMediaReadyPromise = (async () => {
        const db = getPool();

        await db.execute(
            `CREATE TABLE IF NOT EXISTS user_profile_media (
                user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                avatar_data_url MEDIUMTEXT NULL,
                updated_at TIMESTAMP NOT NULL
                    DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_profile_media_updated_at (updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );
    })().catch(error => {
        profileMediaReadyPromise = null;
        throw error;
    });

    return profileMediaReadyPromise;
}

async function getStoredAvatarDataUrl(userId) {
    if (!userId) return '';

    await ensureProfileMediaTable();

    const db = getPool();
    const [[row]] = await db.execute(
        `SELECT avatar_data_url
         FROM user_profile_media
         WHERE user_id = ?
         LIMIT 1`,
        [userId]
    );

    return String(row?.avatar_data_url || '');
}

async function saveStoredAvatarDataUrl(userId, value) {
    if (!userId) return '';

    const avatarDataUrl = validateAvatarDataUrl(value);

    if (!avatarDataUrl) {
        return getStoredAvatarDataUrl(userId);
    }

    await ensureProfileMediaTable();

    const db = getPool();

    await db.execute(
        `INSERT INTO user_profile_media
            (user_id, avatar_data_url)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
            avatar_data_url = VALUES(avatar_data_url),
            updated_at = CURRENT_TIMESTAMP`,
        [userId, avatarDataUrl]
    );

    return avatarDataUrl;
}

function normalizeAccountProfile(profile, avatarUrl = '') {
    if (!profile) return profile;

    return {
        ...profile,
        birthDate: normalizeDateOnly(profile.birthDate),
        avatarUrl: avatarUrl || profile.avatarUrl || ''
    };
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
        'Path=/api',
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
        `${SESSION_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=None; Max-Age=0`
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
        createdAt: row.created_at,
        isAdmin: normalizeEmail(row.email) === RTN_ADMIN_EMAIL
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

    router.get('/mail/health', async (req, res) => {
        const status = getMailStatus();
        const verify = String(req.query?.verify || '') === '1';

        if (!verify) {
            return res.json({
                ok: true,
                ...status
            });
        }

        if (!status.configured) {
            return res.status(503).json({
                ok: false,
                ...status,
                error: 'RTN mail relay is not configured'
            });
        }

        try {
            await verifyMailConnection();

            return res.json({
                ok: true,
                ...status,
                connection: 'verified'
            });
        } catch (error) {
            console.error('RTN mail health error:', error);

            return res.status(503).json({
                ok: false,
                ...status,
                error: 'Mail relay connection failed',
                debug: {
                    code: error?.code || null,
                    command: error?.command || null,
                    responseCode: error?.responseCode || null,
                    syscall: error?.syscall || null,
                    address: error?.address || null,
                    port: error?.port || null,
                    message: String(error?.message || '').slice(0, 300)
                }
            });
        }
    });

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

    router.post('/email/send-code', async (req, res) => {
        const email = normalizeEmail(req.body?.email);

        if (!email) {
            return res.status(400).json({
                error: 'Укажите корректный email'
            });
        }

        const ip = getClientIp(req);

        if (!consumeMemoryRateLimit(
            `email-send-ip:${ip}`,
            40,
            10 * 60 * 1000
        )) {
            return res.status(429).json({
                code: 'IP_COOLDOWN',
                error: 'Слишком много запросов с этого адреса. Попробуйте позже',
                retryAfterSeconds: 600
            });
        }

        try {
            const db = getPool();

            const [[existingUser]] = await db.execute(
                'SELECT id FROM users WHERE email = ? LIMIT 1',
                [email]
            );

            const [[windowUsage]] = await db.execute(
                `SELECT
                    COUNT(*) AS total,
                    LEAST(
                        ${EMAIL_CODE_WINDOW_MINUTES * 60},
                        GREATEST(
                            1,
                            ${EMAIL_CODE_WINDOW_MINUTES * 60} -
                            TIMESTAMPDIFF(SECOND, MIN(created_at), NOW())
                        )
                    ) AS retry_after_seconds
                 FROM verification_codes
                 WHERE channel = 'email'
                   AND target = ?
                   AND purpose = 'login'
                   AND created_at >= DATE_SUB(
                       NOW(),
                       INTERVAL ${EMAIL_CODE_WINDOW_MINUTES} MINUTE
                   )`,
                [email]
            );

            const sentInWindow = Number(windowUsage?.total || 0);

            if (sentInWindow >= EMAIL_CODE_WINDOW_LIMIT) {
                const retryAfterSeconds = Math.max(
                    1,
                    Math.min(
                        EMAIL_CODE_WINDOW_MINUTES * 60,
                        Number(windowUsage?.retry_after_seconds || 1)
                    )
                );

                res.setHeader('Retry-After', String(retryAfterSeconds));

                return res.status(429).json({
                    code: 'EMAIL_COOLDOWN',
                    error: 'EMAIL ПЕРЕГРЕЛСЯ. СЛИШКОМ МНОГО КОДОВ ЗА КОРОТКОЕ ВРЕМЯ.',
                    retryAfterSeconds,
                    retryAfterMinutes: Math.ceil(retryAfterSeconds / 60),
                    windowMinutes: EMAIL_CODE_WINDOW_MINUTES,
                    limit: EMAIL_CODE_WINDOW_LIMIT
                });
            }

            const [[lastCode]] = await db.execute(
                `SELECT
                    LEAST(
                        ${EMAIL_CODE_RESEND_SECONDS},
                        GREATEST(
                            0,
                            ${EMAIL_CODE_RESEND_SECONDS} -
                            TIMESTAMPDIFF(SECOND, created_at, NOW())
                        )
                    ) AS retry_after_seconds
                 FROM verification_codes
                 WHERE channel = 'email'
                   AND target = ?
                   AND purpose = 'login'
                 ORDER BY id DESC
                 LIMIT 1`,
                [email]
            );

            const lastRetryAfterSeconds = Number(
                lastCode?.retry_after_seconds || 0
            );

            if (lastRetryAfterSeconds > 0) {
                    const retryAfterSeconds = Math.max(
                        1,
                        Math.min(
                            EMAIL_CODE_RESEND_SECONDS,
                            lastRetryAfterSeconds
                        )
                    );

                    res.setHeader('Retry-After', String(retryAfterSeconds));

                    return res.status(429).json({
                        code: 'RESEND_WAIT',
                        error: 'КОД УЖЕ ОТПРАВЛЕН. ПОДОЖДИТЕ ПЕРЕД ПОВТОРНОЙ ОТПРАВКОЙ.',
                        retryAfterSeconds,
                        retryAfter: retryAfterSeconds
                    });
            }

            const code = String(
                crypto.randomInt(0, 1000000)
            ).padStart(6, '0');

            const codeHash = hashVerificationCode(code);

            await db.execute(
                `UPDATE verification_codes
                 SET used_at = NOW()
                 WHERE channel = 'email'
                   AND target = ?
                   AND purpose = 'login'
                   AND used_at IS NULL`,
                [email]
            );

            const [insertResult] = await db.execute(
                `INSERT INTO verification_codes
                    (
                        user_id,
                        channel,
                        target,
                        purpose,
                        code_hash,
                        attempts,
                        expires_at
                    )
                 VALUES (?, 'email', ?, 'login', ?, 0,
                         DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
                [
                    existingUser?.id || null,
                    email,
                    codeHash,
                    EMAIL_CODE_TTL_MINUTES
                ]
            );

            try {
                await sendVerificationCodeEmail({
                    to: email,
                    code,
                    expiresMinutes: EMAIL_CODE_TTL_MINUTES
                });
            } catch (mailError) {
                await db.execute(
                    'UPDATE verification_codes SET used_at = NOW() WHERE id = ?',
                    [insertResult.insertId]
                ).catch(() => {});

                throw mailError;
            }

            return res.json({
                ok: true,
                expiresMinutes: EMAIL_CODE_TTL_MINUTES,
                resendAfterSeconds: EMAIL_CODE_RESEND_SECONDS,
                remainingSendsInWindow: Math.max(
                    0,
                    EMAIL_CODE_WINDOW_LIMIT - sentInWindow - 1
                ),
                windowMinutes: EMAIL_CODE_WINDOW_MINUTES
            });
        } catch (error) {
            console.error('RTN email send code error:', error);

            return res.status(500).json({
                error: 'Не удалось отправить код'
            });
        }
    });

    router.post('/email/verify', async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const code = String(req.body?.code || '').replace(/\D/g, '').slice(0, 6);

        if (!email || !/^\d{6}$/.test(code)) {
            return res.status(400).json({
                error: 'Укажите email и шестизначный код'
            });
        }

        const ip = getClientIp(req);

        if (!consumeMemoryRateLimit(
            `email-verify-ip:${ip}`,
            30,
            60 * 60 * 1000
        )) {
            return res.status(429).json({
                error: 'Слишком много попыток. Попробуйте позже'
            });
        }

        let connection;

        try {
            const db = getPool();
            connection = await db.getConnection();
            await connection.beginTransaction();

            const [codeRows] = await connection.execute(
                `SELECT
                    id,
                    user_id,
                    code_hash,
                    attempts,
                    expires_at,
                    TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS expires_in_seconds,
                    used_at
                 FROM verification_codes
                 WHERE channel = 'email'
                   AND target = ?
                   AND purpose = 'login'
                   AND used_at IS NULL
                 ORDER BY id DESC
                 LIMIT 1
                 FOR UPDATE`,
                [email]
            );

            const verification = codeRows[0];

            if (!verification) {
                const [[lastIssued]] = await connection.execute(
                    `SELECT
                        LEAST(
                            ${EMAIL_CODE_RESEND_SECONDS},
                            GREATEST(
                                0,
                                ${EMAIL_CODE_RESEND_SECONDS} -
                                TIMESTAMPDIFF(SECOND, created_at, NOW())
                            )
                        ) AS retry_after_seconds
                     FROM verification_codes
                     WHERE channel = 'email'
                       AND target = ?
                       AND purpose = 'login'
                     ORDER BY id DESC
                     LIMIT 1`,
                    [email]
                );

                const canResendInSeconds = Math.max(
                    0,
                    Math.min(
                        EMAIL_CODE_RESEND_SECONDS,
                        Number(lastIssued?.retry_after_seconds || 0)
                    )
                );

                await connection.rollback();

                return res.status(400).json({
                    code: 'CODE_NOT_FOUND',
                    error: 'КОД НЕ НАЙДЕН ИЛИ УЖЕ ИСПОЛЬЗОВАН.',
                    canResendInSeconds
                });
            }

            if (Number(verification.expires_in_seconds || 0) <= 0) {
                await connection.execute(
                    'UPDATE verification_codes SET used_at = NOW() WHERE id = ?',
                    [verification.id]
                );
                await connection.commit();

                return res.status(400).json({
                    code: 'CODE_EXPIRED',
                    error: 'СРОК ДЕЙСТВИЯ КОДА ИСТЁК.',
                    canResendInSeconds: 0
                });
            }

            if (Number(verification.attempts || 0) >= EMAIL_CODE_MAX_ATTEMPTS) {
                await connection.execute(
                    'UPDATE verification_codes SET used_at = NOW() WHERE id = ?',
                    [verification.id]
                );
                await connection.commit();

                return res.status(429).json({
                    code: 'CODE_ATTEMPTS_EXCEEDED',
                    error: 'ПРЕВЫШЕНО КОЛИЧЕСТВО ПОПЫТОК. ЗАПРОСИТЕ НОВЫЙ КОД.',
                    canResendInSeconds: 0
                });
            }

            const incomingHash = hashVerificationCode(code);

            if (!safeEqualBuffers(verification.code_hash, incomingHash)) {
                const attempts = Number(verification.attempts || 0) + 1;
                const lockCode = attempts >= EMAIL_CODE_MAX_ATTEMPTS;

                await connection.execute(
                    `UPDATE verification_codes
                     SET attempts = ?,
                         used_at = CASE WHEN ? THEN NOW() ELSE used_at END
                     WHERE id = ?`,
                    [attempts, lockCode ? 1 : 0, verification.id]
                );

                await connection.commit();

                return res.status(400).json({
                    error: lockCode
                        ? 'Превышено количество попыток. Запросите новый код'
                        : 'Неверный код',
                    attemptsLeft: Math.max(
                        0,
                        EMAIL_CODE_MAX_ATTEMPTS - attempts
                    )
                });
            }

            const [userRows] = await connection.execute(
                `SELECT *
                 FROM users
                 WHERE email = ?
                 LIMIT 1
                 FOR UPDATE`,
                [email]
            );

            let user = userRows[0];

            if (user && user.status !== 'active') {
                await connection.rollback();

                return res.status(403).json({
                    error: 'Аккаунт недоступен'
                });
            }

            if (!user) {
                const publicId = crypto.randomUUID();
                const unusablePasswordHash = await bcrypt.hash(
                    crypto.randomBytes(32).toString('hex'),
                    12
                );

                const [userResult] = await connection.execute(
                    `INSERT INTO users
                        (
                            public_id,
                            email,
                            password_hash,
                            email_verified_at,
                            status
                        )
                     VALUES (?, ?, ?, NOW(), 'active')`,
                    [
                        publicId,
                        email,
                        unusablePasswordHash
                    ]
                );

                await connection.execute(
                    'INSERT INTO rhino_coin_accounts (user_id) VALUES (?)',
                    [userResult.insertId]
                );

                const [createdRows] = await connection.execute(
                    'SELECT * FROM users WHERE id = ? LIMIT 1',
                    [userResult.insertId]
                );

                user = createdRows[0];
            } else {
                await connection.execute(
                    `UPDATE users
                     SET email_verified_at = COALESCE(email_verified_at, NOW()),
                         updated_at = NOW()
                     WHERE id = ?`,
                    [user.id]
                );

                user.email_verified_at =
                    user.email_verified_at || new Date();
            }

            await connection.execute(
                `UPDATE verification_codes
                 SET used_at = NOW(),
                     user_id = ?
                 WHERE id = ?`,
                [user.id, verification.id]
            );

            const token = await createSession(connection, user.id, req);

            const [publicRows] = await connection.execute(
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
                    COALESCE(a.balance, 0) AS rhino_coin_balance
                 FROM users u
                 LEFT JOIN rhino_coin_accounts a ON a.user_id = u.id
                 WHERE u.id = ?
                 LIMIT 1`,
                [user.id]
            );

            await connection.commit();

            setSessionCookie(res, token);

            ensureAccountBitrixContact({
                ...publicRows[0],
                id: user.id
            }).catch(error => {
                console.error('RTN account Bitrix contact link error:', error.message);
            });

            return res.json({
                ok: true,
                sessionToken: token,
                user: publicUser(publicRows[0])
            });
        } catch (error) {
            if (connection) {
                try {
                    await connection.rollback();
                } catch (_) {}
            }

            console.error('RTN email verify error:', error);

            return res.status(500).json({
                error: 'Не удалось подтвердить код'
            });
        } finally {
            connection?.release();
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

            ensureAccountBitrixContact({
                id: userId,
                public_id: publicId,
                email: email || null,
                phone: phone || null,
                first_name: firstName || null,
                last_name: lastName || null
            }).catch(error => {
                console.error(
                    'RTN account register Bitrix sync error:',
                    error.message
                );
            });

            return res.status(201).json({
                ok: true,
                sessionToken: token,
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
            let token = '';

            try {
                token = await createSession(connection, user.id, req);
                setSessionCookie(res, token);
            } finally {
                connection.release();
            }

            ensureAccountBitrixContact(user).catch(error => {
                console.error(
                    'RTN account password login Bitrix sync error:',
                    error.message
                );
            });

            return res.json({
                ok: true,
                sessionToken: token,
                user: publicUser(user)
            });
        } catch (error) {
            console.error('RTN account login error:', error.message);

            return res.status(500).json({
                error: 'Не удалось выполнить вход'
            });
        }
    });

    router.get('/profile', async (req, res) => {
        try {
            const user = await getAuthenticatedUser(req);

            if (!user) {
                return res.status(401).json({
                    error: 'Требуется вход'
                });
            }

            const [bitrixProfile, storedAvatarUrl] = await Promise.all([
                getAccountBitrixProfile(user),
                getStoredAvatarDataUrl(user.id)
            ]);

            const profile = normalizeAccountProfile(
                bitrixProfile,
                storedAvatarUrl
            );

            return res.json({
                ok: true,
                user: publicUser(user),
                profile
            });
        } catch (error) {
            console.error('RTN account profile get error:', error);

            return res.status(502).json({
                error: 'Не удалось получить профиль'
            });
        }
    });

    router.patch('/profile', async (req, res) => {
        const firstName = cleanText(req.body?.firstName, 100);
        const lastName = cleanText(req.body?.lastName, 100);
        const rawPhone = cleanText(req.body?.phone, 40);
        const phone = rawPhone ? normalizePhone(rawPhone) : '';
        const birthDate = normalizeDateOnly(req.body?.birthDate);
        const photoBase64 = String(req.body?.photoBase64 || '');

        if (rawPhone && !phone) {
            return res.status(400).json({
                error: 'Укажите корректный телефон'
            });
        }

        try {
            const user = await getAuthenticatedUser(req);

            if (!user) {
                return res.status(401).json({
                    error: 'Требуется вход'
                });
            }

            const db = getPool();

            await db.execute(
                `UPDATE users
                 SET first_name = ?,
                     last_name = ?,
                     phone = ?,
                     updated_at = NOW()
                 WHERE id = ?`,
                [
                    firstName || null,
                    lastName || null,
                    phone || null,
                    user.id
                ]
            );

            const updatedUser = {
                ...user,
                first_name: firstName || null,
                last_name: lastName || null,
                phone: phone || null
            };

            const profile = await updateAccountBitrixProfile(
                updatedUser,
                {
                    street: cleanText(
                        req.body?.street ?? req.body?.address,
                        300
                    ),
                    house: cleanText(req.body?.house, 80),
                    apartmentOffice: cleanText(
                        req.body?.apartmentOffice ?? req.body?.address2,
                        120
                    ),
                    city: cleanText(req.body?.city, 150),
                    country: cleanText(req.body?.country, 100),
                    birthDate,
                    photoBase64,
                    photoFilename: cleanText(
                        req.body?.photoFilename || 'rtn-profile.jpg',
                        180
                    )
                }
            );

            const storedAvatarUrl = photoBase64
                ? await saveStoredAvatarDataUrl(user.id, photoBase64)
                : await getStoredAvatarDataUrl(user.id);

            const normalizedProfile = normalizeAccountProfile(
                profile,
                storedAvatarUrl
            );

            return res.json({
                ok: true,
                user: publicUser(updatedUser),
                profile: normalizedProfile
            });
        } catch (error) {
            console.error('RTN account profile update error:', error);

            if (error?.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({
                    error: 'Этот телефон уже используется другим аккаунтом'
                });
            }

            return res.status(502).json({
                error: 'Не удалось сохранить профиль'
            });
        }
    });

    router.get('/orders/:dealId/receipt', async (req, res) => {
        try {
            const user = await getAuthenticatedUser(req);

            if (!user) {
                return res.status(401).json({
                    error: 'Требуется вход'
                });
            }

            const order = await getAccountOrderReference(
                user,
                req.params?.dealId
            );

            if (!order) {
                return res.status(404).json({
                    error: 'Заказ не найден'
                });
            }

            if (!order.orderId) {
                return res.status(404).json({
                    error: 'Для этого заказа нет номера оплаты'
                });
            }

            const receipt = await getOrderReceipt(order.orderId);

            if (!receipt) {
                return res.status(404).json({
                    error: 'Чек для этого заказа пока не найден'
                });
            }

            return res.json({
                ok: true,
                order,
                receipt
            });
        } catch (error) {
            console.error('RTN account receipt error:', error);

            return res.status(502).json({
                error: 'Не удалось получить чек'
            });
        }
    });

    router.get('/orders', async (req, res) => {
        try {
            const user = await getAuthenticatedUser(req);

            if (!user) {
                return res.status(401).json({
                    error: 'Требуется вход'
                });
            }

            const history = await getAccountOrders(user);

            return res.json({
                ok: true,
                bitrixContactId: history.contactId,
                orders: history.orders
            });
        } catch (error) {
            console.error('RTN account orders error:', error);

            return res.status(502).json({
                error: 'Не удалось получить историю заказов'
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
    createAccountRouter,
    getAuthenticatedUser,
    RTN_ADMIN_EMAIL
};
