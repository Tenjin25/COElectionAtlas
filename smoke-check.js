const { chromium } = require('playwright');
(async()=>{
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror:' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console:' + m.text()); });

  await page.goto('file:///C:/Users/Shama/OneDrive/Documents/Course_Materials/CPT-236/Side_Projects/COPrecinctMap/index.html');
  await page.waitForTimeout(1800);

  const contest = await page.$('#contestSelect');
  const jumps = await page.$$('[data-region-jump]');
  const countiesBtn = await page.$('#counties-view');
  const districtsBtn = await page.$('#districts-view');

  if (jumps[0]) await jumps[0].click().catch(()=>{});
  await page.waitForTimeout(300);
  if (districtsBtn) await districtsBtn.click().catch(()=>{});
  await page.waitForTimeout(300);

  const visibleSearch = await page.locator('#desktop-fly-search:visible, #county-search:visible').first();
  if (await visibleSearch.count()) {
    await visibleSearch.fill('Denver').catch(()=>{});
    await page.keyboard.press('Enter').catch(()=>{});
    await page.waitForTimeout(600);
  }

  await page.screenshot({ path: 'smoke-interaction.png', fullPage: true });

  console.log(JSON.stringify({
    contest: !!contest,
    jumps: jumps.length,
    countiesBtn: !!countiesBtn,
    districtsBtn: !!districtsBtn,
    errors: errors.slice(0, 20)
  }));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
