const axios = require('axios');

const baseUrl =
    String(
        process.env.YCP_BASE_URL ||
        'https://rhino-api-yrfq.onrender.com'
    ).replace(/\/$/, '');

const token =
    String(
        process.env.YCP_ACCESS_TOKEN ||
        ''
    ).trim();

if (!token) {
    console.error(
        'Set YCP_ACCESS_TOKEN before test'
    );
    process.exit(1);
}

const headers = {
    Authorization:
        `Bearer ${token}`
};

async function main() {
    const warehouses =
        await axios.get(
            `${baseUrl}/api/v1/warehouses?limit=10&offset=0`,
            {
                headers,
                timeout:
                    20000
            }
        );

    console.log(
        'warehouses:',
        warehouses.status,
        warehouses.data
    );

    const basket =
        await axios.post(
            `${baseUrl}/api/v1/checkout/basket/check`,
            {
                items: [
                    {
                        id:
                            'whey-caramel',
                        quantity:
                            1
                    }
                ],
                offers_id_from_merchant_center:
                    true,
                locality:
                    'Москва',
                is_health_check:
                    true
            },
            {
                headers,
                timeout:
                    20000
            }
        );

    console.log(
        'basket:',
        basket.status,
        basket.data
    );
}

main().catch(error => {
    console.error(
        error.response?.status ||
        error.code ||
        'ERROR',
        error.response?.data ||
        error.message
    );

    process.exit(1);
});
