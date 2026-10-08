// Load test (scope §7): 300 phones polling /v for 10 minutes against
// localhost — the app's numbers, not the tunnel's (CLAUDE.md). Every phone
// is a real signed-in player with its own session, polling at 3s ± 500ms
// like the real page, fetching /state whenever its version moves. The host
// console (1s), a marker (1s) and the big screen poll alongside, and the
// host runs questions throughout so every phone keeps refetching state the
// way it would on the night.
//
// Pass: no errors, and keep-alive confirmed — requests reuse connections
// rather than opening one per poll.
//
//   npm run test:load                    # 10 minutes, 300 phones
//   LOAD_MINUTES=1 LOAD_PHONES=300 npm run test:load
import {
  startServer, stopServer, client, player, operator, hostActions, readTokens, checker, percentile, sleep
} from './lib.mjs';

const MINUTES = Number(process.env.LOAD_MINUTES || 10);
const PHONES = Number(process.env.LOAD_PHONES || 300);
const check = checker();
const server = await startServer();
const { base } = server;

const stats = { requests: 0, errors: [], reused: 0, latency: { v: [], state: [], ops: [] }, perSecond: new Map() };
function record(kind, started, res) {
  stats.requests++;
  if (res.reused) stats.reused++;
  stats.latency[kind].push(performance.now() - started);
  const sec = Math.floor(Date.now() / 1000);
  stats.perSecond.set(sec, (stats.perSecond.get(sec) || 0) + 1);
  if (res.status !== 200) stats.errors.push(`${kind} ${res.status}`);
}

try {
  const tokens = readTokens(server);
  const host = await operator(base, 'host', 'Hana');
  const h = hostActions(host);
  const marker = await operator(base, 'marker', 'Mo');
  const screen = client(base);
  await screen(`/screen/${tokens.screen}`);

  process.stdout.write(`Seating ${PHONES} phones… `);
  const phones = [];
  for (let i = 0; i < PHONES; i++) {
    const t = tokens.tables[i % tokens.tables.length];
    phones.push(await player(base, t.token, `L${i}`));
  }
  console.log('done.');

  const endAt = Date.now() + MINUTES * 60 * 1000;
  let running = true;

  async function pollLoop(call, vPath, statePath, intervalMs, jitterMs, kind) {
    let last = null;
    await sleep(Math.random() * intervalMs); // phones don't start in lockstep
    while (running) {
      try {
        let t0 = performance.now();
        const v = await call(vPath);
        record(kind, t0, v);
        const key = JSON.stringify(v.body);
        if (key !== last) {
          t0 = performance.now();
          const s = await call(statePath);
          record(kind === 'v' ? 'state' : kind, t0, s);
          last = key;
        }
      } catch (err) {
        stats.errors.push(`${kind} ${err.code || err.message}`);
      }
      await sleep(intervalMs + (Math.random() * 2 - 1) * jitterMs);
    }
  }

  // The host runs the question set on a loop: a state change every few
  // seconds wakes all 300 phones at once — the thundering herd /v exists for.
  const ids = (await host('/host/state')).body.questions.filter((q) => !q.is_practice && !q.is_reserve).map((q) => q.id);
  let changes = 0;
  async function hostLoop() {
    let i = 0;
    while (running) {
      const id = ids[i % ids.length];
      for (const state of ['PENDING', 'OPEN', 'CLOSED', 'REVEALED']) {
        if (!running) return;
        try { await h.set(id, state); changes++; } catch (err) { stats.errors.push(`host ${err.message}`); }
        await sleep(5000);
      }
      i++;
    }
  }

  const loops = [
    ...phones.map((p) => pollLoop(p, '/v', '/state', 3000, 500, 'v')),
    pollLoop(host, '/host/v', '/host/state', 1000, 0, 'ops'),
    pollLoop(marker, '/marker/v', '/marker/queue', 1000, 0, 'ops'),
    pollLoop(screen, '/screen/v', '/screen/state', 3000, 500, 'ops'),
    hostLoop()
  ];

  const startedAt = Date.now();
  const progress = setInterval(() => {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`  ${mins} min · ${stats.requests} requests · ${stats.errors.length} errors · ` +
      `/v p95 ${percentile(stats.latency.v, 95).toFixed(1)}ms`);
  }, 60000);
  await sleep(endAt - Date.now());
  running = false;
  clearInterval(progress);
  await Promise.all(loops);

  const secs = [...stats.perSecond.values()];
  console.log(`\n${PHONES} phones for ${MINUTES} min: ${stats.requests} requests, ${changes} host state changes`);
  console.log(`  throughput: mean ${(stats.requests / (MINUTES * 60)).toFixed(0)}/s, peak ${Math.max(...secs)}/s`);
  for (const [kind, label] of [['v', '/v (phones)'], ['state', '/state (phones)'], ['ops', 'operators + screen']]) {
    const l = stats.latency[kind];
    console.log(`  ${label.padEnd(20)} n=${String(l.length).padStart(7)}  p50=${percentile(l, 50).toFixed(1)}ms  ` +
      `p95=${percentile(l, 95).toFixed(1)}ms  p99=${percentile(l, 99).toFixed(1)}ms  max=${Math.max(...l).toFixed(1)}ms`);
  }
  const reuseRate = stats.reused / stats.requests;
  console.log(`  connections reused: ${(reuseRate * 100).toFixed(2)}% of requests\n`);

  check('no errors', stats.errors.length === 0, stats.errors.slice(0, 10));
  check('keep-alive confirmed: over 99% of requests reuse a connection', reuseRate > 0.99, reuseRate);
  check('/v p99 under 100ms', percentile(stats.latency.v, 99) < 100, percentile(stats.latency.v, 99));
  check('every phone kept polling the whole time', stats.latency.v.length > PHONES * (MINUTES * 60 / 3.5) * 0.9, stats.latency.v.length);
} catch (err) {
  check(`script error: ${err.message}`, false, err.stack);
} finally {
  await stopServer(server);
}

process.exitCode = check.summary() ? 0 : 1;
