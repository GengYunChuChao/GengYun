const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const [sdkDir, outDir] = process.argv.slice(2);
const sdk = require(path.resolve(sdkDir));
(async () => {
  const m = await sdk.connect({wsEndpoint: 'ws://127.0.0.1:9425'}), out = path.resolve(outDir);
  fs.mkdirSync(out, {recursive:true}); const report = {width: (await m.systemInfo()).windowWidth, cases:[]}; assert.equal(report.width,320);
  try {
    for (const scale of [1,1.3]) {
      if (scale === 1.3) await m.evaluate(() => {const a=getApp(); a.__knowledgeTestOriginalRefresh=a.refreshFontScale; a.refreshFontScale=function(){this.globalData.fontScale=1.3;return 1.3}});
      await m.reLaunch('/pages/knowledge/knowledge'); let p=await m.currentPage(); await p.waitFor(async()=>!(await p.data('busy')) && (await p.data('items')).length===1);
      const c={scale, elements:[]};
      async function bounds(page, selector) {for(const e of await page.$$(selector)){const size=await e.size(), at=await e.offset(); c.elements.push({selector,width:size.width,height:size.height,left:at.left});assert.ok(at.left>=-1&&at.left+size.width<=321,'horizontal bounds: '+selector);return e}}
      for(const sel of ['.query-input','.chips','.article-card']) await bounds(p,sel);
      const card = await p.$('.article-card'); await m.pageScrollTo((await card.offset()).top-20); await m.screenshot({path:path.join(out,'list-card-'+scale+'.png')});
      const b = await card.$('button');await m.pageScrollTo((await b.offset()).top-80);await b.tap();for(let n=0;n<100;n++){p=await m.currentPage();if(p.path==='pages/knowledgedetail/knowledgedetail')break;await new Promise(r=>setTimeout(r,100))}await p.waitFor(async()=>!!(await p.data('item')));
      const back=await bounds(p,'.back-button');c.backFont=await back.style('font-size');assert.ok(parseFloat(c.backFont)>=18*scale-.1);assert.ok((await back.size()).height>=44*scale-.1);
      for(const sel of ['.detail-heading','.article-card','.stat-grid','.source-url']) await bounds(p,sel);
      await m.pageScrollTo((await(await p.$('.article-card')).offset()).top-20); await m.screenshot({path:path.join(out,'detail-body-'+scale+'.png')});
      report.cases.push(c);
    }
    fs.writeFileSync(path.join(out,'geometry.json'),JSON.stringify(report,null,2)+'\n'); console.log('PASS actual 320px standard and controlled large text; component bounds, back font/height');
  } finally {
    await m.evaluate(()=>{const a=getApp();if(a.__knowledgeTestOriginalRefresh){a.refreshFontScale=a.__knowledgeTestOriginalRefresh;delete a.__knowledgeTestOriginalRefresh}a.refreshFontScale()});await m.reLaunch('/pages/home/home');m.disconnect();
  }
})().catch(e=>{console.error(e.message);process.exitCode=1});

