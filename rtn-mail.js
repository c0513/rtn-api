const { recordAccepted } = require('./rtn-email-crm');

function clean(value) {
    return String(value || '').trim();
}

function getRelayConfig() {
    const url = clean(process.env.RTN_MAILER_URL);
    const apiKey = clean(process.env.RTN_MAILER_API_KEY);

    return {
        configured: Boolean(url && apiKey),
        url,
        apiKey
    };
}

function getMailStatus() {
    const config = getRelayConfig();

    return {
        configured: config.configured,
        transport: 'https-relay',
        relayUrl: config.url || null
    };
}

async function relayRequest(body, timeoutMs = 15000, endpointUrl = null) {
    const config = getRelayConfig();

    if (!config.configured) {
        const error = new Error('RTN mail relay is not configured');
        error.code = 'RTN_MAILER_NOT_CONFIGURED';
        throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(endpointUrl || config.url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        const raw = await response.text();

        let data = null;

        try {
            data = raw ? JSON.parse(raw) : {};
        } catch {
            data = {
                raw: raw.slice(0, 500)
            };
        }

        return {
            ok: response.ok,
            status: response.status,
            data
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeoutError = new Error('RTN mail relay request timed out');
            timeoutError.code = 'RTN_MAILER_TIMEOUT';
            throw timeoutError;
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function verifyMailConnection() {
    const result = await relayRequest({});

    if (result.status === 401 || result.status === 403) {
        const error = new Error('RTN mail relay authentication failed');
        error.code = 'RTN_MAILER_AUTH_FAILED';
        error.responseCode = result.status;
        throw error;
    }

    if (result.status === 404) {
        const error = new Error('RTN mail relay endpoint not found');
        error.code = 'RTN_MAILER_NOT_FOUND';
        error.responseCode = result.status;
        throw error;
    }

    if (result.status !== 400) {
        const error = new Error(
            `Unexpected RTN mail relay response: HTTP ${result.status}`
        );

        error.code = 'RTN_MAILER_UNEXPECTED_RESPONSE';
        error.responseCode = result.status;
        throw error;
    }

    return getMailStatus();
}

async function sendVerificationCodeEmail({
    to,
    code,
    expiresMinutes = 10
}) {
    const recipient = clean(to).toLowerCase();
    const verificationCode = clean(code);

    if (!recipient || !verificationCode) {
        throw new Error(
            'Email recipient and verification code are required'
        );
    }

    const result = await relayRequest({
        to: recipient,
        code: verificationCode,
        expiresMinutes
    });

    if (!result.ok) {
        const message =
            result.data?.error ||
            result.data?.message ||
            `RTN mail relay returned HTTP ${result.status}`;

        const error = new Error(message);

        error.code = `RTN_MAILER_HTTP_${result.status}`;
        error.responseCode = result.status;

        throw error;
    }

    recordAccepted({to:recipient,subject:'RTN.PRO — код для входа',messageId:result.data?.messageId,eventType:'authorization'}).catch(e=>console.error('RTN CRM mail audit:',e.message));

    return {
        messageId: result.data?.messageId || null,
        accepted: [recipient],
        rejected: []
    };
}

// The existing authenticated ushna.ru relay supports both verification
// codes and transactional / opt-in marketing emails. We derive the new
// endpoint from the configured relay URL, so credentials stay on the mail
// server and never have to be copied into Render.
function getMarketingMailerUrl() {
    const { url, configured } = getRelayConfig();
    if (!configured) return '';
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' ||
            !/\/send-verification-code\/?$/.test(parsed.pathname)) {
            return '';
        }
        parsed.pathname = parsed.pathname.replace(
            /\/send-verification-code\/?$/,
            '/send-email'
        );
        return parsed.toString();
    } catch {
        return '';
    }
}

function getMarketingMailStatus() {
    return {
        configured: Boolean(getMarketingMailerUrl()),
        transport: 'https-relay'
    };
}

async function sendMarketingEmail({ to, subject, text, html, eventType = 'other' }) {
    const endpoint = getMarketingMailerUrl();
    if (!endpoint) {
        const error = new Error('Marketing mail relay is not configured');
        error.code = 'RTN_MARKETING_RELAY_NOT_CONFIGURED';
        throw error;
    }

    const address = clean(to).toLowerCase();
    const title = clean(subject);
    const htmlBody = String(html || '');
    const plain = String(text || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ||
        title.length < 3 || title.length > 160 ||
        !htmlBody || htmlBody.length > 85000 ||
        plain.length > 15000) {
        const error = new Error('Invalid marketing email payload');
        error.code = 'RTN_MARKETING_INVALID_EMAIL';
        throw error;
    }

    const result = await relayRequest({
        to: address, subject: title, text: plain, html: htmlBody
    }, 15000, endpoint);

    if (!result.ok) {
        const error = new Error(
            result.data?.error ||
            result.data?.message ||
            'Marketing mail relay returned HTTP ' + result.status
        );
        error.code = 'RTN_MARKETING_RELAY_HTTP_' + result.status;
        throw error;
    }

    recordAccepted({to:address,subject:title,messageId:result.data?.messageId,eventType}).catch(e=>console.error('RTN CRM mail audit:',e.message));

    return {
        messageId: result.data?.messageId || null,
        accepted: Array.isArray(result.data?.accepted)
            ? result.data.accepted : [address],
        rejected: Array.isArray(result.data?.rejected)
            ? result.data.rejected : []
    };
}

module.exports = {
    getMailStatus,
    getMarketingMailStatus,
    verifyMailConnection,
    sendVerificationCodeEmail,
    sendMarketingEmail
};
