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

    const subject = 'Код входа в RTN.PRO';

    const text = [
        'RTN.PRO',
        '',
        'КОД ПОДТВЕРЖДЕНИЯ',
        '',
        verificationCode,
        '',
        `Код действует ${expiresMinutes} минут.`,
        'Если вы не запрашивали код, просто проигнорируйте это письмо.'
    ].join('\n');

    const html = `
<!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${subject}</title>
</head>
<body style="margin:0;background:#050505;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#050505;padding:32px 16px;">
        <tr>
            <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#0b0b0b;border:1px solid #242424;border-radius:16px;overflow:hidden;">
                    <tr>
                        <td style="padding:32px;">
                            <div style="font-size:24px;font-weight:800;letter-spacing:.08em;">RTN.PRO</div>
                            <div style="margin-top:28px;font-size:12px;color:#8d8d8d;letter-spacing:.14em;text-transform:uppercase;">Код подтверждения</div>
                            <div style="margin-top:14px;font-size:42px;line-height:1;font-weight:800;letter-spacing:.16em;">${verificationCode}</div>
                            <div style="margin-top:28px;font-size:15px;line-height:1.6;color:#c7c7c7;">
                                Код действует ${expiresMinutes} минут.<br>
                                Если вы не запрашивали код, просто проигнорируйте это письмо.
                            </div>
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
