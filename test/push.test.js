import assert from 'node:assert/strict';
import test from 'node:test';
import {
  base64UrlDecode,
  base64UrlEncode,
  createVapidKeys,
  parsePushSubscription,
  pushEndpoint,
  sendPush,
  summaryNotification,
  vapidAuthorization,
} from '../src/push.ts';

const decoder = new TextDecoder();

test('VAPID keys are a P-256 pair and the JWT verifies with the public key', async () => {
  const keys = await createVapidKeys();
  assert.equal(keys.privateKey.kty, 'EC');
  assert.equal(keys.privateKey.crv, 'P-256');
  assert.equal(typeof keys.privateKey.d, 'string');

  const raw = base64UrlDecode(keys.publicKey);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);

  const endpoint = new URL('https://push.example.com/sub/abc');
  const authorization = await vapidAuthorization(endpoint, keys);
  assert.match(authorization, /^vapid t=[^,]+, k=/);

  const token = authorization.slice('vapid t='.length).split(', k=')[0];
  const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(decoder.decode(base64UrlDecode(header))).alg, 'ES256');

  const claims = JSON.parse(decoder.decode(base64UrlDecode(payload)));
  assert.equal(claims.aud, 'https://push.example.com');
  assert.match(claims.sub, /^https:\/\//);
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));

  const publicKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64UrlDecode(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert.equal(valid, true);
});

test('base64url round-trips without padding or unsafe characters', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = base64UrlEncode(bytes);
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.deepEqual([...base64UrlDecode(encoded)], [...bytes]);
});

test('only public HTTPS endpoints are accepted', () => {
  assert.ok(pushEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.equal(pushEndpoint('http://fcm.googleapis.com/fcm/send/abc'), null);
  assert.equal(pushEndpoint('https://localhost/push'), null);
  assert.equal(pushEndpoint('https://127.0.0.1/push'), null);
  assert.equal(pushEndpoint('https://192.168.1.5/push'), null);
  assert.equal(pushEndpoint('https://[::1]/push'), null);
  assert.equal(pushEndpoint('not a url'), null);
  assert.equal(pushEndpoint(''), null);
});

test('a subscription keeps the endpoint and bounded key material', () => {
  const record = parsePushSubscription({
    endpoint: 'https://push.example.com/sub/abc',
    keys: { p256dh: 'p'.repeat(300), auth: 'a'.repeat(100) },
  });
  assert.equal(record.endpoint, 'https://push.example.com/sub/abc');
  assert.equal(record.p256dh.length, 200);
  assert.equal(record.auth.length, 64);

  assert.equal(parsePushSubscription({ endpoint: 'http://example.com/x' }), null);
});

test('sendPush reports sent, gone, and failed', async () => {
  const keys = await createVapidKeys();
  const subscription = {
    endpoint: 'https://push.example.com/sub/abc',
    p256dh: '',
    auth: '',
  };
  const original = globalThis.fetch;
  let seen = null;

  try {
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), headers: init.headers };
      return new Response(null, { status: 201 });
    };
    assert.equal(await sendPush(subscription, keys), 'sent');
    assert.equal(seen.url, 'https://push.example.com/sub/abc');
    assert.match(seen.headers.Authorization, /^vapid t=/);
    assert.equal(seen.headers.TTL, '86400');

    globalThis.fetch = async () => new Response(null, { status: 410 });
    assert.equal(await sendPush(subscription, keys), 'gone');

    globalThis.fetch = async () => new Response(null, { status: 500 });
    assert.equal(await sendPush(subscription, keys), 'failed');

    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    assert.equal(await sendPush(subscription, keys), 'failed');
  } finally {
    globalThis.fetch = original;
  }
});

test('sendPush does not call an invalid endpoint', async () => {
  const keys = await createVapidKeys();
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 201 });
  };

  try {
    assert.equal(
      await sendPush({ endpoint: 'http://localhost/push', p256dh: '', auth: '' }, keys),
      'gone',
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(called, false);
});

test('the notification text names the author and links to the card', () => {
  const notification = summaryNotification({
    tweetId: '123 456',
    text: 'fallback text',
    summary: 'The first paragraph.\n\nThe second paragraph.',
    author: { name: 'Ada', username: 'ada', avatarUrl: null, verified: false },
  });
  assert.equal(notification.title, 'New summary from @ada');
  assert.equal(notification.body, 'The first paragraph. The second paragraph.');
  assert.equal(notification.url, '/?layout=saves#bookmark-123%20456');
});

test('a long or missing summary is compacted', () => {
  const long = summaryNotification({
    tweetId: '1',
    text: 'post text',
    summary: 'x'.repeat(400),
    author: null,
  });
  assert.equal(long.title, 'New summary from Shelf');
  assert.ok(long.body.length <= 160);
  assert.match(long.body, /…$/);

  const fallback = summaryNotification({
    tweetId: '1',
    text: 'the post text',
    summary: '',
    author: { name: 'Ada', username: '', avatarUrl: null, verified: false },
  });
  assert.equal(fallback.title, 'New summary from Ada');
  assert.equal(fallback.body, 'the post text');
});
