// Shared poll helper (technical-design §4). Poll /v; only fetch /state when
// the version has moved. Jittered interval, jittered exponential backoff on
// failure capped at 15s, resync immediately on becoming visible again.
window.Poll = (function () {
  function jitter(base, spread) {
    return base + (Math.random() * 2 - 1) * spread;
  }

  function start({
    intervalMs = 3000, jitterMs = 500, maxBackoffMs = 15000,
    vUrl = '/v', stateUrl = '/state', onState, onError
  }) {
    // Compared as a whole object, not a single scalar — /v can return one
    // counter ({version}) or several independent ones ({event_version,
    // table_version}); comparing the raw JSON means a change in any of them
    // is detected, with no risk of two counters colliding into one number.
    let lastKey = null;
    let timer = null;
    let backoff = 0;
    let stopped = false;

    function schedule(ms) {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(tick, Math.max(250, ms));
    }

    async function tick() {
      if (stopped) return;
      if (document.hidden) {
        schedule(intervalMs);
        return;
      }
      try {
        const vRes = await fetch(vUrl, { cache: 'no-store' });
        if (!vRes.ok) throw new Error('v_failed');
        const vData = await vRes.json();
        const key = JSON.stringify(vData);
        backoff = 0;
        if (key !== lastKey) {
          const sRes = await fetch(stateUrl, { cache: 'no-store' });
          if (!sRes.ok) throw new Error('state_failed');
          const state = await sRes.json();
          lastKey = key;
          onState(state);
        }
        schedule(jitter(intervalMs, jitterMs));
      } catch (err) {
        backoff = Math.min(maxBackoffMs, backoff ? backoff * 2 : 1000);
        if (onError) onError(err);
        schedule(jitter(backoff, backoff * 0.2));
      }
    }

    function syncNow() {
      lastKey = null;
      schedule(0);
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncNow();
    });

    tick();

    return {
      stop() { stopped = true; clearTimeout(timer); },
      syncNow
    };
  }

  return { start };
})();
