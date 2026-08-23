// Minimal host console: role sign-in, then absolute setQuestion commands
// with a version guard (CLAUDE.md #8). Marker/Floor/Admin arrive in later
// build steps; picking those roles here just says so for now.
(function () {
  const app = document.getElementById('app');
  // Stopgap: body's own padding was retired in favour of each surface's
  // .pbody/.cbody supplying it (design-handover §2), so this console needs
  // its own until its reskin slice gives it a proper .cbody wrapper.
  app.style.padding = '16px';
  let pollHandle = null;
  let lastState = null;
  let hostEls = null;

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // Team colour is an identifier, not a theme (CLAUDE.md #18) — used here as
  // a border accent only, never as the grid button's fill or text colour.
  function colourCss(colour) {
    if (!colour) return null;
    return colour.type === 'gradient'
      ? `linear-gradient(135deg, ${colour.from}, ${colour.to})`
      : colour.from;
  }

  // Same resolved theme as the phones and the big screen, painting the
  // console's own chrome (CLAUDE.md #19) — canonicalized on documentElement
  // to match play.js/screen.js.
  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement.style;
    const c = theme.colour;
    root.setProperty('--bg', c.bg);
    root.setProperty('--bg2', c.bg2);
    root.setProperty('--surface', c.surface);
    root.setProperty('--surface-selected', c['surface-selected']);
    root.setProperty('--text', c.text);
    root.setProperty('--text-muted', c['text-muted']);
    root.setProperty('--border', c.border);
    root.setProperty('--accent', c.accent);
    root.setProperty('--accent-text', c['accent-text']);
    document.documentElement.dataset.theme = theme.dark ? 'dark' : 'light';
  }

  function renderRolePicker() {
    clear(app);
    app.style.padding = '';
    const pbody = document.createElement('div');
    pbody.className = 'cbody';
    app.appendChild(pbody);

    const heading = document.createElement('div');
    heading.className = 'label';
    heading.style.marginBottom = 'var(--s2)';
    heading.textContent = 'Operator sign in';
    pbody.appendChild(heading);

    const stack = document.createElement('div');
    stack.className = 'stack';
    ['host', 'marker', 'floor', 'admin'].forEach((role) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tile';
      btn.textContent = role[0].toUpperCase() + role.slice(1);
      btn.addEventListener('click', () => renderPinForm(role));
      stack.appendChild(btn);
    });
    pbody.appendChild(stack);
  }

  function renderPinForm(role, prefill) {
    clear(app);
    const pbody = document.createElement('div');
    pbody.className = 'cbody';
    app.appendChild(pbody);

    const heading = document.createElement('div');
    heading.className = 'label';
    heading.style.marginBottom = 'var(--s3)';
    heading.textContent = `${role[0].toUpperCase()}${role.slice(1)} sign in`;

    const form = document.createElement('form');
    form.className = 'stack';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'label';
    nameLabel.textContent = 'Your name';
    const nameInput = document.createElement('input');
    nameInput.className = 'field';
    nameInput.maxLength = 20;
    nameInput.autocomplete = 'off';

    const pinLabel = document.createElement('label');
    pinLabel.className = 'label';
    pinLabel.textContent = 'PIN';
    const input = document.createElement('input');
    input.className = 'field';
    input.type = 'password';
    input.inputMode = 'numeric';
    input.maxLength = 6;
    input.autocomplete = 'off';

    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'btn wide';
    button.textContent = 'Sign in';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn ghost wide';
    back.textContent = 'Back';
    back.addEventListener('click', renderRolePicker);
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');

    form.append(nameLabel, nameInput, pinLabel, input, button, error);
    pbody.append(heading, form, back);
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

    // Convenience for sharing a direct link during setup/testing — same
    // POST /ops/login, same rate limiter, just pre-filled and auto-submitted
    // rather than typed. A PIN in a URL still leaks to history/access logs
    // the way CLAUDE.md #4 flags for table tokens, so this stays a
    // deliberate opt-in via query string, never the default flow. Must run
    // after the listener above is attached, or requestSubmit() falls back
    // to a native form submission and reloads the page.
    if (prefill?.name) nameInput.value = prefill.name;
    if (prefill?.pin) {
      input.value = prefill.pin;
      form.requestSubmit();
    }
  }

  function renderNotBuilt(role) {
    clear(app);
    const p = document.createElement('p');
    p.textContent = `The ${role} console isn't built yet.`;
    app.appendChild(p);
  }

  // Host keyboard shortcuts: one listener, guarded against text input focus
  // and modifier keys, calling the exact same functions the buttons call —
  // a presentation clicker should be able to run the whole night
  // (design-handover §8). Assigned in buildPauseControl/renderHost below so
  // the shortcut always fires whatever is currently the enabled action.
  let hostPauseAction = null;
  let hostResumeAction = null;
  let hostPrimaryAction = null; // { state, questionId } — the current question's one enabled Space/C/R action
  let hostCloseAction = null;
  let hostRevealAction = null;

  function hostKeydown(e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === ' ') {
      e.preventDefault();
      if (hostPrimaryAction) sendCommand(hostPrimaryAction.questionId, hostPrimaryAction.state);
    } else if (e.key === 'c' || e.key === 'C') {
      if (hostCloseAction) sendCommand(hostCloseAction.questionId, 'CLOSED');
    } else if (e.key === 'r' || e.key === 'R') {
      if (hostRevealAction) sendCommand(hostRevealAction.questionId, 'REVEALED');
    } else if (e.key === 'b' || e.key === 'B') {
      hostEls.bonusGrid && hostEls.bonusGrid.querySelector('button')?.focus();
    } else if (e.key === 'p' || e.key === 'P') {
      if (lastState && lastState.paused) { if (hostResumeAction) hostResumeAction(); }
      else if (hostPauseAction) hostPauseAction();
    }
  }

  function startHost() {
    clear(app);
    app.style.padding = '';
    hostEls = {};

    const vitals = document.createElement('div');
    vitals.className = 'vitals';
    app.appendChild(vitals); // flush with the console's top edge, not inset
    hostEls.vitals = vitals;

    // Three fixed sections, built once and never torn down — only one is
    // visible at a time (state.phase decides which). Rebuilding "active"
    // per phase-switch would lose the pause form's typed-but-unsaved text
    // and the bonus grid's selection; toggling display doesn't.
    const preflightBody = document.createElement('div');
    preflightBody.className = 'cbody';
    preflightBody.style.display = 'none';
    app.appendChild(preflightBody);
    hostEls.preflightBody = preflightBody;
    buildPreflightSection(preflightBody);

    const cbody = document.createElement('div');
    cbody.className = 'cbody';
    app.appendChild(cbody);
    hostEls.cbody = cbody;

    const answeredLabel = document.createElement('div');
    answeredLabel.className = 'label';
    answeredLabel.style.margin = 'var(--s4) 0 var(--s2)';
    cbody.appendChild(answeredLabel);
    hostEls.answeredLabel = answeredLabel;

    const tally = document.createElement('div');
    tally.className = 'tally';
    cbody.appendChild(tally);
    hostEls.tally = tally;

    const outstandingNote = document.createElement('p');
    outstandingNote.className = 'note';
    cbody.appendChild(outstandingNote);
    hostEls.outstandingNote = outstandingNote;

    const avCue = document.createElement('div');
    avCue.className = 'notice';
    avCue.style.display = 'none';
    avCue.style.marginTop = 'var(--s3)';
    cbody.appendChild(avCue);
    hostEls.avCue = avCue;

    const rule1 = document.createElement('hr');
    rule1.className = 'rule';
    cbody.appendChild(rule1);

    buildPauseControl(cbody);

    const rule2 = document.createElement('hr');
    rule2.className = 'rule';
    cbody.appendChild(rule2);

    const list = document.createElement('div');
    list.className = 'stack';
    cbody.appendChild(list);
    hostEls.list = list;

    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    cbody.appendChild(error);
    hostEls.error = error;

    const rule3 = document.createElement('hr');
    rule3.className = 'rule';
    cbody.appendChild(rule3);

    buildTableSupport(cbody);
    buildScoresPanel(cbody);

    const finalBody = document.createElement('div');
    finalBody.className = 'cbody';
    finalBody.style.display = 'none';
    app.appendChild(finalBody);
    hostEls.finalBody = finalBody;
    buildFinalSection(finalBody);

    window.addEventListener('keydown', hostKeydown);

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

  function vitalCell(k, v, alert) {
    const cell = document.createElement('div');
    cell.className = 'vital';
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = k;
    const val = document.createElement('span');
    val.className = 'v num' + (alert ? ' alert' : '');
    val.textContent = v;
    cell.append(key, val);
    return cell;
  }

  // One tile per question, reused by the active question list and the
  // pre-flight screen's single "current question" row — same state-machine
  // logic either way. Keyboard shortcuts are only wired for the active
  // list (keyboard=true); the pre-flight tile is click-only.
  function buildQuestionTile(qu, state, { keyboard = false } = {}) {
    const row = document.createElement('div');
    row.className = 'tile flat';

    const label = document.createElement('span');
    label.textContent = qu.is_practice ? `Practice: ${qu.prompt}` : `R${qu.round} Q${qu.order_no}: ${qu.prompt}`;
    row.appendChild(label);

    const isCurrent = state.current && state.current.id === qu.id;
    const currentState = isCurrent ? state.current.state : null;

    const openLabel = isCurrent && state.current.av_cue ? 'Open after clip' : 'Open';
    const actions = [
      { state: 'PENDING', label: 'Show', enabled: !isCurrent },
      { state: 'OPEN', label: openLabel, enabled: isCurrent && currentState === 'PENDING', kbd: 'Space' },
      { state: 'CLOSED', label: 'Close', enabled: isCurrent && currentState === 'OPEN', kbd: 'C' },
      { state: 'REVEALED', label: 'Reveal', enabled: isCurrent && currentState === 'CLOSED', kbd: 'R' },
      { state: 'OPEN', label: 'Reopen', enabled: isCurrent && (currentState === 'CLOSED' || currentState === 'REVEALED') }
    ];

    actions.forEach((action) => {
      if (!action.enabled) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn sm';
      btn.textContent = action.label + ' ';
      if (action.kbd && keyboard) {
        const kbd = document.createElement('kbd');
        kbd.textContent = action.kbd;
        btn.appendChild(kbd);
      }
      btn.addEventListener('click', () => sendCommand(qu.id, action.state));
      row.appendChild(btn);

      // Space always progresses the CURRENT question only (never "Show",
      // which switches to a different question — too consequential for
      // one keystroke). C/R are scoped the same way.
      if (keyboard) {
        if (action.kbd === 'Space') hostPrimaryAction = { questionId: qu.id, state: action.state };
        if (action.kbd === 'C') hostCloseAction = { questionId: qu.id };
        if (action.kbd === 'R') hostRevealAction = { questionId: qu.id };
      }
    });

    return row;
  }

  function renderHost(state) {
    lastState = state;
    applyTheme(state.theme);

    // Phase is resolved server-side (state.phase) — this just shows
    // whichever of the three fixed sections it's told to, never infers
    // "are we done yet" itself (CLAUDE.md #21's principle, applied here).
    hostEls.preflightBody.style.display = state.phase === 'preflight' ? '' : 'none';
    hostEls.cbody.style.display = state.phase === 'active' ? '' : 'none';
    hostEls.finalBody.style.display = state.phase === 'final' ? '' : 'none';

    clear(hostEls.vitals);
    hostEls.vitals.append(
      vitalCell('Round', state.round_progress
        ? `${state.round_progress.number}${state.total_rounds ? ` of ${state.total_rounds}` : ''} · Q${state.round_progress.index}/${state.round_progress.total}`
        : state.round_phase),
      vitalCell('Question', state.current ? state.current.state : '—'),
      vitalCell('Marking', `${state.marking.marked}/${state.marking.total}`, state.marking.marked < state.marking.total),
      vitalCell('Tables', `${state.tables_live.live}/${state.tables_live.total}`, state.tables_live.live < state.tables_live.total),
      vitalCell('Version', `v${state.version}`)
    );

    // Keyboard shortcuts only ever act on the active list — reset every
    // render so a stale action from a previous phase can never fire.
    hostPauseAction = doPause;
    hostResumeAction = doResume;
    hostPrimaryAction = null;
    hostCloseAction = null;
    hostRevealAction = null;

    if (state.phase === 'preflight') renderPreflight(state);
    if (state.phase === 'final') renderFinal(state);
    if (state.phase !== 'active') return;

    // The tally is the one live thing in the room — it answers the host's
    // one question: wait, or move on (design-handover: bLive).
    clear(hostEls.tally);
    if (state.current) {
      hostEls.answeredLabel.textContent = `Answered ${state.answered.count} / ${state.answered.total}`;
      state.answered.tables.forEach((t) => {
        const cell = document.createElement('div');
        cell.className = 't' + (t.answered ? ' in' : '');
        cell.textContent = String(t.table_number);
        hostEls.tally.appendChild(cell);
      });
      hostEls.outstandingNote.textContent = state.answered.outstanding.length
        ? `Not yet answered: ${state.answered.outstanding.join(', ')}` : '';
    } else {
      hostEls.answeredLabel.textContent = '';
      hostEls.outstandingNote.textContent = '';
    }

    // AV runs outside this app — cue card only, a human presses play on the
    // venue laptop (CLAUDE.md/scope: "Console displays a cue card; a human
    // presses play"). Phones show a neutral "listen up" screen until Open.
    const cuePending = state.current && state.current.state === 'PENDING' && state.current.av_cue;
    hostEls.avCue.style.display = cuePending ? '' : 'none';
    hostEls.avCue.textContent = cuePending
      ? `${state.current.av_cue} — play from the venue laptop, not sent to phones. Open the question once it finishes.`
      : '';

    if (state.paused) {
      hostEls.pauseStatus.style.display = '';
      hostEls.pauseStatus.textContent = `Paused — ${state.paused.reason || 'no reason given'}`;
    } else {
      hostEls.pauseStatus.style.display = 'none';
    }

    clear(hostEls.list);
    state.questions.forEach((qu) => {
      hostEls.list.appendChild(buildQuestionTile(qu, state, { keyboard: true }));
    });
  }

  // --- pre-flight: before round 1 opens (design-handover: hPreflight) -----

  function buildPreflightSection(container) {
    const heading = document.createElement('div');
    heading.className = 'label';
    heading.style.marginBottom = 'var(--s2)';
    heading.textContent = 'Before doors';
    container.appendChild(heading);

    const checklist = document.createElement('div');
    checklist.className = 'stack';
    container.appendChild(checklist);
    hostEls.preflightChecklist = checklist;

    const rule = document.createElement('hr');
    rule.className = 'rule';
    container.appendChild(rule);

    const roomLabel = document.createElement('div');
    roomLabel.className = 'label';
    roomLabel.style.marginBottom = 'var(--s2)';
    container.appendChild(roomLabel);
    hostEls.preflightRoomLabel = roomLabel;

    const tally = document.createElement('div');
    tally.className = 'tally';
    container.appendChild(tally);
    hostEls.preflightTally = tally;

    const rule2 = document.createElement('hr');
    rule2.className = 'rule';
    container.appendChild(rule2);

    const currentWrap = document.createElement('div');
    currentWrap.className = 'stack';
    container.appendChild(currentWrap);
    hostEls.preflightCurrent = currentWrap;
  }

  function checklistTile(label, ok, detail) {
    const row = document.createElement('div');
    row.className = 'tile flat';
    const text = document.createElement('span');
    text.textContent = label;
    const mark = document.createElement('span');
    mark.className = 'mark status ' + (ok ? 'ok' : 'wait');
    mark.textContent = detail;
    row.append(text, mark);
    return row;
  }

  function renderPreflight(state) {
    const p = state.preflight;
    if (!p) return;
    clear(hostEls.preflightChecklist);
    hostEls.preflightChecklist.append(
      checklistTile('Question set', p.question_count > 0, `${p.question_count} loaded`),
      checklistTile('AV cues', true, `${p.av_cue_count} set`),
      checklistTile('Themes validated', p.themes.event_default.validation.pass && p.themes.questions.every((q) => q.validation.pass),
        p.themes.questions.filter((q) => q.validation.pass).length + '/' + p.themes.questions.length + ' pass'),
      checklistTile('Tables checked in', state.tables_live.live === state.tables_live.total, `${state.tables_live.live} of ${state.tables_live.total}`)
    );

    hostEls.preflightRoomLabel.textContent = 'Room';
    clear(hostEls.preflightTally);
    state.answered.tables.forEach((t) => {
      const cell = document.createElement('div');
      cell.className = 't' + (t.answered ? ' in' : '');
      cell.textContent = String(t.table_number);
      hostEls.preflightTally.appendChild(cell);
    });

    clear(hostEls.preflightCurrent);
    const currentLabel = document.createElement('div');
    currentLabel.className = 'label';
    currentLabel.style.marginBottom = 'var(--s2)';
    currentLabel.textContent = 'Current';
    hostEls.preflightCurrent.appendChild(currentLabel);
    if (state.current) {
      const qu = state.questions.find((x) => x.id === state.current.id);
      if (qu) hostEls.preflightCurrent.appendChild(buildQuestionTile(qu, state));
    }

    // Quick access to the practice question — only offered if it isn't
    // already the one showing (design-handover: hPreflight).
    if (p.practice_question && !(state.current && state.current.id === p.practice_question.id)) {
      const practiceBtn = document.createElement('button');
      practiceBtn.type = 'button';
      practiceBtn.className = 'btn ghost wide';
      practiceBtn.style.marginTop = 'var(--s3)';
      practiceBtn.textContent = 'Send the practice question';
      practiceBtn.addEventListener('click', () => sendCommand(p.practice_question.id, 'PENDING'));
      hostEls.preflightCurrent.appendChild(practiceBtn);
    }

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'btn wide';
    startBtn.style.marginTop = 'var(--s3)';
    startBtn.textContent = 'Start round 1';
    startBtn.addEventListener('click', () => {
      const firstReal = state.questions.find((qu) => !qu.is_practice);
      if (firstReal) sendCommand(firstReal.id, 'PENDING');
    });
    hostEls.preflightCurrent.appendChild(startBtn);
  }

  // --- final: every round published (design-handover: hFinal) -------------

  function buildFinalSection(container) {
    const heading = document.createElement('div');
    heading.className = 'label';
    heading.style.marginBottom = 'var(--s2)';
    heading.textContent = 'All rounds complete';
    container.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'lb';
    container.appendChild(list);
    hostEls.finalList = list;

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn ghost wide';
    exportBtn.style.marginTop = 'var(--s4)';
    exportBtn.textContent = 'Export results (CSV)';
    exportBtn.addEventListener('click', () => { window.location.href = '/host/results/export'; });
    container.appendChild(exportBtn);
  }

  let finalScoresLoadedForVersion = null;
  async function renderFinal(state) {
    if (finalScoresLoadedForVersion === state.version) return;
    finalScoresLoadedForVersion = state.version;
    const res = await fetch('/host/scores', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    clear(hostEls.finalList);
    data.scores.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'lb-row' + (i === 0 ? ' lead' : '');
      const pos = document.createElement('span');
      pos.className = 'pos num';
      pos.textContent = String(i + 1);
      const swatchCss = s.colour ? (s.colour.type === 'gradient' ? `linear-gradient(135deg, ${s.colour.from}, ${s.colour.to})` : s.colour.from) : null;
      row.appendChild(pos);
      if (swatchCss) {
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = swatchCss;
        row.appendChild(swatch);
      }
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.team_name;
      const score = document.createElement('span');
      score.className = 'score num';
      score.textContent = String(s.score);
      row.append(name, score);
      hostEls.finalList.appendChild(row);
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

  // Presets from the host-console mockup — food service, a speech, marking
  // catching up, a technical issue, or type your own.
  const PAUSE_PRESETS = [
    ['Food service', 'Back shortly — mains are coming out.'],
    ['Speech', 'One moment for a speech.'],
    ['Marking catching up', 'A short pause while marking catches up.'],
    ['Technical issue', 'Back shortly — technical issue.']
  ];

  async function doPause() {
    await fetch('/host/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: hostEls.pauseReason.value, message: hostEls.pauseMessage.value,
        expects_version: lastState.version
      })
    });
    await refreshHost();
  }

  async function doResume() {
    await fetch('/host/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expects_version: lastState.version })
    });
    await refreshHost();
  }

  function buildPauseControl(container) {
    const status = document.createElement('p');
    status.className = 'status wait';
    status.style.display = 'none';
    status.style.marginBottom = 'var(--s3)';
    container.appendChild(status);
    hostEls.pauseStatus = status;

    const presetsRow = document.createElement('div');
    presetsRow.style.display = 'flex';
    presetsRow.style.gap = 'var(--s2)';
    presetsRow.style.flexWrap = 'wrap';
    presetsRow.style.marginBottom = 'var(--s3)';

    const reasonInput = document.createElement('input');
    reasonInput.className = 'field';
    reasonInput.placeholder = 'Reason (e.g. food service)';
    const messageInput = document.createElement('input');
    messageInput.className = 'field';
    messageInput.placeholder = 'Message shown to the room';
    hostEls.pauseReason = reasonInput;
    hostEls.pauseMessage = messageInput;

    PAUSE_PRESETS.forEach(([reason, message]) => {
      const presetBtn = document.createElement('button');
      presetBtn.type = 'button';
      presetBtn.className = 'btn ghost sm';
      presetBtn.textContent = reason;
      presetBtn.addEventListener('click', () => {
        reasonInput.value = reason;
        messageInput.value = message;
      });
      presetsRow.appendChild(presetBtn);
    });

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = 'var(--s2)';
    btnRow.style.marginTop = 'var(--s3)';

    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = 'btn ghost';
    pauseBtn.append('Pause ', Object.assign(document.createElement('kbd'), { textContent: 'P' }));
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'btn';
    resumeBtn.append('Resume ', Object.assign(document.createElement('kbd'), { textContent: 'P' }));

    pauseBtn.addEventListener('click', doPause);
    resumeBtn.addEventListener('click', doResume);
    btnRow.append(pauseBtn, resumeBtn);

    container.append(presetsRow, reasonInput, messageInput, btnRow);
  }

  // --- table support: bonus + answer on a table's behalf ------------------

  function buildTableSupport(container) {
    const heading = document.createElement('div');
    heading.className = 'label';
    heading.style.marginBottom = 'var(--s2)';
    heading.textContent = 'Table support';
    container.appendChild(heading);

    const answerRow = document.createElement('div');
    answerRow.className = 'stack';
    const teamInput = document.createElement('input');
    teamInput.className = 'field';
    teamInput.placeholder = 'Team id';
    teamInput.inputMode = 'numeric';

    const valueInput = document.createElement('input');
    valueInput.className = 'field';
    valueInput.placeholder = 'Answer value';
    const answerBtn = document.createElement('button');
    answerBtn.type = 'button';
    answerBtn.className = 'btn ghost';
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
    answerRow.append(teamInput, valueInput, answerBtn, answerMsg);
    container.appendChild(answerRow);

    const bonusRule = document.createElement('hr');
    bonusRule.className = 'rule';
    container.appendChild(bonusRule);

    // Bonus: tap a table, tap an amount, award. Two taps, or it won't get
    // used during a live night (host-console mockup note). B focuses the
    // grid rather than awarding blind — a real award still needs a table
    // and points chosen first.
    const bonusHeading = document.createElement('div');
    bonusHeading.className = 'label';
    bonusHeading.style.marginBottom = 'var(--s2)';
    bonusHeading.textContent = 'Award a bonus — tap a table';
    container.appendChild(bonusHeading);

    const bonusGrid = document.createElement('div');
    bonusGrid.style.display = 'grid';
    bonusGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(64px, 1fr))';
    bonusGrid.style.gap = 'var(--s2)';
    hostEls.bonusGrid = bonusGrid;
    let selectedTeamId = null;

    async function refreshBonusGrid() {
      const res = await fetch('/host/scores', { cache: 'no-store' });
      const data = await res.json();
      clear(bonusGrid);
      data.scores.forEach((s) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tile' + (s.team_id === selectedTeamId ? ' seated' : '');
        btn.style.justifyContent = 'center';
        if (s.colour) { btn.style.borderLeftWidth = '4px'; btn.style.borderLeftColor = s.colour.from; }
        btn.textContent = `${s.table_number}`;
        btn.addEventListener('click', () => { selectedTeamId = s.team_id; refreshBonusGrid(); });
        bonusGrid.appendChild(btn);
      });
    }
    refreshBonusGrid();

    const pointsRow = document.createElement('div');
    pointsRow.style.display = 'flex';
    pointsRow.style.gap = 'var(--s2)';
    pointsRow.style.margin = 'var(--s3) 0';
    let pointsValue = 1;
    [1, 2, 3].forEach((n) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'btn ghost sm';
      pill.textContent = `+${n}`;
      pill.addEventListener('click', () => { pointsValue = n; customPoints.value = ''; });
      pointsRow.appendChild(pill);
    });
    const customPoints = document.createElement('input');
    customPoints.className = 'field';
    customPoints.placeholder = 'Custom amount';
    customPoints.inputMode = 'numeric';
    pointsRow.appendChild(customPoints);

    const reasonInput = document.createElement('input');
    reasonInput.className = 'field';
    reasonInput.placeholder = 'Reason (shown on their phones)';
    const bonusBtn = document.createElement('button');
    bonusBtn.type = 'button';
    bonusBtn.className = 'btn wide';
    bonusBtn.textContent = 'Award';
    const bonusMsg = document.createElement('p');
    bonusMsg.className = 'error';
    bonusMsg.setAttribute('role', 'alert');

    bonusBtn.addEventListener('click', async () => {
      if (!selectedTeamId) { bonusMsg.textContent = 'Tap a table first.'; return; }
      const points = customPoints.value ? Number(customPoints.value) : pointsValue;
      const idempotencyKey = `${Date.now()}-${Math.random()}`;
      const res = await fetch('/host/bonus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: selectedTeamId, points, reason: reasonInput.value, idempotency_key: idempotencyKey })
      });
      const data = await res.json();
      bonusMsg.textContent = res.ok ? 'Bonus awarded.' : `Could not award: ${data.error}`;
      selectedTeamId = null;
      reasonInput.value = '';
      await refreshBonusGrid();
      await refreshScores();
    });

    container.append(bonusGrid, pointsRow, reasonInput, bonusBtn, bonusMsg);
  }

  // --- scores (derived on read, CLAUDE.md #13) ----------------------------

  function buildScoresPanel(container) {
    const rule = document.createElement('hr');
    rule.className = 'rule';
    container.appendChild(rule);

    const heading = document.createElement('div');
    heading.className = 'label';
    heading.style.marginBottom = 'var(--s2)';
    heading.textContent = 'Scores';
    container.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'stack';
    container.appendChild(list);
    hostEls.scoresList = list;

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn ghost sm';
    refreshBtn.style.marginTop = 'var(--s3)';
    refreshBtn.textContent = 'Refresh scores';
    refreshBtn.addEventListener('click', refreshScores);
    container.appendChild(refreshBtn);

    refreshScores();
  }

  async function refreshScores() {
    const res = await fetch('/host/scores', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    clear(hostEls.scoresList);
    data.scores.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'tile flat';
      const label = document.createElement('span');
      label.textContent = `Table ${s.table_number} — ${s.team_name}`;
      const score = document.createElement('span');
      score.className = 'num';
      score.style.marginLeft = 'auto';
      score.style.fontWeight = '700';
      score.textContent = String(s.score);
      row.append(label, score);
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
    app.style.padding = '';
    markerEls = {};

    const cbody = document.createElement('div');
    cbody.className = 'cbody';
    app.appendChild(cbody);

    const heading = document.createElement('div');
    heading.className = 'label';
    heading.style.marginBottom = 'var(--s2)';
    heading.textContent = 'Marking queue';
    cbody.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'stack';
    cbody.appendChild(list);
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
    applyTheme(state.theme);
    clear(markerEls.list);
    if (!state.questions.length) {
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = 'Nothing waiting to be marked.';
      markerEls.list.appendChild(p);
      return;
    }

    state.questions.forEach((qu) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tile';

      const label = document.createElement('span');
      label.textContent = qu.prompt;
      const mark = document.createElement('span');
      mark.className = 'mark status wait';
      mark.textContent = `${qu.unmarked_count}/${qu.total_answers} to judge`;
      row.append(label, mark);

      if (qu.claim.held) {
        row.classList.add('flat');
        mark.textContent = `Claimed by ${qu.claim.marker}`;
      } else {
        row.addEventListener('click', () => claimAndOpen(qu.id));
      }

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
    applyTheme(data.theme);

    const cbody = document.createElement('div');
    cbody.className = 'cbody';
    app.appendChild(cbody);

    const pending = data.answers.filter((a) => a.is_correct === null);
    const judgedCount = data.answers.length - pending.length;

    const headRow = document.createElement('div');
    headRow.style.display = 'flex';
    headRow.style.justifyContent = 'space-between';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = `${judgedCount} auto-matched · ${pending.length} to judge`;
    const holdLabel = document.createElement('span');
    holdLabel.className = 'label';
    holdLabel.textContent = 'You hold this question';
    headRow.append(label, holdLabel);
    cbody.appendChild(headRow);

    // The correct answer stays on screen throughout the sweep — you're
    // reading it, not remembering it (design-handover §8).
    const prompt = document.createElement('h1');
    prompt.className = 'display';
    prompt.style.fontSize = 'var(--t-h2)';
    prompt.style.margin = 'var(--s2) 0 var(--s2)';
    prompt.textContent = data.question.prompt;
    cbody.appendChild(prompt);

    const answer = document.createElement('p');
    answer.className = 'note';
    answer.textContent = data.question.correct_answer +
      (data.question.aliases.length ? ` · also accepting ${data.question.aliases.join(', ')}` : '');
    cbody.appendChild(answer);

    if (!pending.length) {
      const notice = document.createElement('div');
      notice.className = 'notice ok';
      notice.style.marginTop = 'var(--s4)';
      notice.textContent = 'All answers judged for this question.';
      cbody.appendChild(notice);
    } else {
      const a = pending[0];
      const card = document.createElement('div');
      card.className = 'tile flat';
      card.style.flexDirection = 'column';
      card.style.alignItems = 'flex-start';
      card.style.gap = 'var(--s1)';
      card.style.margin = 'var(--s4) 0 var(--s3)';
      const who = document.createElement('span');
      who.className = 'label';
      who.textContent = `Table ${a.table_number}${a.team_name ? ' — ' + a.team_name : ''}`;
      const value = document.createElement('span');
      value.className = 'display';
      value.style.fontSize = 'var(--t-h3)';
      value.textContent = a.value;
      card.append(who, value);
      cbody.appendChild(card);

      const yesNoRow = document.createElement('div');
      yesNoRow.style.display = 'flex';
      yesNoRow.style.gap = 'var(--s3)';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'btn wide';
      yes.style.color = 'var(--correct)';
      yes.style.background = 'transparent';
      yes.style.borderColor = 'var(--correct)';
      yes.append('Correct ', Object.assign(document.createElement('kbd'), { textContent: 'Y' }));
      yes.addEventListener('click', () => mark(questionId, a.team_id, true));
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'btn wide';
      no.style.color = 'var(--wrong)';
      no.style.background = 'transparent';
      no.style.borderColor = 'var(--wrong)';
      no.append('Wrong ', Object.assign(document.createElement('kbd'), { textContent: 'N' }));
      no.addEventListener('click', () => mark(questionId, a.team_id, false));
      yesNoRow.append(yes, no);
      cbody.appendChild(yesNoRow);

      const alias = document.createElement('button');
      alias.type = 'button';
      alias.className = 'btn ghost wide';
      alias.style.marginTop = 'var(--s3)';
      alias.append('Accept this spelling for every table ', Object.assign(document.createElement('kbd'), { textContent: 'A' }));
      alias.addEventListener('click', () => addAlias(questionId, a.value));
      cbody.appendChild(alias);

      const aliasNote = document.createElement('p');
      aliasNote.className = 'note';
      aliasNote.textContent = 'Applies to all tables and re-scores. Confirmed before it lands.';
      cbody.appendChild(aliasNote);

      markerCurrentAnswer = { questionId, teamId: a.team_id, value: a.value };
    }

    const rule = document.createElement('hr');
    rule.className = 'rule';
    cbody.appendChild(rule);

    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn ghost wide';
    done.textContent = 'Back to queue';
    done.addEventListener('click', async () => {
      window.removeEventListener('keydown', markerKeydown);
      markerKeydownAttached = false;
      await fetch('/marker/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: questionId })
      });
      startMarker();
    });
    cbody.appendChild(done);

    if (!markerKeydownAttached) {
      window.addEventListener('keydown', markerKeydown);
      markerKeydownAttached = true;
    }
  }

  // One shared listener across re-renders of the detail view (a mark
  // re-fetches and re-renders in place) — guarded the same way as the host
  // shortcuts, and always acting on whichever answer is currently on screen.
  let markerCurrentAnswer = null;
  let markerKeydownAttached = false;
  function markerKeydown(e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!markerCurrentAnswer) return;
    const { questionId, teamId, value } = markerCurrentAnswer;
    if (e.key === 'y' || e.key === 'Y') mark(questionId, teamId, true);
    else if (e.key === 'n' || e.key === 'N') mark(questionId, teamId, false);
    else if (e.key === 'a' || e.key === 'A') addAlias(questionId, value);
  }

  async function mark(questionId, teamId, correct) {
    markerCurrentAnswer = null;
    await fetch('/marker/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, team_id: teamId, correct })
    });
    openMarkerDetail(questionId);
  }

  async function addAlias(questionId, alias) {
    markerCurrentAnswer = null;
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
    app.style.padding = '';
    const cbody = document.createElement('div');
    cbody.className = 'cbody';
    app.appendChild(cbody);
    adminBody = cbody;

    const heading = document.createElement('div');
    heading.className = 'label';
    heading.textContent = 'Admin';
    cbody.appendChild(heading);

    buildEventsSection();
    buildQuestionsSection();
    buildTablesSection();
    buildMediaSection();
    buildThemeSection();
    buildConfigSection();
    buildAuditSection();
    buildBackupSection();
  }

  let adminBody = null;

  // --- events: many configured, exactly one active (technical-design §16.5) --

  function buildEventsSection() {
    section('Events');

    const nameInput = document.createElement('input');
    nameInput.className = 'field';
    nameInput.placeholder = 'New event name';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'btn ghost';
    createBtn.textContent = 'New event (draft)';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');

    const list = document.createElement('div');
    list.className = 'stack';

    async function refreshEvents() {
      const res = await fetch('/admin/events', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.events.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'tile flat' + (e.status === 'active' ? ' seated' : '');
        const label = document.createElement('span');
        const current = e.id === data.current_event_id ? ' — this session' : '';
        const rounds = e.total_rounds ? `, ${e.total_rounds} rounds` : ', rounds not set';
        label.textContent = `${e.name} — ${e.status} — ${e.question_count} questions, ${e.table_count} tables${rounds}${current}`;
        row.appendChild(label);

        // Drives the host's pre-flight/final phase detection (see
        // /host/state) — nullable, and unset means final never auto-fires.
        if (e.id === data.current_event_id) {
          const roundsInput = document.createElement('input');
          roundsInput.className = 'field';
          roundsInput.type = 'number';
          roundsInput.min = '1';
          roundsInput.style.width = '80px';
          roundsInput.placeholder = 'Rounds';
          roundsInput.value = e.total_rounds ?? '';
          const roundsSaveBtn = document.createElement('button');
          roundsSaveBtn.type = 'button';
          roundsSaveBtn.className = 'btn ghost sm';
          roundsSaveBtn.textContent = 'Save rounds';
          roundsSaveBtn.addEventListener('click', async () => {
            const res2 = await fetch(`/admin/events/${e.id}/total-rounds`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ total_rounds: roundsInput.value ? Number(roundsInput.value) : null })
            });
            msg.textContent = res2.ok ? 'Saved.' : 'Could not save total rounds.';
            refreshEvents();
          });
          row.append(roundsInput, roundsSaveBtn);
        }

        if (e.status !== 'active' && e.id === data.current_event_id) {
          const activateBtn = document.createElement('button');
          activateBtn.type = 'button';
          activateBtn.className = 'btn sm';
          activateBtn.style.marginLeft = 'auto';
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
          finishBtn.className = 'btn ghost sm';
          finishBtn.style.marginLeft = 'auto';
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

    adminBody.append(nameInput, createBtn, msg, list);
    refreshEvents();
  }

  function section(title) {
    const rule = document.createElement('hr');
    rule.className = 'rule';
    const h = document.createElement('div');
    h.className = 'label';
    h.style.marginBottom = 'var(--s2)';
    h.textContent = title;
    adminBody.append(rule, h);
  }

  function fileNameInput(accept) {
    const input = document.createElement('input');
    input.className = 'field';
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
    previewBtn.className = 'btn ghost';
    previewBtn.textContent = 'Preview CSV';
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'btn';
    importBtn.textContent = 'Import (replaces the whole set)';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');
    const previewList = document.createElement('div');
    previewList.className = 'stack';

    async function withCsvText(fn) {
      if (!fileInput.files[0]) { msg.textContent = 'Choose a CSV file first.'; return; }
      const text = await fileInput.files[0].text();
      await fn(text);
    }

    function renderPreview(result) {
      clear(previewList);
      result.rows.forEach((row) => {
        const line = document.createElement('div');
        line.className = 'tile flat';
        line.style.flexDirection = 'column';
        line.style.alignItems = 'flex-start';
        const label = document.createElement('span');
        label.textContent = `Row ${row.rowNumber}: ${row.prompt || '(no prompt)'}`;
        line.appendChild(label);
        if (row.errors.length) {
          const err = document.createElement('span');
          err.className = 'status bad';
          err.textContent = row.errors.join('; ');
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

    const listHeading = document.createElement('div');
    listHeading.className = 'label';
    listHeading.style.margin = 'var(--s4) 0 var(--s2)';
    listHeading.textContent = 'Current question set';
    const list = document.createElement('div');
    list.className = 'stack';

    async function refreshQuestionsList() {
      const res = await fetch('/admin/questions', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.questions.forEach((qu) => {
        const row = document.createElement('div');
        row.className = 'tile flat';
        const label = document.createElement('span');
        const where = qu.is_practice ? 'Practice' : qu.is_reserve ? 'Reserve' : `R${qu.round} Q${qu.order_no}`;
        label.textContent = `${where}: ${qu.prompt} — answer: ${qu.correct_answer} (${qu.points}pt, ${qu.type})`;
        row.appendChild(label);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn ghost sm';
        editBtn.style.marginLeft = 'auto';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openQuestionEditor(qu.id));
        row.appendChild(editBtn);

        list.appendChild(row);
      });
    }

    const editorWrap = document.createElement('div');
    editorWrap.className = 'stack';

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
      promptInput.className = 'field';
      promptInput.value = qu.prompt;
      const correctInput = document.createElement('input');
      correctInput.className = 'field';
      correctInput.value = qu.correct_answer || '';
      const aliasesInput = document.createElement('input');
      aliasesInput.className = 'field';
      aliasesInput.placeholder = 'Aliases, pipe-separated';
      aliasesInput.value = (qu.aliases || []).join('|');
      const pointsInput = document.createElement('input');
      pointsInput.className = 'field';
      pointsInput.type = 'number';
      pointsInput.value = qu.points;

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'btn ghost';
      previewBtn.textContent = 'Preview impact';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn';
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

    adminBody.append(fileInput, previewBtn, importBtn, msg, previewList, listHeading, list, editorWrap);
    refreshQuestionsList();
  }

  // --- tables: CSV import (upsert), list + archive ------------------------

  function buildTablesSection() {
    section('Tables');

    const fileInput = fileNameInput('.csv');
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'btn ghost';
    importBtn.textContent = 'Import tables CSV (adds/updates only)';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');

    const list = document.createElement('div');
    list.className = 'stack';

    async function refreshTables() {
      const res = await fetch('/admin/tables', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.tables.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'tile flat';
        const label = document.createElement('span');
        label.textContent = `Table ${t.table_number} — ${t.seats} seats${t.archived ? ' (archived)' : ''}`;
        row.appendChild(label);
        if (!t.archived) {
          const archiveBtn = document.createElement('button');
          archiveBtn.type = 'button';
          archiveBtn.className = 'btn ghost sm';
          archiveBtn.style.marginLeft = 'auto';
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
    qrBtn.className = 'btn ghost';
    qrBtn.textContent = 'Print QR sheet';
    qrBtn.addEventListener('click', () => window.open('/admin/tables/qr-sheet', '_blank'));

    adminBody.append(fileInput, importBtn, msg, qrBtn, list);
    refreshTables();
  }

  // --- media: upload (compressed + hashed server-side), list --------------

  function buildMediaSection() {
    section('Media');

    const fileInput = fileNameInput('image/*');
    const nameInput = document.createElement('input');
    nameInput.className = 'field';
    nameInput.placeholder = 'Filename as referenced in the CSV (e.g. opera-house.jpg)';
    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'btn ghost';
    uploadBtn.textContent = 'Upload';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');

    const list = document.createElement('div');
    list.className = 'stack';

    async function refreshMedia() {
      const res = await fetch('/admin/media', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.files.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'tile flat';
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

    adminBody.append(fileInput, nameInput, uploadBtn, msg, list);
    refreshMedia();
  }

  // --- config: export/import JSON, separate from the DB backup -----------

  function buildConfigSection() {
    section('Config export / import');

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn ghost';
    exportBtn.textContent = 'Export config (JSON)';
    const fileInput = fileNameInput('.json');
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'btn ghost';
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

    const configRule = document.createElement('hr');
    configRule.className = 'rule';
    adminBody.append(exportBtn, configRule, fileInput, importBtn, msg);
  }

  // --- audit log (dispute evidence, CLAUDE.md Conventions) ----------------

  function buildAuditSection() {
    section('Audit log');

    const list = document.createElement('div');
    list.className = 'stack';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn ghost sm';
    refreshBtn.style.marginBottom = 'var(--s3)';
    refreshBtn.textContent = 'Refresh audit log';

    async function refreshAudit() {
      const res = await fetch('/admin/audit', { cache: 'no-store' });
      const data = await res.json();
      clear(list);
      data.entries.slice(0, 50).forEach((e) => {
        const row = document.createElement('div');
        row.className = 'tile flat';
        const label = document.createElement('span');
        label.textContent = `${e.at} — ${e.role}${e.operator ? '/' + e.operator : ''}: ${e.action} ${e.target || ''} ${e.reason ? '(' + e.reason + ')' : ''}`;
        row.appendChild(label);
        list.appendChild(row);
      });
    }

    refreshBtn.addEventListener('click', refreshAudit);
    adminBody.append(refreshBtn, list);
    refreshAudit();
  }

  // --- theme: event/round/question cascade (CLAUDE.md #18-22) ------------

  const LAYOUTS = ['standard', 'image', 'media', 'statement', 'text-answer'];

  function buildThemeSection() {
    section('Theme');

    const levelSelect = document.createElement('select');
    levelSelect.className = 'field';
    ['event', 'round', 'question'].forEach((lv) => {
      const opt = document.createElement('option');
      opt.value = lv; opt.textContent = lv[0].toUpperCase() + lv.slice(1);
      levelSelect.appendChild(opt);
    });

    const targetInput = document.createElement('input');
    targetInput.className = 'field';
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
    layoutSelect.className = 'field';
    LAYOUTS.forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l; opt.textContent = l;
      layoutSelect.appendChild(opt);
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn ghost';
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

    const themeRow1 = document.createElement('div');
    themeRow1.style.display = 'flex';
    themeRow1.style.alignItems = 'center';
    themeRow1.style.gap = 'var(--s2)';
    themeRow1.append(layoutOverride, document.createTextNode(' Layout '), layoutSelect);
    const themeRow2 = document.createElement('div');
    themeRow2.style.display = 'flex';
    themeRow2.style.alignItems = 'center';
    themeRow2.style.gap = 'var(--s2)';
    themeRow2.style.flexWrap = 'wrap';
    themeRow2.append(
      bgOverride, document.createTextNode(' Background '), bgInput,
      bg2Override, document.createTextNode(' Gradient end '), bg2Input,
      accentOverride, document.createTextNode(' Accent '), accentInput
    );
    adminBody.append(levelSelect, targetInput, themeRow1, themeRow2, saveBtn, msg);

    // Chrome — event level only, deliberately outside the cascade (CLAUDE.md #20).
    const chromeRule = document.createElement('hr');
    chromeRule.className = 'rule';
    const chromeHeading = document.createElement('div');
    chromeHeading.className = 'label';
    chromeHeading.style.marginBottom = 'var(--s2)';
    chromeHeading.textContent = 'Chrome (event only, does not cascade)';
    const titleInput = document.createElement('input'); titleInput.className = 'field'; titleInput.placeholder = 'Title';
    const subtitleInput = document.createElement('input'); subtitleInput.className = 'field'; subtitleInput.placeholder = 'Subtitle';
    const logoLightInput = document.createElement('input'); logoLightInput.className = 'field'; logoLightInput.placeholder = 'Logo filename (light bg)';
    const logoDarkInput = document.createElement('input'); logoDarkInput.className = 'field'; logoDarkInput.placeholder = 'Logo filename (dark bg)';
    const footerInput = document.createElement('input'); footerInput.className = 'field'; footerInput.placeholder = 'Footer band text';
    const chromeSaveBtn = document.createElement('button');
    chromeSaveBtn.type = 'button';
    chromeSaveBtn.className = 'btn ghost';
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
    adminBody.append(
      chromeRule, chromeHeading, titleInput, subtitleInput, logoLightInput, logoDarkInput, footerInput, chromeSaveBtn
    );

    // Preview — back of the room, at the scale it'll actually be judged at
    // (design-handover: aTheme, "if it fails here, it fails on the night").
    // Shows the event default; a round/question override still needs the
    // resolved-themes list below to confirm nothing downstream broke.
    const previewLabel = document.createElement('div');
    previewLabel.className = 'label';
    previewLabel.style.margin = 'var(--s4) 0 var(--s2)';
    previewLabel.textContent = 'Preview — back of the room';
    const preview = document.createElement('div');
    preview.className = 'bigscreen-preview';
    const previewInner = document.createElement('div');
    const previewEyebrow = document.createElement('div');
    previewEyebrow.className = 's-eyebrow';
    previewEyebrow.textContent = 'Round 1 · Q4';
    const previewPrompt = document.createElement('div');
    previewPrompt.className = 's-prompt';
    previewPrompt.textContent = 'Which Australian city hosted the 2000 Olympics?';
    previewInner.append(previewEyebrow, previewPrompt);
    preview.appendChild(previewInner);
    adminBody.append(previewLabel, preview);

    function renderPreview(resolved) {
      const c = resolved.colour;
      preview.style.setProperty('--bg', c.bg);
      preview.style.setProperty('--bg2', c.bg2);
      preview.style.setProperty('--text', c.text);
      preview.style.setProperty('--accent', c.accent);
    }

    // Resolved + validated (CLAUDE.md #21) — the client never sees the
    // cascade, only this already-resolved result.
    const resolvedHeading = document.createElement('p');
    resolvedHeading.textContent = 'Resolved themes';
    const resolvedList = document.createElement('div');
    resolvedList.className = 'stack';
    adminBody.append(resolvedHeading, resolvedList);

    async function refreshResolved() {
      const res = await fetch('/admin/theme', { cache: 'no-store' });
      const data = await res.json();
      renderPreview(data.event_default.resolved);
      clear(resolvedList);

      const summary = document.createElement('div');
      summary.className = 'notice ' + (data.event_default.validation.pass ? 'ok' : 'bad');
      const failingQuestions = data.questions.filter((r) => !r.validation.pass);
      summary.textContent = `Event default: ${data.event_default.validation.pass ? 'pass' : 'FAIL'} — ` +
        `${data.questions.length - failingQuestions.length}/${data.questions.length} questions pass`;
      resolvedList.appendChild(summary);

      failingQuestions.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'notice bad';
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
    btn.className = 'btn ghost';
    btn.textContent = 'Download database backup';
    btn.addEventListener('click', () => {
      window.location.href = '/admin/backup/database';
    });

    const resultsBtn = document.createElement('button');
    resultsBtn.type = 'button';
    resultsBtn.className = 'btn ghost';
    resultsBtn.textContent = 'Export results (CSV)';
    resultsBtn.addEventListener('click', () => {
      window.location.href = '/admin/results/export';
    });

    adminBody.append(btn, resultsBtn);
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
    app.style.padding = '';
    floorEls = {};

    const cbody = document.createElement('div');
    cbody.className = 'cbody';
    app.appendChild(cbody);

    const summaryRow = document.createElement('div');
    summaryRow.style.display = 'flex';
    summaryRow.style.justifyContent = 'space-between';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Tables';
    const summary = document.createElement('span');
    summary.className = 'label num';
    summaryRow.append(label, summary);
    cbody.appendChild(summaryRow);
    floorEls.summary = summary;

    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(64px, 1fr))';
    grid.style.gap = 'var(--s2)';
    grid.style.margin = 'var(--s2) 0 var(--s4)';
    cbody.appendChild(grid);
    floorEls.grid = grid;

    const rule = document.createElement('hr');
    rule.className = 'rule';
    cbody.appendChild(rule);

    const attentionHeading = document.createElement('div');
    attentionHeading.className = 'label';
    attentionHeading.style.marginBottom = 'var(--s2)';
    attentionHeading.textContent = 'Needs attention';
    const attention = document.createElement('div');
    attention.className = 'stack';
    cbody.append(attentionHeading, attention);
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
    applyTheme(state.theme);
    const teams = state.teams;
    const statuses = teams.map((t) => ({ t, status: presenceStatus(t, state.question_open) }));
    const answeredCount = teams.filter((t) => t.answered_current).length;

    floorEls.summary.textContent = state.question_open
      ? `${answeredCount} answering`
      : 'no question open';

    clear(floorEls.grid);
    statuses.forEach(({ t, status }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tile';
      btn.style.justifyContent = 'center';
      // Team colour identifies the table, never a correctness signal on
      // this surface (CLAUDE.md #16/#18) — a small accent, not a status.
      if (t.colour) {
        btn.style.borderLeftWidth = '4px';
        btn.style.borderLeftColor = t.colour.from;
      }
      btn.textContent = String(t.table_number);
      if (status !== 'ok') {
        const dot = document.createElement('span');
        dot.className = 'status ' + (status === 'offline' ? 'bad' : 'wait');
        btn.appendChild(dot);
      }
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
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tile';

      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = String(t.table_number);
      const label = document.createElement('span');
      label.textContent = status === 'offline' ? 'Offline' : 'No answer this round';
      const mark = document.createElement('span');
      mark.className = 'mark status ' + (status === 'offline' ? 'bad' : 'wait');
      mark.textContent = status === 'offline' ? 'Down' : 'Quiet';
      row.append(chip, label, mark);
      row.addEventListener('click', () => openFloorTable(t.team_id));
      floorEls.attention.appendChild(row);
    });
  }

  async function openFloorTable(teamId) {
    if (floorPollHandle) floorPollHandle.stop();
    clear(app);
    app.style.padding = '';

    const res = await fetch(`/floor/team/${teamId}`, { cache: 'no-store' });
    if (!res.ok) { startFloor(); return; }
    const data = await res.json();
    applyTheme(data.theme);

    const band = document.createElement('div');
    band.className = 'band';
    const name = document.createElement('span');
    name.textContent = data.team.team_name || '';
    const tableNo = document.createElement('span');
    tableNo.className = 'table-no num';
    tableNo.textContent = `Table ${data.team.table_number}`;
    band.append(name, tableNo);
    app.appendChild(band);

    const cbody = document.createElement('div');
    cbody.className = 'cbody';
    app.appendChild(cbody);

    const info = document.createElement('div');
    info.className = 'tile flat';
    info.textContent = `Players: ${data.players.map((p) => p.username).join(', ') || 'none yet'}`;
    cbody.appendChild(info);

    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.style.marginTop = 'var(--s3)';

    const renameInput = document.createElement('input');
    renameInput.className = 'field';
    renameInput.placeholder = 'New team name';
    renameInput.value = data.team.team_name || '';
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn ghost wide';
    renameBtn.textContent = 'Rename team';
    renameBtn.addEventListener('click', async () => {
      await fetch('/floor/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId, team_name: renameInput.value })
      });
      openFloorTable(teamId);
    });

    const captainSelect = document.createElement('select');
    captainSelect.className = 'field';
    data.players.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.username + (p.id === data.team.captain_player_id ? ' (captain)' : '');
      captainSelect.appendChild(opt);
    });
    const captainBtn = document.createElement('button');
    captainBtn.type = 'button';
    captainBtn.className = 'btn ghost wide';
    captainBtn.textContent = 'Make captain';
    captainBtn.addEventListener('click', async () => {
      await fetch('/floor/reassign-captain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId, player_id: Number(captainSelect.value) })
      });
      openFloorTable(teamId);
    });

    stack.append(renameInput, renameBtn, captainSelect, captainBtn);
    cbody.appendChild(stack);

    if (data.current_question) {
      const rule = document.createElement('hr');
      rule.className = 'rule';
      cbody.appendChild(rule);

      const qHeading = document.createElement('p');
      qHeading.className = 'note';
      qHeading.textContent = data.current_question.prompt;
      cbody.appendChild(qHeading);

      const answerStack = document.createElement('div');
      answerStack.className = 'stack';
      const valueInput = document.createElement('input');
      valueInput.className = 'field';
      valueInput.placeholder = 'What the table told you';
      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'btn ghost wide';
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

      answerStack.append(valueInput, submitBtn, msg);
      cbody.appendChild(answerStack);
    }

    const backRule = document.createElement('hr');
    backRule.className = 'rule';
    cbody.appendChild(backRule);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn ghost wide';
    back.textContent = 'Back to room';
    back.addEventListener('click', startFloor);
    cbody.appendChild(back);
  }

  // Direct-link convenience: /ops?role=host&pin=111111&name=Sam skips
  // straight to a pre-filled, auto-submitted sign-in — see the comment in
  // renderPinForm for the tradeoff this accepts.
  (function bootstrap() {
    const params = new URLSearchParams(location.search);
    const role = params.get('role');
    if (['host', 'marker', 'floor', 'admin'].includes(role)) {
      renderPinForm(role, { pin: params.get('pin'), name: params.get('name') });
    } else {
      renderRolePicker();
    }
  })();
})();
