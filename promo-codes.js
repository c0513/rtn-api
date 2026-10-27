// Central, persistent RTN.PRO discount codes. MySQL is the source of truth for checkout.
const { getPool } = require('./db');

const RETIRED_CODES = new Set(['TRUVOR8814', 'TRUVER8814']);
const INITIAL_CODES = Object.freeze({
  RTN2026: 5,
  RHINO: 10,
  BIGGY: 10,
  BATR: 10,
  DOC: 10,
  TOPLIVO10: 10,
  LION: 10,
  PANTERA: 10,
  VEPR: 10,
  SJ10: 10,
  TRUVOR828: 10,
  PANDA: 10,
  MOON10: 10,
  OVS: 10,
  ZAVARKA10: 10
});

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}
function validateCode(code) {
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
    const error = new Error('Код: 2–40 латинских букв, цифр, - или _');
    error.status = 400;
    throw error;
  }
  if (RETIRED_CODES.has(code)) {
    const error = new Error('Этот промокод закрыт и не может быть активирован');
    error.status = 409;
    throw error;
  }
}
let initPromise = null;
async function ensurePromoTable() {
  if (!initPromise) {
    initPromise = (async () => {
      const db = getPool();
      await db.query(`CREATE TABLE IF NOT EXISTS rtn_promo_codes (
        code VARCHAR(40) NOT NULL PRIMARY KEY,
        discount_percent DECIMAL(5,2) NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      const codes = Object.entries(INITIAL_CODES);
      await db.query(
        `INSERT IGNORE INTO rtn_promo_codes (code, discount_percent, active) VALUES ${codes.map(() => '(?,?,1)').join(',')}`,
        codes.flatMap(([code, percent]) => [code, percent])
      );
      // Never restore these retired spelling variants, including from old DB rows.
      await db.query(
        "UPDATE rtn_promo_codes SET active=0 WHERE code IN ('TRUVOR8814','TRUVER8814')"
      );
    })().catch(error => {
      initPromise = null; // allow retry after a transient database outage
      throw error;
    });
  }
  await initPromise;
}
function formatRow(row) {
  if (!row) return null;
  return {
    code: row.code,
    discountPercent: Number(row.discount_percent),
    active: Boolean(row.active)
  };
}
async function getPromo(code) {
  const normalized = normalizeCode(code);
  if (!normalized || normalized.length > 40) return null;
  if (RETIRED_CODES.has(normalized)) {
    return { code: normalized, discountPercent: 0, active: false };
  }
  await ensurePromoTable();
  const [rows] = await getPool().execute(
    'SELECT code, discount_percent, active FROM rtn_promo_codes WHERE code=? LIMIT 1',
    [normalized]
  );
  return formatRow(rows[0]);
}
async function listPromos() {
  await ensurePromoTable();
  const [rows] = await getPool().query(
    'SELECT code, discount_percent, active FROM rtn_promo_codes ORDER BY code ASC'
  );
  return rows.map(formatRow);
}
async function savePromo(code, percent, active = true) {
  const normalized = normalizeCode(code);
  validateCode(normalized);
  const value = Number(percent);
  if (!Number.isFinite(value) || value <= 0 || value > 100 || Math.round(value * 100) !== value * 100) {
    const error = new Error('Скидка должна быть от 0,01 до 100% с точностью до сотых');
    error.status = 400;
    throw error;
  }
  await ensurePromoTable();
  await getPool().execute(
    `INSERT INTO rtn_promo_codes (code, discount_percent, active) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE discount_percent=VALUES(discount_percent), active=VALUES(active)`,
    [normalized, value, active ? 1 : 0]
  );
  return getPromo(normalized);
}
async function disablePromo(code) {
  const normalized = normalizeCode(code);
  if (!/^[A-Z0-9_-]{2,40}$/.test(normalized)) {
    const error = new Error('Некорректный промокод');
    error.status = 400;
    throw error;
  }
  await ensurePromoTable();
  await getPool().execute(
    `INSERT INTO rtn_promo_codes (code, discount_percent, active) VALUES (?,0,0)
     ON DUPLICATE KEY UPDATE active=0`,
    [normalized]
  );
  return getPromo(normalized);
}
module.exports = { getPromo, listPromos, savePromo, disablePromo, normalizeCode, RETIRED_CODES };
