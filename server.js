const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Настройки ЮKassa из переменных окружения
const SHOP_ID = process.env.SHOP_ID || '1403586';
const SECRET_KEY = process.env.SECRET_KEY;

if (!SECRET_KEY) {
    console.error('❌ ОШИБКА: SECRET_KEY не задан в переменных окружения!');
}

app.use(cors());
app.use(express.json());

// Логирование всех запросов
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// --- СОЗДАНИЕ ПЛАТЕЖА ---
app.post('/api/create-payment', async (req, res) => {
    console.log('\n🔵 ===== НОВЫЙ ЗАПРОС НА ОПЛАТУ =====');
    console.log('📥 Получены данные от фронтенда:', JSON.stringify(req.body, null, 2));

    try {
        const { amount, description, orderId, items, customer, delivery, comment } = req.body;

        // Проверка: есть ли сумма
        if (!amount) {
            console.error('❌ ОШИБКА: amount не передан');
            return res.status(400).json({ error: 'amount обязателен' });
        }

        // Проверка: есть ли секретный ключ
        if (!SECRET_KEY) {
            console.error('❌ ОШИБКА: SECRET_KEY не настроен');
            return res.status(500).json({ error: 'Сервер не настроен. Обратитесь к администратору.' });
        }

        console.log(`💰 Сумма к оплате: ${amount} RUB`);
        console.log(`📦 Заказ: ${description || 'Без описания'}`);

        // Генерируем уникальный ключ идемпотентности
        const idempotenceKey = `${orderId || Date.now()}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        console.log(`🔑 Idempotence-Key: ${idempotenceKey}`);

        // Формируем платеж в ЮKassa
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
            capture: true
        };

        console.log('📤 Отправляем в ЮKassa:', JSON.stringify(paymentData, null, 2));

        // Отправляем запрос в ЮKassa
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

        console.log('✅ Платёж успешно создан! ID:', response.data.id);
        console.log('🔗 Ссылка для оплаты:', response.data.confirmation?.confirmation_url);
        console.log('====================================\n');

        res.json(response.data);

    } catch (error) {
        console.error('\n❌ ===== ОШИБКА СОЗДАНИЯ ПЛАТЕЖА =====');
        
        if (error.response) {
            // ЮKassa вернула ошибку
            console.error('📌 Статус ответа ЮKassa:', error.response.status);
            console.error('📌 Данные ошибки от ЮKassa:', JSON.stringify(error.response.data, null, 2));
            
            // Извлекаем понятное сообщение об ошибке
            let errorMessage = 'Ошибка при создании платежа';
            if (error.response.data?.description) {
                errorMessage = error.response.data.description;
            } else if (error.response.data?.error?.description) {
                errorMessage = error.response.data.error.description;
            }

            res.status(error.response.status).json({
                error: errorMessage,
                details: error.response.data
            });
        } else if (error.request) {
            // Запрос был сделан, но ответа нет
            console.error('❌ Нет ответа от ЮKassa');
            res.status(500).json({
                error: 'ЮKassa не отвечает. Попробуйте позже.',
                details: 'No response from YooKassa'
            });
        } else {
            // Ошибка на стороне сервера
            console.error('❌ Внутренняя ошибка:', error.message);
            res.status(500).json({
                error: 'Внутренняя ошибка сервера',
                details: error.message
            });
        }
        console.error('====================================\n');
    }
});

// --- ПРОВЕРКА СТАТУСА ПЛАТЕЖА ---
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

// --- WEBHOOK ДЛЯ УВЕДОМЛЕНИЙ ---
app.post('/api/yookassa-webhook', (req, res) => {
    try {
        const event = req.body;
        console.log('📨 Webhook получен:', JSON.stringify(event, null, 2));

        if (event.object && event.object.status === 'succeeded') {
            console.log('✅ ПЛАТЁЖ УСПЕШЕН! 🎉');
            console.log('💰 Сумма:', event.object.amount.value, event.object.amount.currency);
            console.log('📦 Заказ:', event.object.metadata?.orderId);
            // Здесь можно обновить статус заказа в базе данных
            // И отправить уведомление в Telegram
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Ошибка обработки webhook:', error);
        res.sendStatus(500);
    }
});

// --- ПРОВЕРКА ЗДОРОВЬЯ ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log(`🚀 Сервер ЮKassa запущен на порту ${PORT}`);
    console.log(`📝 Webhook URL: https://rtn.pro/api/yookassa-webhook`);
    console.log(`✅ Health: https://rtn.pro/api/health`);
    console.log(`🏪 SHOP_ID: ${SHOP_ID}`);
    console.log(`🔑 SECRET_KEY: ${SECRET_KEY ? '✅ Установлен' : '❌ НЕ УСТАНОВЛЕН!'}`);
});