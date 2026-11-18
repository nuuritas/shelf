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

// A YouTube card is a poster until the reader taps it, then the frame replaces
// the link in place. Nothing is fetched from YouTube on a page load, the embed
// host keeps its cookies out until playback, and a tap with a modifier key or a
// page without this script still opens YouTube as the link always did.
(() => {
  const VIDEO_ID = /^[A-Za-z0-9_-]{6,}$/;

  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-youtube]');
    if (!link) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const id = link.getAttribute('data-youtube') || '';
    if (!VIDEO_ID.test(id)) return;

    event.preventDefault();
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0`;
    frame.title = link.getAttribute('data-title') || 'YouTube video';
    frame.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    link.replaceWith(frame);

    // A summary landing later would otherwise swap the card out and stop the
    // video, so a card with a player in it is left alone by the poll.
    const card = frame.closest('.card');
    if (card) card.setAttribute('data-playing', '1');
  });
})();

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

// A filter panel closes on an outside tap, as the apps' panels do. A pick
// reloads the page with `menu` in the URL, so the panel it came from stays up;
// this adds the other half — any tap that is not inside that panel closes it,
// and the key leaves the URL with it, so a reload does not bring back a panel
// the reader dismissed.
(() => {
  document.addEventListener('click', event => {
    const target = event.target;
    if (!target || !target.closest) return;

    const open = document.querySelectorAll('details.filter-menu[open]');
    if (!open.length) return;

    let closed = false;
    for (const menu of open) {
      if (menu.contains(target)) continue;
      menu.removeAttribute('open');
      closed = true;
    }
    if (!closed || !window.history || !window.history.replaceState) return;

    const url = new URL(window.location.href);
    if (!url.searchParams.has('menu')) return;
    url.searchParams.delete('menu');
    window.history.replaceState(null, '', url);
  });
})();

// Labels are a tick list: the box the reader clicks is the save. The route
// answers a redirect, and `fetch` follows it, so the body is the page the
// browser would have landed on — the card's chips are cut out of it and the
// tick list stays where it was clicked, because refreshing it between two quick
// ticks would drop the second one. A save that cannot be cut in — no fetch, a
// lost connection, a page whose session has ended — posts the form the old way,
// so a failure is the server's answer and never a tick that quietly did
// nothing. Adding a name rebuilds the block instead, which is where the new
// label joins the list and the typed text clears.
(() => {
  if (!window.fetch || !window.FormData || !window.DOMParser) return;

  // Saves run one at a time, in the order they were made. Each carries the set
  // as it stood when it was made, so a second tick waits for the first.
  let queue = Promise.resolve();

  const bookmarkId = form => {
    const field = form.querySelector('input[name="id"]');
    return field ? field.value : '';
  };

  const cardOf = form => (form.closest ? form.closest('.card') : null);

  const ownChildren = (root, selector) =>
    Array.from(root.children).filter(child => child.matches(selector));

  /** The card the answer has for this post, or null when the filter drops it. */
  const cardWithId = (page, id) => {
    for (const form of page.querySelectorAll('form.label-form')) {
      if (bookmarkId(form) === id) return cardOf(form);
    }
    return null;
  };

  /** Chips and their count, without rebuilding the tick list under the click. */
  const paintChips = (card, fresh) => {
    const current = card.querySelector('.card-labels');
    const saved = fresh.querySelector('.card-labels');
    if (!current || !saved) return;

    const editor = current.querySelector('.label-editor');
    ownChildren(current, 'a.label').forEach(chip => chip.remove());
    ownChildren(saved, 'a.label').forEach(chip => {
      current.insertBefore(chip.cloneNode(true), editor);
    });

    const count = current.querySelector('.label-editor summary');
    const savedCount = saved.querySelector('.label-editor summary');
    if (count && savedCount) count.innerHTML = savedCount.innerHTML;
  };

  // A ticked label used to leave the card open at the list's full height until
  // the reader tapped somewhere else. The editor folds itself away five seconds
  // after the last save, and any click, key or edit in the checklist restarts
  // that wait, so a second tick never lands on a closed card. A name still being
  // typed keeps it open: the text is the reader still working.
  const FOLD_MS = 5000;
  let foldTimer = 0;

  const fold = editor => {
    if (!editor || !editor.isConnected || !editor.open) return;
    const typed = editor.querySelector('input[name="newLabel"]');
    if (typed && typed.value.trim()) return;
    // The new-name chip closes before the editor it sits in, so no nested open
    // state outlives the block it belongs to.
    const chip = editor.querySelector('.label-new[open]');
    if (chip) chip.removeAttribute('open');
    editor.open = false;
  };

  /** Clear the one wait and start it again from this moment. */
  const armFold = editor => {
    if (!editor) return;
    window.clearTimeout(foldTimer);
    foldTimer = window.setTimeout(() => fold(editor), FOLD_MS);
  };

  /** The filtered view has nothing left, so show what a reload would show. */
  const paintEmpty = page => {
    const container = document.querySelector('.cards');
    if (!container || container.querySelector('.card')) return;
    const empty = page.querySelector('.empty');
    if (empty) container.replaceWith(empty.cloneNode(true));
    const note = document.querySelector('.library .fine-print');
    if (note) note.remove();
  };

  /** Put the reader back where they were if a card above them changed height. */
  const holdScroll = top => {
    if (window.scrollY === top) return;
    const shell = document.documentElement;
    const previous = shell.style.scrollBehavior;
    shell.style.scrollBehavior = 'auto';
    window.scrollTo(window.scrollX, top);
    shell.style.scrollBehavior = previous;
  };

  /** Swap in what the answer says, or report that it cannot be cut in. */
  const paint = (html, form, rebuilt) => {
    const page = new DOMParser().parseFromString(html, 'text/html');
    // Anything but the library — a sign-in page, an error page — is not
    // something this code can cut in.
    if (!page.querySelector('.library')) return false;

    const card = cardOf(form);
    const fresh = cardWithId(page, bookmarkId(form));
    // Measured before the swap, because a rebuilt or removed block moves
    // everything under it.
    const top = window.scrollY;

    if (card && !fresh) {
      // The change took the post out of the filtered view, exactly as a reload
      // would.
      card.remove();
    } else if (card && rebuilt) {
      const current = card.querySelector('.card-labels');
      const next = fresh.querySelector('.card-labels');
      if (current && next) {
        // The parsed page carries the no-script save button as a real element;
        // it must not follow the labels into a page with a script.
        const labels = next.cloneNode(true);
        labels.querySelectorAll('noscript').forEach(node => node.remove());
        // Adding a name is one step, not the end of the session: the editor
        // stays open where it was, while the chip that carried the name closes
        // and its text goes with it.
        const editor = current.querySelector('.label-editor');
        const wasOpen = editor ? editor.open : false;
        current.replaceWith(labels);
        const reopened = labels.querySelector('.label-editor');
        if (reopened && wasOpen) reopened.open = true;
        armFold(reopened);
      }
    } else if (card) {
      paintChips(card, fresh);
      armFold(card.querySelector('.label-editor'));
    }

    paintEmpty(page);
    holdScroll(top);
    return true;
  };

  const send = (form, rebuilt) => {
    const action = form.getAttribute('action') || '/labels';
    const card = cardOf(form);
    // A ticked box saves the set; text still being typed is not part of it. The
    // name waits for the button, so a half-typed label never becomes one.
    const body = new FormData(form);
    if (!rebuilt) body.delete('newLabel');

    queue = queue
      .then(() => {
        if (!card || !card.isConnected) return null;
        return fetch(action, {
          method: 'POST',
          body,
          credentials: 'same-origin',
          headers: { Accept: 'text/html' },
        });
      })
      .then(response => {
        if (!response) return;
        if (!response.ok) throw new Error('label save failed');
        return response.text().then(html => {
          if (!paint(html, form, rebuilt)) form.submit();
        });
      })
      .catch(() => {
        // No answer to cut in: let the browser post the form, so the server's
        // page is the answer instead of a tick that silently did nothing.
        form.submit();
      });
  };

  document.addEventListener('change', event => {
    const target = event.target;
    if (!target || target.name !== 'label') return;
    const picks = target.closest ? target.closest('.label-picks') : null;
    const form = picks ? picks.closest('form.label-form') : null;
    if (form) send(form, false);
  });

  // A tap, a key or an edit anywhere in the checklist restarts the wait from
  // that moment, so the editor never folds under a reader still at work.
  const restartFold = event => {
    const target = event.target;
    if (!target || !target.closest) return;
    const form = target.closest('form.label-form');
    const editor = form ? form.closest('.label-editor') : null;
    if (editor) armFold(editor);
  };
  for (const type of ['click', 'keydown', 'input']) {
    document.addEventListener(type, restartFold);
  }

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!form || !form.classList || !form.classList.contains('label-form')) return;
    const action = form.getAttribute('action') || '';
    try {
      if (new URL(action, window.location.href).origin !== window.location.origin) return;
    } catch {
      return;
    }
    event.preventDefault();
    // The ticked boxes save themselves; the button is only for the name being
    // typed. An empty one closes the chip that opened it, without a post and
    // without a reload, so no text is left behind to press a button for.
    const typed = form.querySelector('input[name="newLabel"]');
    if (!typed || !typed.value.trim()) {
      const open = form.querySelector('.label-new[open]');
      if (open) open.removeAttribute('open');
      return;
    }
    send(form, true);
  });

  // The new-name chip is a details, so it opens without this script; the field
  // is focused here only so a tap on the chip lands in it. `toggle` fires after
  // the open state changes, which is when the field can take focus.
  document.addEventListener(
    'toggle',
    event => {
      const chip = event.target;
      if (!chip || !chip.classList || !chip.classList.contains('label-new')) return;
      if (!chip.open) return;
      const field = chip.querySelector('input[name="newLabel"]');
      if (field) field.focus();
    },
    true,
  );
})();

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
   * A reader who is typing a label, who opened a card, or who is watching a
   * video is in the middle of something: the card is skipped this pass and
   * tried again on the next.
   */
  const busy = card =>
    card.hasAttribute('data-playing') ||
    card.contains(document.activeElement) ||
    Boolean(card.querySelector('details[open]'));

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
