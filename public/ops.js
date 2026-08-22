// Minimal host console: role sign-in, then absolute setQuestion commands
// with a version guard (CLAUDE.md #8). Marker/Floor/Admin arrive in later
// build steps; picking those roles here just says so for now.
(function () {
  const app = document.getElementById('app');
  let pollHandle = null;
  let lastState = null;
  let hostEls = null;

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function renderRolePicker() {
    clear(app);
    const heading = document.createElement('h1');
    heading.textContent = 'Operator sign in';
    app.appendChild(heading);

    ['host', 'marker', 'floor', 'admin'].forEach((role) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = role[0].toUpperCase() + role.slice(1);
      btn.addEventListener('click', () => renderPinForm(role));
      app.appendChild(btn);
    });
  }

  function renderPinForm(role) {
    clear(app);
    const heading = document.createElement('h1');
    heading.textContent = `${role[0].toUpperCase()}${role.slice(1)} sign in`;

    const form = document.createElement('form');

    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Your name';
    const nameInput = document.createElement('input');
    nameInput.maxLength = 20;
    nameInput.autocomplete = 'off';

    const pinLabel = document.createElement('label');
    pinLabel.textContent = 'PIN';
    const input = document.createElement('input');
    input.type = 'password';
    input.inputMode = 'numeric';
    input.maxLength = 6;
    input.autocomplete = 'off';

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Sign in';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back';
    back.addEventListener('click', renderRolePicker);
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');

    form.append(nameLabel, nameInput, pinLabel, input, button, error);
    app.append(heading, form, back);
    nameInput.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      button.disabled = true;
      try {
        const res = await fetch('/ops/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, pin: input.value, name: nameInput.value })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          if (data.role === 'host') startHost();
          else if (data.role === 'marker') startMarker();
          else if (data.role === 'admin') startAdmin();
          else renderNotBuilt(data.role);
        } else if (res.status === 423) {
          error.textContent = 'This role is locked after too many failed attempts.';
        } else if (res.status === 429) {
          error.textContent = 'Too many attempts. Wait a moment.';
        } else {
          error.textContent = data.message || 'Incorrect PIN.';
        }
      } catch {
        error.textContent = 'Could not reach the server.';
      } finally {
        button.disabled = false;
      }
    });
  }

  function renderNotBuilt(role) {
    clear(app);
    const p = document.createElement('p');
    p.textContent = `The ${role} console isn't built yet.`;
    app.appendChild(p);
  }

  function startHost() {
    clear(app);
    hostEls = {};

    const vitals = document.createElement('p');
    vitals.className = 'vitals';
    app.appendChild(vitals);
    hostEls.vitals = vitals;

    const answered = document.createElement('p');
    app.appendChild(answered);
    hostEls.answered = answered;

    buildPauseControl();

    const list = document.createElement('div');
    list.className = 'question-list';
    app.appendChild(list);
    hostEls.list = list;

    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    app.appendChild(error);
    hostEls.error = error;

    buildTableSupport();
    buildScoresPanel();

    refreshHost();
    pollHandle = window.Poll.start({
      vUrl: '/host/v',
      stateUrl: '/host/state',
      intervalMs: 1000,
      onState: renderHost
    });
  }

  async function refreshHost() {
    const res = await fetch('/host/state', { cache: 'no-store' });
    const state = await res.json();
    renderHost(state);
  }

  function renderHost(state) {
    lastState = state;
    hostEls.vitals.textContent =
      `Round phase: ${state.round_phase} — version ${state.version}` +
      (state.current ? ` — current: Q${state.current.id} (${state.current.state})` : ' — no current question');

    hostEls.answered.textContent = state.current
      ? `Answered: ${state.answered.count}/${state.answered.total}`
      : '';

    clear(hostEls.list);
    state.questions.forEach((qu) => {
      const row = document.createElement('div');
      row.className = 'question-row';

      const label = document.createElement('span');
      label.textContent = `R${qu.round} Q${qu.order_no}: ${qu.prompt}`;
      row.appendChild(label);

      const isCurrent = state.current && state.current.id === qu.id;
      const currentState = isCurrent ? state.current.state : null;

      const actions = [
        { state: 'PENDING', label: 'Show', enabled: !isCurrent },
        { state: 'OPEN', label: 'Open', enabled: isCurrent && currentState === 'PENDING' },
        { state: 'CLOSED', label: 'Close', enabled: isCurrent && currentState === 'OPEN' },
        { state: 'REVEALED', label: 'Reveal', enabled: isCurrent && currentState === 'CLOSED' },
        { state: 'OPEN', label: 'Reopen', enabled: isCurrent && (currentState === 'CLOSED' || currentState === 'REVEALED') }
      ];

      actions.forEach((action) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = action.label;
        btn.disabled = !action.enabled;
        btn.addEventListener('click', () => sendCommand(qu.id, action.state));
        row.appendChild(btn);
      });

      hostEls.list.appendChild(row);
    });
  }

  async function sendCommand(questionId, state) {
    hostEls.error.textContent = '';
    try {
      const res = await fetch('/host/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: questionId, state, expects_version: lastState.version })
      });
      const data = await res.json();
      if (!res.ok) {
        hostEls.error.textContent = data.error === 'stale'
          ? 'Another host session moved on — refreshing.'
          : `Could not apply: ${data.error}`;
      }
      await refreshHost();
    } catch {
      hostEls.error.textContent = 'Could not reach the server.';
    }
  }

  // --- pause: a flag on the event, not a state (CLAUDE.md #17) -----------

  function buildPauseControl() {
    const reasonInput = document.createElement('input');
    reasonInput.placeholder = 'Reason (e.g. food service)';
    const messageInput = document.createElement('input');
    messageInput.placeholder = 'Message shown to the room';
    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.textContent = 'Pause';
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.textContent = 'Resume';

    pauseBtn.addEventListener('click', async () => {
      await fetch('/host/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: reasonInput.value, message: messageInput.value,
          expects_version: lastState.version
        })
      });
      await refreshHost();
    });
    resumeBtn.addEventListener('click', async () => {
      await fetch('/host/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expects_version: lastState.version })
      });
      await refreshHost();
    });

    app.append(reasonInput, messageInput, pauseBtn, resumeBtn);
  }

  // --- table support: bonus + answer on a table's behalf ------------------

  function buildTableSupport() {
    const heading = document.createElement('h1');
    heading.textContent = 'Table support';
    app.appendChild(heading);

    const teamInput = document.createElement('input');
    teamInput.placeholder = 'Team id';
    teamInput.inputMode = 'numeric';

    const valueInput = document.createElement('input');
    valueInput.placeholder = 'Answer value';
    const answerBtn = document.createElement('button');
    answerBtn.type = 'button';
    answerBtn.textContent = 'Enter answer for table';
    const answerMsg = document.createElement('p');
    answerMsg.className = 'error';
    answerMsg.setAttribute('role', 'alert');

    answerBtn.addEventListener('click', async () => {
      if (!lastState || !lastState.current) { answerMsg.textContent = 'No current question.'; return; }
      const res = await fetch('/host/answer-on-behalf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: Number(teamInput.value), question_id: lastState.current.id, value: valueInput.value
        })
      });
      const data = await res.json();
      answerMsg.textContent = res.ok ? 'Recorded.' : `Could not record: ${data.error}`;
      await refreshHost();
    });

    const pointsInput = document.createElement('input');
    pointsInput.placeholder = 'Bonus points';
    pointsInput.inputMode = 'numeric';
    const reasonInput = document.createElement('input');
    reasonInput.placeholder = 'Reason';
    const bonusBtn = document.createElement('button');
    bonusBtn.type = 'button';
    bonusBtn.textContent = 'Award bonus';
    const bonusMsg = document.createElement('p');
    bonusMsg.className = 'error';
    bonusMsg.setAttribute('role', 'alert');

    bonusBtn.addEventListener('click', async () => {
      const idempotencyKey = `${Date.now()}-${Math.random()}`;
      const res = await fetch('/host/bonus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: Number(teamInput.value), points: Number(pointsInput.value),
          reason: reasonInput.value, idempotency_key: idempotencyKey
        })
      });
      const data = await res.json();
      bonusMsg.textContent = res.ok ? 'Bonus awarded.' : `Could not award: ${data.error}`;
      await refreshScores();
    });

    app.append(
      teamInput,
      valueInput, answerBtn, answerMsg,
      pointsInput, reasonInput, bonusBtn, bonusMsg
    );
  }

  // --- scores (derived on read, CLAUDE.md #13) ----------------------------

  function buildScoresPanel() {
    const heading = document.createElement('h1');
    heading.textContent = 'Scores';
    app.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'question-list';
    app.appendChild(list);
    hostEls.scoresList = list;

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh scores';
    refreshBtn.addEventListener('click', refreshScores);
    app.appendChild(refreshBtn);

    refreshScores();
  }

  async function refreshScores() {
    const res = await fetch('/host/scores', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    clear(hostEls.scoresList);
    data.scores.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'question-row';
      const label = document.createElement('span');
      label.textContent = `Table ${s.table_number} — ${s.team_name}: ${s.score}`;
      row.appendChild(label);
      hostEls.scoresList.appendChild(row);
    });
    if (data.recent_bonuses.length) {
      const recent = document.createElement('p');
      recent.className = 'note';
      recent.textContent = 'Recent: ' + data.recent_bonuses
        .map((b) => `Table ${b.table_number} +${b.points} (${b.awarded_by})`)
        .join(', ');
      hostEls.scoresList.appendChild(recent);
    }
  }

  // --- marker console -------------------------------------------------

  let markerEls = null;
  let markerPollHandle = null;

  function startMarker() {
    clear(app);
    markerEls = {};

    const heading = document.createElement('h1');
    heading.textContent = 'Marking queue';
    app.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'question-list';
    app.appendChild(list);
    markerEls.list = list;

    refreshQueue();
    markerPollHandle = window.Poll.start({
      vUrl: '/marker/v', // event-wide version is enough to notice new closes
      stateUrl: '/marker/queue',
      intervalMs: 2000,
      onState: renderQueue
    });
  }

  async function refreshQueue() {
    const res = await fetch('/marker/queue', { cache: 'no-store' });
    renderQueue(await res.json());
  }

  function renderQueue(state) {
    clear(markerEls.list);
    if (!state.questions.length) {
      const p = document.createElement('p');
      p.textContent = 'Nothing waiting to be marked.';
      markerEls.list.appendChild(p);
      return;
    }

    state.questions.forEach((qu) => {
      const row = document.createElement('div');
      row.className = 'question-row';

      const label = document.createElement('span');
      label.textContent = `${qu.prompt} — ${qu.unmarked_count}/${qu.total_answers} unmarked`;
      row.appendChild(label);

      const btn = document.createElement('button');
      btn.type = 'button';
      if (qu.claim.held) {
        btn.textContent = `Claimed by ${qu.claim.marker}`;
        btn.disabled = true;
      } else {
        btn.textContent = 'Claim';
        btn.addEventListener('click', () => claimAndOpen(qu.id));
      }
      row.appendChild(btn);

      markerEls.list.appendChild(row);
    });
  }

  async function claimAndOpen(questionId) {
    const res = await fetch('/marker/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      openMarkerDetail(questionId);
    } else {
      await refreshQueue();
    }
  }

  async function openMarkerDetail(questionId) {
    if (markerPollHandle) markerPollHandle.stop();
    clear(app);

    const res = await fetch(`/marker/question/${questionId}`, { cache: 'no-store' });
    if (!res.ok) { startMarker(); return; }
    const data = await res.json();

    const heading = document.createElement('h1');
    heading.textContent = data.question.prompt;
    app.appendChild(heading);

    const answer = document.createElement('p');
    answer.textContent = `Correct answer: ${data.question.correct_answer}` +
      (data.question.aliases.length ? ` (also: ${data.question.aliases.join(', ')})` : '');
    app.appendChild(answer);

    const list = document.createElement('div');
    list.className = 'question-list';
    app.appendChild(list);

    data.answers.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'question-row';

      const label = document.createElement('span');
      label.textContent = `Table ${a.table_number}${a.team_name ? ' — ' + a.team_name : ''}: "${a.value}"` +
        (a.is_correct === null ? '' : a.is_correct ? ' (marked correct)' : ' (marked incorrect)');
      row.appendChild(label);

      const yes = document.createElement('button');
      yes.type = 'button';
      yes.textContent = 'Correct';
      yes.addEventListener('click', () => mark(questionId, a.team_id, true));
      row.appendChild(yes);

      const no = document.createElement('button');
      no.type = 'button';
      no.textContent = 'Wrong';
      no.addEventListener('click', () => mark(questionId, a.team_id, false));
      row.appendChild(no);

      const alias = document.createElement('button');
      alias.type = 'button';
      alias.textContent = 'Accept spelling for all';
      alias.addEventListener('click', () => addAlias(questionId, a.value));
      row.appendChild(alias);

      list.appendChild(row);
    });

    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Back to queue';
    done.addEventListener('click', async () => {
      await fetch('/marker/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: questionId })
      });
      startMarker();
    });
    app.appendChild(done);
  }

  async function mark(questionId, teamId, correct) {
    await fetch('/marker/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, team_id: teamId, correct })
    });
    openMarkerDetail(questionId);
  }

  async function addAlias(questionId, alias) {
    await fetch('/marker/alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, alias })
    });
    openMarkerDetail(questionId);
  }

  // --- admin console -------------------------------------------------
  // Admin prepares the night; host runs it (technical-design §9) — nothing
  // here changes question/round state, only content and configuration.

  function startAdmin() {
    clear(app);
    const heading = document.createElement('h1');
    heading.textContent = 'Admin';
    app.appendChild(heading);

    buildQuestionsSection();
    buildTablesSection();
    buildMediaSection();
    buildConfigSection();
    buildAuditSection();
    buildBackupSection();
  }

  function section(title) {
    const h = document.createElement('h1');
    h.textContent = title;
    app.appendChild(h);
  }

  function fileNameInput(accept) {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    return input;
  }

  // --- questions: CSV import with preview, then the current list ---------

  function buildQuestionsSection() {
    section('Questions');

    const fileInput = fileNameInput('.csv');
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.textContent = 'Preview CSV';
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.textContent = 'Import (replaces the whole set)';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');
    const previewList = document.createElement('div');
    previewList.className = 'question-list';

    async function withCsvText(fn) {
      if (!fileInput.files[0]) { msg.textContent = 'Choose a CSV file first.'; return; }
      const text = await fileInput.files[0].text();
      await fn(text);
    }

    function renderPreview(result) {
      clear(previewList);
      result.rows.forEach((row) => {
        const line = document.createElement('div');
        line.className = 'question-row';
        const label = document.createElement('span');
        label.textContent = `Row ${row.rowNumber}: ${row.prompt || '(no prompt)'}`;
        line.appendChild(label);
        if (row.errors.length) {
          const err = document.createElement('span');
          err.className = 'error';
          err.textContent = 'ERROR: ' + row.errors.join('; ');
          line.appendChild(err);
        }
        if (row.warnings.length) {
          const warn = document.createElement('span');
          warn.className = 'note';
          warn.textContent = 'Warning: ' + row.warnings.join('; ');
          line.appendChild(warn);
        }
        previewList.appendChild(line);
      });
      msg.textContent = result.valid
        ? `${result.rows.length} rows, no blocking errors.`
        : 'Blocking errors found — fix them before importing.';
    }

    previewBtn.addEventListener('click', () => withCsvText(async (text) => {
      const res = await fetch('/admin/questions/preview', {
        method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text
      });
      renderPreview(await res.json());
    }));

    importBtn.addEventListener('click', () => withCsvText(async (text) => {
      const res = await fetch('/admin/questions/import', {
        method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text
      });
      const data = await res.json();
      msg.textContent = res.ok
        ? `Imported ${data.imported} questions.`
        : `Could not import: ${data.message || data.error}`;
      if (res.ok) refreshQuestionsList();
    }));

    const listHeading = document.createElement('p');
    listHeading.textContent = 'Current question set:';
    const list = document.createElement('div');
    list.className = 'question-list';

    async function refreshQuestionsList() {
      const res = await fetch('/admin/questions', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.questions.forEach((qu) => {
        const row = document.createElement('div');
        row.className = 'question-row';
        const label = document.createElement('span');
        const where = qu.is_practice ? 'Practice' : qu.is_reserve ? 'Reserve' : `R${qu.round} Q${qu.order_no}`;
        label.textContent = `${where}: ${qu.prompt} — answer: ${qu.correct_answer} (${qu.points}pt, ${qu.type})`;
        row.appendChild(label);
        list.appendChild(row);
      });
    }

    app.append(fileInput, previewBtn, importBtn, msg, previewList, listHeading, list);
    refreshQuestionsList();
  }

  // --- tables: CSV import (upsert), list + archive ------------------------

  function buildTablesSection() {
    section('Tables');

    const fileInput = fileNameInput('.csv');
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.textContent = 'Import tables CSV (adds/updates only)';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');

    const list = document.createElement('div');
    list.className = 'question-list';

    async function refreshTables() {
      const res = await fetch('/admin/tables', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.tables.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'question-row';
        const label = document.createElement('span');
        label.textContent = `Table ${t.table_number} — ${t.seats} seats${t.archived ? ' (archived)' : ''}`;
        row.appendChild(label);
        if (!t.archived) {
          const archiveBtn = document.createElement('button');
          archiveBtn.type = 'button';
          archiveBtn.textContent = 'Archive';
          archiveBtn.addEventListener('click', async () => {
            await fetch(`/admin/tables/${t.id}/archive`, { method: 'POST' });
            refreshTables();
          });
          row.appendChild(archiveBtn);
        }
        list.appendChild(row);
      });
    }

    importBtn.addEventListener('click', async () => {
      if (!fileInput.files[0]) { msg.textContent = 'Choose a CSV file first.'; return; }
      const text = await fileInput.files[0].text();
      const res = await fetch('/admin/tables/import', {
        method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text
      });
      const data = await res.json();
      msg.textContent = res.ok
        ? `Added ${data.added}, updated ${data.updated}.`
        : `Could not import: ${(data.errors || [data.error]).join('; ')}`;
      if (res.ok) refreshTables();
    });

    app.append(fileInput, importBtn, msg, list);
    refreshTables();
  }

  // --- media: upload (compressed + hashed server-side), list --------------

  function buildMediaSection() {
    section('Media');

    const fileInput = fileNameInput('image/*');
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Filename as referenced in the CSV (e.g. opera-house.jpg)';
    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.textContent = 'Upload';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');

    const list = document.createElement('div');
    list.className = 'question-list';

    async function refreshMedia() {
      const res = await fetch('/admin/media', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.files.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'question-row';
        const label = document.createElement('span');
        label.textContent = `${f.filename} → /media/${f.sha256}.webp`;
        row.appendChild(label);
        list.appendChild(row);
      });
    }

    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      if (!file) { msg.textContent = 'Choose an image first.'; return; }
      const name = nameInput.value.trim() || file.name;
      const res = await fetch(`/admin/media/upload?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      });
      const data = await res.json();
      msg.textContent = res.ok
        ? `Uploaded: ${data.original_size} → ${data.processed_size} bytes.`
        : `Could not upload: ${data.error}`;
      if (res.ok) refreshMedia();
    });

    app.append(fileInput, nameInput, uploadBtn, msg, list);
    refreshMedia();
  }

  // --- config: export/import JSON, separate from the DB backup -----------

  function buildConfigSection() {
    section('Config export / import');

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = 'Export config (JSON)';
    const fileInput = fileNameInput('.json');
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.textContent = 'Import as new event (draft)';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');

    exportBtn.addEventListener('click', async () => {
      const res = await fetch('/admin/config/export', { cache: 'no-store' });
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(data.name || 'event').replace(/[^a-z0-9-]+/gi, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

    importBtn.addEventListener('click', async () => {
      if (!fileInput.files[0]) { msg.textContent = 'Choose a config JSON file first.'; return; }
      const text = await fileInput.files[0].text();
      let config;
      try {
        config = JSON.parse(text);
      } catch {
        msg.textContent = 'That file is not valid JSON.';
        return;
      }
      const res = await fetch('/admin/config/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config)
      });
      const data = await res.json();
      msg.textContent = res.ok
        ? `Created event ${data.event_id} as ${data.status}. Activate it from event lifecycle admin (not yet built) or the database directly.`
        : `Could not import: ${data.error}`;
    });

    app.append(exportBtn, document.createElement('br'), fileInput, importBtn, msg);
  }

  // --- audit log (dispute evidence, CLAUDE.md Conventions) ----------------

  function buildAuditSection() {
    section('Audit log');

    const list = document.createElement('div');
    list.className = 'question-list';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh audit log';

    async function refreshAudit() {
      const res = await fetch('/admin/audit', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.entries.slice(0, 50).forEach((e) => {
        const row = document.createElement('div');
        row.className = 'question-row';
        const label = document.createElement('span');
        label.textContent = `${e.at} — ${e.role}${e.operator ? '/' + e.operator : ''}: ${e.action} ${e.target || ''} ${e.reason ? '(' + e.reason + ')' : ''}`;
        row.appendChild(label);
        list.appendChild(row);
      });
    }

    refreshBtn.addEventListener('click', refreshAudit);
    app.append(refreshBtn, list);
    refreshAudit();
  }

  // --- backup: the whole database is one file (technical-design §8.2) ----

  function buildBackupSection() {
    section('Backup');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Download database backup';
    btn.addEventListener('click', () => {
      window.location.href = '/admin/backup/database';
    });

    app.appendChild(btn);
  }

  renderRolePicker();
})();
