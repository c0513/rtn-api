const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP_ID = process.env.SHOP_ID || '1403586';
const SECRET_KEY = process.env.SECRET_KEY;
const CDEK_ACCOUNT = process.env.CDEK_ACCOUNT;
const CDEK_SECRET = process.env.CDEK_SECRET;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ============================================================
// 1. ПОИСК ГОРОДОВ (с фильтрацией по названию)
// ============================================================
app.post('/api/search-cities', async (req, res) => {
    console.log('🔍 Поиск городов para:', req.body.query);

    try {
        const query = req.body.query;

        if (!query || query.length < 2) {
            return res.json({ cities: [] });
        }

        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        const tokenResponse = await axios.post(
            'https://api.cdek.ru/v2/oauth/token',
            {
                grant_type: 'client_credentials',
                client_id: CDEK_ACCOUNT,
                client_secret: CDEK_SECRET
            }
        );

        const accessToken = tokenResponse.data.access_token;
        console.log('✅ Токен получен');

        const cityResponse = await axios.get(
            'https://api.cdek.ru/v2/location/cities',
            {
                params: {
                    country_codes: 'RU',
                    q: query,
                    limit: 50
                },
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        console.log('📦 Ответ от СДЭК:', cityResponse.data ? cityResponse.data.length : 0, 'записей');

        const queryLower = query.toLowerCase();
        const cities = [];

        if (cityResponse.data && cityResponse.data.length > 0) {
            for (let i = 0; i < cityResponse.data.length; i++) {
                const city = cityResponse.data[i];
                const cityName = city.city || city.name || '';
                const cityNameLower = cityName.toLowerCase();

                const startsWithQuery = cityNameLower.startsWith(queryLower);
                const containsAsWord = cityNameLower.includes(queryLower) && 
                                       (cityNameLower.length === queryLower.length || 
                                        cityNameLower[queryLower.length] === ' ' ||
                                        cityNameLower[queryLower.length] === '-' ||
                                        cityNameLower[queryLower.length] === '(');
                const isExactMatch = cityNameLower === queryLower;

                if (startsWithQuery || containsAsWord || isExactMatch) {
                    cities.push({
                        code: city.code || 0,
                        name: cityName,
                        postalCode: city.postal_code || '',
                        region: city.region || '',
                        isExact: isExactMatch,
                        isStartsWith: startsWithQuery
                    });
                }
            }

            cities.sort((a, b) => {
                if (a.isExact && !b.isExact) return -1;
                if (!a.isExact && b.isExact) return 1;
                if (a.isStartsWith && !b.isStartsWith) return -1;
                if (!a.isStartsWith && b.isStartsWith) return 1;
                return a.name.localeCompare(b.name);
            });

            const uniqueCities = [];
            const seenNames = new Set();
            for (let i = 0; i < cities.length; i++) {
                const city = cities[i];
                if (!seenNames.has(city.name)) {
                    seenNames.add(city.name);
                    uniqueCities.push(city);
                }
                if (uniqueCities.length >= 15) break;
            }

            console.log('✅ Найдено городов после фильтрации:', uniqueCities.length);
            res.json({ cities: uniqueCities });
        } else {
            console.log('ℹ️ Города не найдены');
            res.json({ cities: [] });
        }

    } catch (error) {
        console.error('❌ Ошибка в /api/search-cities:');
        if (error.response) {
            console.error('Статус:', error.response.status);
            console.error('Данные:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Ошибка:', error.message);
        }

        res.status(500).json({
            error: 'Ошибка поиска городов',
            details: error.message || 'Неизвестная ошибка'
        });
    }
});

// ============================================================
// 2. РАСЧЁТ ДОСТАВКИ СДЭК (с реальными тарифами)
// ============================================================
app.post('/api/calculate-delivery', async (req, res) => {
    console.log('📦 Расчёт доставки для города:', req.body);

    try {
        const { cityCode, postalCode, cityName } = req.body;

        if (!cityCode) {
            return res.status(400).json({ error: 'Не передан код города' });
        }

        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        const tokenResponse = await axios.post(
            'https://api.cdek.ru/v2/oauth/token',
            {
                grant_type: 'client_credentials',
                client_id: CDEK_ACCOUNT,
                client_secret: CDEK_SECRET
            }
        );

        const accessToken = tokenResponse.data.access_token;

        const packageWeight = 500;
        const packageLength = 400;
        const packageWidth = 400;
        const packageHeight = 200;

        const tariffs = [3, 137, 139];
        let lastError = null;

        for (const tariffCode of tariffs) {
            try {
                console.log(`🔍 Пробуем тариф ${tariffCode}...`);
                
                const tariffResponse = await axios.post(
                    'https://api.cdek.ru/v2/calculator/tariff',
                    {
                        tariff_code: tariffCode,
                        from_location: {
                            code: 270,
                            postal_code: '196608'
                        },
                        to_location: {
                            code: cityCode,
                            postal_code: postalCode || undefined
                        },
                        packages: [{
                            weight: packageWeight,
                            length: packageLength,
                            width: packageWidth,
                            height: packageHeight
                        }]
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${accessToken}`
                        }
                    }
                );

                console.log(`✅ Тариф ${tariffCode} работает! Стоимость: ${tariffResponse.data.total_sum} ₽`);
                
                return res.json({
                    deliveryPrice: tariffResponse.data.total_sum,
                    deliveryTime: tariffResponse.data.delivery_time || null,
                    city: cityName || 'Город',
                    currency: 'RUB'
                });

            } catch (error) {
                console.log(`❌ Тариф ${tariffCode} не подходит`);
                lastError = error;
            }
        }

        console.log('⚠️ Все тарифы недоступны. Используем фиксированную стоимость');
        return res.json({
            deliveryPrice: 500,
            deliveryTime: 3,
            city: cityName || 'Город',
            currency: 'RUB',
            isFallback: true
        });

    } catch (error) {
        console.error('❌ Ошибка расчёта доставки:', error.response?.data || error.message);
        res.json({
            deliveryPrice: 500,
            deliveryTime: 3,
            city: req.body.cityName || 'Город',
            currency: 'RUB',
            isFallback: true
        });
    }
});

// ============================================================
// 3. ПОЛУЧЕНИЕ ПВЗ СДЭК
// ============================================================
app.post('/api/get-pickup-points', async (req, res) => {
    console.log('📍 Получение ПВЗ para города:', req.body.cityCode);

    try {
        const { cityCode } = req.body;

        if (!cityCode) {
            return res.status(400).json({ error: 'Не передан код города' });
        }

        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        const tokenResponse = await axios.post(
            'https://api.cdek.ru/v2/oauth/token',
            {
                grant_type: 'client_credentials',
                client_id: CDEK_ACCOUNT,
                client_secret: CDEK_SECRET
            }
        );

        const accessToken = tokenResponse.data.access_token;

        const pickupResponse = await axios.get(
            'https://api.cdek.ru/v2/deliverypoints',
            {
                params: {
                    city_code: cityCode,
                    type: 'PVZ',
                    have_cashless: true,
                    have_cash: true,
                    allow_mark: true
                },
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        console.log(`✅ Найдено ПВЗ: ${pickupResponse.data.length}`);

        const points = pickupResponse.data.map(point => ({
            code: point.code,
            name: point.name,
            address: point.address,
            city: point.city,
            workTime: point.work_time,
            phone: point.phone,
            lat: point.coord_lat,
            lon: point.coord_long,
            nearestStation: point.nearest_station,
            metroStation: point.metro_station,
            weightLimit: point.weight_limit,
            dimensions: point.dimensions
        }));

        res.json({ points });

    } catch (error) {
        console.error('❌ Ошибка получения ПВЗ:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка получения пунктов выдачи',
            details: error.response?.data || error.message
        });
    }
});

// ============================================================
// 4. СОЗДАНИЕ ПЛАТЕЖА (ЮKASSA)
// ============================================================
app.post('/api/create-payment', async (req, res) => {
    console.log('💳 Создание платежа');

    try {
        const { amount, description, orderId, items, customer, delivery } = req.body;

        if (!amount) {
            return res.status(400).json({ error: 'amount обязателен' });
        }

        if (!SECRET_KEY) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        const idempotenceKey = Date.now() + '_' + Math.random().toString(36).substring(2, 8);

        const receiptItems = (items || []).map(item => ({
            description: item.name + ' (' + (item.flavor || 'стандарт') + ')',
            quantity: item.quantity || 1,
            amount: {
                value: ((item.price || 0) * (item.quantity || 1)).toFixed(2),
                currency: 'RUB'
            },
            vat_code: 1,
            payment_mode: 'full_payment',
            payment_subject: 'commodity'
        }));

        if (delivery && delivery.price) {
            receiptItems.push({
                description: 'Доставка (' + (delivery.method || 'СДЭК') + ')',
                quantity: 1,
                amount: {
                    value: delivery.price.toFixed(2),
                    currency: 'RUB'
                },
                vat_code: 1,
                payment_mode: 'full_payment',
                payment_subject: 'service'
            });
        }

        const paymentResponse = await axios.post(
            'https://api.yookassa.ru/v3/payments',
            {
                amount: {
                    value: String(amount),
                    currency: 'RUB'
                },
                payment_method_data: {
                    type: 'bank_card'
                },
                confirmation: {
                    type: 'redirect',
                    return_url: 'https://rtn.pro/after-payment'
                },
                description: description || ('Заказ ' + (orderId || Date.now())),
                metadata: {
                    orderId: orderId || Date.now().toString(),
                    customerName: customer?.name || '',
                    customerPhone: customer?.phone || ''
                },
                capture: true,
                receipt: {
                    customer: {
                        email: customer?.email || 'customer@example.com',
                        phone: customer?.phone || ''
                    },
                    items: receiptItems
                }
            },
            {
                auth: {
                    username: SHOP_ID,
                    password: SECRET_KEY
                },
                headers: {
                    'Idempotence-Key': idempotenceKey
                }
            }
        );

        res.json(paymentResponse.data);

    } catch (error) {
        console.error('❌ Ошибка платежа:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка создания платежа',
            details: error.response?.data || error.message
        });
    }
});

// ============================================================
// 5. HEALTH CHECK
// ============================================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`✅ Health: https://rhino-api-yrfq.onrender.com/api/health`);
});