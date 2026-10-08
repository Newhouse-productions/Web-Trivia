// Scope §7 criteria that need a real browser: the staleness warning, a
// half-typed answer surviving pause, focus never lost to a re-render, a
// phone waking from sleep, a hostile team name rendering as text on every
// surface, and the table token appearing in one URL only. Phone-sized
// Chromium, real pages, real polling.
//
// Needs Playwright, which is deliberately not a project dependency:
//   npm install --no-save playwright && npx playwright install chromium
//   npm run test:browser
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { startServer, stopServer, operator, hostActions, readTokens, checker, sleep, PASSPHRASE } from './lib.mjs';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch { /* fall through */ }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(`${globalRoot}/`)('playwright');
  } catch {
    console.log('Playwright is not installed. Run:\n  npm install --no-save playwright && npx playwright install chromium');
    process.exit(2);
  }
}
const { chromium } = loadPlaywright();

const check = checker();
const server = await startServer();
const { base } = server;
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const pageErrors = [];

async function phone(name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
  // 4xx responses and the deliberate aeroplane-mode failures are expected.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 4\d\d|ERR_INTERNET_DISCONNECTED/.test(m.text())) pageErrors.push(`${name}: ${m.text()}`);
  });
  const urls = [];
  page.on('request', (req) => urls.push(req.url()));
  return { context, page, urls };
}

async function joinTable(p, token, username) {
  await p.page.goto(`${base}/t/${token}`);
  await p.page.getByRole('textbox').first().fill(PASSPHRASE);
  await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(600);
  await p.page.getByRole('textbox').first().fill(username);
  await p.page.keyboard.press('Enter');
  await p.page.waitForSelector('.band');
}

try {
  const tokens = readTokens(server);
  const table = (n) => tokens.tables.find((t) => t.table_number === String(n));
  const host = await operator(base, 'host', 'Hana');
  const h = hostActions(host);
  const floor = await operator(base, 'floor', 'Flo');

  const ana = await phone('ana');
  await joinTable(ana, table(1).token, 'Ana');
  const ben = await phone('ben');
  await joinTable(ben, table(1).token, 'Ben');

  // -------------------------------------------------------------------
  console.log('\n14. The table token appears in one URL per device');
  const withToken = ana.urls.filter((u) => u.includes(table(1).token));
  check('only the initial /t/<token> request carries it', withToken.length === 1 && withToken[0].endsWith(`/t/${table(1).token}`), withToken);
  check('the page settles on plain /play', new URL(ana.page.url()).pathname === '/play' && !ana.page.url().includes(table(1).token));

  // -------------------------------------------------------------------
  console.log('\n10 / 21. A half-typed answer survives polls, pause and resume, without losing focus');
  await h.set(3, 'PENDING');
  await h.set(3, 'OPEN'); // free text: "Name the largest planet"
  await ana.page.waitForSelector('#answer-text', { state: 'visible', timeout: 8000 });
  await ana.page.click('#answer-text');
  await ana.page.keyboard.type('Jupi');
  // Something this table can see changes: a bonus bumps its version.
  await host('/host/bonus', { json: { team_id: table(1).id, points: 1, reason: 'Spirit', idempotency_key: 'b1' } });
  await ana.page.waitForFunction(() => /Score 1/i.test(document.body.innerText), null, { timeout: 8000 });
  check('a re-render on version change leaves the draft and focus alone',
    await ana.page.evaluate(() => document.activeElement?.id === 'answer-text' && document.activeElement.value === 'Jupi'));
  check('the change is announced through aria-live, not by moving focus',
    await ana.page.evaluate(() => document.querySelector('[aria-live]') !== null));
  await h.post('/host/pause', { reason: 'Speech', message: 'One moment please' });
  await ana.page.waitForFunction(() => /One moment please/.test(document.body.innerText), null, { timeout: 8000 });
  check('pause shows the pause message', true);
  check('the question is not readable during the pause', await ana.page.evaluate(() => {
    const overlay = document.querySelector('.paused-overlay');
    return overlay && getComputedStyle(overlay).display !== 'none';
  }));
  await h.post('/host/resume');
  await ana.page.waitForFunction(() => !/One moment please/.test(document.body.innerText) ||
    getComputedStyle(document.querySelector('.paused-overlay')).display === 'none', null, { timeout: 8000 });
  check('after resume the half-typed "Jupi" is still there', (await ana.page.inputValue('#answer-text')) === 'Jupi');
  await ana.page.click('#answer-text');
  await ana.page.keyboard.type('ter');
  await ana.page.getByRole('button', { name: 'Submit answer' }).click();
  await ana.page.waitForTimeout(800);

  // -------------------------------------------------------------------
  console.log('\n2. Takeover moves the controls between phones');
  await ben.page.waitForSelector('text=Take over as captain', { timeout: 8000 });
  check('a follower sees Take over and no answer field', await ben.page.isVisible('text=Take over as captain') && !(await ben.page.isVisible('#answer-text')));
  check("a follower sees the table's answer", /Jupiter/.test(await ben.page.innerText('.pbody')) && /Ana answered/.test(await ben.page.innerText('body')));
  await ben.page.getByRole('button', { name: 'Take over as captain' }).click();
  await ben.page.waitForSelector('#answer-text', { state: 'visible', timeout: 8000 });
  await ana.page.waitForSelector('text=Take over as captain', { timeout: 8000 });
  check('the answer field moves to the new captain and away from the old one',
    await ben.page.isVisible('#answer-text') && !(await ana.page.isVisible('#answer-text')));
  check("the new captain's field starts from the table's current answer", (await ben.page.inputValue('#answer-text')) === 'Jupiter');

  // -------------------------------------------------------------------
  console.log('\n3. A phone that sleeps shows the current question as soon as it wakes');
  await ben.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await h.set(3, 'CLOSED');
  await h.set(4, 'PENDING');
  await h.set(4, 'OPEN'); // "What is the capital of Japan?"
  await sleep(4000);
  check('while asleep the phone does not poll', !(await ben.page.isVisible('text=capital of Japan')));
  const wokeAt = Date.now();
  await ben.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await ben.page.waitForSelector('text=capital of Japan', { timeout: 5000 });
  check(`on wake it shows the live question (${Date.now() - wokeAt}ms, well within one poll)`, Date.now() - wokeAt < 3000);

  // -------------------------------------------------------------------
  console.log('\n4. Aeroplane mode shows the staleness warning, then recovers');
  await ana.context.setOffline(true);
  await ana.page.waitForSelector('.stale-banner:has-text("Reconnecting")', { timeout: 20000 });
  check('after ~10s offline: a quiet "Reconnecting…"', true);
  await ana.page.waitForSelector('.stale-banner:has-text("Out of date")', { timeout: 30000 });
  check('after 30s offline: a prominent "Out of date — tap Sync now"', true);
  await h.set(4, 'CLOSED');
  await ana.context.setOffline(false);
  await ana.page.getByRole('button', { name: 'Sync now' }).click();
  await ana.page.waitForFunction(() => getComputedStyle(document.querySelector('.stale-banner')).display === 'none', null, { timeout: 20000 });
  check('back online, the banner clears', true);
  await ana.page.waitForSelector('text=Answers are closed', { timeout: 8000 }).catch(() => {});
  check('and the phone shows answers have closed', /Answers are closed/.test(await ana.page.innerText('body')));

  // -------------------------------------------------------------------
  console.log('\n12. A hostile team name renders as text on every surface');
  const nasty = `<img src=x onerror=alert(1)>'"🦉`;
  await floor('/floor/rename', { json: { team_id: table(1).id, team_name: nasty } });
  await h.set(4, 'REVEALED');
  await h.post('/host/publish', { round: 1, force: true });
  const scr = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  scr.on('pageerror', (e) => pageErrors.push(`screen: ${e.message}`));
  await scr.goto(`${base}/screen/${tokens.screen}`);
  await scr.waitForSelector('text=Leaderboard', { timeout: 8000 }).catch(() => scr.waitForSelector('text=Top five'));
  await ana.page.waitForSelector('.lb', { timeout: 8000 });
  const hostPage = await browser.newPage();
  await hostPage.goto(`${base}/ops?role=floor&pin=333333&name=F`);
  await hostPage.waitForTimeout(1500);
  for (const [name, page] of [['phone', ana.page], ['big screen', scr]]) {
    const result = await page.evaluate((s) => ({
      shown: document.body.innerText.includes(s),
      injected: [...document.querySelectorAll('img')].some((img) => img.getAttribute('src') === 'x')
    }), nasty);
    check(`${name}: name shown literally, no element injected`, result.shown && !result.injected, result);
  }
  await hostPage.locator('button.tile', { hasText: /^1$/ }).first().click();
  await hostPage.waitForTimeout(800);
  check('floor console: name shown literally, no element injected', await hostPage.evaluate((s) =>
    document.body.innerText.includes(s) && ![...document.querySelectorAll('img')].some((img) => img.getAttribute('src') === 'x'), nasty));

  check('no script errors or blocked resources on any page', pageErrors.length === 0, pageErrors);
} catch (err) {
  check(`script error: ${err.message}`, false, err.stack);
} finally {
  await browser.close();
  await stopServer(server);
}

process.exitCode = check.summary() ? 0 : 1;
