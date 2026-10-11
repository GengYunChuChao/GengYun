const fs=require('node:fs'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=process.argv[2],bin=process.argv[3];
const c={owner:'gy_i07_owner_wx',runtime:'gy_i07_runtime_wx',database:'gy_i07_test_wechat',ownerPassword:crypto.randomBytes(24).toString('hex'),runtimePassword:crypto.randomBytes(24).toString('hex'),pgPort:55489,apiPort:3129};
fs.writeFileSync(root+'/private/config.json',JSON.stringify(c));fs.writeFileSync(root+'/private/owner-password',c.ownerPassword+'\n');
function run(name,args){const r=spawnSync(bin+'/'+name+'.exe',args,{stdio:'inherit',windowsHide:true});if(r.status!==0)throw Error(name+' failed')}
run('postgres',['--version']);run('initdb',['-D',root+'/data','-U',c.owner,'--pwfile='+root+'/private/owner-password','-A','scram-sha-256','--encoding=UTF8','--locale=C']);
fs.appendFileSync(root+'/data/postgresql.conf',"\nlisten_addresses='127.0.0.1'\nport=55489\npassword_encryption='scram-sha-256'\nlog_statement='none'\nlog_min_error_statement='panic'\n");
run('pg_ctl',['-D',root+'/data','-l',root+'/postgres.log','-w','start']);console.log('Fresh native WeChat test PG ready; credentials private and not printed');
