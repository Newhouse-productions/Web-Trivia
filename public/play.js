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

    if (state.stage === 'no_session') {
      const p = document.createElement('p');
      p.textContent = "Scan your table's QR code to join.";
      app.appendChild(p);
      return;
    }

    if (state.stage === 'event_not_running') {
      const p = document.createElement('p');
      p.textContent = "This event isn't running right now.";
      app.appendChild(p);
      return;
    }

    if (state.stage === 'gate') return renderGate();
    if (state.stage === 'name') return renderName(state.team);
    if (state.stage === 'play') return enterPlay(state);
    if (state.stage === 'leaderboard') return renderLeaderboard(state);
  }

  function renderLeaderboard(state) {
    const heading = document.createElement('p');
    heading.textContent = `Table ${state.team.table_number}${state.team.team_name ? ' — ' + state.team.team_name : ''}`;
    const title = document.createElement('h1');
    title.textContent = `Leaderboard — Round ${state.round}`;
    app.append(heading, title);

    if (state.our_place) {
      const place = document.createElement('p');
      place.className = 'note';
      place.textContent = `Your table: ${ordinal(state.our_place)} place`;
      app.appendChild(place);
    }

    const list = document.createElement('div');
    list.className = 'options';
    state.leaderboard.forEach((row, i) => {
      const line = document.createElement('div');
      line.className = 'option' + (state.our_place === i + 1 ? ' selected' : '');
      // Swatch beside the row, never a row background or text colour
      // (CLAUDE.md #18, technical-design §20.4) — every other row's
      // contrast against it would become a separate problem otherwise.
      const swatchCss = colourCss(row.colour);
      if (swatchCss) {
        const swatch = document.createElement('span');
        swatch.className = 'team-swatch';
        swatch.style.background = swatchCss;
        line.appendChild(swatch);
      }
      const rank = document.createElement('span');
      rank.textContent = `${i + 1}. ${row.team_name}`;
      const score = document.createElement('span');
      score.textContent = String(row.score);
      score.style.float = 'right';
      line.append(rank, score);
      list.appendChild(line);
    });
    app.appendChild(list);
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
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = 'Room passphrase';
    label.htmlFor = 'passphrase';
    const input = document.createElement('input');
    input.id = 'passphrase';
    input.name = 'passphrase';
    input.autocapitalize = 'off';
    input.autocorrect = 'off';
    input.autocomplete = 'off';
    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Enter';
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');

    form.append(label, input, button, error);
    app.appendChild(form);
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
  }

  function renderName(team) {
    const heading = document.createElement('p');
    heading.textContent = `Table ${team.table_number}${team.team_name ? ' — ' + team.team_name : ''}`;

    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = 'Your name';
    label.htmlFor = 'username';
    const input = document.createElement('input');
    input.id = 'username';
    input.name = 'username';
    input.maxLength = 20;
    input.autocomplete = 'off';
    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Join';
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');

    form.append(label, input, button, error);
    app.append(heading, form);
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

    const teamLine = document.createElement('p');
    teamLine.className = 'team-line';
    app.appendChild(teamLine);
    playEls.teamLine = teamLine;

    const image = document.createElement('img');
    image.className = 'question-image';
    image.style.display = 'none';
    app.appendChild(image);
    playEls.image = image;

    const prompt = document.createElement('h1');
    app.appendChild(prompt);
    playEls.prompt = prompt;

    const videoWrap = document.createElement('div');
    videoWrap.className = 'video-wrap';
    app.appendChild(videoWrap);
    playEls.videoWrap = videoWrap;

    const takeoverBtn = document.createElement('button');
    takeoverBtn.type = 'button';
    takeoverBtn.textContent = 'Take over answering';
    takeoverBtn.addEventListener('click', () => takeover());
    app.appendChild(takeoverBtn);
    playEls.takeoverBtn = takeoverBtn;

    // Persistent text-answer widget — never recreated while a question is
    // OPEN, so a captain's half-typed draft survives an unrelated re-render
    // (CLAUDE.md #15, #17: never clear a typed draft that isn't theirs to lose).
    const textWrap = document.createElement('div');
    textWrap.className = 'options';
    textWrap.style.display = 'none';
    const textLabel = document.createElement('label');
    textLabel.textContent = 'Your answer';
    textLabel.htmlFor = 'answer-text';
    const textInput = document.createElement('input');
    textInput.id = 'answer-text';
    textInput.maxLength = 200;
    textInput.autocomplete = 'off';
    const textSubmit = document.createElement('button');
    textSubmit.type = 'button';
    textSubmit.textContent = 'Submit answer';
    textSubmit.addEventListener('click', () => {
      submitAnswer(latestPlayState.question.id, textInput.value.trim());
    });
    const textBadge = document.createElement('span');
    textBadge.className = 'badge';
    textWrap.append(textLabel, textInput, textSubmit, textBadge);
    app.appendChild(textWrap);
    playEls.textWrap = textWrap;
    playEls.textInput = textInput;
    playEls.textSubmit = textSubmit;
    playEls.textBadge = textBadge;
    playEls.lastQuestionId = null;

    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'options';
    app.appendChild(optionsWrap);
    playEls.optionsWrap = optionsWrap;

    const note = document.createElement('p');
    note.className = 'note';
    app.appendChild(note);
    playEls.note = note;

    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'sync';
    syncBtn.textContent = 'Sync now';
    syncBtn.addEventListener('click', () => pollHandle && pollHandle.syncNow());
    app.appendChild(syncBtn);

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
    const root = document.body.style;
    const c = theme.colour;
    root.setProperty('--bg', c.bg);
    root.setProperty('--surface', c.surface);
    root.setProperty('--surface-selected', c['surface-selected']);
    root.setProperty('--text', c.text);
    root.setProperty('--text-muted', c['text-muted']);
    root.setProperty('--border', c.border);
    root.setProperty('--accent', c.accent);
    root.setProperty('--accent-text', c['accent-text']);
  }

  function updatePlay(state) {
    if (!playEls) { enterPlay(state); return; }
    latestPlayState = state;
    applyTheme(state.theme);

    const team = state.team;
    playEls.teamLine.textContent =
      `Table ${team.table_number}${team.team_name ? ' — ' + team.team_name : ''} · Score ${team.score}` +
      (team.is_captain
        ? ' — you are answering'
        : team.captain_name ? ` — ${team.captain_name} is answering` : ' — no captain yet');

    const bandCss = colourCss(team.colour);
    if (bandCss) {
      playEls.teamLine.style.background = bandCss;
      playEls.teamLine.style.color = bestTextOn(team.colour.from);
    } else {
      playEls.teamLine.style.background = '';
      playEls.teamLine.style.color = '';
    }

    playEls.takeoverBtn.style.display = team.is_captain ? 'none' : '';

    if (!state.question) {
      playEls.prompt.textContent = 'Waiting for the next question…';
      playEls.image.style.display = 'none';
      clear(playEls.videoWrap);
      clear(playEls.optionsWrap);
      playEls.textWrap.style.display = 'none';
      playEls.note.textContent = '';
      playEls.lastQuestionId = null;
      return;
    }

    // PENDING is a holding screen — the server withholds the prompt
    // entirely until the host opens it (CLAUDE.md #1), so there is nothing
    // to render here but "coming up."
    if (state.question.state === 'PENDING') {
      playEls.prompt.textContent = 'Question coming up…';
      playEls.image.style.display = 'none';
      clear(playEls.videoWrap);
      clear(playEls.optionsWrap);
      playEls.textWrap.style.display = 'none';
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
      playEls.note.textContent = 'The answer opens once the clip finishes.';
      return;
    }
    const isNewQuestion = playEls.lastQuestionId !== state.question.id;
    playEls.lastQuestionId = state.question.id;

    if (state.question.type === 'mcq') {
      playEls.textWrap.style.display = 'none';
      playEls.optionsWrap.style.display = '';
      clear(playEls.optionsWrap);

      const options = state.question.options || [];
      options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'option';
        btn.textContent = opt;
        const selected = !!(state.our_answer && state.our_answer.value === opt);
        btn.setAttribute('aria-pressed', String(selected));
        if (selected) btn.classList.add('selected');

        if (isRevealed && opt === state.question.correct_answer) {
          btn.classList.add('correct');
          const badge = document.createElement('span');
          badge.className = 'badge correct';
          badge.textContent = '✓ Correct';
          btn.appendChild(badge);
        } else if (isRevealed && selected) {
          btn.classList.add('incorrect');
          const badge = document.createElement('span');
          badge.className = 'badge incorrect';
          badge.textContent = '✗ Wrong';
          btn.appendChild(badge);
        }

        if (team.is_captain && isOpen) {
          btn.addEventListener('click', () => submitAnswer(state.question.id, opt));
        } else {
          btn.disabled = true;
        }
        playEls.optionsWrap.appendChild(btn);
      });
    } else {
      // Free text: the input is never recreated while a question is OPEN —
      // only its enabled state and, on a genuinely new question, its value.
      playEls.optionsWrap.style.display = 'none';
      clear(playEls.optionsWrap);
      playEls.textWrap.style.display = '';

      if (isNewQuestion) {
        playEls.textInput.value = state.our_answer ? state.our_answer.value : '';
      }
      playEls.textInput.disabled = !(team.is_captain && isOpen);
      playEls.textSubmit.disabled = !(team.is_captain && isOpen);
      playEls.textSubmit.style.display = team.is_captain ? '' : 'none';

      playEls.textBadge.textContent = '';
      playEls.textBadge.className = 'badge';
      if (isRevealed && state.our_answer) {
        if (state.our_answer.is_correct !== undefined) {
          playEls.textBadge.textContent = state.our_answer.is_correct ? '✓ Correct' : '✗ Wrong';
          playEls.textBadge.classList.add(state.our_answer.is_correct ? 'correct' : 'incorrect');
        } else {
          playEls.textBadge.textContent = 'Scored at the end of the round';
        }
      }
    }

    if (!team.is_captain) {
      playEls.note.textContent = state.our_answer
        ? `${state.our_answer.value} was answered for your table.`
        : 'Waiting for your captain to answer.';
    } else if (isRevealed) {
      if (!state.our_answer) {
        playEls.note.textContent = 'Your table did not answer.';
      } else if (state.question.type === 'mcq') {
        playEls.note.textContent = state.our_answer.is_correct
          ? 'Your table got this one.' : 'Your table did not get this one.';
      } else {
        playEls.note.textContent = `Correct answer: ${state.question.correct_answer}`;
      }
    } else if (!isOpen) {
      playEls.note.textContent = 'This question is not open for answers.';
    } else {
      playEls.note.textContent = '';
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
