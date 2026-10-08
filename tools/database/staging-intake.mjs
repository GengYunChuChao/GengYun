import { parseArgs } from 'node:util';
import { createPool } from '../../services/api/src/db/pool.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { extractIntake,importIntake,rollbackIntake,validateStagingDatabaseUrl } from '../../services/api/src/db/staging-intake.ts';
let pool;
try {
  const {values}=parseArgs({options:{action:{type:'string'},'operation-id':{type:'string'},workbook:{type:'string'},
    'previous-import-id':{type:'string'},'batch-id':{type:'string'},'import-id':{type:'string'},'payload-hash':{type:'string'}},strict:true,allowPositionals:false});
  const dsn=validateStagingDatabaseUrl(process.env.DATABASE_URL);
  if(!values['operation-id']||!['import','rollback'].includes(values.action))throw new ApiError('INVALID_REQUEST','暂存操作参数错误');
  let result;
  if(values.action==='import'){
    if(!values.workbook||values['batch-id']||values['import-id']||values['payload-hash'])throw new ApiError('INVALID_REQUEST','暂存操作参数错误');
    const payload=await extractIntake(values.workbook,process.env.STAGING_PYTHON??(process.platform==='win32'?'python':'python3'));
    pool=createPool(dsn);result=await importIntake(pool,values['operation-id'],payload,values['previous-import-id']);
  }else{
    if(values.workbook||values['previous-import-id']||!values['batch-id']||!values['import-id']||!values['payload-hash'])throw new ApiError('INVALID_REQUEST','暂存操作参数错误');
    pool=createPool(dsn);result=await rollbackIntake(pool,values['operation-id'],values['batch-id'],values['import-id'],values['payload-hash']);
  }
  console.log(JSON.stringify({data:result}));
}catch(e){console.error(JSON.stringify({error:{code:e instanceof ApiError?e.code:'INVALID_REQUEST',message:e instanceof ApiError?e.message:'暂存配置或参数错误'}}));process.exitCode=1;}
finally{await pool?.end();}
