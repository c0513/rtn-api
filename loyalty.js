const { getPool } = require('./db');

const SIX_MONTHS = 6;
const COIN_TTL_DAYS = 180;

const LEVEL_RULES = Object.freeze({
    BRONZE: Object.freeze({
        friendDiscount: 5,
        referralPercent: 5,
        friendBonus: 50
    }),
    SILVER: Object.freeze({
        friendDiscount: 7,
        referralPercent: 7,
        friendBonus: 75
    }),
    GOLD: Object.freeze({
        friendDiscount: 10,
        referralPercent: 10,
        friendBonus: 100
    })
});

let tablesReadyPromise = null;
let maintenanceTimer = null;

function toMoney(value) {
    const number = Number(value || 0);
    return Number.isFinite(number)
        ? Math.max(0, Math.round(number * 100) / 100)
        : 0;
}

function normalizeLevel(value) {
    const level = String(value || '').trim().toUpperCase();
    return LEVEL_RULES[level] ? level : 'BRONZE';
}

function getLoyaltyBenefits(level) {
    const normalized = normalizeLevel(level);
    return {
        level: normalized,
        ...LEVEL_RULES[normalized]
    };
}

function addMonths(date, months) {
    const result = new Date(date.getTime());
    result.setUTCMonth(result.getUTCMonth() + months);
    return result;
}

function addDays(date, days) {
    return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function normalizePurchase(purchase) {
    const amount = toMoney(purchase?.amount);
    const date = new Date(
        purchase?.date ||
        purchase?.closedAt ||
        purchase?.createdAt ||
        0
    );

    if (amount <= 0 || Number.isNaN(date.getTime())) {
        return null;
    }

    return {
        amount,
        date,
        orderId: String(purchase?.orderId || purchase?.dealId || '')
    };
}

function calculateLoyaltyFromPurchases(purchases = [], nowValue = new Date()) {
    const now = new Date(nowValue);
    const normalized = (Array.isArray(purchases) ? purchases : [])
        .map(normalizePurchase)
        .filter(Boolean)
        .sort((a, b) => a.date.getTime() - b.date.getTime());

    const totalPurchaseAmount = Math.round(
        normalized.reduce((sum, item) => sum + item.amount, 0) * 100
    ) / 100;

    if (!normalized.length) {
        return {
            level: 'BRONZE',
            totalPurchaseAmount,
            qualifyingPurchaseAmount: 0,
            silverProgress: 0,
            goldProgress: 0,
            lastPurchaseAt: null,
            qualificationStartedAt: null,
            inactive: false,
            expiresAt: null,
            progress: {
                current: 0,
                target: 50000,
                nextLevel: 'SILVER',
                percent: 0
            },
            benefits: getLoyaltyBenefits('BRONZE')
        };
    }

    let cycleStart = 0;

    for (let index = 1; index < normalized.length; index += 1) {
        const previous = normalized[index - 1].date;
        const current = normalized[index].date;

        if (current.getTime() >= addMonths(previous, SIX_MONTHS).getTime()) {
            cycleStart = index;
        }
    }

    const lastPurchase = normalized[normalized.length - 1].date;
    const levelExpiresAt = addMonths(lastPurchase, SIX_MONTHS);
    const inactive = now.getTime() >= levelExpiresAt.getTime();

    const activePurchases = inactive
        ? []
        : normalized.slice(cycleStart);

    const qualifyingPurchaseAmount = Math.round(
        activePurchases.reduce((sum, item) => sum + item.amount, 0) * 100
    ) / 100;

    let level = 'BRONZE';

    if (qualifyingPurchaseAmount >= 150000) {
        level = 'GOLD';
    } else if (qualifyingPurchaseAmount >= 50000) {
        level = 'SILVER';
    }

    const silverProgress = Math.min(50000, qualifyingPurchaseAmount);
    const goldProgress = Math.min(
        100000,
        Math.max(0, qualifyingPurchaseAmount - 50000)
    );

    let current = silverProgress;
    let target = 50000;
    let nextLevel = 'SILVER';

    if (level === 'SILVER') {
        current = goldProgress;
        target = 100000;
        nextLevel = 'GOLD';
    } else if (level === 'GOLD') {
        current = 100000;
        target = 100000;
        nextLevel = null;
    }

    return {
        level,
        totalPurchaseAmount,
        qualifyingPurchaseAmount,
        silverProgress,
        goldProgress,
        lastPurchaseAt: lastPurchase,
        qualificationStartedAt:
            activePurchases[0]?.date || null,
        inactive,
        expiresAt: levelExpiresAt,
        progress: {
            current,
            target,
            nextLevel,
            percent: target > 0
                ? Math.min(100, Math.round((current / target) * 10000) / 100)
                : 100
        },
        benefits: getLoyaltyBenefits(level)
    };
}

async function ensureLoyaltyTables() {
    if (tablesReadyPromise) {
        return tablesReadyPromise;
    }

    tablesReadyPromise = (async () => {
        const db = getPool();

        await db.execute(
            `CREATE TABLE IF NOT EXISTS loyalty_profiles (
                user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                loyalty_level VARCHAR(20) NOT NULL DEFAULT 'BRONZE',
                total_purchase_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
                qualifying_purchase_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
                silver_progress DECIMAL(14,2) NOT NULL DEFAULT 0,
                gold_progress DECIMAL(14,2) NOT NULL DEFAULT 0,
                available_coins INT UNSIGNED NOT NULL DEFAULT 0,
                qualification_started_at DATETIME NULL,
                last_purchase_at DATETIME NULL,
                level_expires_at DATETIME NULL,
                updated_at TIMESTAMP NOT NULL
                    DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_loyalty_level (loyalty_level),
                KEY idx_loyalty_last_purchase (last_purchase_at),
                KEY idx_loyalty_expires (level_expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );

        await db.execute(
            `CREATE TABLE IF NOT EXISTS coins_transactions (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT UNSIGNED NOT NULL,
                type VARCHAR(40) NOT NULL,
                amount INT NOT NULL,
                balance_after INT UNSIGNED NOT NULL DEFAULT 0,
                order_id VARCHAR(100) NULL,
                friend_user_id BIGINT UNSIGNED NULL,
                description VARCHAR(255) NULL,
                expires_at DATETIME NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_coins_user_created (user_id, created_at),
                KEY idx_coins_expires (status, expires_at),
                KEY idx_coins_order (order_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );

        await db.execute(
            `CREATE TABLE IF NOT EXISTS referral_rewards (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT UNSIGNED NOT NULL,
                friend_user_id BIGINT UNSIGNED NULL,
                friend_key VARCHAR(190) NULL,
                order_id VARCHAR(100) NULL,
                payment_id VARCHAR(100) NULL,
                reward_type VARCHAR(40) NOT NULL,
                percent DECIMAL(6,2) NOT NULL DEFAULT 0,
                amount INT UNSIGNED NOT NULL DEFAULT 0,
                dedupe_key VARCHAR(190) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
                UNIQUE KEY uq_referral_reward_dedupe (dedupe_key),
                KEY idx_referral_reward_user (user_id, created_at),
                KEY idx_referral_reward_friend (friend_user_id),
                KEY idx_referral_reward_payment (payment_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );

        // Совместимость с текущей боевой реферальной таблицей.
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
        tablesReadyPromise = null;
        throw error;
    });

    return tablesReadyPromise;
}

async function getAvailableCoins(userId, connection = null) {
    if (!userId) return 0;

    const db = connection || getPool();
    const [rows] = await db.execute(
        `SELECT COALESCE(balance, 0) AS balance
         FROM rhino_coin_accounts
         WHERE user_id = ?
         LIMIT 1`,
        [Number(userId)]
    );

    return Math.max(0, Number(rows?.[0]?.balance || 0));
}

async function upsertLoyaltyProfile(userId, snapshot) {
    if (!userId) return snapshot;

    await ensureLoyaltyTables();

    const db = getPool();
    const availableCoins = await getAvailableCoins(userId);

    await db.execute(
        `INSERT INTO loyalty_profiles
            (
                user_id,
                loyalty_level,
                total_purchase_amount,
                qualifying_purchase_amount,
                silver_progress,
                gold_progress,
                available_coins,
                qualification_started_at,
                last_purchase_at,
                level_expires_at
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            loyalty_level = VALUES(loyalty_level),
            total_purchase_amount = VALUES(total_purchase_amount),
            qualifying_purchase_amount = VALUES(qualifying_purchase_amount),
            silver_progress = VALUES(silver_progress),
            gold_progress = VALUES(gold_progress),
            available_coins = VALUES(available_coins),
            qualification_started_at = VALUES(qualification_started_at),
            last_purchase_at = VALUES(last_purchase_at),
            level_expires_at = VALUES(level_expires_at),
            updated_at = CURRENT_TIMESTAMP`,
        [
            Number(userId),
            normalizeLevel(snapshot?.level),
            toMoney(snapshot?.totalPurchaseAmount),
            toMoney(snapshot?.qualifyingPurchaseAmount),
            toMoney(snapshot?.silverProgress),
            toMoney(snapshot?.goldProgress),
            availableCoins,
            snapshot?.qualificationStartedAt || null,
            snapshot?.lastPurchaseAt || null,
            snapshot?.expiresAt || null
        ]
    );

    return {
        ...snapshot,
        availableCoins
    };
}

async function getCoinHistory(userId, limit = 50) {
    if (!userId) return [];

    await ensureLoyaltyTables();

    const db = getPool();
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const [rows] = await db.query(
        `SELECT
            id,
            type,
            amount,
            balance_after,
            order_id,
            friend_user_id,
            description,
            expires_at,
            status,
            created_at
         FROM coins_transactions
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT ${safeLimit}`,
        [Number(userId)]
    );

    return rows.map(row => ({
        id: String(row.id),
        type: String(row.type || ''),
        amount: Number(row.amount || 0),
        balanceAfter: Number(row.balance_after || 0),
        orderId: row.order_id ? String(row.order_id) : null,
        friendUserId: row.friend_user_id
            ? String(row.friend_user_id)
            : null,
        description: String(row.description || ''),
        expiresAt: row.expires_at || null,
        status: String(row.status || ''),
        createdAt: row.created_at || null
    }));
}

async function findFriendUser(connection, { email, phone }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedPhone = String(phone || '').trim();

    if (!normalizedEmail && !normalizedPhone) {
        return null;
    }

    const clauses = [];
    const params = [];

    if (normalizedEmail) {
        clauses.push('LOWER(email) = ?');
        params.push(normalizedEmail);
    }

    if (normalizedPhone) {
        clauses.push('phone = ?');
        params.push(normalizedPhone);
    }

    const [rows] = await connection.execute(
        `SELECT id, public_id, email, phone
         FROM users
         WHERE status = 'active'
           AND (${clauses.join(' OR ')})
         ORDER BY id ASC
         LIMIT 1`,
        params
    );

    return rows?.[0] || null;
}

async function awardReferralRewards({
    paymentId,
    dealId,
    referrerUserId,
    promoCode,
    orderAmount,
    level,
    friendEmail,
    friendPhone,
    friendKey
}) {
    await ensureLoyaltyTables();

    const cleanPaymentId = String(paymentId || '').trim();
    const cleanPromo = String(promoCode || '').trim().toUpperCase();
    const cleanDealId = String(dealId || '').trim();

    if (
        !cleanPaymentId ||
        !cleanDealId ||
        !referrerUserId ||
        toMoney(orderAmount) <= 0
    ) {
        return { ok: true, ignored: true, reason: 'invalid_input' };
    }

    const benefits = getLoyaltyBenefits(level);
    const orderReward = Math.max(
        1,
        Math.round(toMoney(orderAmount) * benefits.referralPercent / 100)
    );
    const db = getPool();
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [legacyInsert] = await connection.execute(
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
                cleanPaymentId,
                Number(dealId),
                Number(referrerUserId),
                cleanPromo,
                orderReward
            ]
        );

        if (Number(legacyInsert?.affectedRows || 0) === 0) {
            await connection.rollback();
            return {
                ok: true,
                ignored: true,
                reason: 'already_awarded',
                rewardCoins: 0,
                friendBonusCoins: 0,
                rewardPercent: benefits.referralPercent
            };
        }

        const friendUser = await findFriendUser(connection, {
            email: friendEmail,
            phone: friendPhone
        });

        const resolvedFriendKey = String(
            friendKey ||
            (friendUser?.id ? `user:${friendUser.id}` : '') ||
            [
                String(friendEmail || '').trim().toLowerCase(),
                String(friendPhone || '').trim()
            ].filter(Boolean).join('|')
        ).slice(0, 160);

        const expiresAt = addDays(new Date(), COIN_TTL_DAYS);
        const rewardRows = [];

        const orderDedupeKey = `payment:${cleanPaymentId}:percent`.slice(0, 190);
        const [orderInsert] = await connection.execute(
            `INSERT IGNORE INTO referral_rewards
                (
                    user_id,
                    friend_user_id,
                    friend_key,
                    order_id,
                    payment_id,
                    reward_type,
                    percent,
                    amount,
                    dedupe_key,
                    expires_at,
                    status
                )
             VALUES (?, ?, ?, ?, ?, 'FRIEND_ORDER_PERCENT', ?, ?, ?, ?, 'ACTIVE')`,
            [
                Number(referrerUserId),
                friendUser?.id || null,
                resolvedFriendKey || null,
                cleanDealId,
                cleanPaymentId,
                benefits.referralPercent,
                orderReward,
                orderDedupeKey,
                expiresAt
            ]
        );

        if (Number(orderInsert?.affectedRows || 0) > 0) {
            rewardRows.push({
                type: 'FRIEND_ORDER_REWARD',
                amount: orderReward,
                description:
                    `${benefits.referralPercent}% RhinoCoins с заказа друга #${cleanDealId}`
            });
        }

        let friendBonusCoins = 0;

        if (resolvedFriendKey && benefits.friendBonus > 0) {
            const friendDedupeKey =
                `friend:${Number(referrerUserId)}:${resolvedFriendKey}:bonus`
                    .slice(0, 190);

            const [friendInsert] = await connection.execute(
                `INSERT IGNORE INTO referral_rewards
                    (
                        user_id,
                        friend_user_id,
                        friend_key,
                        order_id,
                        payment_id,
                        reward_type,
                        percent,
                        amount,
                        dedupe_key,
                        expires_at,
                        status
                    )
                 VALUES (?, ?, ?, ?, ?, 'FRIEND_BONUS', 0, ?, ?, ?, 'ACTIVE')`,
                [
                    Number(referrerUserId),
                    friendUser?.id || null,
                    resolvedFriendKey,
                    cleanDealId,
                    cleanPaymentId,
                    benefits.friendBonus,
                    friendDedupeKey,
                    expiresAt
                ]
            );

            if (Number(friendInsert?.affectedRows || 0) > 0) {
                friendBonusCoins = benefits.friendBonus;
                rewardRows.push({
                    type: 'REFERRAL_BONUS',
                    amount: friendBonusCoins,
                    description:
                        `Бонус за активного друга · заказ #${cleanDealId}`
                });
            }
        }

        const totalAwarded = rewardRows.reduce(
            (sum, item) => sum + Number(item.amount || 0),
            0
        );

        if (totalAwarded > 0) {
            const startingBalance = await getAvailableCoins(
                referrerUserId,
                connection
            );

            await connection.execute(
                `INSERT INTO rhino_coin_accounts
                    (user_id, balance)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE
                    balance = COALESCE(balance, 0) + VALUES(balance)`,
                [Number(referrerUserId), totalAwarded]
            );

            let runningBalance = startingBalance;

            for (const reward of rewardRows) {
                runningBalance += Number(reward.amount || 0);

                await connection.execute(
                    `INSERT INTO coins_transactions
                        (
                            user_id,
                            type,
                            amount,
                            balance_after,
                            order_id,
                            friend_user_id,
                            description,
                            expires_at,
                            status
                        )
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
                    [
                        Number(referrerUserId),
                        reward.type,
                        Number(reward.amount || 0),
                        runningBalance,
                        cleanDealId,
                        friendUser?.id || null,
                        reward.description,
                        expiresAt
                    ]
                );
            }

            await connection.execute(
                `UPDATE loyalty_profiles
                 SET available_coins = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = ?`,
                [runningBalance, Number(referrerUserId)]
            );
        }

        await connection.commit();

        return {
            ok: true,
            ignored: false,
            rewardCoins: orderReward,
            friendBonusCoins,
            totalAwarded: orderReward + friendBonusCoins,
            rewardPercent: benefits.referralPercent,
            friendUserId: friendUser?.id || null,
            expiresAt
        };
    } catch (error) {
        try {
            await connection.rollback();
        } catch {}

        throw error;
    } finally {
        connection.release();
    }
}

async function expireCoins() {
    await ensureLoyaltyTables();

    const db = getPool();
    const [groups] = await db.execute(
        `SELECT
            user_id,
            COALESCE(SUM(amount), 0) AS expiring_amount
         FROM coins_transactions
         WHERE status = 'ACTIVE'
           AND amount > 0
           AND expires_at IS NOT NULL
           AND expires_at <= NOW()
         GROUP BY user_id`
    );

    let usersProcessed = 0;
    let totalExpired = 0;

    for (const group of groups) {
        const userId = Number(group.user_id);
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [accountRows] = await connection.execute(
                `SELECT COALESCE(balance, 0) AS balance
                 FROM rhino_coin_accounts
                 WHERE user_id = ?
                 FOR UPDATE`,
                [userId]
            );

            const balance = Math.max(
                0,
                Number(accountRows?.[0]?.balance || 0)
            );
            const requested = Math.max(
                0,
                Number(group.expiring_amount || 0)
            );
            const expiredAmount = Math.min(balance, requested);
            const newBalance = Math.max(0, balance - expiredAmount);

            await connection.execute(
                `UPDATE coins_transactions
                 SET status = 'EXPIRED'
                 WHERE user_id = ?
                   AND status = 'ACTIVE'
                   AND amount > 0
                   AND expires_at IS NOT NULL
                   AND expires_at <= NOW()`,
                [userId]
            );

            if (expiredAmount > 0) {
                await connection.execute(
                    `UPDATE rhino_coin_accounts
                     SET balance = ?
                     WHERE user_id = ?`,
                    [newBalance, userId]
                );

                await connection.execute(
                    `INSERT INTO coins_transactions
                        (
                            user_id,
                            type,
                            amount,
                            balance_after,
                            description,
                            status
                        )
                     VALUES (?, 'EXPIRED', ?, ?, 'Сгорание RhinoCoins через 180 дней', 'POSTED')`,
                    [userId, -expiredAmount, newBalance]
                );

                totalExpired += expiredAmount;
            }

            await connection.execute(
                `UPDATE loyalty_profiles
                 SET available_coins = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = ?`,
                [newBalance, userId]
            );

            await connection.commit();
            usersProcessed += 1;
        } catch (error) {
            try {
                await connection.rollback();
            } catch {}

            console.error(
                `RTN loyalty coin expiry error for user ${userId}:`,
                error.message
            );
        } finally {
            connection.release();
        }
    }

    return {
        usersProcessed,
        totalExpired
    };
}

async function downgradeInactiveProfiles() {
    await ensureLoyaltyTables();

    const db = getPool();
    const [result] = await db.execute(
        `UPDATE loyalty_profiles
         SET loyalty_level = 'BRONZE',
             qualifying_purchase_amount = 0,
             silver_progress = 0,
             gold_progress = 0,
             qualification_started_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE last_purchase_at IS NOT NULL
           AND DATE_ADD(last_purchase_at, INTERVAL 6 MONTH) <= NOW()
           AND (
                loyalty_level <> 'BRONZE'
                OR qualifying_purchase_amount <> 0
                OR silver_progress <> 0
                OR gold_progress <> 0
           )`
    );

    return Number(result?.affectedRows || 0);
}

async function runDailyLoyaltyMaintenance() {
    const [expired, downgraded] = await Promise.all([
        expireCoins(),
        downgradeInactiveProfiles()
    ]);

    console.log(
        `RTN loyalty maintenance: expired=${expired.totalExpired} RC / users=${expired.usersProcessed}, downgraded=${downgraded}`
    );

    return {
        expired,
        downgraded
    };
}

function startLoyaltyMaintenanceScheduler() {
    if (maintenanceTimer) {
        return maintenanceTimer;
    }

    const run = () => {
        runDailyLoyaltyMaintenance().catch(error => {
            console.error(
                'RTN loyalty maintenance error:',
                error.message
            );
        });
    };

    const firstRun = setTimeout(run, 25000);
    if (typeof firstRun.unref === 'function') {
        firstRun.unref();
    }

    maintenanceTimer = setInterval(
        run,
        24 * 60 * 60 * 1000
    );

    if (typeof maintenanceTimer.unref === 'function') {
        maintenanceTimer.unref();
    }

    return maintenanceTimer;
}

module.exports = {
    LEVEL_RULES,
    calculateLoyaltyFromPurchases,
    getLoyaltyBenefits,
    ensureLoyaltyTables,
    getAvailableCoins,
    upsertLoyaltyProfile,
    getCoinHistory,
    awardReferralRewards,
    expireCoins,
    downgradeInactiveProfiles,
    runDailyLoyaltyMaintenance,
    startLoyaltyMaintenanceScheduler
};
