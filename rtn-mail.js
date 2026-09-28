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

async function relayRequest(body, timeoutMs = 15000) {
    const config = getRelayConfig();

    if (!config.configured) {
        const error = new Error('RTN mail relay is not configured');
        error.code = 'RTN_MAILER_NOT_CONFIGURED';
        throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(config.url, {
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

    return {
        messageId: result.data?.messageId || null,
        accepted: [recipient],
        rejected: []
    };
}

module.exports = {
    getMailStatus,
    verifyMailConnection,
    sendVerificationCodeEmail
};
