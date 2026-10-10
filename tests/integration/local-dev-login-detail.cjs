const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
if(process.argv.length<3||process.argv.length>4){console.error('Usage: node tests/integration/local-dev-login-detail.cjs <official SDK directory> [loopback API port]');process.exit(1);}
const apiPort=Number(process.argv[3]||3100);assert.ok(Number.isInteger(apiPort)&&apiPort>=1024&&apiPort<=65535);
const sdk=require(path.resolve(process.argv[2]));const out=path.resolve(__dirname,'../../.local');let mini,stage='connect';
const deadline=setTimeout(()=>{console.error('GUI timeout at '+stage+'; no session or code printed.');mini?.disconnect();process.exit(2);},120000);
(async()=>{
 for(let n=0;n<5&&!mini;n++){try{mini=await sdk.connect({wsEndpoint:'ws://127.0.0.1:9420'});}catch(e){if(n===4)throw e;await new Promise(r=>setTimeout(r,300));}}
 const info=await mini.systemInfo();const report={kind:'actual WeChat simulator + loopback API + persistent PostgreSQL; synthetic server identity',SDKVersion:info.SDKVersion,windowWidth:info.windowWidth,cases:[]};
 for(const [name,id] of [['referencedetail','gy-i03-hb-001'],['referenceseeddetail','gy-i07-seed-hb-001']]){
  stage=name+'-guest';await mini.callWxMethod('removeStorageSync','gengyun.session');stage=name+'-home';console.log('GUI '+stage);const home=await mini.reLaunch('/pages/home/home');assert.equal(home.path,'pages/home/home');assert.equal(await home.data('local'),true);await home.waitFor(async()=>!(await home.data('loggedIn')));
  stage=name+'-navigation';let login;try{login=await mini.navigateTo('/pages/'+name+'/'+name+'?id='+id);}catch{login=await mini.currentPage();}for(let n=0;n<40&&login.path!=='pages/login/login';n++){await new Promise(r=>setTimeout(r,250));login=await mini.currentPage();}assert.equal(login.path,'pages/login/login');assert.equal(await login.data('busy'),false);
  stage=name+'-login';await(await login.$('button')).tap();let target;
  for(let n=0;n<40;n++){const page=await mini.currentPage();if(page.path==='pages/'+name+'/'+name){target=page;break;}await new Promise(r=>setTimeout(r,250));}
  assert.ok(target,'Login must return to the actual requested detail');await target.waitFor(async()=>await target.data('gatePassed')&&await target.data('found'));
  assert.equal(await mini.evaluate(()=>typeof getCurrentPages()[getCurrentPages().length-1].checkGate),'function');
  assert.ok(await target.data(name==='referencedetail'?'detail':'item'));
  await mini.screenshot({path:path.join(out,'pr68-'+name+'-gui.png')});report.cases.push({page:name,id,gatePassed:true,found:true});console.log('PASS GUI actual guest → login → original '+name+' → verified data rendered.');
 }
 stage='logout';const cached=await mini.callWxMethod('getStorageSync','gengyun.session');assert.ok(cached&&typeof cached.accessToken==='string');const login=await mini.reLaunch('/pages/login/login');assert.equal(await login.data('loggedIn'),true);
 let logout;for(const button of await login.$$('button'))if((await button.text()).includes('退出登录'))logout=button;assert.ok(logout);await logout.tap();await login.waitFor(async()=>!(await login.data('loggedIn'))&&/服务端会话已撤销/.test(await login.data('status')));
 const revoked=await fetch('http://127.0.0.1:'+apiPort+'/api/v1/auth/session',{headers:{authorization:'Bearer '+cached.accessToken}});assert.equal(revoked.status,401);report.logout={serverAck:true,revokedHTTPStatus:401};
 await mini.reLaunch('/pages/home/home');fs.writeFileSync(path.join(out,'pr68-login-detail-gui.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS GUI logout Ack + actual HTTP rejects old token; synthetic identity, not real WeChat server exchange.');
 mini.disconnect();clearTimeout(deadline);
})().catch(e=>{console.error('GUI failed at '+stage+'; error type='+e.name+'; no sensitive values printed.');clearTimeout(deadline);mini?.disconnect();process.exitCode=1;});
