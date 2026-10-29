'use strict';

// RTN.PRO customer messages go to Bitrix24 Open Lines first. This module
// receives only post-send userMessage browser events and mirrors a copy
// into the existing, private RTN orders/1C Telegram chat.
const crypto = require('crypto');
const { getPool } = require('./db');

const ALLOWED_ORIGINS = new Set(
  String(process.env.RTN_CHAT_ALLOWED_ORIGINS || 'https://rtn.pro,https://www.rtn.pro')
    .split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean)
);
const WINDOW_MS = 10 * 60 * 1000;
const byIp = new Map();
let totalWindowStart = Date.now();
let totalInWindow = 0;
let initPromise = null;

function clean(value, limit) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim().slice(0, limit);
}

async function ensureTable() {
  if (!initPromise) {
    initPromise = (async () => {
      await getPool().query(
        'CREATE TABLE IF NOT EXISTS rtn_bitrix_chat_mirror (' +
        'event_hash CHAR(64) NOT NULL PRIMARY KEY, ' +
        'message_id VARCHAR(80) NOT NULL, session_id VARCHAR(80) NOT NULL, ' +
        'delivery VARCHAR(12) NOT NULL DEFAULT \'pending\', ' +
        'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
        'INDEX idx_mirror_created (created_at)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
      );
    })().catch(err => { initPromise = null; throw err; });
  }
  return initPromise;
}

function throttle(req, res, next) {
  const origin = String(req.get('origin') || '').replace(/\/$/, '');
  // A browser-origin check, not cryptographic proof of Bitrix's authorship.
  // Rate limits and single-delivery IDs also protect the Telegram group.
  if (!ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'Недопустимый источник' });
  }
  const now = Date.now();
  if (byIp.size > 3000) for (const [key, value] of byIp) {
    if (now - value.since > WINDOW_MS) byIp.delete(key);
  }
  if (now - totalWindowStart > WINDOW_MS) {
    totalWindowStart = now;
    totalInWindow = 0;
  }
  const ip = String(req.ip || req.socket?.remoteAddress || 'guest');
  const current = byIp.get(ip) || { since: now, count: 0 };
  if (now - current.since > WINDOW_MS) { current.since = now; current.count = 0; }
  current.count += 1;
  totalInWindow += 1;
  byIp.set(ip, current);
  if (current.count > 24 || totalInWindow > 300) {
    return res.status(429).json({ error: 'Слишком много сообщений' });
  }
  next();
}

function installSiteSupport(app, { sendMessage, chatConfigured }) {
  // Legacy bot is intentionally disabled. The React bubble opens Bitrix24.
  app.post('/api/support/chat', (_req, res) =>
    res.status(410).json({ error: 'Чат-помощник отключён. Используйте онлайн-чат Bitrix24.' })
  );
  app.post('/api/support/handoff', (_req, res) =>
    res.status(410).json({ error: 'Обращения направляются непосредственно в Bitrix24.' })
  );

  app.post('/api/support/bitrix-mirror', throttle, async (req, res) => {
    if (!chatConfigured) {
      return res.status(503).json({ error: 'Telegram-уведомления не настроены' });
    }
    const messageId = clean(req.body?.messageId, 80);
    const sessionId = clean(req.body?.sessionId, 80);
    const text = clean(req.body?.text, 3000);
    const page = clean(req.body?.page, 180);
    if (!/^\d{1,80}$/.test(messageId) ||
        (sessionId && !/^\d{1,80}$/.test(sessionId)) ||
        !text || text.length > 3000 ||
        (page && (!page.startsWith('/') || page.includes('://')))) {
      return res.status(400).json({ error: 'Некорректное событие Bitrix24' });
    }
    const hash = crypto.createHash('sha256').update(sessionId + ':' + messageId).digest('hex');

    try {
      await ensureTable();
      const db = getPool();
      // An identical Bitrix message must not be posted twice by page reloads.
      const [insert] = await db.execute(
        'INSERT IGNORE INTO rtn_bitrix_chat_mirror (event_hash, message_id, session_id) VALUES (?,?,?)',
        [hash, messageId, sessionId]
      );
      if (!insert.affectedRows) {
        return res.json({ ok: true, duplicate: true });
      }

      try {
        await sendMessage([
          '💬 RTN.PRO — СООБЩЕНИЕ В BITRIX24',
          '',
          'Сообщение: #' + messageId,
          ...(sessionId ? ['Сессия: ' + sessionId] : []),
          'Страница: ' + (page || '/'),
          '',
          text,
          '',
          'Ответьте клиенту в открытой линии Bitrix24 (Telegram — только копия).'
        ].join('\n'));
        await db.execute(
          "UPDATE rtn_bitrix_chat_mirror SET delivery='sent' WHERE event_hash=?",
          [hash]
        );
        return res.json({ ok: true, mirrored: true });
      } catch (telegramError) {
        await db.execute(
          "UPDATE rtn_bitrix_chat_mirror SET delivery='failed' WHERE event_hash=?",
          [hash]
        );
        console.error('Bitrix24 Telegram mirror delivery error:', clean(telegramError?.message, 140));
        return res.status(502).json({ error: 'Не удалось дублировать сообщение в Telegram' });
      }
    } catch (error) {
      console.error('Bitrix24 Telegram mirror error:', clean(error?.message, 140));
      return res.status(503).json({ error: 'Дублирование сообщений временно недоступно' });
    }
  });

  // Remove only event IDs, not actual chat content, on a rolling basis.
  const expire = () => {
    ensureTable().then(() =>
      getPool().query('DELETE FROM rtn_bitrix_chat_mirror WHERE created_at < DATE_SUB(NOW(), INTERVAL 14 DAY)')
    ).catch(error => console.error('Bitrix mirror retention error:', clean(error?.message, 140)));
  };
  setTimeout(expire, 40000).unref();
  setInterval(expire, 24 * 60 * 60 * 1000).unref();
}

module.exports = { installSiteSupport };
