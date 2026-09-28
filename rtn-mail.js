const nodemailer = require('nodemailer');

function clean(value) {
    return String(value || '').trim();
}

function getMailConfig() {
    const host = clean(process.env.RTN_SMTP_HOST);
    const port = Number(process.env.RTN_SMTP_PORT || 0);
    const secure = String(process.env.RTN_SMTP_SECURE || '').trim().toLowerCase() === 'true';
    const user = clean(process.env.RTN_SMTP_USER);
    const password = String(process.env.RTN_SMTP_PASSWORD || '');
    const from = clean(process.env.RTN_MAIL_FROM || user);

    return {
        configured: Boolean(host && port && user && password && from),
        host,
        port,
        secure,
        user,
        password,
        from
    };
}

let transporter = null;
let transporterKey = '';

function getTransporter() {
    const config = getMailConfig();

    if (!config.configured) {
        throw new Error('RTN SMTP is not configured');
    }

    const key = [
        config.host,
        config.port,
        config.secure,
        config.user,
        config.from
    ].join('|');

    if (!transporter || transporterKey !== key) {
        transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure,
            auth: {
                user: config.user,
                pass: config.password
            },
            pool: true,
            maxConnections: 3,
            maxMessages: 100,
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000
        });

        transporterKey = key;
    }

    return transporter;
}

function getMailStatus() {
    const config = getMailConfig();

    return {
        configured: config.configured,
        host: config.host || null,
        port: config.port || null,
        secure: config.secure,
        user: config.user || null,
        from: config.from || null
    };
}

async function verifyMailConnection() {
    const transport = getTransporter();
    await transport.verify();
    return getMailStatus();
}

async function sendVerificationCodeEmail({
    to,
    code,
    expiresMinutes = 10
}) {
    const config = getMailConfig();
    const transport = getTransporter();

    const recipient = clean(to).toLowerCase();
    const verificationCode = clean(code);

    if (!recipient || !verificationCode) {
        throw new Error('Email recipient and verification code are required');
    }

    const subject = 'RTN.PRO — код для входа';

    const text = [
        'RTN.PRO',
        '',
        'Код для входа:',
        verificationCode,
        '',
        `Аккаунт: ${recipient}`,
        'Уровень доступа: 99%',
        `Код действует ${expiresMinutes} минут.`,
        '',
        'Если вы не запрашивали вход, просто проигнорируйте письмо.'
    ].join('\n');

    const html = `<!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#050505;font-family:Arial,Helvetica,sans-serif;color:#fff;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#050505;padding:24px 12px;">
    <tr>
        <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#090909;border:1px solid #1b1f22;border-radius:18px;overflow:hidden;">
                <tr>
                    <td style="height:3px;background:linear-gradient(90deg,#A259FF 0%,#00F0FF 50%,#FF5E00 100%);font-size:0;line-height:0;">&nbsp;</td>
                </tr>

                <tr>
                    <td align="center" style="padding:30px 28px 18px;">
                        <img src="https://rtn.pro/images/logo-mail.png" alt="Rhino Tech Nutrition" width="205" style="display:block;width:205px;max-width:100%;height:auto;margin:0 auto;">
                    </td>
                </tr>

                <tr>
                    <td style="padding:0 28px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                            <tr>
                                <td style="border-top:1px solid rgba(0,240,255,.08);border-left:1px solid rgba(0,240,255,.08);height:22px;width:25%;"></td>
                                <td style="border-top:1px solid rgba(0,240,255,.08);border-left:1px solid rgba(0,240,255,.08);height:22px;width:25%;"></td>
                                <td style="border-top:1px solid rgba(0,240,255,.08);border-left:1px solid rgba(0,240,255,.08);height:22px;width:25%;"></td>
                                <td style="border-top:1px solid rgba(0,240,255,.08);border-left:1px solid rgba(0,240,255,.08);border-right:1px solid rgba(0,240,255,.08);height:22px;width:25%;"></td>
                            </tr>
                        </table>
                    </td>
                </tr>

                <tr>
                    <td align="center" style="padding:6px 28px 0;">
                        <div style="font-family:'Courier New',monospace;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#00F0FF;">АВТОРИЗАЦИЯ</div>
                        <div style="margin-top:16px;display:inline-block;padding:18px 24px;border:1px solid #20343a;border-radius:14px;background:#0b0f11;font-family:'Courier New',monospace;font-size:44px;line-height:1;font-weight:700;letter-spacing:8px;color:#fff;box-shadow:0 0 18px rgba(0,240,255,.08);">
                            ${verificationCode}
                        </div>
                    </td>
                </tr>

                <tr>
                    <td style="padding:22px 28px 0;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                                <td align="left" style="font-family:'Courier New',monospace;font-size:12px;letter-spacing:1px;color:rgba(0,240,255,.55);">УРОВЕНЬ ДОСТУПА</td>
                                <td align="right" style="font-family:'Courier New',monospace;font-size:12px;font-weight:700;color:#00F0FF;">99%</td>
                            </tr>
                        </table>

                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:9px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden;">
                            <tr>
                                <td width="99%" style="height:8px;background:linear-gradient(90deg,#A259FF 0%,#00F0FF 50%,#FF5E00 100%);box-shadow:0 0 12px rgba(0,240,255,.6);font-size:0;line-height:0;">&nbsp;</td>
                                <td width="1%" style="height:8px;background:rgba(255,255,255,.06);font-size:0;line-height:0;">&nbsp;</td>
                            </tr>
                        </table>

                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:5px;">
                            <tr>
                                <td align="left" style="font-family:'Courier New',monospace;font-size:10px;color:rgba(0,240,255,.35);">0%</td>
                                <td align="center" style="font-family:'Courier New',monospace;font-size:10px;color:rgba(0,240,255,.35);">25%</td>
                                <td align="center" style="font-family:'Courier New',monospace;font-size:10px;color:rgba(0,240,255,.35);">50%</td>
                                <td align="center" style="font-family:'Courier New',monospace;font-size:10px;color:rgba(0,240,255,.35);">75%</td>
                                <td align="right" style="font-family:'Courier New',monospace;font-size:10px;color:rgba(0,240,255,.35);">100%</td>
                            </tr>
                        </table>
                    </td>
                </tr>

                <tr>
                    <td align="center" style="padding:20px 28px 0;">
                        <div style="font-size:13px;line-height:1.7;color:#a8a8a8;">Вход для</div>
                        <div style="font-size:15px;line-height:1.6;color:#fff;font-weight:700;">${recipient}</div>
                        <div style="margin-top:12px;font-size:12px;color:#747474;">Код действует ${expiresMinutes} минут</div>
                    </td>
                </tr>

                <tr>
                    <td style="padding:20px 28px 0;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                            <tr>
                                <td style="border-bottom:1px solid rgba(0,240,255,.08);border-left:1px solid rgba(0,240,255,.08);height:22px;width:25%;"></td>
                                <td style="border-bottom:1px solid rgba(0,240,255,.08);border-left:1px solid rgba(0,240,255,.08);height:22px;width:25%;"></td>
                                <td style="border-bottom:1px solid rgba(0,240,255,.08);border-left:1px solid rgba(0,240,255,.08);height:22px;width:25%;"></td>
                                <td style="border-bottom:1px solid rgba(0,240,255,.08);border-left:1px solid rgba(0,240,255,.08);border-right:1px solid rgba(0,240,255,.08);height:22px;width:25%;"></td>
                            </tr>
                        </table>
                    </td>
                </tr>

                <tr>
                    <td align="center" style="padding:16px 28px 28px;">
                        <div style="font-size:11px;line-height:1.7;color:#5f5f5f;">Если вы не запрашивали вход, просто проигнорируйте письмо.</div>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
</body>
</html>`;

    const result = await transport.sendMail({
        from: `RTN.PRO <${config.from}>`,
        to: recipient,
        subject,
        text,
        html
    });

    return {
        messageId: result.messageId || null,
        accepted: Array.isArray(result.accepted) ? result.accepted : [],
        rejected: Array.isArray(result.rejected) ? result.rejected : []
    };
}

module.exports = {
    getMailStatus,
    verifyMailConnection,
    sendVerificationCodeEmail
};
