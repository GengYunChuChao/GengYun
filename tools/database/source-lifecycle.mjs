/** Local isolated operations only. Credentials never accepted in argv/output. */
import { parseArgs } from 'node:util';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applySourceOperation, validateSourceDatabaseUrl } from '../../services/api/src/db/source-lifecycle.ts';
import { ApiError } from '../../services/api/src/errors.ts';

let pool;
try {
  const { values }=parseArgs({ options: {
    action:{type:'string'}, 'operation-id':{type:'string'}, 'source-id':{type:'string'},
    'source-version-id':{type:'string'}, 'expected-revision':{type:'string'},
    'expected-validity':{type:'string'}, reason:{type:'string'}, 'restores-operation-id':{type:'string'},
  }, strict:true, allowPositionals:false });
  // Reject all connection-string options before constructing the pg pool.
  pool=createPool(validateSourceDatabaseUrl(process.env.DATABASE_URL));
  const result=await applySourceOperation(pool, {
    operationId:values['operation-id'],action:values.action,sourceId:values['source-id'],
    sourceVersionId:values['source-version-id'],expectedRevision:Number(values['expected-revision']),
    expectedValidity:values['expected-validity'],reason:values.reason,
    restoresOperationId:values['restores-operation-id'],
  });
  console.log(JSON.stringify({data:result}));
} catch (error) {
  console.error(JSON.stringify({error:{code:error instanceof ApiError?error.code:'INVALID_REQUEST',message:error instanceof ApiError?error.message:'来源操作配置或参数错误'}}));
  process.exitCode=1;
} finally { await pool?.end(); }
