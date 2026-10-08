// Player page. One render() reacting to /state's `stage`. Re-renders the
// play view in place rather than tearing it down (CLAUDE.md #15) — the gate
// and name screens are one-shot forms, so only the play view needs that care.
// Every user-facing string here is set via textContent, never innerHTML
// (CLAUDE.md #2).
(function () {
  const app = document.getElementById('app');
  const announcer = document.getElementById('announcer');
  let pollHandle = null;
  let currentStage = null;
  let playEls = null;
  let latestPlayState = null;

  // Team colour is an identifier, not a theme (CLAUDE.md #18) — header band
  // and small markers only, never the content area. The table number
  // always appears alongside it in plain text; colour is never the sole
  // identifier.
  function colourCss(colour) {
    if (!colour) return null;
    return colour.type === 'gradient'
      ? `linear-gradient(135deg, ${colour.from}, ${colour.to})`
      : colour.from;
  }

  function luminance(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function bestTextOn(hex) {
    return luminance(hex) < 0.4 ? '#ffffff' : '#111111';
  }

  function announce(msg) {
    announcer.textContent = msg;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function toEmbedUrl(url) {
    const match = String(url).match(/(?:v=|youtu\.be\/|embed\/)([\w-]{6,})/);
    if (!match) return null;
    return `https://www.youtube-nocookie.com/embed/${match[1]}?rel=0&modestbranding=1`;
  }

  async function refreshState() {
    const res = await fetch('/state', { cache: 'no-store' });
    const state = await res.json();
    render(state);
  }

  let pauseOverlay = null;

  function showPaused(message) {
    if (playEls) {
      // Already in the play view — overlay on top and touch nothing
      // underneath. currentStage deliberately stays 'play' so resuming
      // (stage flips back to 'play') falls straight into the in-place
      // updatePlay() branch below, leaving any typed draft untouched
      // (CLAUDE.md #17).
      if (!pauseOverlay) {
        pauseOverlay = document.createElement('div');
        pauseOverlay.className = 'paused-overlay';
        document.body.appendChild(pauseOverlay);
      }
      pauseOverlay.textContent = '';
      const p = document.createElement('p');
      p.textContent = message || 'Paused';
      pauseOverlay.appendChild(p);
      pauseOverlay.style.display = '';
      announce(`Paused. ${message || ''}`);
      return;
    }

    // Never entered the play view this session (e.g. page loaded fresh
    // while already paused) — nothing to preserve, just show the card.
    currentStage = 'paused';
    clear(app);
    const p = document.createElement('p');
    p.textContent = message || 'Paused';
    app.appendChild(p);
  }

  function hidePaused() {
    if (pauseOverlay) pauseOverlay.style.display = 'none';
  }

  function render(state) {
    if (state.stage === 'paused') {
      showPaused(state.message);
      return;
    }
    hidePaused();

    if (state.stage === 'play' && currentStage === 'play') {
      updatePlay(state);
      return;
    }

    currentStage = state.stage;
    playEls = null;
    clear(app);

    if (state.stage === 'no_session' || state.stage === 'event_not_running') {
      const pbody = document.createElement('div');
      pbody.className = 'pbody';
      const p = document.createElement('p');
      p.textContent = state.stage === 'no_session'
        ? "Scan your table's QR code to join."
        : "This event isn't running right now.";
      pbody.appendChild(p);
      app.appendChild(pbody);
      return;
    }

    if (state.stage === 'gate') return renderGate();
    if (state.stage === 'name') return renderName(state.team);
    if (state.stage === 'play') return enterPlay(state);
    if (state.stage === 'leaderboard') return renderLeaderboard(state);
  }

  function renderLeaderboard(state) {
    if (state.theme) applyTheme(state.theme);

    const pbody = document.createElement('div');
    pbody.className = 'pbody';
    app.appendChild(pbody);

    const eyebrow = document.createElement('p');
    eyebrow.className = 'label';
    eyebrow.textContent = `Table ${state.team.table_number}${state.team.team_name ? ' — ' + state.team.team_name : ''}`;
    const title = document.createElement('h1');
    title.className = 'display';
    title.style.fontSize = 'var(--t-h2)';
    title.style.margin = '4px 0 var(--s4)';
    title.textContent = `Leaderboard — Round ${state.round}`;
    pbody.append(eyebrow, title);

    if (state.our_place) {
      const place = document.createElement('p');
      place.className = 'note';
      place.textContent = `Your table: ${ordinal(state.our_place)} place`;
      pbody.appendChild(place);
    }

    const list = document.createElement('div');
    list.className = 'lb';
    state.leaderboard.forEach((row, i) => {
      const line = document.createElement('div');
      // .lead is rank-based (top of the board), distinct from "our table"
      // which gets its own marker below — the old markup conflated the two
      // via a single .selected class.
      line.className = 'lb-row' + (i === 0 ? ' lead' : '');
      const pos = document.createElement('span');
      pos.className = 'pos num';
      pos.textContent = String(i + 1);
      line.appendChild(pos);
      // Team colour is a fixed swatch bar, never a row background
      // (CLAUDE.md #18, technical-design §20.4).
      const swatchCss = colourCss(row.colour);
      if (swatchCss) {
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = swatchCss;
        line.appendChild(swatch);
      }
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.team_name;
      if (state.our_place === i + 1) {
        const us = document.createElement('span');
        us.className = 'label';
        us.style.marginLeft = '6px';
        us.textContent = '(you)';
        name.appendChild(us);
      }
      const score = document.createElement('span');
      score.className = 'score num';
      score.textContent = String(row.score);
      line.append(name, score);
      list.appendChild(line);
    });
    pbody.appendChild(list);
  }

  // Shown honestly: without a push channel the client can't tell "nothing
  // changed" from "unreachable for two minutes" (technical-design §5).
  function renderStaleness(elapsedMs) {
    if (!playEls || !playEls.staleBanner) return;
    const banner = playEls.staleBanner;
    if (elapsedMs < 10000) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = '';
    if (elapsedMs < 30000) {
      banner.className = 'stale-banner note';
      banner.textContent = 'Reconnecting…';
    } else {
      banner.className = 'stale-banner error';
      const secs = Math.round(elapsedMs / 1000);
      banner.textContent = `Out of date — last update ${secs}s ago. Tap Sync now below.`;
    }
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderGate() {
    const pbody = document.createElement('div');
    pbody.className = 'pbody';
    app.appendChild(pbody);

    const form = document.createElement('form');
    form.className = 'stack';
    const label = document.createElement('label');
    label.className = 'label';
    label.textContent = 'Room passphrase';
    label.htmlFor = 'passphrase';
    const input = document.createElement('input');
    input.className = 'field';
    input.id = 'passphrase';
    input.name = 'passphrase';
    input.autocapitalize = 'off';
    input.autocorrect = 'off';
    input.autocomplete = 'off';
    const button = document.createElement('button');
    button.className = 'btn wide';
    button.type = 'submit';
    button.textContent = 'Enter';
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');

    form.append(label, input, button, error);
    pbody.appendChild(form);
    input.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      button.disabled = true;
      error.textContent = '';
      try {
        const res = await fetch('/gate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: input.value })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          announce('Passphrase accepted.');
          await refreshState();
        } else if (res.status === 429) {
          error.textContent = 'Too many attempts. Wait a moment and try again.';
        } else {
          error.textContent = data.message || 'Incorrect passphrase.';
        }
      } catch {
        error.textContent = 'Could not reach the server. Try again.';
      } finally {
        button.disabled = false;
      }
    });

    // Convenience for sharing a direct link during setup/testing — same
    // POST /gate, same rate limiter, just pre-filled and auto-submitted
    // rather than typed. A passphrase in a URL still leaks to history/
    // access logs the way CLAUDE.md #4 flags for table tokens, so this
    // stays a deliberate opt-in via query string, never the default flow.
    // Must run after the listener above is attached, or requestSubmit()
    // falls back to a native form submission and reloads the page.
    const prefillPassphrase = new URLSearchParams(location.search).get('passphrase');
    if (prefillPassphrase) {
      input.value = prefillPassphrase;
      form.requestSubmit();
    }
  }

  function renderName(team) {
    const pbody = document.createElement('div');
    pbody.className = 'pbody';
    app.appendChild(pbody);

    const eyebrow = document.createElement('p');
    eyebrow.className = 'label';
    eyebrow.textContent = `Table ${team.table_number}`;
    const heading = document.createElement('h1');
    heading.className = 'display';
    heading.style.fontSize = 'var(--t-h2)';
    heading.style.margin = '4px 0 var(--s5)';
    heading.textContent = team.team_name || "Who's on this phone?";

    const form = document.createElement('form');
    form.className = 'stack';
    const label = document.createElement('label');
    label.className = 'label';
    label.textContent = 'Your name';
    label.htmlFor = 'username';
    const input = document.createElement('input');
    input.className = 'field';
    input.id = 'username';
    input.name = 'username';
    input.maxLength = 20;
    input.autocomplete = 'off';
    const button = document.createElement('button');
    button.className = 'btn wide';
    button.type = 'submit';
    button.textContent = 'Join';
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');

    form.append(label, input, button, error);
    pbody.append(eyebrow, heading, form);
    input.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      button.disabled = true;
      error.textContent = '';
      try {
        const res = await fetch('/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: input.value })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          announce('Joined.');
          await refreshState();
        } else if (data.error === 'username_taken') {
          error.textContent = `That name is taken. Try "${data.suggested}"?`;
          input.value = data.suggested;
        } else {
          error.textContent = 'Enter a name to join.';
        }
      } catch {
        error.textContent = 'Could not reach the server. Try again.';
      } finally {
        button.disabled = false;
      }
    });
  }

  function enterPlay(state) {
    playEls = {};

    const staleBanner = document.createElement('p');
    staleBanner.className = 'stale-banner';
    staleBanner.style.display = 'none';
    app.appendChild(staleBanner);
    playEls.staleBanner = staleBanner;

    // Team colour band — identity, constant all night, never the content
    // area (CLAUDE.md #18). Name and table number only; anything that
    // changes tick to tick (captain, score) lives below it, not in the band.
    const teamBand = document.createElement('div');
    teamBand.className = 'band';
    const teamName = document.createElement('span');
    const tableNo = document.createElement('span');
    tableNo.className = 'table-no num';
    teamBand.append(teamName, tableNo);
    app.appendChild(teamBand);
    playEls.teamBand = teamBand;
    playEls.teamName = teamName;
    playEls.tableNo = tableNo;

    const statusRow = document.createElement('div');
    statusRow.className = 'label';
    statusRow.style.display = 'flex';
    statusRow.style.justifyContent = 'space-between';
    statusRow.style.margin = 'var(--s3) var(--s4) 0';
    const captainStatus = document.createElement('span');
    const scoreText = document.createElement('span');
    scoreText.className = 'num';
    statusRow.append(captainStatus, scoreText);
    app.appendChild(statusRow);
    playEls.captainStatus = captainStatus;
    playEls.scoreText = scoreText;

    const pbody = document.createElement('div');
    pbody.className = 'pbody';
    app.appendChild(pbody);

    const eyebrowRow = document.createElement('div');
    eyebrowRow.style.display = 'flex';
    eyebrowRow.style.justifyContent = 'space-between';
    eyebrowRow.style.alignItems = 'baseline';
    const roundEyebrow = document.createElement('span');
    roundEyebrow.className = 'label';
    const pointsEyebrow = document.createElement('span');
    pointsEyebrow.className = 'label';
    eyebrowRow.append(roundEyebrow, pointsEyebrow);
    pbody.appendChild(eyebrowRow);
    playEls.roundEyebrow = roundEyebrow;
    playEls.pointsEyebrow = pointsEyebrow;

    // Soft cue only — never blocks or auto-submits an answer.
    const timer = document.createElement('p');
    timer.className = 'display num';
    timer.style.fontSize = 'var(--t-lead)';
    timer.style.margin = 'var(--s2) 0 0';
    timer.style.display = 'none';
    pbody.appendChild(timer);
    playEls.timer = timer;

    const image = document.createElement('img');
    image.className = 'question-image';
    image.style.display = 'none';
    pbody.appendChild(image);
    playEls.image = image;

    const prompt = document.createElement('h1');
    prompt.className = 'display prompt';
    pbody.appendChild(prompt);
    playEls.prompt = prompt;

    const videoWrap = document.createElement('div');
    videoWrap.className = 'video-wrap';
    pbody.appendChild(videoWrap);
    playEls.videoWrap = videoWrap;

    const takeoverBtn = document.createElement('button');
    takeoverBtn.type = 'button';
    takeoverBtn.className = 'btn ghost wide';
    takeoverBtn.textContent = 'Take over as captain';
    takeoverBtn.addEventListener('click', () => takeover());
    pbody.appendChild(takeoverBtn);
    playEls.takeoverBtn = takeoverBtn;

    // Persistent text-answer widget — never recreated while a question is
    // OPEN, so a captain's half-typed draft survives an unrelated re-render
    // (CLAUDE.md #15, #17: never clear a typed draft that isn't theirs to lose).
    const textWrap = document.createElement('div');
    textWrap.className = 'stack';
    textWrap.style.display = 'none';
    const textLabel = document.createElement('label');
    textLabel.className = 'label';
    textLabel.textContent = 'Your answer';
    textLabel.htmlFor = 'answer-text';
    const textInput = document.createElement('input');
    textInput.className = 'field';
    textInput.id = 'answer-text';
    textInput.maxLength = 200;
    textInput.autocomplete = 'off';
    const textSubmit = document.createElement('button');
    textSubmit.type = 'button';
    textSubmit.className = 'btn wide';
    textSubmit.textContent = 'Submit answer';
    textSubmit.addEventListener('click', () => {
      submitAnswer(latestPlayState.question.id, textInput.value.trim());
    });
    textWrap.append(textLabel, textInput, textSubmit);
    pbody.appendChild(textWrap);
    playEls.textWrap = textWrap;
    playEls.textInput = textInput;
    playEls.textSubmit = textSubmit;
    playEls.lastQuestionId = null;

    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'stack';
    pbody.appendChild(optionsWrap);
    playEls.optionsWrap = optionsWrap;

    // Submission confirmation / reveal result — a .notice for "it landed",
    // a .status for the correct/wrong/pending verdict once revealed. Two
    // different signals, never conflated (design-handover §8).
    const resultNotice = document.createElement('div');
    resultNotice.className = 'notice';
    resultNotice.style.display = 'none';
    resultNotice.style.marginTop = 'var(--s3)';
    pbody.appendChild(resultNotice);
    playEls.resultNotice = resultNotice;

    const resultStatus = document.createElement('p');
    resultStatus.style.marginTop = 'var(--s3)';
    pbody.appendChild(resultStatus);
    playEls.resultStatus = resultStatus;

    const note = document.createElement('p');
    note.className = 'note';
    pbody.appendChild(note);
    playEls.note = note;

    // Team name — the captain can set it until round 1 starts (scope §2).
    // Built once like the answer field, so a poll never wipes what's typed.
    const nameWrap = document.createElement('div');
    nameWrap.className = 'stack';
    nameWrap.style.display = 'none';
    nameWrap.style.marginTop = 'var(--s5)';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'label';
    nameLabel.textContent = 'Team name';
    nameLabel.htmlFor = 'team-name';
    const nameInput = document.createElement('input');
    nameInput.className = 'field';
    nameInput.id = 'team-name';
    nameInput.maxLength = 32;
    nameInput.autocomplete = 'off';
    nameInput.addEventListener('input', () => { nameInput.dataset.dirty = '1'; });
    const nameSave = document.createElement('button');
    nameSave.type = 'button';
    nameSave.className = 'btn ghost wide';
    nameSave.textContent = 'Save team name';
    const nameMsg = document.createElement('p');
    nameMsg.className = 'note';
    nameSave.addEventListener('click', () => saveTeamName(nameInput, nameMsg));
    nameWrap.append(nameLabel, nameInput, nameSave, nameMsg);
    pbody.appendChild(nameWrap);
    playEls.nameWrap = nameWrap;
    playEls.nameInput = nameInput;

    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn ghost sm';
    syncBtn.style.marginTop = 'var(--s5)';
    syncBtn.textContent = 'Sync now';
    syncBtn.addEventListener('click', () => pollHandle && pollHandle.syncNow());
    pbody.appendChild(syncBtn);

    updatePlay(state);

    if (!pollHandle) {
      pollHandle = window.Poll.start({ onState: render, onStaleness: renderStaleness });
    }
  }

  // The resolved theme paints phone content, matching the projector for the
  // same question (CLAUDE.md #19). Team colour is the header band only and
  // never touches this (CLAUDE.md #18) — teamLine keeps its own class.
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

  // Soft, server-timestamped cue (CLAUDE.md/scope §2) — recomputed fresh
  // from the server timestamp on every poll so drift never accumulates,
  // ticked locally in between polls purely for display.
  let timerInterval = null;
  function renderTimer(el, timer) {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (!timer) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = '';
    const openedAtMs = new Date(timer.opened_at).getTime();
    const tick = () => {
      const remaining = Math.max(0, timer.duration_seconds - (Date.now() - openedAtMs) / 1000);
      el.textContent = `${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, '0')}`;
      if (remaining <= 0 && timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function updatePlay(state) {
    if (!playEls) { enterPlay(state); return; }
    latestPlayState = state;
    applyTheme(state.theme);
    renderTimer(playEls.timer, state.timer);

    const team = state.team;
    playEls.teamName.textContent = team.team_name || '';
    playEls.tableNo.textContent = `Table ${team.table_number}`;
    playEls.captainStatus.textContent = team.is_captain
      ? 'You are answering'
      : team.captain_name ? `${team.captain_name} is answering` : 'No captain yet';
    playEls.scoreText.textContent = `Score ${team.score}`;

    const bandCss = colourCss(team.colour);
    if (bandCss) {
      playEls.teamBand.style.background = bandCss;
      playEls.teamBand.style.color = bestTextOn(team.colour.from);
    } else {
      playEls.teamBand.style.background = '';
      playEls.teamBand.style.color = '';
    }

    playEls.takeoverBtn.style.display = team.is_captain ? 'none' : '';

    playEls.nameWrap.style.display = team.can_rename ? '' : 'none';
    // Never overwrite what the captain is typing (CLAUDE.md #15).
    if (document.activeElement !== playEls.nameInput && !playEls.nameInput.dataset.dirty) {
      playEls.nameInput.value = team.team_name || '';
    }

    playEls.roundEyebrow.textContent = state.round ? `Round ${state.round}` : '';

    if (!state.question) {
      playEls.pointsEyebrow.textContent = '';
      playEls.prompt.classList.remove('statement-prompt');
      playEls.prompt.textContent = 'Waiting for the next question…';
      playEls.image.style.display = 'none';
      clear(playEls.videoWrap);
      clear(playEls.optionsWrap);
      playEls.textWrap.style.display = 'none';
      playEls.resultNotice.style.display = 'none';
      playEls.resultStatus.textContent = '';
      playEls.note.textContent = '';
      playEls.lastQuestionId = null;
      return;
    }

    playEls.pointsEyebrow.textContent = `${state.question.points} pt${state.question.points === 1 ? '' : 's'}`;

    // PENDING is a holding screen — the server withholds the prompt
    // entirely until the host opens it (CLAUDE.md #1), so there is nothing
    // to render here but "coming up."
    if (state.question.state === 'PENDING') {
      playEls.prompt.classList.remove('statement-prompt');
      playEls.prompt.textContent = 'Question coming up…';
      playEls.image.style.display = 'none';
      clear(playEls.videoWrap);
      clear(playEls.optionsWrap);
      playEls.textWrap.style.display = 'none';
      playEls.resultNotice.style.display = 'none';
      playEls.resultStatus.textContent = '';
      playEls.note.textContent = 'Eyes on the screen.';
      playEls.lastQuestionId = null;
      return;
    }

    playEls.prompt.textContent = state.question.prompt;

    if (state.question.image) {
      playEls.image.src = state.question.image;
      playEls.image.alt = state.question.image_alt || '';
      playEls.image.style.display = '';
    } else {
      playEls.image.style.display = 'none';
    }

    // Video embeds unlock at REVEALED, never before (CLAUDE.md #1) —
    // youtube-nocookie plus no-referrer so the table token never reaches
    // Google (CLAUDE.md #4, #2).
    clear(playEls.videoWrap);
    if (state.question.state === 'REVEALED' && state.question.video_url) {
      const embedUrl = toEmbedUrl(state.question.video_url);
      if (embedUrl) {
        const iframe = document.createElement('iframe');
        iframe.src = embedUrl;
        iframe.width = '100%';
        iframe.height = '240';
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.setAttribute('allow', 'encrypted-media; picture-in-picture');
        iframe.setAttribute('allowfullscreen', '');
        playEls.videoWrap.appendChild(iframe);
      }
    }

    const isOpen = state.question.state === 'OPEN';
    const isRevealed = state.question.state === 'REVEALED';
    const layout = state.theme ? state.theme.layout : 'standard';

    playEls.prompt.classList.toggle('statement-prompt', layout === 'statement');

    // Media layout holds phones on a neutral "listen up" screen while the
    // clip plays on the venue system — stops people reading ahead
    // (Mockups/trivia-host-console.html note on the AV-cue state).
    if (layout === 'media' && !isOpen && !isRevealed) {
      playEls.prompt.textContent = 'Listen up…';
      playEls.image.style.display = 'none';
      clear(playEls.optionsWrap);
      playEls.textWrap.style.display = 'none';
      playEls.resultNotice.style.display = 'none';
      playEls.resultStatus.textContent = '';
      playEls.note.textContent = 'The answer opens once the clip finishes.';
      return;
    }
    const isNewQuestion = playEls.lastQuestionId !== state.question.id;
    playEls.lastQuestionId = state.question.id;

    const canAnswer = team.is_captain && isOpen;

    if (state.question.type === 'mcq') {
      playEls.textWrap.style.display = 'none';
      playEls.optionsWrap.style.display = '';
      clear(playEls.optionsWrap);

      const options = state.question.options || [];
      options.forEach((opt, i) => {
        const selected = !!(state.our_answer && state.our_answer.value === opt);
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'tile' + (canAnswer ? '' : ' flat') + (selected ? ' seated' : '');
        tile.setAttribute('aria-pressed', String(selected));

        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = String.fromCharCode(65 + i);
        const label = document.createElement('span');
        label.textContent = opt;
        tile.append(chip, label);

        if (isRevealed && opt === state.question.correct_answer) {
          const mark = document.createElement('span');
          mark.className = 'mark status ok';
          mark.textContent = 'Correct';
          tile.appendChild(mark);
        } else if (isRevealed && selected) {
          const mark = document.createElement('span');
          mark.className = 'mark status bad';
          mark.textContent = 'Wrong';
          tile.appendChild(mark);
        } else if (!isRevealed && selected && !canAnswer) {
          const mark = document.createElement('span');
          mark.className = 'mark status ok';
          mark.textContent = 'Chosen';
          tile.appendChild(mark);
        }

        if (canAnswer) {
          tile.addEventListener('click', () => submitAnswer(state.question.id, opt));
        }
        playEls.optionsWrap.appendChild(tile);
      });
    } else {
      // Free text: the input is never recreated while a question is OPEN —
      // only its enabled state and, on a genuinely new question, its value.
      clear(playEls.optionsWrap);
      if (isRevealed) {
        playEls.textWrap.style.display = 'none';
        playEls.optionsWrap.style.display = '';
        const tile = document.createElement('div');
        tile.className = 'tile flat seated';
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = '✓';
        const label = document.createElement('span');
        label.textContent = state.question.correct_answer;
        tile.append(chip, label);
        playEls.optionsWrap.appendChild(tile);
      } else {
        playEls.optionsWrap.style.display = 'none';
        playEls.textWrap.style.display = '';
        if (isNewQuestion) {
          playEls.textInput.value = state.our_answer ? state.our_answer.value : '';
        }
        playEls.textInput.disabled = !canAnswer;
        playEls.textSubmit.disabled = !canAnswer;
        playEls.textSubmit.style.display = team.is_captain ? '' : 'none';
      }
    }

    // Submission confirmation (it landed) vs reveal result (right/wrong) —
    // two distinct signals, never conflated (design-handover §8).
    playEls.resultNotice.style.display = 'none';
    playEls.resultStatus.textContent = '';
    playEls.resultStatus.className = '';

    if (canAnswer && state.our_answer && !isRevealed) {
      const time = new Date(state.our_answer.submitted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      playEls.resultNotice.textContent = `Answer submitted — ${state.our_answer.value}, ${time}`;
      playEls.resultNotice.style.display = '';
    } else if (isRevealed && state.our_answer && state.question.type !== 'mcq') {
      // MCQ already shows correct/wrong per-tile — this line is only for
      // free text, where the tile above just shows the correct answer.
      if (state.our_answer.is_correct !== undefined) {
        playEls.resultStatus.className = 'status ' + (state.our_answer.is_correct ? 'ok' : 'bad');
        playEls.resultStatus.textContent = state.our_answer.is_correct ? 'Correct' : 'Wrong';
      } else {
        playEls.resultStatus.className = 'status wait';
        playEls.resultStatus.textContent = 'Scored at the end of the round';
      }
    }

    if (!team.is_captain) {
      playEls.note.textContent = state.our_answer
        ? (team.captain_name ? `${team.captain_name} answered for your table.` : 'Answered for your table.')
        : 'Waiting for your captain to answer.';
    } else if (isRevealed) {
      if (!state.our_answer) {
        playEls.note.textContent = 'Your table did not answer.';
      } else if (state.question.type !== 'mcq') {
        playEls.note.textContent = `Your answer: ${state.our_answer.value}`;
      } else {
        playEls.note.textContent = '';
      }
    } else if (!isOpen) {
      playEls.note.textContent = 'This question is not open for answers.';
    } else {
      playEls.note.textContent = '';
    }
  }

  async function saveTeamName(input, msg) {
    try {
      const res = await fetch('/team-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_name: input.value.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        delete input.dataset.dirty;
        msg.textContent = data.team_name ? 'Team name saved.' : 'Team name cleared.';
        announce(msg.textContent);
        if (pollHandle) pollHandle.syncNow();
      } else {
        msg.textContent = data.error === 'rename_closed'
          ? 'Round 1 has started — ask a host to change the name.'
          : data.error === 'not_captain' ? 'Only the captain can change the team name.'
          : 'Could not save the name. Try again.';
      }
    } catch {
      msg.textContent = 'Could not reach the server. Try again.';
    }
  }

  async function takeover() {
    const expectsCaptain = latestPlayState ? latestPlayState.team.captain_player_id : null;
    try {
      const res = await fetch('/takeover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expects_captain_player_id: expectsCaptain })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        announce('You are now answering for this table.');
      } else if (data.error === 'captain_changed') {
        announce(`${data.current_captain || 'Someone else'} just became captain.`);
      }
      await refreshState();
    } catch {
      announce('Could not take over. Check your connection and try again.');
    }
  }

  async function submitAnswer(questionId, value) {
    try {
      const res = await fetch('/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: questionId, value })
      });
      if (res.ok) announce(`Answer submitted: ${value}`);
      await refreshState();
    } catch {
      announce('Could not submit. Check your connection and try again.');
    }
  }

  refreshState();
})();
