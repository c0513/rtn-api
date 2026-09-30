const express = require('express');

function publicApiUrl(req) {
    return String(
        process.env.PUBLIC_API_URL ||
        ('https://' + req.get('host'))
    ).replace(/\/+$/, '');
}

function installHtml(handlerUrl) {
    const safeHandler = JSON.stringify(handlerUrl);
    return '<!doctype html>' +
        '<html lang="ru"><head><meta charset="utf-8">' +
        '<title>RTN Warehouse — установка</title>' +
        '<script src="https://api.bitrix24.tech/api/v1/"></script>' +
        '<style>body{font-family:Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px}.ok{color:#00ff88}.err{color:#ff5577;white-space:pre-wrap}</style>' +
        '</head><body><h2>RTN Warehouse</h2><div id="status">Устанавливаем приложение…</div>' +
        '<script>' +
        'BX24.init(function(){' +
        'var status=document.getElementById("status");' +
        'function fail(m){status.className="err";status.textContent="Ошибка установки: "+m;}' +
        'BX24.callMethod("placement.bind",{' +
        'PLACEMENT:"CRM_DEAL_DETAIL_TAB",HANDLER:'+safeHandler+',TITLE:"СКЛАД RTN",LANG_ALL:{ru:{TITLE:"СКЛАД RTN"}}' +
        '},function(tabResult){' +
        'if(tabResult.error()){fail(tabResult.error()+": "+(tabResult.error_description()||""));return;}' +
        'BX24.callMethod("placement.bind",{' +
        'PLACEMENT:"CRM_DEAL_DETAIL_ACTIVITY",HANDLER:'+safeHandler+',TITLE:"СБОРКА RTN",LANG_ALL:{ru:{TITLE:"СБОРКА RTN"}},' +
        'OPTIONS:{useBuiltInInterface:"Y",newUserNotificationTitle:"RTN Warehouse",newUserNotificationText:"Сборка, маркировка и доставка заказа"}' +
        '},function(activityResult){' +
        'if(activityResult.error()){fail(activityResult.error()+": "+(activityResult.error_description()||""));return;}' +
        'status.className="ok";status.textContent="RTN Warehouse установлен";BX24.installFinish();' +
        '});' +
        '});' +
        '});' +
        '</script></body></html>';
}

function widgetHtml() {
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>RTN Warehouse</title><script src="https://api.bitrix24.tech/api/v1/"></script>' +
        '<style>body{margin:0;background:#070707;color:#fff;font-family:Arial,sans-serif}.wrap{padding:20px}.tag{font:700 11px monospace;color:#00f0ff;letter-spacing:.15em}h2{margin:8px 0}.muted{color:#92929d}.box{margin-top:16px;border:1px solid #25252e;background:#0c0c0f;padding:16px}</style>' +
        '</head><body><div class="wrap"><div class="tag">// RTN.PRO · WAREHOUSE</div><h2>СКЛАД RTN</h2><div id="state" class="muted">Определяем сделку…</div><div id="deal" class="box" style="display:none"></div></div>' +
        '<script>BX24.init(async function(){try{var info=BX24.placement.info();var options=info&&info.options?info.options:{};var dealId=Number(options.ID||options.entityId||0);var builtIn=String(options.useBuiltInInterface||"").toUpperCase()==="Y";if(builtIn){BX24.placement.call("setLayout",{blocks:{title:{type:"text",properties:{value:"Сборка RTN",bold:true,size:"lg",color:"base_90"}},status:{type:"text",properties:{value:dealId?("Сделка #"+dealId+" готова к работе со складом RTN"):"Сделка RTN",size:"sm",color:"base_70"}},hint:{type:"text",properties:{value:"Рабочая сборка выполняется во вкладке СКЛАД RTN.",multiline:true,size:"sm",color:"base_70"}}},primaryButton:{title:"Готово"},secondaryButton:{title:"Закрыть"}},function(){});BX24.placement.call("bindPrimaryButtonClickCallback",null,function(){BX24.placement.call("finish");});BX24.placement.call("bindSecondaryButtonClickCallback",null,function(){BX24.placement.call("finish");});return;}var state=document.getElementById("state");if(!dealId){state.textContent="Не удалось определить ID сделки";return;}state.textContent="Авторизация склада для сделки #"+dealId+"…";var auth=BX24.getAuth();if(!auth||!auth.access_token||!auth.domain){throw new Error("Bitrix24 не выдал OAuth-сессию");}var response=await fetch("/api/warehouse/bitrix/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({domain:auth.domain,accessToken:auth.access_token,dealId:dealId})});var data=await response.json();if(!response.ok||!data.token){throw new Error(data.error||"Не удалось открыть складскую сессию");}location.replace("/api/warehouse/ui?dealId="+encodeURIComponent(String(dealId))+"#widget="+encodeURIComponent(data.token));}catch(e){var el=document.getElementById("state");if(el){el.textContent="Ошибка: "+String(e&&e.message||e);el.style.color="#ff6b86";}}});</script>' +
        '</body></html>';
}

function createBitrixWarehouseAppRouter() {
    const router = express.Router();
    router.all('/install', (req, res) => {
        const handlerUrl = publicApiUrl(req) + '/api/warehouse-bitrix/widget';
        res.set('Cache-Control', 'no-store').type('html').send(installHtml(handlerUrl));
    });
    router.all('/widget', (req, res) => {
        res.set('Cache-Control', 'no-store').type('html').send(widgetHtml());
    });
    return router;
}

module.exports = { createBitrixWarehouseAppRouter };