'use strict';
// Reserve at most one promotional mail per recipient per seven days.
// Transactional authentication and order-payment emails are never throttled here.
const crypto=require('crypto');
const {getPool}=require('./db');
let table;
async function ensure(){
 if(!table)table=getPool().query('CREATE TABLE IF NOT EXISTS rtn_marketing_mail_limits ('+
  'email VARCHAR(254) NOT NULL PRIMARY KEY, claim_token CHAR(36) NOT NULL,'+
  'next_allowed_at DATETIME NOT NULL, INDEX idx_next_allowed(next_allowed_at)'+
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4').catch(e=>{table=null;throw e;});
 return table;
}
async function reserve(address){
 await ensure();
 const token=crypto.randomUUID(),db=getPool();
 await db.execute(
  'INSERT INTO rtn_marketing_mail_limits(email,claim_token,next_allowed_at) VALUES (?, ?, DATE_ADD(NOW(),INTERVAL 7 DAY)) '+
  'ON DUPLICATE KEY UPDATE '+
  'claim_token=IF(next_allowed_at<=NOW(),VALUES(claim_token),claim_token), '+
  'next_allowed_at=IF(next_allowed_at<=NOW(),VALUES(next_allowed_at),next_allowed_at)',
  [address,token]);
 const [[row]]=await db.execute('SELECT claim_token,next_allowed_at FROM rtn_marketing_mail_limits WHERE email=?',[address]);
 if(row?.claim_token===token)return {allowed:true};
 const err=new Error('Marketing frequency limit: at most 1 email per 7 days');
 err.code='RTN_MARKETING_FREQUENCY_LIMIT';
 throw err;
}
module.exports={reserve};
