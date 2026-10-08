// Scope §7 acceptance criteria, run against a real server on a throwaway
// database. Each check names the criterion it covers. Criteria that need
// a real phone or browser (staleness banner, a half-typed draft surviving
// pause, screen-reader focus, readability from the back of the room) are
// covered by test/browser.mjs or listed at the end as manual.
//
//   npm test
import {
  startServer, stopServer, kill, launch, client, player, operator, hostActions, readTokens, checker, sleep, PASSPHRASE
} from './lib.mjs';

const check = checker();
const server = await startServer();
const { base } = server;

try {
  const tokens = readTokens(server);
  const table = (n) => tokens.tables.find((t) => t.table_number === String(n));
  const host = await operator(base, 'host', 'Hana');
  const h = hostActions(host);
  const admin = await operator(base, 'admin', 'Ada');
  const marker = await operator(base, 'marker', 'Mo');

  // Three accepted spellings for the free-text question (Q3, answer
  // Jupiter) — set before anyone answers, so it's a free edit.
  await admin('/admin/questions/3', { method: 'PUT', json: { aliases: ['jupitor', 'jupiter planet', 'the planet jupiter'] } });

  // ---------------------------------------------------------------------
  console.log('\n1. Scan, gate, name and answer within 30 seconds');
  await h.set(1, 'PENDING');
  await h.set(1, 'OPEN');
  let started = performance.now();
  const ana = client(base);
  const scan = await ana(`/t/${table(1).token}`);
  await ana('/gate', { json: { passphrase: PASSPHRASE } });
  await ana('/join', { json: { username: 'Ana' } });
  let r = await ana('/answer', { json: { question_id: 1, value: 'Sydney' } });
  const elapsed = performance.now() - started;
  check(`first answer accepted (server time ${elapsed.toFixed(0)}ms of the 30s budget)`, r.status === 200 && elapsed < 30000, r.body);

  // ---------------------------------------------------------------------
  console.log('\n2. Captain auto-assigns; takeover moves the controls');
  let st = (await ana('/state')).body;
  check('first player at a table is captain', st.team.is_captain === true);
  const ben = await player(base, table(1).token, 'Ben');
  st = (await ben('/state')).body;
  check('second player is a follower', st.team.is_captain === false && st.team.captain_name === 'Ana');
  r = await ben('/answer', { json: { question_id: 1, value: 'Perth' } });
  check('a follower cannot answer', r.status === 403);
  r = await ben('/takeover', { json: { expects_captain_player_id: st.team.captain_player_id } });
  check('takeover mid-question succeeds', r.status === 200);
  check('controls moved: Ben is captain, Ana is not',
    (await ben('/state')).body.team.is_captain === true && (await ana('/state')).body.team.is_captain === false);
  r = await ana('/answer', { json: { question_id: 1, value: 'Sydney' } });
  check('the old captain can no longer answer', r.status === 403);
  r = await ana('/takeover', { json: { expects_captain_player_id: st.team.captain_player_id } });
  check('a takeover based on a stale captain is refused, not applied twice', r.status === 409);

  // ---------------------------------------------------------------------
  console.log('\n3. A phone asleep for a while shows the current question within one poll');
  const cara = await player(base, table(2).token, 'Cara');
  const asleepAt = (await cara('/v')).body;
  await h.set(1, 'CLOSED');
  await h.set(1, 'REVEALED');
  await h.set(2, 'PENDING');
  await h.set(2, 'OPEN');
  const woke = (await cara('/v')).body;
  st = (await cara('/state')).body;
  check('one /v shows the version moved and one /state shows the live question',
    JSON.stringify(woke) !== JSON.stringify(asleepAt) && st.question.id === 2 && st.question.state === 'OPEN');

  // ---------------------------------------------------------------------
  console.log('\n5. An answer after close is rejected with its own message');
  await h.set(2, 'CLOSED');
  r = await cara('/answer', { json: { question_id: 2, value: 'Charles Dickens' } });
  check('rejected as closed_before_arrival with a message', r.status === 409 && r.body.error === 'closed_before_arrival' && /closed before your answer arrived/.test(r.body.message), r.body);

  // ---------------------------------------------------------------------
  console.log('\n6. Two host sessions cannot skip or reopen a question by accident');
  const host2 = await operator(base, 'host', 'Hugo');
  const v = await h.version();
  const [a, b] = await Promise.all([
    host('/host/state', { json: { question_id: 2, state: 'REVEALED', expects_version: v } }),
    host2('/host/state', { json: { question_id: 2, state: 'REVEALED', expects_version: v } })
  ]);
  const statuses = [a.status, b.status].sort().join(',');
  check('two hosts pressing Reveal together: one applies, the other is stale or a no-op', statuses === '200,200' || statuses === '200,409', statuses);
  r = await host2('/host/state', { json: { question_id: 2, state: 'OPEN', expects_version: v } });
  check('a stale screen pressing Reopen is refused with 409', r.status === 409 && r.body.error === 'stale', r.body);
  check('question 2 is still revealed', (await host('/host/state')).body.current.state === 'REVEALED');
  r = await host2('/host/state', { json: { question_id: 4, state: 'OPEN', expects_version: await h.version() } });
  check('jumping straight to OPEN on another question is refused (Show first)', r.status === 400);

  // ---------------------------------------------------------------------
  console.log('\n7. Free text: aliases auto-match, the marker judges only edge cases');
  const texters = [];
  const answers = ['Jupiter', 'jupitor', 'Jupiter planet', 'the planet jupiter', 'Jupyter', 'Saturn'];
  for (let i = 0; i < answers.length; i++) texters.push(await player(base, table(10 + i).token, `P${i}`));
  await h.set(3, 'PENDING');
  await h.set(3, 'OPEN');
  for (let i = 0; i < answers.length; i++) await texters[i]('/answer', { json: { question_id: 3, value: answers[i] } });
  await h.set(3, 'CLOSED');
  const queue = (await marker('/marker/queue')).body.questions.find((qq) => qq.id === 3);
  check('4 of 6 auto-matched; only "Jupyter" and "Saturn" wait for the marker', queue && queue.total_answers === 6 && queue.unmarked_count === 2, queue);
  const detail = (await marker('/marker/question/3')).body;
  check('marker has claimed the whole question', (await marker('/marker/queue')).body.questions.find((qq) => qq.id === 3).claim.marker === 'Mo');
  const marker2 = await operator(base, 'marker', 'Mia');
  r = await marker2('/marker/question/3');
  check('a second marker cannot open a claimed question', r.status === 409 && r.body.holder === 'Mo');

  // ---------------------------------------------------------------------
  console.log('\n8. "Accept for every table" re-scores correctly and is logged');
  const jupyterTeams = detail.answers.filter((x) => x.value === 'Jupyter').map((x) => x.team_id);
  const extra = await player(base, table(20).token, 'Late');
  await h.set(3, 'OPEN'); // reopen briefly so a second table can give the same spelling
  await extra('/answer', { json: { question_id: 3, value: 'jupyter' } });
  await h.set(3, 'CLOSED');
  await marker('/marker/question/3');
  r = await marker('/marker/alias', { json: { question_id: 3, alias: 'Jupyter' } });
  check('accepting "Jupyter" re-scores exactly the two tables that wrote it', r.status === 200 && r.body.rescored === 2, r.body);
  const after = (await marker('/marker/question/3')).body.answers;
  check('every Jupyter spelling is now correct', after.filter((x) => /jupyter/i.test(x.value)).every((x) => x.is_correct === true));
  const auditRows = (await admin('/admin/audit')).body.entries;
  check('logged in the audit trail', auditRows.some((e) => e.action === 'addAlias' && /Jupyter/.test(e.reason)));
  await marker('/marker/mark', { json: { question_id: 3, team_id: detail.answers.find((x) => x.value === 'Saturn').team_id, correct: false } });
  check('queue empty once Saturn is judged', !(await marker('/marker/queue')).body.questions.some((qq) => qq.id === 3));
  check('(jupyter teams were found)', jupyterTeams.length === 1);

  // ---------------------------------------------------------------------
  console.log('\n9. Reopening a marked question re-queues only the changed answer and releases the claim');
  await marker('/marker/claim', { json: { question_id: 3 } });
  await h.set(3, 'OPEN');
  const claimAfterReopen = (await marker('/marker/queue')).body.questions.find((qq) => qq.id === 3);
  check('claim released by the reopen', !claimAfterReopen || claimAfterReopen.claim.held === false);
  await texters[5]('/answer', { json: { question_id: 3, value: 'Jupitre' } }); // Saturn -> Jupitre
  await h.set(3, 'CLOSED');
  const requeued = (await marker('/marker/queue')).body.questions.find((qq) => qq.id === 3);
  check('only the changed answer is back in the queue', requeued && requeued.unmarked_count === 1, requeued);
  const marks = (await marker('/marker/question/3')).body.answers;
  check('the other marks stand', marks.filter((x) => x.is_correct === true).length === 6);
  await marker('/marker/mark', { json: { question_id: 3, team_id: marks.find((x) => x.value === 'Jupitre').team_id, correct: true } });
  await h.set(3, 'REVEALED');

  // ---------------------------------------------------------------------
  console.log('\n10. Pause hides the question and freezes writes; resume restores it');
  await h.set(4, 'PENDING');
  await h.set(4, 'OPEN');
  await h.post('/host/pause', { reason: 'Speech', message: 'One moment' });
  st = (await cara('/state')).body;
  check('phone payload while paused has no question at all', st.stage === 'paused' && !('question' in st) && st.message === 'One moment', st);
  const scr = client(base);
  await scr(`/screen/${tokens.screen}`);
  const sp = (await scr('/screen/state')).body;
  check('big screen payload while paused has no question', sp.stage === 'paused' && !('question' in sp));
  r = await cara('/answer', { json: { question_id: 4, value: 'Tokyo' } });
  check('answers are refused while paused', r.status === 423);
  r = await marker('/marker/queue');
  check('marking keeps working while paused', r.status === 200);
  await h.post('/host/resume');
  st = (await cara('/state')).body;
  check('resume restores exactly the open question', st.stage === 'play' && st.question.id === 4 && st.question.state === 'OPEN');

  // ---------------------------------------------------------------------
  console.log('\n11. The correct answer never reaches a player before reveal');
  const leaks = (obj) => JSON.stringify(obj).match(/"(correct_answer|aliases|av_cue)"/g);
  st = (await cara('/state')).body;
  check('OPEN: no correct_answer, aliases or cue in the phone payload', !leaks(st), leaks(st));
  check('OPEN: no answer key in the big screen payload', !leaks((await scr('/screen/state')).body));
  check('OPEN: "Tokyo" appears only as an option, never on its own', !JSON.stringify(st).replace(/"options":\[[^\]]*\]/, '').includes('Tokyo'));
  await h.set(4, 'CLOSED');
  check('CLOSED: still no answer key', !leaks((await cara('/state')).body) && !leaks((await scr('/screen/state')).body));
  await h.set(5, 'PENDING');
  st = (await cara('/state')).body;
  check('PENDING: not even the prompt is sent', !('prompt' in st.question) && !('options' in st.question), st.question);
  await h.set(5, 'OPEN');
  await h.set(5, 'CLOSED');
  await h.set(5, 'REVEALED');
  st = (await cara('/state')).body;
  check('REVEALED: the answer is sent', st.question.correct_answer === '2000s');

  // ---------------------------------------------------------------------
  console.log('\n12. A hostile team name is stored and served as plain text');
  const nasty = `<img src=x onerror=alert(1)>'"🦉`; // tag, both quotes and an emoji, under the 32 cap
  const dan = await player(base, table(25).token, 'Dan');
  r = await dan('/team-name', { json: { team_name: nasty } });
  check('rejected? no — accepted and stored verbatim (escaping is on output)', r.status === 409 || r.body.team_name === nasty, r.body);
  const floor = await operator(base, 'floor', 'Flo');
  const teamId25 = table(25).id;
  await floor('/floor/rename', { json: { team_id: teamId25, team_name: nasty } });
  st = (await dan('/state')).body;
  check('phone JSON carries the exact string', st.team.team_name === nasty, st.team.team_name);
  await floor('/floor/rename', { json: { team_id: teamId25, team_name: 'x'.repeat(31) + '🦉🦉' } });
  st = (await dan('/state')).body;
  check('a name over the cap is cut by character, never through an emoji', st.team.team_name === 'x'.repeat(31) + '🦉', st.team.team_name);
  await floor('/floor/rename', { json: { team_id: teamId25, team_name: nasty } });
  const qr = (await admin('/admin/tables/qr-sheet')).body;
  check('server-rendered HTML pages never contain the raw tag', !qr.includes('<img src=x'));
  const csp = (await dan('/play')).headers['content-security-policy'];
  check("CSP blocks inline script: script-src 'self' only", /script-src 'self'(;|$)/.test(csp) && !/unsafe-inline/.test(csp), csp);

  // ---------------------------------------------------------------------
  console.log('\n13. A bonus at one table does not wake the other tables');
  const vOther = (await cara('/v')).body;
  const vDan = (await dan('/v')).body;
  r = await host('/host/bonus', { json: { team_id: teamId25, points: 3, reason: 'Best costume', idempotency_key: 'k1' } });
  await host('/host/bonus', { json: { team_id: teamId25, points: 3, reason: 'Best costume', idempotency_key: 'k1' } });
  check("another table's /v is unchanged", JSON.stringify((await cara('/v')).body) === JSON.stringify(vOther));
  check("the awarded table's /v moved", JSON.stringify((await dan('/v')).body) !== JSON.stringify(vDan));
  check('a retried bonus is applied once', (await host('/host/scores')).body.scores.find((s) => s.team_id === teamId25).score >= 3 &&
    (await admin('/admin/audit')).body.entries.filter((e) => e.action === 'awardBonus').length === 1);

  // ---------------------------------------------------------------------
  console.log('\n14. The table token is used once per device, then never in a URL');
  check('/t/:token answers with a redirect to plain /play', scan.status === 302 && scan.headers.location === '/play', scan.headers.location);
  check('Referrer-Policy: no-referrer', scan.headers['referrer-policy'] === 'no-referrer');
  const everything = JSON.stringify([(await ana('/state')).body, (await ana('/v')).body]);
  check('no player payload carries a table token', !tokens.tables.some((t) => everything.includes(t.token)));
  check('the session cookie is HttpOnly', /HttpOnly/i.test(String(scan.headers['set-cookie'])));

  // ---------------------------------------------------------------------
  console.log('\n16. Every resolved theme passes 7:1 projection and 4.5:1 phone contrast');
  const themes = (await admin('/admin/theme')).body;
  const failing = themes.questions.filter((x) => !x.validation.pass).length + (themes.event_default.validation.pass ? 0 : 1);
  check(`all ${themes.questions.length} question themes and the event default pass`, failing === 0, failing);

  // ---------------------------------------------------------------------
  console.log('\n18. Round publishes; the big screen leaderboard matches the console');
  r = await h.post('/host/publish', { round: 1 });
  const consoleScores = (await host('/host/scores')).body.scores;
  const board = (await scr('/screen/state')).body;
  check('publish refused? only if unmarked — round 1 is fully marked', r.status === 200, r.body);
  check('big screen shows the round 1 leaderboard', board.stage === 'leaderboard' && board.round === 1);
  check('top five on screen match the console exactly',
    board.leaderboard.every((row, i) => row.team_id === consoleScores[i].team_id && row.score === consoleScores[i].score),
    { screen: board.leaderboard.map((x) => [x.team_name, x.score]), console: consoleScores.slice(0, 5).map((x) => [x.team_name, x.score]) });

  // ---------------------------------------------------------------------
  console.log('\n19. Killed mid-round, the process restarts with state intact — marking claims included');
  await h.set(7, 'PENDING');
  await h.set(7, 'OPEN');
  await texters[0]('/answer', { json: { question_id: 7, value: 'Gold' } });
  await h.set(7, 'CLOSED');
  await marker('/marker/question/7'); // takes the claim
  const before = { host: (await host('/host/state')).body, phone: (await texters[0]('/state')).body };
  await kill(server);
  await launch(server);
  const afterHost = (await host('/host/state')).body;
  check('host session survives the restart (cookies are stateless)', afterHost.version === before.host.version);
  check('current question and state survive', afterHost.current.id === 7 && afterHost.current.state === 'CLOSED');
  check("the phone's answer survives", (await texters[0]('/state')).body.our_answer.value === 'Gold');
  r = await marker2('/marker/question/7');
  check("Mo's marking claim survives, so Mia is still kept out", r.status === 409 && r.body.holder === 'Mo', r.body);
  check('scores survive', JSON.stringify((await host('/host/scores')).body.scores) === JSON.stringify((await host('/host/scores')).body.scores) &&
    (await host('/host/scores')).body.scores.find((s) => s.team_id === teamId25).score === consoleScores.find((s) => s.team_id === teamId25).score);

  // ---------------------------------------------------------------------
  console.log('\n20. The big screen opens from a bookmark with no typing');
  const venueLaptop = client(base);
  r = await venueLaptop(`/screen/${tokens.screen}`);
  check('bookmarked /screen/<token> signs in and redirects', r.status === 302 && r.headers.location === '/screen');
  check('…and the screen has state straight away', (await venueLaptop('/screen/state')).body.stage !== 'no_session');

  // ---------------------------------------------------------------------
  console.log('\n15. A finished event shows a plain "not running" message');
  await admin(`/admin/events/${tokens.eventId}/finish`, { method: 'POST' });
  r = await client(base)(`/t/${table(1).token}`);
  check('scanning a code: 200 with "isn\'t running", not a 404', r.status === 200 && /isn&#39;t running/.test(r.body), r.status);
  st = (await cara('/state')).body;
  check('an open phone gets event_not_running, not stale state', st.stage === 'event_not_running');
} catch (err) {
  check(`script error: ${err.message}`, false, err.stack);
} finally {
  await stopServer(server);
}

console.log(`
Not automated here — check by hand or with test/browser.mjs:
  4.  Aeroplane mode for 2 minutes shows the staleness warning, then recovers
  10. A half-typed answer survives pause and resume
  17. The big screen is readable from the back of the actual room
  21. A screen reader completes a full question without losing focus
  Load: npm run test:load`);

process.exitCode = check.summary() ? 0 : 1;
