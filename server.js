const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ---
const SHOP_ID = process.env.SHOP_ID || '1403586';
const SECRET_KEY = process.env.SECRET_KEY;
const CDEK_ACCOUNT = process.env.CDEK_ACCOUNT;
const CDEK_SECRET = process.env.CDEK_SECRET;

if (!SECRET_KEY) console.error('❌ SECRET_KEY не задан!');
if (!CDEK_ACCOUNT || !CDEK_SECRET) console.error('❌ Данные СДЭК не заданы!');

app.use(cors());
app.use(express.json());

// --- ЛОГИРОВАНИЕ ---
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ============================================================
// 1. ПОИСК ГОРОДОВ СДЭК
// ============================================================
app.post('/api/search-cities', async (req, res) => {
    console.log('\n🔍 ===== ПОИСК ГОРОДОВ =====');
    console.log('📥 Запрос:', req.body);

    try {
        const { query } = req.body;

        if (!query || query.length < 2) {
            return res.status(400).json({ error: 'Введите минимум 2 символа' });
        }

        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        // Получаем токен СДЭК
        const tokenResponse = await axios.post(
            'https://api.cdek.ru/v2/oauth/token',
            {
                grant_type: 'client_credentials',
                client_id: CDEK_ACCOUNT,
                client_secret: CDEK_SECRET
            }
        );

        const accessToken = tokenResponse.data.access_token;

        // Ищем города
        const cityResponse = await axios.get(
            'https://api.cdek.ru/v2/location/cities',
            {
                params: {
                    country_codes: 'RU',
                    q: query,
                    limit: 10
                },
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        const cities = cityResponse.data.map(function(city) {
            return {
                code: city.code,
                name: city.name,
                postalCode: city.postal_code,
                region: city.region,
                country: city.country_name
            };
        });

        console.log('✅ Найдено городов:', cities.length);
        res.json({ cities });

    } catch (error) {
        console.error('❌ Ошибка поиска городов:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка поиска городов',
            details: error.response?.data || error.message
        });
    }
});

// ============================================================
// 2. РАСЧЁТ ДОСТАВКИ СДЭК
// ============================================================
app.post('/api/calculate-delivery', async (req, res) => {
    console.log('\n📦 ===== РАСЧЁТ ДОСТАВКИ =====');
    console.log('📥 Данные:', req.body);

    try {
        const { cityCode, postalCode, cityName } = req.body;

        if (!cityCode) {
            return res.status(400).json({ error: 'Не передан код города' });
        }

        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        // Получаем токен
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

        // Параметры посылки
        const packageWeight = 500;
        const packageLength = 400;
        const packageWidth = 400;
        const packageHeight = 200;

        // Пробуем несколько тарифов
        const tariffs = [3, 137, 139];

        for (let i = 0; i < tariffs.length; i++) {
            const tariffCode = tariffs[i];
            console.log(`🔍 Пробуем тариф ${tariffCode}...`);

            try {
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
                            'Authorization': 'Bearer ' + accessToken
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
            }
        }

        console.error('❌ Все тарифы недоступны');
        return res.status(404).json({
            error: 'Доставка в этот город недоступна'
        });

    } catch (error) {
        console.error('❌ Ошибка расчёта:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка расчёта доставки',
            details: error.response?.data || error.message
        });
    }
});

// ============================================================
// 3. ПОЛУЧЕНИЕ СПИСКА ПВЗ СДЭК
// ============================================================
app.post('/api/get-pickup-points', async (req, res) => {
    console.log('\n📍 ===== ПОЛУЧЕНИЕ ПВЗ СДЭК =====');
    console.log('📥 Запрос:', req.body);

    try {
        const { cityCode } = req.body;

        if (!cityCode) {
            return res.status(400).json({ error: 'Не передан код города' });
        }

        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        // Получаем токен
        const tokenResponse = await axios.post(
            'https://api.cdek.ru/v2/oauth/token',
            {
                grant_type: 'client_credentials',
                client_id: CDEK_ACCOUNT,
                client_secret: CDEK_SECRET
            }
        );

        const accessToken = tokenResponse.data.access_token;

        // Получаем список ПВЗ
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
                    'Authorization': 'Bearer ' + accessToken
                }
            }
        );

        console.log(`✅ Найдено ПВЗ: ${pickupResponse.data.length}`);

        const points = pickupResponse.data.map(function(point) {
            return {
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
            };
        });

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
    console.log('\n🔵 ===== НОВЫЙ ПЛАТЁЖ =====');
    console.log('📥 Данные:', JSON.stringify(req.body, null, 2));

    try {
        const { amount, description, orderId, items, customer, delivery } = req.body;

        if (!amount) {
            return res.status(400).json({ error: 'amount обязателен' });
        }

        if (!SECRET_KEY) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        const idempotenceKey = orderId + '_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

        var receiptItems = [];
        if (Array.isArray(items)) {
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                receiptItems.push({
                    description: item.name + ' (' + (item.flavor || 'стандарт') + ')',
                    quantity: item.quantity || 1,
                    amount: {
                        value: ((item.price || 0) * (item.quantity || 1)).toFixed(2),
                        currency: 'RUB'
                    },
                    vat_code: 1,
                    payment_mode: 'full_payment',
                    payment_subject: 'commodity'
                });
            }
        }

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

        var paymentData = {
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
                customerPhone: customer?.phone || '',
                delivery: delivery?.method || ''
            },
            capture: true,
            receipt: {
                customer: {
                    email: customer?.email || 'customer@example.com',
                    phone: customer?.phone || ''
                },
                items: receiptItems
            }
        };

        var response = await axios.post(
            'https://api.yookassa.ru/v3/payments',
            paymentData,
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

        console.log('✅ Платёж создан! ID:', response.data.id);
        res.json(response.data);

    } catch (error) {
        console.error('❌ Ошибка:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка создания платежа',
            details: error.response?.data || error.message
        });
    }
});

// ============================================================
// 5. ПРОВЕРКА ПЛАТЕЖА
// ============================================================
app.get('/api/check-payment', async (req, res) => {
    try {
        var paymentId = req.query.paymentId;
        if (!paymentId) {
            return res.status(400).json({ error: 'paymentId не указан' });
        }

        var response = await axios.get(
            'https://api.yookassa.ru/v3/payments/' + paymentId,
            {
                auth: {
                    username: SHOP_ID,
                    password: SECRET_KEY
                }
            }
        );

        res.json({
            status: response.data.status,
            paid: response.data.paid
        });
    } catch (error) {
        console.error('❌ Ошибка проверки:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка проверки платежа',
            details: error.response?.data || error.message
        });
    }
});

// ============================================================
// 6. WEBHOOK
// ============================================================
app.post('/api/yookassa-webhook', function(req, res) {
    try {
        var event = req.body;
        console.log('📨 Webhook:', JSON.stringify(event, null, 2));

        if (event.object && event.object.status === 'succeeded') {
            console.log('✅ ПЛАТЁЖ УСПЕШЕН! 🎉');
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Ошибка webhook:', error);
        res.sendStatus(500);
    }
});

// ============================================================
// 7. HEALTH CHECK
// ============================================================
app.get('/api/health', function(req, res) {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ============================================================
// 8. ЗАПУСК
// ============================================================
app.listen(PORT, function() {
    console.log('\n🚀 Сервер запущен на порту ' + PORT);
    console.log('✅ Health: https://rhino-api-yrfq.onrender.com/api/health');
    console.log('🔑 SECRET_KEY: ' + (SECRET_KEY ? '✅' : '❌'));
    console.log('📦 СДЭК: ' + (CDEK_ACCOUNT && CDEK_SECRET ? '✅' : '❌'));
    console.log('');
});