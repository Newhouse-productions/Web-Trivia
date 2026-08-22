// Big screen. Read-only, unauthenticated by PIN — the screen token in the
// URL already granted access at exchange time. Re-renders whole sections on
// version change; nothing here holds keyboard focus so the "never over
// focus" concern (CLAUDE.md #15) doesn't bite the way it does on /play.
(function () {
  const app = document.getElementById('app');

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
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
    root.setProperty('--surface', c.surface);
    root.setProperty('--text', c.text);
    root.setProperty('--text-muted', c['text-muted']);
    root.setProperty('--border', c.border);
    root.setProperty('--accent', c.accent);
    root.setProperty('--accent-text', c['accent-text']);
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
    const existingFooter = document.querySelector('.screen-footer');
    if (existingFooter) existingFooter.remove();
    const existingLogo = document.querySelector('.screen-logo');
    if (existingLogo) existingLogo.remove();
    document.body.style.paddingBottom = '';

    if (!chrome) return;

    if (chrome.logo) {
      const logo = document.createElement('img');
      logo.className = 'screen-logo';
      logo.src = chrome.logo;
      logo.alt = '';
      document.body.appendChild(logo);
    }
    if (chrome.footer) {
      const footer = document.createElement('div');
      footer.className = 'screen-footer';
      footer.textContent = chrome.footer;
      document.body.appendChild(footer);
      document.body.style.paddingBottom = '80px';
    }
  }

  function render(state) {
    clear(app);
    if (state.theme) applyTheme(state.theme);
    renderChrome(state.chrome);

    if (state.stage === 'no_session' || state.stage === 'event_not_running') {
      const p = document.createElement('p');
      p.className = 'screen-title';
      p.textContent = "This event isn't running right now.";
      app.appendChild(p);
      return;
    }

    const title = document.createElement('p');
    title.className = 'screen-title';
    title.textContent = state.event_name;
    app.appendChild(title);

    if (state.stage === 'holding') {
      const p = document.createElement('p');
      p.className = 'screen-prompt';
      p.textContent = 'Scan the QR code at your table to join.';
      app.appendChild(p);
      return;
    }

    if (state.stage === 'leaderboard') {
      const heading = document.createElement('p');
      heading.className = 'screen-prompt';
      heading.textContent = `Leaderboard — Round ${state.round}`;
      app.appendChild(heading);

      const list = document.createElement('div');
      list.className = 'screen-leaderboard';
      state.leaderboard.forEach((row, i) => {
        const line = document.createElement('div');
        line.className = 'screen-leaderboard-row';
        const rank = document.createElement('span');
        const swatchCss = colourCss(row.colour);
        if (swatchCss) {
          const swatch = document.createElement('span');
          swatch.className = 'screen-swatch';
          swatch.style.background = swatchCss;
          rank.appendChild(swatch);
        }
        rank.appendChild(document.createTextNode(`${i + 1}. ${row.team_name}`));
        const score = document.createElement('span');
        score.textContent = String(row.score);
        line.append(rank, score);
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
        holding.className = 'screen-prompt';
        holding.textContent = layout === 'media' ? 'Listen carefully…' : `Round ${state.round}`;
        app.appendChild(holding);
        return;
      }

      const prompt = document.createElement('p');
      prompt.className = 'screen-prompt' + (layout === 'statement' ? ' statement' : '');
      prompt.textContent = q.prompt;
      app.appendChild(prompt);

      if (q.options) {
        const grid = document.createElement('div');
        grid.className = 'screen-options';
        q.options.forEach((opt) => {
          const card = document.createElement('div');
          card.className = 'screen-option';
          if (q.state === 'REVEALED' && opt === q.correct_answer) card.classList.add('correct');

          const label = document.createElement('div');
          label.textContent = opt;
          card.appendChild(label);

          if (q.spread) {
            const found = q.spread.find((s) => s.option === opt);
            const count = document.createElement('div');
            count.className = 'screen-spread-count';
            const n = found ? found.count : 0;
            count.textContent = `${n} ${n === 1 ? 'table' : 'tables'}`;
            card.appendChild(count);
          }
          if (q.state === 'REVEALED' && opt === q.correct_answer) {
            const badge = document.createElement('div');
            badge.textContent = '✓ Correct';
            card.appendChild(badge);
          }
          grid.appendChild(card);
        });
        app.appendChild(grid);
      } else if (q.state === 'REVEALED') {
        const answer = document.createElement('p');
        answer.className = 'screen-prompt';
        answer.textContent = `Answer: ${q.correct_answer}`;
        app.appendChild(answer);
      }

      const answered = document.createElement('p');
      answered.className = 'screen-answered';
      answered.textContent = q.state === 'OPEN'
        ? `${state.answered.count}/${state.answered.total} tables have answered`
        : '';
      app.appendChild(answered);
    }
  }

  refresh();
  window.Poll.start({ vUrl: '/screen/v', stateUrl: '/screen/state', onState: render });
})();
