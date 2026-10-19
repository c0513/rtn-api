'use strict';

// Uses the existing RTN MySQL connection. No schema writes on server startup.
// Apply migration.sql and seed the reviewed state only after deployment approval.
function mysqlStore(getPool) {
    return {
        async readReport() {
            const [rows]=await getPool().query('SELECT state_json FROM rtn_onec_exchange_state WHERE id = 1');
            if(rows.length!==1)throw new Error('1C exchange state is not initialized');
            const state=typeof rows[0].state_json==='string'?JSON.parse(rows[0].state_json):rows[0].state_json;
            return {reconciliationApproved:state.reconciliation?.approved===true,report:state.lastReport||null,pending:state.pending?{id:state.pending.id,count:state.pending.orderIds.length,createdAt:state.pending.createdAt}:null,acknowledgedCount:Object.keys(state.delivered||{}).length};
        },
        async transaction(action) {
            const connection=await getPool().getConnection();
            try {
                await connection.beginTransaction();
                const [rows]=await connection.query('SELECT state_json FROM rtn_onec_exchange_state WHERE id = 1 FOR UPDATE');
                if(rows.length!==1)throw new Error('1C exchange state is not initialized');
                const state=typeof rows[0].state_json==='string'?JSON.parse(rows[0].state_json):rows[0].state_json;
                const result=await action(state);
                await connection.execute('UPDATE rtn_onec_exchange_state SET state_json = ? WHERE id = 1',[JSON.stringify(state)]);
                await connection.commit();
                return result;
            } catch(error) {
                await connection.rollback();
                throw error;
            } finally { connection.release(); }
        }
    };
}
module.exports={mysqlStore};
