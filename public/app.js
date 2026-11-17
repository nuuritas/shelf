if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // The app still works as a normal web page if registration is unavailable.
    });
  });
}

function setExpanded(card, expanded) {
  card.classList.toggle('is-collapsed', !expanded);
  const button = card.querySelector('[data-expand]');
  if (button) {
    button.textContent = expanded ? 'Collapse' : 'Read more';
    button.setAttribute('aria-expanded', String(expanded));
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-expand]');
  if (button) {
    const card = button.closest('.card');
    if (card) setExpanded(card, card.classList.contains('is-collapsed'));
    return;
  }

  const card = event.target.closest('.card');
  if (!card) return;
  if (event.target.closest('a, video, form, input, label, summary, button')) return;
  setExpanded(card, card.classList.contains('is-collapsed'));
});

document.addEventListener('click', event => {
  const fold = event.target.closest('[data-fold]');
  if (!fold) return;
  const box = fold.closest('.topic-overview');
  if (!box) return;
  const folded = box.classList.toggle('is-folded');
  fold.textContent = folded ? 'Read the full synthesis' : 'Show less';
});

document.addEventListener('click', async event => {
  const chip = event.target.closest('[data-copy]');
  if (!chip) return;
  event.stopPropagation();

  const value = chip.getAttribute('data-copy') || '';
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = document.createElement('input');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    try {
      document.execCommand('copy');
    } catch {
      // Nothing else to try; the id is still visible to select by hand.
    }
    field.remove();
  }

  const label = chip.dataset.label || chip.textContent;
  chip.dataset.label = label;
  chip.textContent = 'copied';
  chip.classList.add('is-copied');
  window.setTimeout(() => {
    chip.textContent = label;
    chip.classList.remove('is-copied');
  }, 1200);
});

// Settings: keep the prompt character count honest while typing. The server
// still enforces the limit; this is only feedback.
(() => {
  const source = document.querySelector('[data-prompt-source]');
  const counter = document.querySelector('[data-prompt-count]');
  if (!source || !counter) return;
  const update = () => {
    counter.textContent = source.value.length.toLocaleString('en-US');
  };
  source.addEventListener('input', update);
  update();
})();

// Settings: turn Web Push on and off for finished summaries.
(() => {
  const card = document.querySelector('[data-push]');
  if (!card) return;

  const badge = card.querySelector('[data-push-badge]');
  const state = card.querySelector('[data-push-state]');
  const detail = card.querySelector('[data-push-detail]');
  const enable = card.querySelector('[data-push-enable]');
  const disable = card.querySelector('[data-push-disable]');
  const test = card.querySelector('[data-push-test]');
  const webview = /;\s?wv[);]/i.test(navigator.userAgent);

  const setMode = mode => {
    enable.hidden = mode !== 'off';
    disable.hidden = mode !== 'on';
    test.hidden = mode !== 'on';
    badge.textContent = mode === 'on' ? 'On' : mode === 'off' ? 'Off' : 'Unavailable';
    badge.classList.toggle('is-custom', mode === 'on');
  };

  const post = (path, body) =>
    fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

  const updateDetail = count => {
    if (typeof count !== 'number') return;
    detail.textContent =
      count > 0
        ? `${count} ${count === 1 ? 'browser is' : 'browsers are'} subscribed.`
        : 'No browsers are subscribed yet.';
  };

  const unsupported = () => {
    setMode('unavailable');
    if (webview) {
      badge.textContent = 'Android';
      test.hidden = false;
      detail.textContent = 'The Android app checks in the background.';
      state.textContent =
        'Use “Send a test notification”, then reopen the app (or wait for the next check) to see it.';
      return;
    }
    state.textContent =
      'This browser cannot show notifications. Try Chrome, Edge, Firefox, or an installed PWA on iOS 16.4+.';
  };

  // Works even where Web Push does not: the Worker queues the row and the
  // Android job picks it up on its next check.
  test.addEventListener('click', async () => {
    test.disabled = true;
    state.textContent = 'Queueing a test…';
    try {
      const response = await post('/api/notifications/test');
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not send the test.');
      if (!webview) updateDetail(payload.subscriptions);
      state.textContent = webview
        ? 'Test queued. Reopen the app (or wait for the background check) to see it.'
        : 'Test queued. It should arrive in a moment.';
    } catch (error) {
      state.textContent = error && error.message ? error.message : 'Could not send the test.';
    } finally {
      test.disabled = false;
    }
  });

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    unsupported();
    return;
  }

  const toBytes = value => {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replaceAll('-', '+').replaceAll('_', '/');
    return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  };

  let registration = null;
  const ready = async () => {
    registration = registration || (await navigator.serviceWorker.ready);
    return registration;
  };

  const show = async () => {
    const subscription = await (await ready()).pushManager.getSubscription();
    setMode(subscription ? 'on' : 'off');
    state.textContent = subscription
      ? 'This browser will show a notification when a summary is ready.'
      : 'Turn on notifications to hear about finished summaries.';
  };

  show().catch(() => unsupported());

  enable.addEventListener('click', async () => {
    enable.disabled = true;
    state.textContent = 'Asking the browser for permission…';
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        state.textContent =
          'Permission was not granted. Allow notifications in the browser settings, then try again.';
        return;
      }

      const response = await fetch('/api/push/key', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Could not read the push key.');
      const { publicKey } = await response.json();
      const subscription = await (await ready()).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toBytes(publicKey),
      });

      const saved = await post('/api/push/subscribe', subscription.toJSON());
      if (!saved.ok) {
        await subscription.unsubscribe().catch(() => {});
        const payload = await saved.json().catch(() => ({}));
        throw new Error(payload.error || 'Could not save the subscription.');
      }
      const payload = await saved.json().catch(() => ({}));
      updateDetail(payload.subscriptions);
      await show();
    } catch (error) {
      state.textContent = error && error.message ? error.message : 'Could not turn on notifications.';
    } finally {
      enable.disabled = false;
    }
  });

  disable.addEventListener('click', async () => {
    disable.disabled = true;
    try {
      const subscription = await (await ready()).pushManager.getSubscription();
      if (subscription) {
        await post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      await show();
    } catch (error) {
      state.textContent = error && error.message ? error.message : 'Could not turn off notifications.';
    } finally {
      disable.disabled = false;
    }
  });
})();

// A summary is written after the page is painted. Reloading the document to
// pick it up throws the reader back to the top, loses every open card, and
// drops a half-typed label, so the page asks for itself again instead and
// swaps only the cards whose summary has landed.
//
// The poll runs while a card carries `data-pending`, every fifteen seconds, and
// stops on its own when none is left or after ten minutes. That flag covers
// every job the card is waiting on — the summary, a queued version, the English
// translation — so a finished summary with a version still being written keeps
// the card updating. The cap is what keeps a save whose job never finishes — a
// dead link, a stopped worker — from turning the shelf into an endless poll. A
// browser without JavaScript gets the <noscript> refresh in the page head
// instead.
(() => {
  if (!window.fetch || !window.DOMParser) return;

  const CARD = '.card[data-ref]';
  const DELAY_MS = 15000;
  const MAX_PASSES = 40;
  let passes = 0;

  const inProgress = card => card.hasAttribute('data-pending');

  const pending = () => Array.from(document.querySelectorAll(CARD)).filter(inProgress);

  /** Cards by ref, so a card that stayed pending is found and left alone. */
  const byRef = page => {
    const map = {};
    page.querySelectorAll(CARD).forEach(card => {
      map[card.getAttribute('data-ref')] = card;
    });
    return map;
  };

  /**
   * A reader who is typing a label, or who opened a card, is in the middle of
   * something: the card is skipped this pass and tried again on the next.
   */
  const busy = card =>
    card.contains(document.activeElement) || Boolean(card.querySelector('details[open]'));

  /** Put the reader back where they were if a card above them changed height. */
  const holdScroll = top => {
    if (window.scrollY === top) return;
    const shell = document.documentElement;
    const previous = shell.style.scrollBehavior;
    shell.style.scrollBehavior = 'auto';
    window.scrollTo(window.scrollX, top);
    shell.style.scrollBehavior = previous;
  };

  const pass = () => {
    const cards = pending();
    if (!cards.length || passes >= MAX_PASSES) return;
    passes += 1;

    fetch(location.href, { cache: 'no-store', credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) throw new Error('cards');
        return response.text();
      })
      .then(html => {
        const fresh = byRef(new DOMParser().parseFromString(html, 'text/html'));
        const top = window.scrollY;

        cards.forEach(card => {
          const updated = fresh[card.getAttribute('data-ref')];
          if (!updated || busy(card)) return;
          // Still being written: leave the pulse line alone, or it restarts
          // its animation on every poll. `data-pending` covers the summary, a
          // queued version and the English translation alike.
          if (inProgress(updated)) return;

          const next = document.importNode(updated, true);
          if (!card.classList.contains('is-collapsed')) next.classList.remove('is-collapsed');
          card.parentNode.replaceChild(next, card);
        });

        holdScroll(top);
        window.setTimeout(pass, DELAY_MS);
      })
      .catch(() => {
        // A dropped request is not worth a page reload either: the card keeps
        // its pending state and the next pass tries again.
        window.setTimeout(pass, DELAY_MS);
      });
  };

  if (pending().length) window.setTimeout(pass, DELAY_MS);
})();
