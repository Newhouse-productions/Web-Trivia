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
          else if (data.role === 'floor') startFloor();
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
    const parts = [
      state.round_progress
        ? `Round ${state.round_progress.number} · Q${state.round_progress.index} of ${state.round_progress.total}`
        : `Round phase: ${state.round_phase}`,
      state.current ? `${state.current.state}` : 'no current question',
      `Marking: ${state.marking.marked}/${state.marking.total}`,
      `Tables live: ${state.tables_live.live}/${state.tables_live.total}`,
      `v${state.version}`
    ];
    hostEls.vitals.textContent = parts.join(' — ');

    hostEls.answered.textContent = state.current
      ? `Answered: ${state.answered.count}/${state.answered.total}` +
        (state.answered.outstanding.length ? ` — outstanding: ${state.answered.outstanding.join(', ')}` : '')
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

    buildEventsSection();
    buildQuestionsSection();
    buildTablesSection();
    buildMediaSection();
    buildThemeSection();
    buildConfigSection();
    buildAuditSection();
    buildBackupSection();
  }

  // --- events: many configured, exactly one active (technical-design §16.5) --

  function buildEventsSection() {
    section('Events');

    const nameInput = document.createElement('input');
    nameInput.placeholder = 'New event name';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.textContent = 'New event (draft)';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');

    const list = document.createElement('div');
    list.className = 'question-list';

    async function refreshEvents() {
      const res = await fetch('/admin/events', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.events.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'question-row';
        const label = document.createElement('span');
        const current = e.id === data.current_event_id ? ' — this session' : '';
        label.textContent = `${e.name} — ${e.status} — ${e.question_count} questions, ${e.table_count} tables${current}`;
        row.appendChild(label);

        if (e.status !== 'active' && e.id === data.current_event_id) {
          const activateBtn = document.createElement('button');
          activateBtn.type = 'button';
          activateBtn.textContent = 'Activate';
          activateBtn.addEventListener('click', async () => {
            const res2 = await fetch(`/admin/events/${e.id}/activate`, { method: 'POST' });
            const d2 = await res2.json();
            msg.textContent = res2.ok ? 'Activated.' : `Could not activate: ${d2.error} ${d2.active_event_name || ''}`;
            refreshEvents();
          });
          row.appendChild(activateBtn);
        }
        if (e.status === 'active' && e.id === data.current_event_id) {
          const finishBtn = document.createElement('button');
          finishBtn.type = 'button';
          finishBtn.textContent = 'Finish event';
          finishBtn.addEventListener('click', async () => {
            await fetch(`/admin/events/${e.id}/finish`, { method: 'POST' });
            refreshEvents();
          });
          row.appendChild(finishBtn);
        }
        list.appendChild(row);
      });
    }

    createBtn.addEventListener('click', async () => {
      const res = await fetch('/admin/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value })
      });
      const data = await res.json();
      if (res.ok) {
        msg.textContent = `Created. PINs — host ${data.pins.host}, marker ${data.pins.marker}, ` +
          `floor ${data.pins.floor}, admin ${data.pins.admin}. Write these down now.`;
        nameInput.value = '';
        refreshEvents();
      } else {
        msg.textContent = `Could not create: ${data.error}`;
      }
    });

    app.append(nameInput, createBtn, msg, list);
    refreshEvents();
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

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openQuestionEditor(qu.id));
        row.appendChild(editBtn);

        list.appendChild(row);
      });
    }

    const editorWrap = document.createElement('div');
    editorWrap.className = 'question-list';

    async function openQuestionEditor(id) {
      const res = await fetch(`/admin/questions/${id}`, { cache: 'no-store' });
      const data = await res.json();
      clear(editorWrap);

      if (data.edit_state === 'blocked') {
        const p = document.createElement('p');
        p.className = 'error';
        p.textContent = 'This question is currently OPEN — close it before editing.';
        editorWrap.appendChild(p);
        return;
      }

      const qu = data.question;
      const warn = document.createElement('p');
      warn.className = 'note';
      warn.textContent = data.edit_state === 'revealed'
        ? 'This question has been revealed. Changing the answer or aliases will re-score every table that answered — preview the impact first.'
        : data.edit_state === 'closed'
          ? 'This question has answers recorded. Changing the answer or aliases will re-score them.'
          : 'Not yet reached — edits freely, no impact.';
      editorWrap.appendChild(warn);

      const promptInput = document.createElement('input');
      promptInput.value = qu.prompt;
      const correctInput = document.createElement('input');
      correctInput.value = qu.correct_answer || '';
      const aliasesInput = document.createElement('input');
      aliasesInput.placeholder = 'Aliases, pipe-separated';
      aliasesInput.value = (qu.aliases || []).join('|');
      const pointsInput = document.createElement('input');
      pointsInput.type = 'number';
      pointsInput.value = qu.points;

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.textContent = 'Preview impact';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save';
      const msg = document.createElement('p');
      msg.className = 'error';
      msg.setAttribute('role', 'alert');

      let confirmed = false;

      function buildBody() {
        return {
          prompt: promptInput.value,
          correct_answer: correctInput.value,
          aliases: aliasesInput.value.split('|').map((s) => s.trim()).filter(Boolean),
          points: Number(pointsInput.value)
        };
      }

      previewBtn.addEventListener('click', async () => {
        const res2 = await fetch(`/admin/questions/${id}/preview-impact`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody())
        });
        const impact = await res2.json();
        msg.className = 'note';
        msg.textContent = `${impact.flipped_to_correct} tables wrong→correct, ${impact.flipped_to_wrong} correct→wrong, ` +
          `${impact.unaffected} unaffected, ${impact.points_delta >= 0 ? '+' : ''}${impact.points_delta} points.` +
          (impact.needs_republish ? ' A published round will need re-publishing.' : '');
        confirmed = true;
      });

      saveBtn.addEventListener('click', async () => {
        const res2 = await fetch(`/admin/questions/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...buildBody(), confirm: confirmed })
        });
        const data2 = await res2.json();
        if (res2.status === 428) {
          msg.className = 'error';
          msg.textContent = 'Preview the impact first, then save.';
        } else if (res2.ok) {
          msg.className = 'note';
          msg.textContent = 'Saved.';
          refreshQuestionsList();
        } else {
          msg.className = 'error';
          msg.textContent = `Could not save: ${data2.message || data2.error}`;
        }
      });

      editorWrap.append(
        promptInput, correctInput, aliasesInput, pointsInput, previewBtn, saveBtn, msg
      );
    }

    app.append(fileInput, previewBtn, importBtn, msg, previewList, listHeading, list, editorWrap);
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

    const qrBtn = document.createElement('button');
    qrBtn.type = 'button';
    qrBtn.textContent = 'Print QR sheet';
    qrBtn.addEventListener('click', () => window.open('/admin/tables/qr-sheet', '_blank'));

    app.append(fileInput, importBtn, msg, qrBtn, list);
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
      a.download = `${(data.event?.name || 'event').replace(/[^a-z0-9-]+/gi, '-')}.json`;
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
        ? `Created event ${data.event_id} as ${data.status}. PINs — host ${data.pins.host}, ` +
          `marker ${data.pins.marker}, floor ${data.pins.floor}, admin ${data.pins.admin}. ` +
          `Activate it from the Events section above.`
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

  // --- theme: event/round/question cascade (CLAUDE.md #18-22) ------------

  const LAYOUTS = ['standard', 'image', 'media', 'statement', 'text-answer'];

  function buildThemeSection() {
    section('Theme');

    const levelSelect = document.createElement('select');
    ['event', 'round', 'question'].forEach((lv) => {
      const opt = document.createElement('option');
      opt.value = lv; opt.textContent = lv[0].toUpperCase() + lv.slice(1);
      levelSelect.appendChild(opt);
    });

    const targetInput = document.createElement('input');
    targetInput.placeholder = 'Round number or question id';
    targetInput.style.display = 'none';
    levelSelect.addEventListener('change', () => {
      targetInput.style.display = levelSelect.value === 'event' ? 'none' : '';
    });

    const bgOverride = document.createElement('input'); bgOverride.type = 'checkbox';
    const bgInput = document.createElement('input'); bgInput.type = 'color'; bgInput.value = '#1a1d24';
    const bg2Override = document.createElement('input'); bg2Override.type = 'checkbox';
    const bg2Input = document.createElement('input'); bg2Input.type = 'color'; bg2Input.value = '#2a2f3a';
    const accentOverride = document.createElement('input'); accentOverride.type = 'checkbox';
    const accentInput = document.createElement('input'); accentInput.type = 'color'; accentInput.value = '#e0a82e';
    const layoutOverride = document.createElement('input'); layoutOverride.type = 'checkbox';
    const layoutSelect = document.createElement('select');
    LAYOUTS.forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l; opt.textContent = l;
      layoutSelect.appendChild(opt);
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save theme for this level';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');

    saveBtn.addEventListener('click', async () => {
      const theme = {};
      if (layoutOverride.checked) theme.layout = layoutSelect.value;
      if (bgOverride.checked) theme.bg = bgInput.value;
      if (bg2Override.checked) theme.bg2 = bg2Input.value;
      if (accentOverride.checked) theme.accent = accentInput.value;

      let url;
      if (levelSelect.value === 'event') url = '/admin/theme/event';
      else if (levelSelect.value === 'round') url = `/admin/theme/round/${Number(targetInput.value)}`;
      else url = `/admin/theme/question/${Number(targetInput.value)}`;

      const res = await fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme })
      });
      const data = await res.json();
      msg.textContent = res.ok ? 'Saved.' : `Could not save: ${data.error}`;
      refreshResolved();
    });

    app.append(
      levelSelect, targetInput,
      document.createElement('br'),
      layoutOverride, document.createTextNode(' Layout '), layoutSelect,
      document.createElement('br'),
      bgOverride, document.createTextNode(' Background '), bgInput,
      bg2Override, document.createTextNode(' Gradient end '), bg2Input,
      accentOverride, document.createTextNode(' Accent '), accentInput,
      document.createElement('br'),
      saveBtn, msg
    );

    // Chrome — event level only, deliberately outside the cascade (CLAUDE.md #20).
    const chromeHeading = document.createElement('p');
    chromeHeading.textContent = 'Chrome (event only, does not cascade)';
    const titleInput = document.createElement('input'); titleInput.placeholder = 'Title';
    const subtitleInput = document.createElement('input'); subtitleInput.placeholder = 'Subtitle';
    const logoLightInput = document.createElement('input'); logoLightInput.placeholder = 'Logo filename (light bg)';
    const logoDarkInput = document.createElement('input'); logoDarkInput.placeholder = 'Logo filename (dark bg)';
    const footerInput = document.createElement('input'); footerInput.placeholder = 'Footer band text';
    const chromeSaveBtn = document.createElement('button');
    chromeSaveBtn.type = 'button';
    chromeSaveBtn.textContent = 'Save chrome';
    chromeSaveBtn.addEventListener('click', async () => {
      await fetch('/admin/theme/chrome', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chrome: {
            title: titleInput.value, subtitle: subtitleInput.value,
            logo_light: logoLightInput.value, logo_dark: logoDarkInput.value, footer: footerInput.value
          }
        })
      });
    });
    app.append(
      chromeHeading, titleInput, subtitleInput, logoLightInput, logoDarkInput, footerInput, chromeSaveBtn
    );

    // Resolved + validated (CLAUDE.md #21) — the client never sees the
    // cascade, only this already-resolved result.
    const resolvedHeading = document.createElement('p');
    resolvedHeading.textContent = 'Resolved themes';
    const resolvedList = document.createElement('div');
    resolvedList.className = 'question-list';
    app.append(resolvedHeading, resolvedList);

    async function refreshResolved() {
      const res = await fetch('/admin/theme', { cache: 'no-store' });
      const data = await res.json();
      clear(resolvedList);

      const summary = document.createElement('div');
      summary.className = 'question-row';
      const failingQuestions = data.questions.filter((r) => !r.validation.pass);
      summary.textContent = `Event default: ${data.event_default.validation.pass ? 'pass' : 'FAIL'} — ` +
        `${data.questions.length - failingQuestions.length}/${data.questions.length} questions pass`;
      resolvedList.appendChild(summary);

      failingQuestions.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'question-row';
        const failed = r.validation.checks.filter((c) => !c.pass).map((c) => `${c.label} (${c.ratio}:1, needs ${c.required}:1)`);
        row.textContent = `Q${r.order_no ?? r.question_id}: ${failed.join('; ')}`;
        resolvedList.appendChild(row);
      });
    }

    refreshResolved();
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

  // --- floor console -------------------------------------------------
  // Walks the room with a phone. Never sees correct answers
  // (technical-design §13.2) — the room grid and table detail below never
  // request or render one.

  let floorEls = null;
  let floorPollHandle = null;
  const OFFLINE_MS = 60000;
  const QUIET_MS = 20000;

  function startFloor() {
    clear(app);
    floorEls = {};

    const heading = document.createElement('h1');
    heading.textContent = 'Floor';
    app.appendChild(heading);

    const summary = document.createElement('p');
    app.appendChild(summary);
    floorEls.summary = summary;

    const grid = document.createElement('div');
    grid.className = 'question-list';
    app.appendChild(grid);
    floorEls.grid = grid;

    const attentionHeading = document.createElement('p');
    attentionHeading.textContent = 'Needs attention';
    const attention = document.createElement('div');
    attention.className = 'question-list';
    app.append(attentionHeading, attention);
    floorEls.attention = attention;

    refreshFloor();
    floorPollHandle = window.Poll.start({
      vUrl: '/floor/v', stateUrl: '/floor/teams', intervalMs: 3000, onState: renderFloor
    });
  }

  async function refreshFloor() {
    const res = await fetch('/floor/teams', { cache: 'no-store' });
    renderFloor(await res.json());
  }

  function presenceStatus(team, questionOpen) {
    if (!team.last_seen_at) return 'offline';
    const age = Date.now() - new Date(team.last_seen_at).getTime();
    if (age > OFFLINE_MS) return 'offline';
    if (questionOpen && age > QUIET_MS && !team.answered_current) return 'quiet';
    return 'ok';
  }

  function renderFloor(state) {
    const teams = state.teams;
    const statuses = teams.map((t) => ({ t, status: presenceStatus(t, state.question_open) }));
    const answeredCount = teams.filter((t) => t.answered_current).length;

    floorEls.summary.textContent = state.question_open
      ? `${answeredCount} of ${teams.length} answering`
      : 'No question open';

    clear(floorEls.grid);
    statuses.forEach(({ t, status }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${t.table_number}${status !== 'ok' ? ` (${status})` : ''}`;
      btn.addEventListener('click', () => openFloorTable(t.team_id));
      floorEls.grid.appendChild(btn);
    });

    clear(floorEls.attention);
    const needsAttention = statuses.filter((s) => s.status !== 'ok');
    if (!needsAttention.length) {
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = 'Nothing needs a visit right now.';
      floorEls.attention.appendChild(p);
    }
    needsAttention.forEach(({ t, status }) => {
      const row = document.createElement('div');
      row.className = 'question-row';
      const label = document.createElement('span');
      label.textContent = `Table ${t.table_number} — ${status === 'offline' ? 'offline' : 'quiet, not answered yet'}`;
      row.appendChild(label);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Open';
      btn.addEventListener('click', () => openFloorTable(t.team_id));
      row.appendChild(btn);
      floorEls.attention.appendChild(row);
    });
  }

  async function openFloorTable(teamId) {
    if (floorPollHandle) floorPollHandle.stop();
    clear(app);

    const res = await fetch(`/floor/team/${teamId}`, { cache: 'no-store' });
    if (!res.ok) { startFloor(); return; }
    const data = await res.json();

    const heading = document.createElement('h1');
    heading.textContent = `Table ${data.team.table_number}${data.team.team_name ? ' — ' + data.team.team_name : ''}`;
    app.appendChild(heading);

    const info = document.createElement('p');
    info.className = 'note';
    info.textContent = `Players: ${data.players.map((p) => p.username).join(', ') || 'none yet'}`;
    app.appendChild(info);

    const renameInput = document.createElement('input');
    renameInput.placeholder = 'New team name';
    renameInput.value = data.team.team_name || '';
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.textContent = 'Rename team';
    renameBtn.addEventListener('click', async () => {
      await fetch('/floor/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId, team_name: renameInput.value })
      });
      openFloorTable(teamId);
    });

    const captainSelect = document.createElement('select');
    data.players.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.username + (p.id === data.team.captain_player_id ? ' (captain)' : '');
      captainSelect.appendChild(opt);
    });
    const captainBtn = document.createElement('button');
    captainBtn.type = 'button';
    captainBtn.textContent = 'Make captain';
    captainBtn.addEventListener('click', async () => {
      await fetch('/floor/reassign-captain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId, player_id: Number(captainSelect.value) })
      });
      openFloorTable(teamId);
    });

    app.append(renameInput, renameBtn, document.createElement('br'), captainSelect, captainBtn);

    if (data.current_question) {
      const qHeading = document.createElement('p');
      qHeading.textContent = `Q: ${data.current_question.prompt}`;
      app.appendChild(qHeading);

      const valueInput = document.createElement('input');
      valueInput.placeholder = 'What the table told you';
      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.textContent = 'Submit for this table';
      const msg = document.createElement('p');
      msg.className = 'error';
      msg.setAttribute('role', 'alert');

      submitBtn.addEventListener('click', async () => {
        const res2 = await fetch('/floor/answer-on-behalf', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            team_id: teamId, question_id: data.current_question.id, value: valueInput.value
          })
        });
        const d2 = await res2.json();
        msg.textContent = res2.ok ? 'Recorded.' : `Could not record: ${d2.error}`;
      });

      app.append(valueInput, submitBtn, msg);
    }

    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back to room';
    back.addEventListener('click', startFloor);
    app.appendChild(back);
  }

  renderRolePicker();
})();
