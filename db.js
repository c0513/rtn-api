const mysql = require('mysql2/promise');

let pool = null;

function clean(value) {
    return String(value || '').trim();
}

function getDbConfig() {
    const host = clean(process.env.RTN_DB_HOST);
    const port = Number(process.env.RTN_DB_PORT || 3306);
    const database = clean(process.env.RTN_DB_NAME);
    const user = clean(process.env.RTN_DB_USER);
    const password = String(process.env.RTN_DB_PASSWORD || '');

    if (!host || !database || !user || !password) {
        throw new Error('RTN MySQL is not configured');
    }

    return {
        host,
        port,
        database,
        user,
        password,
        waitForConnections: true,
        connectionLimit: 8,
        queueLimit: 0,
        charset: 'utf8mb4',
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        connectTimeout: 10000
    };
}

function getPool() {
    if (!pool) {
        pool = mysql.createPool(getDbConfig());
    }

    return pool;
}

async function pingDatabase() {
    const db = getPool();
    const [rows] = await db.query('SELECT DATABASE() AS db, NOW() AS serverTime');

    return rows[0] || null;
}

module.exports = {
    getPool,
    pingDatabase
};
