// Big screen. Read-only, unauthenticated by PIN — the screen token in the
// URL already granted access at exchange time. Re-renders whole sections on
// version change; nothing here holds keyboard focus so the "never over
// focus" concern (CLAUDE.md #15) doesn't bite the way it does on /play.
// Type is sized in cqw against #app's own inline size (container-type set
// in screen.css) so it scales with the actual projector, not the viewport.
(function () {
  const app = document.getElementById('app');

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // Soft, server-timestamped cue (CLAUDE.md/scope §2). Unlike play.js this
  // page fully rebuilds every poll (~3s), so rather than fight that with a
  // per-render interval, one persistent interval looks up the current
  // .s-timer element by class each tick — it naturally survives the
  // clear+rebuild cycle without needing to be restarted.
  function formatRemaining(openedAt, durationSeconds) {
    const openedAtMs = new Date(openedAt).getTime();
    const remaining = Math.max(0, durationSeconds - (Date.now() - openedAtMs) / 1000);
    return `${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, '0')}`;
  }
  let screenTimerInterval = null;
  function ensureTimerTicking() {
    if (screenTimerInterval) return;
    screenTimerInterval = setInterval(() => {
      const el = document.querySelector('.s-timer');
      if (!el) return;
      el.textContent = formatRemaining(el.dataset.openedAt, Number(el.dataset.duration));
    }, 1000);
  }

  // Swatch beside the leaderboard row, never a row background or text
  // colour (technical-design §20.4) — team colour is an identifier, not a
  // theme (CLAUDE.md #18).
  function colourCss(colour) {
    if (!colour) return null;
    return colour.type === 'gradient'
      ? `linear-gradient(135deg, ${colour.from}, ${colour.to})`
      : colour.from;
  }

  // Same resolved theme as the phones, painting both surfaces together for
  // the same question (CLAUDE.md #19).
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

  async function refresh() {
    const res = await fetch('/screen/state', { cache: 'no-store' });
    render(await res.json());
  }

  // Logo top corner, footer band full-width at the bottom — set once at
  // event level and never cascading (CLAUDE.md #20). The band reduces the
  // content area rather than overlapping it, so a statement layout's
  // oversized prompt never runs under it.
  function renderChrome(chrome) {
    const existingFooter = app.querySelector('.s-foot');
    if (existingFooter) existingFooter.remove();
    const existingLogo = app.querySelector('.s-logo');
    if (existingLogo) existingLogo.remove();
    app.style.paddingBottom = '';

    if (!chrome) return;

    if (chrome.logo) {
      const logo = document.createElement('img');
      logo.className = 's-logo';
      logo.src = chrome.logo;
      logo.alt = '';
      app.appendChild(logo);
    }
    if (chrome.footer) {
      const footer = document.createElement('div');
      footer.className = 's-foot';
      const label = document.createElement('span');
      label.textContent = chrome.footer;
      footer.appendChild(label);
      app.appendChild(footer);
      // Read the rendered height back so the content area truly stops
      // above it rather than guessing a fixed px value (CLAUDE.md #20).
      app.style.paddingBottom = `calc(4.5% + ${footer.getBoundingClientRect().height}px)`;
    }
  }

  function tally(count, total, outstanding) {
    const grid = document.createElement('div');
    grid.className = 's-tally';
    for (let i = 1; i <= total; i++) {
      const cell = document.createElement('div');
      cell.className = 't' + (i <= count ? ' in' : '') + (outstanding && outstanding.includes(i) ? ' out' : '');
      grid.appendChild(cell);
    }
    return grid;
  }

  function render(state) {
    clear(app);
    if (state.theme) applyTheme(state.theme);
    renderChrome(state.chrome);

    if (state.stage === 'no_session' || state.stage === 'event_not_running') {
      const p = document.createElement('p');
      p.className = 's-prompt';
      p.textContent = "This event isn't running right now.";
      app.appendChild(p);
      return;
    }

    const eyebrow = document.createElement('p');
    eyebrow.className = 's-eyebrow';
    eyebrow.textContent = state.event_name;
    app.appendChild(eyebrow);

    if (state.stage === 'holding') {
      const p = document.createElement('p');
      p.className = 's-prompt statement';
      p.textContent = 'Scan the code on your table';
      app.appendChild(p);
      return;
    }

    if (state.stage === 'leaderboard') {
      const heading = document.createElement('p');
      heading.className = 's-prompt';
      heading.style.fontSize = '4cqw';
      heading.textContent = `Leaderboard — Round ${state.round}`;
      app.appendChild(heading);

      const list = document.createElement('div');
      list.className = 's-lb';
      state.leaderboard.forEach((row, i) => {
        const line = document.createElement('div');
        line.className = 's-lb-row' + (i === 0 ? ' lead' : '');
        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = String(i + 1);
        line.appendChild(pos);
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
        const score = document.createElement('span');
        score.className = 'score';
        score.textContent = String(row.score);
        line.append(name, score);
        list.appendChild(line);
      });
      app.appendChild(list);
      return;
    }

    if (state.stage === 'question') {
      const layout = state.theme ? state.theme.layout : 'standard';
      const q = state.question;

      // PENDING is a round card, not the question — the server withholds
      // the prompt until the host opens it (CLAUDE.md #1).
      if (q.state === 'PENDING') {
        const holding = document.createElement('p');
        holding.className = 's-prompt statement';
        holding.textContent = layout === 'media' ? 'Listen carefully…' : `Round ${state.round}`;
        app.appendChild(holding);
        return;
      }

      const prompt = document.createElement('p');
      prompt.className = 's-prompt' + (layout === 'statement' ? ' statement' : '');
      prompt.textContent = q.prompt;
      app.appendChild(prompt);

      if (state.timer) {
        const timerEl = document.createElement('p');
        timerEl.className = 's-eyebrow s-timer';
        timerEl.dataset.openedAt = state.timer.opened_at;
        timerEl.dataset.duration = state.timer.duration_seconds;
        timerEl.textContent = formatRemaining(state.timer.opened_at, state.timer.duration_seconds);
        app.appendChild(timerEl);
        ensureTimerTicking();
      }

      if (q.options) {
        const grid = document.createElement('div');
        grid.className = 's-opts';
        q.options.forEach((opt, i) => {
          const card = document.createElement('div');
          card.className = 's-opt';
          // Fixed --correct, never the theme's own --accent (a warm brass
          // accent must never double as "this was right").
          if (q.state === 'REVEALED' && opt === q.correct_answer) card.classList.add('correct');

          const chip = document.createElement('span');
          chip.className = 'c';
          chip.textContent = String.fromCharCode(65 + i);
          const label = document.createElement('span');
          label.textContent = opt;
          card.append(chip, label);

          if (q.spread) {
            const found = q.spread.find((s) => s.option === opt);
            const count = document.createElement('span');
            count.className = 's-spread';
            const n = found ? found.count : 0;
            count.textContent = `${n} ${n === 1 ? 'table' : 'tables'}`;
            card.appendChild(count);
          }
          if (q.state === 'REVEALED' && opt === q.correct_answer) {
            // Border highlight (above) plus a word, never colour alone
            // (CLAUDE.md #16) — sized in cqw like the rest of this surface,
            // not the phone-scale .status component.
            const mark = document.createElement('span');
            mark.style.marginLeft = 'auto';
            mark.style.color = 'var(--correct)';
            mark.style.fontWeight = '700';
            mark.style.fontSize = '1.8cqw';
            mark.textContent = 'Correct';
            card.appendChild(mark);
          }
          grid.appendChild(card);
        });
        app.appendChild(grid);
      } else if (q.state === 'REVEALED') {
        const answer = document.createElement('p');
        answer.className = 's-prompt';
        answer.textContent = `Answer: ${q.correct_answer}`;
        app.appendChild(answer);
      }

      if (q.state === 'OPEN') {
        const answered = document.createElement('p');
        answered.className = 's-eyebrow';
        answered.style.marginTop = '1.6cqw';
        answered.textContent = `${state.answered.count} / ${state.answered.total} answered`;
        app.appendChild(answered);
        app.appendChild(tally(state.answered.count, state.answered.total, null));
      }
    }
  }

  refresh();
  window.Poll.start({ vUrl: '/screen/v', stateUrl: '/screen/state', onState: render });
})();
