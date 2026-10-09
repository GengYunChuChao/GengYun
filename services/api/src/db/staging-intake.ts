import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../errors.ts';
import type { PgPool } from './pool.ts';
import { validateSourceDatabaseUrl } from './source-lifecycle.ts';

const ROOT=fileURLToPath(new URL('../../../../',import.meta.url));
const MAX_JSON=8_000_000;
const VERSION='herbicide-summary-v1';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
const fields=['name_text','aliases_text','risk_grade_text','risk_text','weed_text','region_text'];
const invalid=()=>new ApiError('INVALID_REQUEST','暂存输入或参数不符合受限导入要求');
type JsonObject=Record<string, unknown>;
const object=(x:unknown): x is JsonObject => x!==null && typeof x==='object' && !Array.isArray(x);
function keys(x:JsonObject,allowed:string[],required=allowed):boolean {
  return Object.keys(x).every(k=>allowed.includes(k)) && required.every(k=>Object.hasOwn(x,k));
}
/** Python's sorted Unicode keys and default separators, for string/null cell payloads. */
export function pythonJson(value:unknown):string {
  if(Array.isArray(value)) return '['+value.map(pythonJson).join(', ')+']';
  if(object(value)) return '{'+Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .map(k=>JSON.stringify(k)+': '+pythonJson(value[k])).join(', ')+'}';
  return JSON.stringify(value);
}
export function stagingBatchId(fileHash:string):string {
  const bytes=createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex'))
    .update(fileHash+':'+VERSION).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&15)|80; bytes[8]=(bytes[8]!&63)|128;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export interface IntakePayload extends JsonObject {
  batch_id:string;sha256:string;filename:string;mapping_version:string;quality:JsonObject;rows:JsonObject[];
}
export function validateIntakePayload(value:unknown): asserts value is IntakePayload {
  if(!object(value)||!keys(value,['batch_id','sha256','filename','mapping_version','extracted_at','quality','rows'])
    || typeof value.sha256!=='string'||!hash.test(value.sha256)||value.batch_id!==stagingBatchId(value.sha256)
    || value.mapping_version!==VERSION||typeof value.filename!=='string'||value.filename.length<1||value.filename.length>255
    ||typeof value.extracted_at!=='string'||!object(value.quality)||!Array.isArray(value.rows)
    ||value.rows.length<1||value.rows.length>10000||Buffer.byteLength(JSON.stringify(value))>MAX_JSON)throw invalid();
  const q=value.quality;
  if(q.macro_present!==false||q.external_links_present!==false||!Array.isArray(q.sheets)||q.sheets.length<1||q.sheets.length>100)throw invalid();
  const sheets=new Map<string,{index:number,count:number,actual:number,last:number}>();
  for(const [i,s] of q.sheets.entries()) {
    if(!object(s)||typeof s.name!=='string'||!s.name||s.name.length>255||sheets.has(s.name)
      ||!Number.isInteger(s.nonempty_rows)||Number(s.nonempty_rows)<0||Number(s.nonempty_rows)>10000)throw invalid();
    sheets.set(s.name,{index:i,count:Number(s.nonempty_rows),actual:0,last:0});
  }
  let lastSheet=-1, dataCount=0;
  for(const row of value.rows) {
    if(!object(row)||!keys(row,['sheet','excel_row','row_hash','raw','mapped','state','issues'])
      ||typeof row.sheet!=='string'||!Number.isInteger(row.excel_row)||Number(row.excel_row)<1||Number(row.excel_row)>1048576
      ||!object(row.raw)||!keys(row.raw,['cells','sheet_state'])||!object(row.raw.cells)||typeof row.raw.sheet_state!=='string'
      ||!object(row.mapped)||!Array.isArray(row.issues)||!row.issues.every(i=>typeof i==='string')
      ||!['context','unreviewed','quarantined'].includes(String(row.state)))throw invalid();
    const sheet=sheets.get(row.sheet);
    if(!sheet||sheet.index<lastSheet||Number(row.excel_row)<=sheet.last)throw invalid();
    lastSheet=sheet.index;sheet.last=Number(row.excel_row);sheet.actual++;
    for(const [coord,cell]of Object.entries(row.raw.cells)) {
      if(!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(coord)||Number(coord.replace(/^[A-Z]+/,''))!==row.excel_row||!object(cell)
        ||!keys(cell,['value','stored','type','formula','formula_attributes','style'],['value','stored','type','formula','style'])
        ||!['value','stored','formula','style'].every(k=>cell[k]===null||typeof cell[k]==='string')
        ||typeof cell.type!=='string'||!(cell.formula_attributes===undefined||cell.formula_attributes===null
          ||object(cell.formula_attributes)&&Object.values(cell.formula_attributes).every(v=>typeof v==='string')))throw invalid();
    }
    if(row.row_hash!==createHash('sha256').update(pythonJson(row.raw)).digest('hex'))throw invalid();
    const isData=row.sheet==='除草剂汇总表'&&Number(row.excel_row)>1;
    if(isData) {
      dataCount++;
      const m=row.mapped;
      if(!keys(m,[...fields,'name_search','registration_number','dosage_form','concentration_text','unit_text','label_text','source_url','validity','review_status','card_ready'])
        ||m.validity!=='unknown'||m.review_status!=='unverified'||m.card_ready!==false
        ||!['registration_number','dosage_form','concentration_text','unit_text','label_text','source_url'].every(k=>m[k]===null)
        ||row.state!==(row.issues.length?'quarantined':'unreviewed'))throw invalid();
      for(const [i,field]of fields.entries()) {
        const cell=row.raw.cells[String.fromCharCode(65+i)+row.excel_row];
        const expected=object(cell)?cell.value:null;
        if(m[field]!==expected)throw invalid();
      }
      if(m.name_search!==(m.name_text===null?null:String(m.name_text).normalize('NFKC').trim()))throw invalid();
    }else if(row.state!=='context'||Object.keys(row.mapped).length||row.issues.length)throw invalid();
  }
  if([...sheets.values()].some(s=>s.actual!==s.count)||q.data_rows!==dataCount)throw invalid();
}
export function validateStagingDatabaseUrl(value:string|undefined):string {
  return validateSourceDatabaseUrl(value,['/gengyun_staging_intake_test','/gengyun_local']);
}
/** Captured pipe only: no caller JSON/SQL files, no private parent environment. */
export async function extractIntake(workbook:string,python:string):Promise<IntakePayload> {
  let path:string;
  try {
    path=realpathSync(workbook);
    const local=realpathSync(resolve(ROOT,'.local'));
    const rel=relative(local,path);
    if(rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel)||!path.toLowerCase().endsWith('.xlsx'))throw invalid();
  }catch{throw invalid();}
  const env:NodeJS.ProcessEnv={PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
  for(const k of ['PATH','SystemRoot','WINDIR','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
  const text=await new Promise<string>((accept,reject)=>{
    const child=spawn(python,[resolve(ROOT,'tools/knowledge/import_workbook_staging.py'),path,'--internal-json'],
      {env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let size=0,failed=false;const chunks:Buffer[]=[];
    const fail=()=>{if(!failed){failed=true;child.kill();reject(invalid());}};
    const timer=setTimeout(fail,15000);
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_JSON)fail();else chunks.push(chunk);});
    // Drain/discard stderr; it may contain input paths or parser excerpts.
    child.stderr.on('data',()=>{});child.on('error',fail);
    child.on('close',(code)=>{clearTimeout(timer);if(code!==0||failed)fail();else accept(Buffer.concat(chunks).toString('utf8'));});
  });
  let value:unknown;try{value=JSON.parse(text);}catch{throw invalid();}
  validateIntakePayload(value);return value;
}
function validateId(value:string){if(!uuid.test(value))throw invalid();}
export interface IntakeReceipt {
  operation_id:string;action:'import'|'rollback';batch_id:string;generation:number;payload_hash:string;
  row_count:number;state:'imported'|'reverted';import_id:string;replayed:boolean;
}
async function execute(pool:PgPool,text:string,values:unknown[],id:string,action:'import'|'rollback',batch:string):Promise<IntakeReceipt> {
  try {
    const result=await pool.query(text,values);const r=result.rows[0]?.result;
    if(!object(r)||r.operation_id!==id||r.action!==action||r.batch_id!==batch
      ||typeof r.payload_hash!=='string'||!hash.test(r.payload_hash)||!Number.isInteger(r.generation)||Number(r.generation)<1
      ||!Number.isInteger(r.row_count)||Number(r.row_count)<1||Number(r.row_count)>10000
      ||typeof r.import_id!=='string'||!uuid.test(r.import_id)||typeof r.replayed!=='boolean'
      ||r.import_id!==(action==='import'?id:values[2])
      ||r.state!==(action==='import'?'imported':'reverted'))throw new ApiError('PROVIDER_OUTCOME_UNKNOWN','暂存回执未确认，请保持操作编号核对');
    return {operation_id:id,action,batch_id:batch,generation:Number(r.generation),payload_hash:r.payload_hash,
      row_count:Number(r.row_count),state:r.state as IntakeReceipt['state'],import_id:r.import_id,replayed:r.replayed};
  }catch(e){
    if(e instanceof ApiError)throw e;
    const code=(e as {code?:unknown})?.code;
    if(['G0001','22P02','22023','23514','23502'].includes(String(code)))throw invalid();
    if(code==='G0004')throw new ApiError('SOURCE_CONFLICT','暂存批次归属、内容或世代不匹配');
    if(code==='G0005'||code==='23505')throw new ApiError('IDEMPOTENCY_CONFLICT','操作编号或批次已被其他请求使用');
    if(code==='57014')throw new ApiError('PROVIDER_TIMEOUT','暂存操作超时');
    throw new ApiError('PROVIDER_OUTCOME_UNKNOWN','暂存结果未确认，请保持同一操作编号核对');
  }
}
export async function importIntake(pool:PgPool,id:string,payload:unknown,previous?:string):Promise<IntakeReceipt> {
  validateId(id);if(previous!==undefined)validateId(previous);validateIntakePayload(payload);
  return execute(pool,'SELECT staging_intake.apply_import($1,$2::jsonb,$3) AS result',[id,JSON.stringify(payload),previous??null],id,'import',payload.batch_id);
}
export async function rollbackIntake(pool:PgPool,id:string,batch:string,importId:string,payloadHash:string):Promise<IntakeReceipt> {
  [id,batch,importId].forEach(validateId);if(!hash.test(payloadHash))throw invalid();
  return execute(pool,'SELECT staging_intake.rollback_import($1,$2,$3,$4) AS result',[id,batch,importId,payloadHash],id,'rollback',batch);
}
