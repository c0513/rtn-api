const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ---
// ЮKassa
const SHOP_ID = process.env.SHOP_ID || '1403586';
const SECRET_KEY = process.env.SECRET_KEY;

// СДЭК
const CDEK_ACCOUNT = process.env.CDEK_ACCOUNT;
const CDEK_SECRET = process.env.CDEK_SECRET;

// --- ПРОВЕРКИ ---
if (!SECRET_KEY) {
    console.error('❌ ОШИБКА: SECRET_KEY не задан!');
}
if (!CDEK_ACCOUNT || !CDEK_SECRET) {
    console.error('❌ ОШИБКА: Данные СДЭК не заданы!');
}

app.use(cors());
app.use(express.json());

// --- ЛОГИРОВАНИЕ ВСЕХ ЗАПРОСОВ ---
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ============================================================
// 1. РАСЧЁТ ДОСТАВКИ СДЭК
// ============================================================
app.post('/api/calculate-delivery', async (req, res) => {
    console.log('\n📦 ===== РАСЧЁТ ДОСТАВКИ СДЭК =====');
    console.log('📥 Входящие данные:', JSON.stringify(req.body, null, 2));

    try {
        const { city, postalCode, weight = 100, length = 300, width = 300, height = 100 } = req.body;

        // Проверка: указан ли город или индекс
        if (!city && !postalCode) {
            console.error('❌ Город или индекс не указаны');
            return res.status(400).json({ error: 'Укажите город или индекс' });
        }

        // Проверка: есть ли данные для СДЭК
        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            console.error('❌ Данные СДЭК не настроены');
            return res.status(500).json({ error: 'Сервер не настроен для расчёта доставки' });
        }

        // --- ШАГ 1: Получаем токен СДЭК ---
        console.log('🔑 Получение токена СДЭК...');
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

        // --- ШАГ 2: Получаем код города СДЭК ---
        console.log(`🔍 Поиск города: ${city || postalCode}`);
        const cityResponse = await axios.get(
            'https://api.cdek.ru/v2/location/cities',
            {
                params: {
                    city: city,
                    postal_code: postalCode,
                    country_codes: 'RU'
                },
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        if (!cityResponse.data || cityResponse.data.length === 0) {
            console.error('❌ Город не найден');
            return res.status(404).json({ error: 'Город не найден. Проверьте название или индекс.' });
        }

        const cityData = cityResponse.data[0];
        const cityCode = cityData.code;
        console.log(`✅ Найден город: ${cityData.name} (код: ${cityCode})`);

        // --- ШАГ 3: Рассчитываем стоимость доставки ---
        console.log('📊 Расчёт стоимости доставки...');
        const tariffResponse = await axios.post(
            'https://api.cdek.ru/v2/calculator/tariff',
            {
                tariff_code: 137, // Посылка склад-дверь
                from_location: {
                    code: 270, // Санкт-Петербург
                    postal_code: '196608'
                },
                to_location: {
                    code: cityCode,
                    postal_code: postalCode || cityData.postal_code
                },
                packages: [{
                    weight: weight,
                    length: length,
                    width: width,
                    height: height
                }]
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        console.log('✅ Расчёт выполнен успешно');
        console.log(`💰 Стоимость доставки: ${tariffResponse.data.total_sum} ₽`);
        console.log('====================================\n');

        res.json({
            deliveryPrice: tariffResponse.data.total_sum,
            deliveryTime: tariffResponse.data.delivery_time,
            deliveryDateMin: tariffResponse.data.delivery_date_min,
            deliveryDateMax: tariffResponse.data.delivery_date_max,
            city: cityData.name,
            cityCode: cityCode,
            currency: 'RUB'
        });

    } catch (error) {
        console.error('\n❌ ===== ОШИБКА РАСЧЁТА ДОСТАВКИ =====');
        if (error.response) {
            console.error('📌 Статус:', error.response.status);
            console.error('📌 Данные ошибки:', JSON.stringify(error.response.data, null, 2));
            res.status(error.response.status).json({
                error: error.response.data.message || 'Ошибка расчёта доставки',
                details: error.response.data
            });
        } else if (error.request) {
            console.error('❌ Нет ответа от СДЭК');
            res.status(500).json({
                error: 'СДЭК не отвечает. Попробуйте позже.'
            });
        } else {
            console.error('❌ Внутренняя ошибка:', error.message);
            res.status(500).json({
                error: 'Внутренняя ошибка сервера',
                details: error.message
            });
        }
        console.error('====================================\n');
    }
});

// ============================================================
// 2. СОЗДАНИЕ ПЛАТЕЖА (ЮKASSA)
// ============================================================
app.post('/api/create-payment', async (req, res) => {
    console.log('\n🔵 ===== НОВЫЙ ЗАПРОС НА ОПЛАТУ =====');
    console.log('📥 Получены данные:', JSON.stringify(req.body, null, 2));

    try {
        const { amount, description, orderId, items, customer, delivery } = req.body;

        if (!amount) {
            console.error('❌ amount не передан');
            return res.status(400).json({ error: 'amount обязателен' });
        }

        if (!SECRET_KEY) {
            console.error('❌ SECRET_KEY не настроен');
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        console.log(`💰 Сумма: ${amount} RUB`);

        const idempotenceKey = `${orderId || Date.now()}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        console.log(`🔑 Idempotence-Key: ${idempotenceKey}`);

        // Формируем чек (обязательно для 54-ФЗ)
        const receiptItems = Array.isArray(items) ? items.map(item => ({
            description: `${item.name} (${item.flavor || 'стандарт'})`,
            quantity: item.quantity || 1,
            amount: {
                value: ((item.price || 0) * (item.quantity || 1)).toFixed(2),
                currency: 'RUB'
            },
            vat_code: 1, // 1 = НДС не облагается
            payment_mode: 'full_payment',
            payment_subject: 'commodity'
        })) : [];

        // Если есть доставка, добавляем её как отдельную позицию
        if (delivery && delivery.price) {
            receiptItems.push({
                description: `Доставка (${delivery.method || 'СДЭК'})`,
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

        const paymentData = {
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
            description: description || `Заказ ${orderId || Date.now()}`,
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

        console.log('📤 Отправляем в ЮKassa:', JSON.stringify(paymentData, null, 2));

        const response = await axios.post(
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
        console.log('🔗 Ссылка для оплаты:', response.data.confirmation?.confirmation_url);
        console.log('====================================\n');

        res.json(response.data);

    } catch (error) {
        console.error('\n❌ ===== ОШИБКА СОЗДАНИЯ ПЛАТЕЖА =====');
        if (error.response) {
            console.error('📌 Статус:', error.response.status);
            console.error('📌 Данные ошибки:', JSON.stringify(error.response.data, null, 2));
            const errorMessage = error.response.data?.description || 'Ошибка при создании платежа';
            res.status(error.response.status).json({
                error: errorMessage,
                details: error.response.data
            });
        } else if (error.request) {
            console.error('❌ Нет ответа от ЮKassa');
            res.status(500).json({
                error: 'ЮKassa не отвечает'
            });
        } else {
            console.error('❌ Внутренняя ошибка:', error.message);
            res.status(500).json({
                error: 'Внутренняя ошибка сервера',
                details: error.message
            });
        }
        console.error('====================================\n');
    }
});

// ============================================================
// 3. ПРОВЕРКА СТАТУСА ПЛАТЕЖА
// ============================================================
app.get('/api/check-payment', async (req, res) => {
    try {
        const { paymentId } = req.query;
        if (!paymentId) {
            return res.status(400).json({ error: 'paymentId не указан' });
        }

        console.log(`🔍 Проверка платежа ${paymentId}`);

        const response = await axios.get(
            `https://api.yookassa.ru/v3/payments/${paymentId}`,
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
        console.error('❌ Ошибка проверки платежа:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка проверки платежа',
            details: error.response?.data || error.message
        });
    }
});

// ============================================================
// 4. WEBHOOK ДЛЯ УВЕДОМЛЕНИЙ ОТ ЮKASSA
// ============================================================
app.post('/api/yookassa-webhook', (req, res) => {
    try {
        const event = req.body;
        console.log('📨 Webhook получен:', JSON.stringify(event, null, 2));

        if (event.object && event.object.status === 'succeeded') {
            console.log('✅ ПЛАТЁЖ УСПЕШЕН! 🎉');
            console.log('💰 Сумма:', event.object.amount.value, event.object.amount.currency);
            console.log('📦 Заказ:', event.object.metadata?.orderId);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Ошибка обработки webhook:', error);
        res.sendStatus(500);
    }
});

// ============================================================
// 5. ПРОВЕРКА ЗДОРОВЬЯ
// ============================================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ============================================================
// 6. ЗАПУСК СЕРВЕРА
// ============================================================
app.listen(PORT, () => {
    console.log(`\n🚀 Сервер ЮKassa + СДЭК запущен на порту ${PORT}`);
    console.log(`📝 Webhook URL: https://rtn.pro/api/yookassa-webhook`);
    console.log(`✅ Health: https://rtn.pro/api/health`);
    console.log(`🏪 SHOP_ID: ${SHOP_ID}`);
    console.log(`🔑 SECRET_KEY: ${SECRET_KEY ? '✅ Установлен' : '❌ НЕ УСТАНОВЛЕН!'}`);
    console.log(`📦 СДЭК Account: ${CDEK_ACCOUNT ? '✅ Установлен' : '❌ НЕ УСТАНОВЛЕН!'}`);
    console.log(`🔐 СДЭК Secret: ${CDEK_SECRET ? '✅ Установлен' : '❌ НЕ УСТАНОВЛЕН!'}\n`);
});