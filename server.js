const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP_ID = process.env.SHOP_ID || '1403586';
const SECRET_KEY = process.env.SECRET_KEY;
const CDEK_ACCOUNT = process.env.CDEK_ACCOUNT;
const CDEK_SECRET = process.env.CDEK_SECRET;

// ============================================================
// CDEK PERFORMANCE CACHE
// Не запрашиваем OAuth-токен при каждом вводе буквы.
// ============================================================
let cdekTokenCache = {
    token: null,
    expiresAt: 0
};

const citySearchCache = new Map();
const CITY_CACHE_TTL = 10 * 60 * 1000; // 10 минут
const CITY_CACHE_MAX = 250;

const addressSearchCache = new Map();
const ADDRESS_CACHE_TTL = 30 * 60 * 1000; // 30 минут
const ADDRESS_CACHE_MAX = 400;

async function getCdekAccessToken() {
    const now = Date.now();

    // Оставляем запас 60 секунд до реального истечения токена.
    if (cdekTokenCache.token && now < cdekTokenCache.expiresAt - 60_000) {
        return cdekTokenCache.token;
    }

    if (!CDEK_ACCOUNT || !CDEK_SECRET) {
        throw new Error('CDEK credentials are not configured');
    }

    const tokenResponse = await axios.post(
        'https://api.cdek.ru/v2/oauth/token',
        {
            grant_type: 'client_credentials',
            client_id: CDEK_ACCOUNT,
            client_secret: CDEK_SECRET
        },
        {
            timeout: 8000
        }
    );

    const expiresIn = Number(tokenResponse.data.expires_in || 3600);

    cdekTokenCache = {
        token: tokenResponse.data.access_token,
        expiresAt: now + expiresIn * 1000
    };

    console.log('✅ Новый токен СДЭК получен и закэширован');
    return cdekTokenCache.token;
}

function getCachedCitySearch(query) {
    const key = String(query || '').trim().toLowerCase();
    const cached = citySearchCache.get(key);

    if (!cached) return null;

    if (Date.now() - cached.createdAt > CITY_CACHE_TTL) {
        citySearchCache.delete(key);
        return null;
    }

    return cached.cities;
}

function setCachedCitySearch(query, cities) {
    const key = String(query || '').trim().toLowerCase();

    if (citySearchCache.size >= CITY_CACHE_MAX) {
        const oldestKey = citySearchCache.keys().next().value;
        if (oldestKey) citySearchCache.delete(oldestKey);
    }

    citySearchCache.set(key, {
        cities,
        createdAt: Date.now()
    });
}


function getCachedAddressSearch(cityName, query) {
    const key = `${String(cityName || '').trim().toLowerCase()}::${String(query || '').trim().toLowerCase()}`;
    const cached = addressSearchCache.get(key);

    if (!cached) return null;

    if (Date.now() - cached.createdAt > ADDRESS_CACHE_TTL) {
        addressSearchCache.delete(key);
        return null;
    }

    return cached.addresses;
}

function setCachedAddressSearch(cityName, query, addresses) {
    const key = `${String(cityName || '').trim().toLowerCase()}::${String(query || '').trim().toLowerCase()}`;

    if (addressSearchCache.size >= ADDRESS_CACHE_MAX) {
        const oldestKey = addressSearchCache.keys().next().value;
        if (oldestKey) addressSearchCache.delete(oldestKey);
    }

    addressSearchCache.set(key, {
        addresses,
        createdAt: Date.now()
    });
}

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});


app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'rtn-api',
        time: new Date().toISOString(),
        cdekTokenCached: Boolean(cdekTokenCache.token && Date.now() < cdekTokenCache.expiresAt)
    });
});

// ============================================================
// 1. ПОИСК ГОРОДОВ (с фильтрацией по названию)
// ============================================================
app.post('/api/search-cities', async (req, res) => {
    console.log('🔍 Поиск городов para:', req.body.query);

    try {
        const query = String(req.body.query || '').trim();

        if (!query || query.length < 2) {
            return res.json({ cities: [] });
        }

        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        const cachedCities = getCachedCitySearch(query);
        if (cachedCities) {
            console.log('⚡ Города отданы из кэша:', query, cachedCities.length);
            return res.json({ cities: cachedCities, cached: true });
        }

        const accessToken = await getCdekAccessToken();

        const cityResponse = await axios.get(
            'https://api.cdek.ru/v2/location/cities',
            {
                params: {
                    country_codes: 'RU',
                    q: query,
                    limit: 25
                },
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                },
                timeout: 8000
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
            setCachedCitySearch(query, uniqueCities);
            res.json({ cities: uniqueCities });
        } else {
            console.log('ℹ️ Города не найдены');
            setCachedCitySearch(query, []);
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

// ============================================================
// 2. ПОИСК УЛИЦ / ДОМОВ ДЛЯ КУРЬЕРСКОЙ ДОСТАВКИ
// Быстрый серверный прокси к OpenStreetMap Nominatim.
// На фронте запросы дебаунсятся, здесь ещё есть 30-минутный кэш.
// ============================================================
app.post('/api/search-addresses', async (req, res) => {
    try {
        const cityName = String(req.body.cityName || '').trim();
        const query = String(req.body.query || '').trim();

        if (!cityName || !query || query.length < 2) {
            return res.json({ addresses: [] });
        }

        const cached = getCachedAddressSearch(cityName, query);
        if (cached) {
            return res.json({ addresses: cached, cached: true });
        }

        const response = await axios.get(
            'https://nominatim.openstreetmap.org/search',
            {
                params: {
                    q: `${query}, ${cityName}, Россия`,
                    format: 'jsonv2',
                    addressdetails: 1,
                    limit: 8,
                    countrycodes: 'ru',
                    layer: 'address'
                },
                headers: {
                    // Для публичного Nominatim User-Agent обязателен.
                    'User-Agent': 'RTN.PRO/1.0 (https://rtn.pro)',
                    'Accept-Language': 'ru'
                },
                timeout: 7000
            }
        );

        const seen = new Set();
        const addresses = (response.data || [])
            .map(item => {
                const a = item.address || {};
                const road =
                    a.road ||
                    a.pedestrian ||
                    a.residential ||
                    a.footway ||
                    a.neighbourhood ||
                    '';
                const house = a.house_number || '';
                const postcode = a.postcode || '';

                let label = '';
                if (road && house) label = `${road}, д. ${house}`;
                else if (road) label = road;
                else label = String(item.display_name || '').split(',').slice(0, 2).join(',').trim();

                return {
                    id: String(item.place_id || `${item.lat}_${item.lon}`),
                    label,
                    road,
                    house,
                    postcode,
                    displayName: item.display_name,
                    lat: Number(item.lat),
                    lon: Number(item.lon)
                };
            })
            .filter(item => {
                const key = item.label.toLowerCase();
                if (!item.label || seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        setCachedAddressSearch(cityName, query, addresses);
        res.json({ addresses });

    } catch (error) {
        console.error('❌ Ошибка поиска адреса:', error.response?.data || error.message);
        res.status(502).json({
            error: 'Не удалось выполнить поиск адреса',
            addresses: []
        });
    }
});

app.post('/api/calculate-delivery', async (req, res) => {
    console.log('📦 Расчёт доставки СДЭК:', req.body);

    try {
        const {
            cityCode,
            postalCode,
            cityName,
            deliveryMethod = 'cdek_courier',
            packageWeight = 1000,
            packageLength = 35,
            packageWidth = 25,
            packageHeight = 20
        } = req.body;

        if (!cityCode) {
            return res.status(400).json({ error: 'Не передан код города' });
        }

        if (!CDEK_ACCOUNT || !CDEK_SECRET) {
            return res.status(500).json({ error: 'Сервер не настроен' });
        }

        const accessToken = await getCdekAccessToken();

        // CDEK API:
        // weight — граммы
        // length / width / height — сантиметры
        // В старой версии были размеры 400×400×200, которые API трактовал как САНТИМЕТРЫ.
        // Из-за этого реальные тарифы часто не находились, и сайт падал в фиксу 500 ₽.
        const safeWeight = Math.max(200, Math.min(Number(packageWeight) || 1000, 30000));
        const safeLength = Math.max(10, Math.min(Number(packageLength) || 35, 120));
        const safeWidth = Math.max(10, Math.min(Number(packageWidth) || 25, 80));
        const safeHeight = Math.max(5, Math.min(Number(packageHeight) || 20, 80));

        const tariffResponse = await axios.post(
            'https://api.cdek.ru/v2/calculator/tarifflist',
            {
                from_location: {
                    code: 270,
                    postal_code: '196608'
                },
                to_location: {
                    code: Number(cityCode),
                    postal_code: postalCode || undefined
                },
                packages: [{
                    weight: safeWeight,
                    length: safeLength,
                    width: safeWidth,
                    height: safeHeight
                }]
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        const tariffCodes = Array.isArray(tariffResponse.data?.tariff_codes)
            ? tariffResponse.data.tariff_codes
            : [];

        // CDEK delivery_mode:
        // 1 = дверь → дверь
        // 2 = дверь → склад
        // 3 = склад → дверь
        // 4 = склад → склад
        //
        // У RTN отправка идёт со склада:
        // courier = склад → дверь
        // pvz     = склад → склад (ПВЗ)
        const wantedMode = deliveryMethod === 'cdek_pvz' ? 4 : 3;

        const eligible = tariffCodes
            .filter(t => Number(t.delivery_mode) === wantedMode)
            .filter(t => Number.isFinite(Number(t.delivery_sum)) && Number(t.delivery_sum) > 0)
            .sort((a, b) => Number(a.delivery_sum) - Number(b.delivery_sum));

        if (eligible.length === 0) {
            console.log('⚠️ СДЭК не вернул подходящий тариф', {
                cityCode,
                deliveryMethod,
                wantedMode,
                returned: tariffCodes.map(t => ({
                    code: t.tariff_code,
                    mode: t.delivery_mode,
                    sum: t.delivery_sum
                }))
            });

            return res.status(422).json({
                error: deliveryMethod === 'cdek_pvz'
                    ? 'СДЭК не нашёл тариф до ПВЗ для этого города'
                    : 'СДЭК не нашёл курьерский тариф для этого города'
            });
        }

        const best = eligible[0];

        console.log(
            `✅ СДЭК: ${deliveryMethod}, тариф ${best.tariff_code}, ` +
            `${best.tariff_name}, ${best.delivery_sum} ₽`
        );

        return res.json({
            deliveryPrice: Number(best.delivery_sum),
            deliveryTimeMin: best.period_min ?? null,
            deliveryTimeMax: best.period_max ?? null,
            tariffCode: best.tariff_code,
            tariffName: best.tariff_name,
            deliveryMode: best.delivery_mode,
            city: cityName || 'Город',
            currency: 'RUB',
            calculatedByCdek: true
        });

    } catch (error) {
        console.error('❌ Ошибка расчёта доставки СДЭК:', error.response?.data || error.message);

        // ВАЖНО: больше не подменяем ошибку фиктивными 500 ₽.
        // Лучше честно показать ошибку и дать пользователю повторить расчёт.
        return res.status(502).json({
            error: 'СДЭК временно не смог рассчитать доставку. Попробуйте ещё раз.'
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

        const accessToken = await getCdekAccessToken();

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
                },
                timeout: 10000
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