import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectVideoTargets,
  readTranscripts,
  youtubeVideoId,
} from '../src/transcript.ts';

function bookmark(overrides = {}) {
  return {
    ref: 'k7f3',
    tweetId: '123',
    url: 'https://x.com/a/status/123',
    text: 'Look at this.',
    media: [],
    quote: null,
    links: [],
    ...overrides,
  };
}

function videoMedia(bitrates = [256000, 2176000]) {
  return {
    type: 'video',
    url: `https://video.twimg.com/amplify_video/1/vid/avc1/high-${bitrates.at(-1)}.mp4`,
    posterUrl: null,
    width: 1280,
    height: 720,
    altText: null,
    durationMs: 60000,
    variants: bitrates.map(bitrate => ({
      url: `https://video.twimg.com/amplify_video/1/vid/avc1/${bitrate}.mp4`,
      container: 'mp4',
      bitrate,
    })),
  };
}

test('recognises YouTube watch, short, shorts, and embed URLs', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(youtubeVideoId('https://vimeo.com/12345'), null);
});

test('collects the post video first and YouTube links after it', () => {
  const targets = collectVideoTargets(
    bookmark({
      media: [videoMedia()],
      links: [
        {
          url: 'https://youtu.be/dQw4w9WgXcQ',
          finalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      ],
    }),
  );

  assert.deepEqual(
    targets.map(target => target.source),
    ['x', 'youtube'],
  );
  assert.equal(targets[0].durationSec, 60);
});

test('transcribes an X video with Workers AI and picks the smallest MP4', async () => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    requested.push(String(url));
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Length': '3' },
    });
  };

  try {
    let model;
    let input;
    const transcripts = await readTranscripts(bookmark({ media: [videoMedia()] }), {
      AI: {
        async run(receivedModel, receivedInput) {
          model = receivedModel;
          input = receivedInput;
          return {
            text: 'Merhaba, bu bir deneme.',
            transcription_info: { language: 'tr', duration: 60 },
          };
        },
      },
    });

    assert.equal(model, '@cf/openai/whisper-large-v3-turbo');
    assert.equal(input.task, 'transcribe');
    assert.equal(typeof input.audio, 'string');
    assert.match(requested[0], /256000\.mp4/);
    assert.equal(transcripts[0].status, 'done');
    assert.equal(transcripts[0].provider, 'workers-ai');
    assert.equal(transcripts[0].lang, 'tr');
    assert.equal(transcripts[0].text, 'Merhaba, bu bir deneme.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed transcription does not reject the summary job', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Length': '1' } });

  try {
    const transcripts = await readTranscripts(bookmark({ media: [videoMedia()] }), {
      AI: {
        async run() {
          throw new Error('Whisper is unavailable.');
        },
      },
    });

    assert.equal(transcripts.length, 1);
    assert.equal(transcripts[0].status, 'failed');
    assert.match(transcripts[0].error, /Whisper is unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reads YouTube captions through Supadata when a key is set', async () => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url, init) => {
    requested = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ content: 'Captions here.', lang: 'en' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const transcripts = await readTranscripts(
      bookmark({
        links: [
          {
            url: 'https://youtu.be/dQw4w9WgXcQ',
            finalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          },
        ],
      }),
      { SUPADATA_API_KEY: 'test-key' },
    );

    assert.match(requested.url, /mode=native/);
    assert.match(requested.url, /text=true/);
    assert.equal(requested.headers['x-api-key'], 'test-key');
    assert.equal(transcripts[0].provider, 'supadata');
    assert.equal(transcripts[0].text, 'Captions here.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('skips YouTube quietly when Supadata is not configured', async () => {
  const transcripts = await readTranscripts(
    bookmark({
      links: [
        {
          url: 'https://youtu.be/dQw4w9WgXcQ',
          finalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      ],
    }),
    {},
  );

  assert.deepEqual(transcripts, []);
});
