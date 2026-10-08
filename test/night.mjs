// A whole night, simulated end to end: 30 tables of 8 phones (240
// players), a practice question and three rounds of ten imported from CSV,
// captains answering with realistic spelling, followers polling, live
// marking with alias acceptance, a takeover, a floor-entered answer,
// bonuses, a pause, two late tables, a skipped question, a publish after
// every round and the final board.
//
// Every score is checked against an independent tally kept by this script
// from what each table actually submitted — never from the app's own
// numbers — on the console, the big screen, every phone and the CSV export.
//
//   npm run test:night
import {
  startServer, stopServer, client, player, operator, hostActions, readTokens, checker, timingReport, timings
} from './lib.mjs';

const check = checker();

// Deterministic, so a failure reproduces.
let seed = 20260911;
const rand = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// --- the question set: 3 rounds x (7 mcq + 3 text), plus practice and reserve
const WORDS = ['Canberra', 'Everest', 'Picasso', 'Mozart', 'Nile', 'Saturn', 'Darwin', 'Tolkien', 'Kilimanjaro', 'Amazon'];
const questions = [];
for (let round = 1; round <= 3; round++) {
  for (let n = 1; n <= 10; n++) {
    const orderNo = (round - 1) * 10 + n;
    if (n <= 7) {
      const options = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((o) => `${o} ${orderNo}`);
      questions.push({ round, orderNo, type: 'mcq', prompt: `Round ${round} question ${n}?`, options, correct: options[orderNo % 4], points: round });
    } else {
      const word = WORDS[orderNo % WORDS.length];
      questions.push({
        round, orderNo, type: 'text', prompt: `Round ${round} free text ${n}?`,
        correct: word, aliases: [`Mt ${word}`, `${word.toLowerCase()}s`], points: round + 1
      });
    }
  }
}
const csv = ['round,order_no,type,prompt,options,correct_answer,aliases,points,image_file,image_alt,video_url,av_cue,layout,is_practice,is_reserve,av_alt']
  .concat(questions.map((q) => [q.round, q.orderNo, q.type, q.prompt, q.options ? q.options.join('|') : '', q.correct,
    q.aliases ? q.aliases.join('|') : '', q.points, '', '', '', '', '', '', '', ''].join(',')))
  .concat([',,mcq,Practice: what colour is the sky?,Blue|Green|Red,Blue,,0,,,,,,y,,', ',,mcq,Sudden death: 2 + 2?,3|4|5,4,,1,,,,,,,y,'])
  .join('\r\n');

// The common slip a marker would accept: the second letter doubled. The
// same slip at several tables is what "accept for every table" is for.
const misspell = (w) => w[0] + w[1] + w.slice(1);

const server = await startServer();
const { base } = server;
const started = Date.now();

try {
  const admin = await operator(base, 'admin', 'Ada');
  let r = await admin('/admin/questions/import', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv });
  check(`imported ${questions.length + 2} questions from CSV`, r.status === 200 && r.body.imported === 32, r.body);
  await admin('/admin/events/1/total-rounds', { method: 'PUT', json: { total_rounds: 3 } });

  const tokens = readTokens(server);
  const host = await operator(base, 'host', 'Hana');
  const h = hostActions(host);
  const marker = await operator(base, 'marker', 'Mo');
  const floor = await operator(base, 'floor', 'Flo');
  const screen = client(base);
  await screen(`/screen/${tokens.screen}`);

  const hostQuestions = (await host('/host/state')).body.questions;
  const idOf = (orderNo) => hostQuestions.find((q) => q.order_no === orderNo).id;
  const practiceId = hostQuestions.find((q) => q.is_practice).id;

  // --- tables and players -------------------------------------------------
  const tables = tokens.tables
    .sort((a, b) => Number(a.table_number) - Number(b.table_number))
    .map((t) => ({ ...t, skill: 0.35 + rand() * 0.55, phones: [], captain: 0, late: Number(t.table_number) >= 29 }));
  async function seatTable(t) {
    for (let i = 0; i < 8; i++) t.phones.push(await player(base, t.token, `T${t.table_number}P${i}`));
  }
  const joinStart = performance.now();
  await Promise.all(tables.filter((t) => !t.late).map(seatTable));
  check(`${tables.filter((t) => !t.late).length * 8} phones joined in ${((performance.now() - joinStart) / 1000).toFixed(1)}s`, true);

  // The independent tally: points this script believes each table earned.
  const expected = new Map(tables.map((t) => [t.id, { total: 0, byRound: { 1: 0, 2: 0, 3: 0 }, textCorrect: 0 }]));
  const truth = new Map(); // `${questionId}:${teamId}` -> true/false
  const credit = (t, q, ok) => {
    truth.set(`${idOf(q.orderNo)}:${t.id}`, ok);
    if (!ok) return;
    const e = expected.get(t.id);
    e.total += q.points;
    e.byRound[q.round] += q.points;
    if (q.type === 'text') e.textCorrect++;
  };

  const followersPoll = async () => {
    // Every follower polls /v; those whose version moved fetch /state.
    await Promise.all(tables.flatMap((t) => t.phones.map(async (p, i) => {
      if (i === t.captain) return;
      const v = await p('/v');
      if (v.status !== 200) throw new Error(`/v ${v.status}`);
      if (!p.lastV || JSON.stringify(v.body) !== p.lastV) {
        p.lastV = JSON.stringify(v.body);
        const s = await p('/state');
        if (s.status !== 200) throw new Error(`/state ${s.status}`);
      }
    })));
  };

  // --- practice question ----------------------------------------------------
  await h.set(practiceId, 'PENDING');
  await h.set(practiceId, 'OPEN');
  await Promise.all(tables.filter((t) => !t.late).map((t) => t.phones[0]('/answer', { json: { question_id: practiceId, value: 'Blue' } })));
  await h.set(practiceId, 'CLOSED');
  await h.set(practiceId, 'REVEALED');

  let aliasAccepted = 0;
  let floorEntered = false;
  let tookOver = false;
  const skipOrderNo = 27; // round 3: the host jumps past this one

  for (let round = 1; round <= 3; round++) {
    if (round === 2) {
      // Two tables arrive late; they score zero for round 1, nothing else.
      await Promise.all(tables.filter((t) => t.late).map(seatTable));
    }
    for (const q of questions.filter((qq) => qq.round === round)) {
      if (q.orderNo === skipOrderNo) continue;
      const qid = idOf(q.orderNo);
      await h.set(qid, 'PENDING');
      await h.set(qid, 'OPEN');

      if (round === 2 && q.orderNo === 13) {
        // Pause mid-question: answers refused, then accepted again.
        await h.post('/host/pause', { reason: 'Food service', message: 'Mains are out' });
        const refused = await tables[0].phones[tables[0].captain]('/answer', { json: { question_id: qid, value: q.options[0] } });
        check('during a pause a captain\'s answer is refused', refused.status === 423);
        await h.post('/host/resume');
      }
      if (round === 2 && q.orderNo === 14 && !tookOver) {
        // Table 3's captain leaves; a teammate takes over mid-question.
        const t = tables[2];
        const st = (await t.phones[1]('/state')).body;
        const res = await t.phones[1]('/takeover', { json: { expects_captain_player_id: st.team.captain_player_id } });
        check('a teammate takes over mid-question', res.status === 200);
        t.captain = 1;
        tookOver = true;
      }

      await Promise.all(tables.map(async (t) => {
        const captain = t.phones[t.captain];
        if (round === 2 && q.orderNo === 15 && t.table_number === '7') {
          // Table 7's phones are flat: Floor enters their answer.
          floorEntered = true;
          const res = await floor('/floor/answer-on-behalf', { json: { team_id: t.id, question_id: qid, value: q.type === 'mcq' ? q.correct : q.correct } });
          if (res.status !== 200) throw new Error('floor answer failed');
          credit(t, q, true);
          return;
        }
        if (round === 1 && t.late) return;
        if (rand() < 0.04) { // a table that never answers this one
          truth.set(`${qid}:${t.id}`, false);
          return;
        }
        const right = rand() < t.skill;
        let value;
        if (q.type === 'mcq') {
          value = right ? q.correct : pick(q.options.filter((o) => o !== q.correct));
          if (rand() < 0.15) { // changes their mind: first submission superseded
            await captain('/answer', { json: { question_id: qid, value: pick(q.options) } });
          }
        } else {
          const roll = rand();
          value = right
            ? (roll < 0.5 ? q.correct : roll < 0.75 ? pick(q.aliases) : roll < 0.9 ? q.correct.toUpperCase() : misspell(q.correct))
            : pick(WORDS.filter((w) => w !== q.correct));
          if (!right && rand() < 0.2) value = misspell(value);
        }
        const res = await captain('/answer', { json: { question_id: qid, value } });
        if (res.status !== 200) throw new Error(`answer ${res.status} ${JSON.stringify(res.body)}`);
        credit(t, q, right);
      }));

      await followersPoll();
      await h.set(qid, 'CLOSED');

      // Live marking as each free-text question closes (CLAUDE.md #7).
      if (q.type === 'text') {
        const detail = (await marker(`/marker/question/${qid}`)).body;
        const pending = detail.answers.filter((a) => a.is_correct === null);
        // A misspelling of the right answer at two or more tables: accept
        // it for every table at once rather than one by one.
        const counts = new Map();
        for (const a of pending) if (truth.get(`${qid}:${a.team_id}`)) counts.set(a.value.toLowerCase(), (counts.get(a.value.toLowerCase()) || 0) + 1);
        const common = [...counts.entries()].find(([, n]) => n >= 2);
        if (common) {
          const res = await marker('/marker/alias', { json: { question_id: qid, alias: common[0] } });
          aliasAccepted += res.body.rescored;
        }
        const still = (await marker(`/marker/question/${qid}`)).body.answers.filter((a) => a.is_correct === null);
        for (const a of still) {
          await marker('/marker/mark', { json: { question_id: qid, team_id: a.team_id, correct: !!truth.get(`${qid}:${a.team_id}`) } });
        }
        await marker('/marker/release', { json: { question_id: qid } });
      }

      await h.set(qid, 'REVEALED');
      await followersPoll();
    }

    if (round === 2) {
      // Bonuses: additive, idempotent, never in the countback.
      for (const [n, pts] of [[5, 3], [12, 2]]) {
        const t = tables.find((tt) => tt.table_number === String(n));
        const key = `bonus-${n}`;
        await host('/host/bonus', { json: { team_id: t.id, points: pts, reason: 'Best costume', idempotency_key: key } });
        await host('/host/bonus', { json: { team_id: t.id, points: pts, reason: 'Best costume', idempotency_key: key } }); // retry
        expected.get(t.id).total += pts;
        expected.get(t.id).bonus = pts;
      }
    }

    // --- publish and verify --------------------------------------------------
    const queue = (await marker('/marker/queue')).body.questions.filter((qq) => qq.round === round);
    check(`round ${round}: marking queue empty before publish`, queue.length === 0, queue);
    r = await h.post('/host/publish', { round });
    check(`round ${round}: published${round === 3 ? ' (question 27 never asked → skipped)' : ''}`, r.status === 200 && r.body.skipped === (round === 3 ? 1 : 0), r.body);

    const scores = (await host('/host/scores')).body.scores;
    const mismatches = scores.filter((s) => s.score !== expected.get(s.team_id).total)
      .map((s) => ({ table: s.table_number, app: s.score, expected: expected.get(s.team_id).total }));
    check(`round ${round}: all 30 console scores match the independent tally`, mismatches.length === 0, mismatches);

    const board = (await screen('/screen/state')).body;
    const top = scores.slice(0, board.leaderboard?.length || 0);
    check(`round ${round}: big screen shows ${round < 3 ? 'top five' : 'the full board'} and matches the console`,
      board.stage === 'leaderboard' && board.leaderboard.length === (round < 3 ? 5 : 30) &&
      board.leaderboard.every((row, i) => row.team_id === top[i].team_id && row.score === top[i].score),
      { stage: board.stage, n: board.leaderboard?.length });

    const phoneScores = await Promise.all(tables.filter((t) => t.phones.length).map(async (t) => {
      const st = (await t.phones[t.captain]('/state')).body;
      return { t, st };
    }));
    const wrongPlace = phoneScores.filter(({ t, st }) =>
      st.stage !== 'leaderboard' || st.our_place !== scores.findIndex((s) => s.team_id === t.id) + 1);
    check(`round ${round}: every seated table's phone shows its own correct place`, wrongPlace.length === 0, wrongPlace.map(({ t, st }) => [t.table_number, st.our_place]));

    // Ordering: total, then countback (round 3, round 2, free text correct),
    // bonuses excluded from countback, then table number.
    const order = [...tables].sort((a, b) => {
      const A = expected.get(a.id); const B = expected.get(b.id);
      return B.total - A.total || B.byRound[3] - A.byRound[3] || B.byRound[2] - A.byRound[2] ||
        B.textCorrect - A.textCorrect || Number(a.table_number) - Number(b.table_number);
    }).map((t) => t.id);
    check(`round ${round}: leaderboard order follows total, then countback, then table number`,
      scores.every((s, i) => s.team_id === order[i]), { app: scores.slice(0, 8).map((s) => s.table_number), expected: order.slice(0, 8) });
  }

  // --- end of night ------------------------------------------------------------
  const hs = (await host('/host/state')).body;
  check('host console reaches the final screen', hs.phase === 'final', hs.phase);
  check('a floor-entered answer and a takeover happened during the night', floorEntered && tookOver);
  check(`"accept for every table" used during marking (${aliasAccepted} answers re-scored)`, aliasAccepted > 0);

  const exportCsv = (await host('/host/results/export')).body;
  const finalBlock = exportCsv.split('\r\n\r\n')[1].split('\r\n').slice(1).map((l) => l.split(','));
  const csvMismatch = finalBlock.filter(([tn, , score]) => {
    const t = tables.find((tt) => tt.table_number === tn);
    return Number(score) !== expected.get(t.id).total;
  });
  check('results CSV final scores match the tally', finalBlock.length === 30 && csvMismatch.length === 0, csvMismatch);
  check('results CSV carries no usernames', !/T\d+P\d/.test(exportCsv));
  const answerRows = exportCsv.split('\r\n\r\n')[0].split('\r\n').slice(1).map((l) => l.split(','));
  check('late tables have no round 1 answers, and do have round 2 answers',
    !answerRows.some(([tn, , rnd]) => ['29', '30'].includes(tn) && rnd === '1') &&
    answerRows.some(([tn, , rnd]) => tn === '29' && rnd === '2'));

  const leader = (await host('/host/scores')).body.scores[0];
  const winner = tables.find((t) => t.id === leader.team_id);
  console.log(`\nWinner: Table ${winner.table_number} with ${expected.get(winner.id).total} points` +
    ` · ${((Date.now() - started) / 1000).toFixed(1)}s for the whole night`);
  const requests = [...timings.values()].reduce((n, v) => n + v.length, 0);
  console.log(`\n${requests} requests. Latency by endpoint:`);
  console.log(timingReport((k) => !k.startsWith('/admin/questions/import')));
} catch (err) {
  check(`script error: ${err.message}`, false, err.stack);
} finally {
  await stopServer(server);
}

process.exit(check.summary() ? 0 : 1);
