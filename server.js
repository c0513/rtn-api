const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Настройки ЮKassa
const SHOP_ID = process.env.SHOP_ID || '1403586';
const SECRET_KEY = process.env.SECRET_KEY;

app.use(cors());
app.use(express.json());

// Логирование запросов
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Создание платежа
app.post('/api/create-payment', async (req, res) => {
    try {
        const { amount, description, orderId, items } = req.body;
        
        console.log('Создание платежа:', { amount, description, orderId });

        const response = await axios.post(
            'https://api.yookassa.ru/v3/payments',
            {
                amount: {
                    value: amount,
                    currency: 'RUB'
                },
                payment_method_data: {
                    type: 'bank_card'
                },
                confirmation: {
                    type: 'redirect',
                    return_url: 'https://rtn.pro/after-payment'
                },
                description: description || `Заказ ${orderId}`,
                metadata: {
                    orderId: orderId || Date.now().toString()
                },
                capture: true
            },
            {
                auth: {
                    username: SHOP_ID,
                    password: SECRET_KEY
                }
            }
        );

        console.log('Платёж создан:', response.data.id);
        res.json(response.data);
    } catch (error) {
        console.error('Ошибка создания платежа:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка создания платежа',
            details: error.response?.data || error.message
        });
    }
});

// Проверка статуса платежа
app.get('/api/check-payment', async (req, res) => {
    try {
        const { paymentId } = req.query;
        
        if (!paymentId) {
            return res.status(400).json({ error: 'paymentId не указан' });
        }

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
        console.error('Ошибка проверки платежа:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Ошибка проверки платежа',
            details: error.response?.data || error.message
        });
    }
});

// Webhook для уведомлений от ЮKassa
app.post('/api/yookassa-webhook', (req, res) => {
    try {
        const event = req.body;
        console.log('Webhook получен:', JSON.stringify(event, null, 2));

        // Проверяем подпись (опционально, для безопасности)
        // Здесь можно добавить проверку IP или подписи

        if (event.object && event.object.status === 'succeeded') {
            console.log('✅ ПЛАТЁЖ УСПЕШЕН:', {
                paymentId: event.object.id,
                orderId: event.object.metadata?.orderId,
                amount: event.object.amount.value,
                currency: event.object.amount.currency
            });
            // Здесь можно обновить статус заказа в базе данных
            // И отправить уведомление в Telegram
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Ошибка обработки webhook:', error);
        res.sendStatus(500);
    }
});

// Тестовый эндпоинт
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер ЮKassa запущен на порту ${PORT}`);
    console.log(`📝 Webhook URL: https://rtn.pro/api/yookassa-webhook`);
    console.log(`✅ Health: https://rtn.pro/api/health`);
});