const { chromium } = require('playwright');
(async()=>{
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push({msg:e.message, stack:e.stack||''}));
  await page.goto('file:///C:/Users/Shama/OneDrive/Documents/Course_Materials/CPT-236/Side_Projects/COPrecinctMap/index.html');
  await page.waitForTimeout(2000);
  console.log(JSON.stringify(errors.slice(0,10), null, 2));
  await browser.close();
})();
