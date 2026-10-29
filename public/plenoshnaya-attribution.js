/*
 * A051 Agency · Плёношная · атрибуция Яндекс Директа
 * Подключить ВЫШЕ существующего скрипта аналитики на Tilda.
 * Работает только с рекламными переходами; не меняет работу калькулятора.
 */
(function (win) {
  'use strict';
  if (typeof win.plenoshnayaSource === 'function' && win.plenoshnayaSource.version === '2.0') return;

  var KEY = 'pl_src';
  var SESSION = 'pl_src_session';
  var TTL = 30 * 86400000;
  var CAMPAIGNS = {
    '715585055': 'Поиск',
    '715209100': 'Карты',
    '707458653': 'ЕПК (РСЯ + Карты)',
    '715588050': 'РСЯ — догоняющая реклама'
  };
  var GROUPS = {
    '5817622983': 'Тонировка',
    '5817623940': 'Атермальная тонировка',
    '5817628677': 'Бронирование фар',
    '5817631879': 'Бронирование лобового',
    '5817632596': 'Оклейка зон риска',
    '5817633890': 'Растонировка',
    '5817680791': 'Бренд (Плёношная)',
    '5810620816': 'Тонировка',
    '5817658284': 'Атермальная тонировка',
    '5817658847': 'Бронирование фар',
    '5817660853': 'Бронирование лобового',
    '5817662030': 'Оклейка зон риска',
    '5817662554': 'Растонировка',
    '5817666046': 'Посетители сайта без заявки',
    '5719936201': 'Все услуги'
  };
  var PLACES = {search: 'Поиск', context: 'РСЯ'};
  var DEVICES = {desktop: 'компьютер', mobile: 'телефон', tablet: 'планшет'};
  var inMemory = null;

  function safeString(v, max) {
    return String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 180);
  }
  function digitId(v) {
    var s = safeString(v, 32);
    return /^\d{1,24}$/.test(s) ? s : '';
  }
  function param(p, key) {
    return safeString(p.get(key), 200);
  }
  function store(d) {
    inMemory = d;
    try { win.localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {}
    try { win.sessionStorage.setItem(SESSION, String(d.t)); } catch (e) {}
  }
  function load() {
    var d = inMemory;
    if (!d) {
      try { d = JSON.parse(win.localStorage.getItem(KEY) || 'null'); } catch (e) {}
    }
    if (!d || !Number.isFinite(Number(d.t)) || Date.now() - Number(d.t) < 0 ||
        Date.now() - Number(d.t) >= TTL || !d.d || typeof d.d !== 'object') {
      inMemory = null;
      try { win.localStorage.removeItem(KEY); } catch (e) {}
      return null;
    }
    return d;
  }

  var params = new URLSearchParams(win.location.search);
  var source = param(params, 'utm_source').toLowerCase();
  var medium = param(params, 'utm_medium').toLowerCase();
  var yclid = digitId(param(params, 'yclid'));
  var isYandexAd = !!yclid || ((source === 'yandex' || source === 'ya') && /^(cpc|ppc|paid|cpm|search|display)$/.test(medium));

  if (isYandexAd) {
    var groupAd = param(params, 'utm_content').split('_');
    var campaignId = digitId(param(params, 'utm_campaign'));
    var groupId = digitId(groupAd[0]);
    var adId = digitId(groupAd[1]);
    var phrase = param(params, 'utm_term');
    if (phrase === '---autotargeting') phrase = 'автотаргетинг';
    if (/^\{[^}]+\}$/.test(phrase)) phrase = '';
    var placeId = param(params, 'src');
    var deviceId = param(params, 'device');
    var capturedAt = Date.now();
    store({
      t: capturedAt,
      d: {
        traffic: 'Яндекс Директ',
        campaign_id: campaignId,
        campaign: CAMPAIGNS[campaignId] || (campaignId ? 'кампания №' + campaignId : 'кампания не определена'),
        group_id: groupId,
        service: GROUPS[groupId] || '',
        ad_id: adId,
        keyword: phrase || '—',
        place: PLACES[placeId] || '',
        device: DEVICES[deviceId] || '',
        landing: safeString(win.location.pathname, 260),
        captured_at: capturedAt
      }
    });
  }

  function current() {
    var item = load();
    if (!item) return null;
    var d = item.d;
    var sameSession = false;
    try { sameSession = win.sessionStorage.getItem(SESSION) === String(item.t); } catch (e) {}
    // Источник прошлого рекламного перехода не выдаём за новый клик.
    var returned = !sameSession || Date.now() - item.t > 12 * 3600000;
    var copy = {
      traffic: safeString(d.traffic, 40),
      campaign_id: digitId(d.campaign_id),
      campaign: safeString(d.campaign, 100),
      group_id: digitId(d.group_id),
      service: safeString(d.service, 100),
      ad_id: digitId(d.ad_id),
      keyword: safeString(d.keyword, 180),
      place: safeString(d.place, 40),
      device: safeString(d.device, 40),
      landing: safeString(d.landing, 260),
      captured_at: Number(item.t),
      returning: returned
    };
    copy.summary = copy.traffic + ' · ' + copy.campaign +
      (copy.service ? ' — ' + copy.service : '') +
      (copy.place && copy.campaign !== copy.place ? ' (' + copy.place + ')' : '') +
      (copy.returning ? ' · повторный визит' : '');
    return copy;
  }
  current.version = '2.0';
  win.plenoshnayaSource = current;
})(window);
