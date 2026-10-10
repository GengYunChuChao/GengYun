const assert=require('node:assert/strict');
const path=require('node:path');
if(process.argv.length!==3){console.error('Usage: node tests/integration/local-dev-wechat.cjs <official SDK module directory>');process.exit(1);}
const automator=require(path.resolve(process.argv[2]));
const deadline=setTimeout(()=>{console.error('GUI verification timeout; no credentials printed.');process.exit(1);},45000);deadline.unref();
let stage='automation-connect';
async function main(){
 const mini=await automator.connect({wsEndpoint:'ws://127.0.0.1:9420'});
 try{
  let home;
  for(let n=0;n<30;n++){home=await mini.currentPage();if(home&&await home.$('.title'))break;await new Promise(r=>setTimeout(r,500));}
  stage='home-render';home=await mini.switchTab('/pages/home/home');
  assert.equal(await (await home.$('.title')).text(),'耕云');
  assert.equal(await home.data('local'),true);
  const buttons=await home.$$('button');
  let diagnostic;
  for(const button of buttons)if((await button.text()).includes('本地替身'))diagnostic=button;
  stage='diagnostic-request';assert.ok(diagnostic);await diagnostic.tap();
  await home.waitFor(500);
  await home.waitFor(async()=>{const data=await home.data();return !data.busy&&/API 与 PostgreSQL 已连接/.test(data.status);});
  console.log('PASS actual simulator rendering and local HTTP diagnostic.');
  stage='login-render';let login=await mini.reLaunch('/pages/login/login');
  stage='login-request';await (await login.$('button')).tap();
  for(let n=0;n<30;n++){const p=await mini.currentPage();if(p.path==='pages/home/home')break;await new Promise(r=>setTimeout(r,500));}
  home=await mini.currentPage();assert.equal(home.path,'pages/home/home');
  await home.waitFor(async()=>await home.data('loggedIn'));
  console.log('PASS simulator wx.login → synthetic backend session → home verified. Not real WeChat identity exchange.');
  stage='reference-render';const reference=await mini.navigateTo('/pages/reference/reference');assert.equal(reference.path,'pages/reference/reference');
  await reference.waitFor('.title');console.log('PASS authenticated reference page rendered.');
  await mini.switchTab('/pages/home/home');
  await mini.screenshot({path:path.resolve(__dirname,'../../.local/local-dev/local-home.png')});
 }finally{mini.disconnect();}
}
main().catch(error=>{console.error('GUI smoke failed at '+stage+'; error type='+error.name+'; no credentials or session values printed.');process.exitCode=1;});
