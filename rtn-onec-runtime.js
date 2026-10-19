'use strict';
const fs=require('node:fs');
const {createExchange}=require('./rtn-onec-orders');
const {createCollector}=require('./rtn-onec-source');
const {mysqlStore}=require('./rtn-onec-store');

function createRuntime({getPool,bitrixCall,orderFile,config}) {
    const collect=createCollector({bitrixCall,config,readLocalOrders(){
        // A missing ephemeral file is possible on Render. Bitrix is also read.
        if(!fs.existsSync(orderFile))return [];
        const orders=JSON.parse(fs.readFileSync(orderFile,'utf8'));
        if(!Array.isArray(orders))throw new Error('invalid_local_order_store');
        return orders;
    }});
    return createExchange({store:mysqlStore(getPool),collect,config});
}
module.exports={createRuntime};
