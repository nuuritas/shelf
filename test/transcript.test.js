import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectVideoTargets,
  collectYoutubeIds,
  parseTranscriptBody,
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

test('collects YouTube ids from links and post text, ignoring channel pages', () => {
  const ids = collectYoutubeIds(
    bookmark({
      links: [
        {
          url: 'https://youtu.be/abc123xyz',
          finalUrl: 'https://www.youtube.com/watch?v=abc123xyz&list=PL1',
        },
        {
          url: 'https://youtube.com/@someone',
          finalUrl: 'https://youtube.com/@someone',
        },
      ],
      text: 'Also https://www.youtube.com/watch?v=def456uvw and https://youtu.be/abc123xyz',
    }),
  );

  assert.deepEqual(ids.sort(), ['abc123xyz', 'def456uvw']);
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

const youtubeBookmark = () =>
  bookmark({
    links: [
      {
        url: 'https://youtu.be/dQw4w9WgXcQ',
        finalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    ],
  });

test('a custom transcript service is tried before Supadata', async () => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url, init) => {
    requested = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ text: 'Custom captions.', language: 'en' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      TRANSCRIPT_API_URL: 'https://captions.example.com/{videoId}.json',
      TRANSCRIPT_API_KEY: 'svc-key',
      SUPADATA_API_KEY: 'supadata-key',
    });

    assert.equal(requested.url, 'https://captions.example.com/dQw4w9WgXcQ.json');
    assert.equal(requested.headers.Authorization, 'Bearer svc-key');
    assert.equal(transcripts[0].provider, 'custom');
    assert.equal(transcripts[0].lang, 'en');
    assert.equal(transcripts[0].text, 'Custom captions.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the {url} placeholder receives the encoded watch URL', async () => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async url => {
    requested = String(url);
    return new Response('plain text transcript', { status: 200 });
  };

  try {
    await readTranscripts(youtubeBookmark(), {
      TRANSCRIPT_API_URL: 'https://captions.example.com/get?url={url}',
    });
    assert.match(requested, /url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DdQw4w9WgXcQ/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a WebVTT body is reduced to words', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:02.000 align:start position:0%',
        '<c>Hello</c> there',
        '',
        '00:00:02.000 --> 00:00:04.000',
        'Hello there',
        'second line',
      ].join('\n'),
      { status: 200, headers: { 'Content-Type': 'text/vtt' } },
    );

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      TRANSCRIPT_API_URL: 'https://captions.example.com/{videoId}',
    });
    assert.equal(transcripts[0].text, 'Hello there second line');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a service that has no captions is reported, not thrown', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 404 });

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      TRANSCRIPT_API_URL: 'https://captions.example.com/{videoId}',
    });
    assert.equal(transcripts[0].status, 'unavailable');
    assert.equal(transcripts[0].provider, null);
    assert.match(transcripts[0].error, /no captions/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transcript bodies parse from JSON, SRT, and plain text', () => {
  assert.equal(parseTranscriptBody('{"transcript":"from json"}').text, 'from json');
  assert.equal(
    parseTranscriptBody('{"content":[{"text":"one"},{"text":"two"}]}').text,
    'one two',
  );
  assert.equal(
    parseTranscriptBody('1\n00:00:01,000 --> 00:00:03,000\nfirst\n\n2\n00:00:03,000 --> 00:00:05,000\nsecond').text,
    'first second',
  );
  assert.equal(parseTranscriptBody('just words').text, 'just words');
  assert.equal(parseTranscriptBody('').text, '');
});

test('a raw key header replaces the Authorization header', async () => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url, init) => {
    requested = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ content: 'from brevyd', lang: 'en' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      TRANSCRIPT_API_URL: 'https://brevyd.com/api/v1/transcript?url={url}&text=true',
      TRANSCRIPT_API_KEY: 'brv_live_test',
      TRANSCRIPT_API_HEADER: 'x-api-key',
    });

    assert.equal(requested.headers['x-api-key'], 'brv_live_test');
    assert.equal(requested.headers.Authorization, undefined);
    assert.equal(transcripts[0].text, 'from brevyd');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('segment arrays from transcript services are joined', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        transcript: [
          { start: 0, duration: 3.5, text: 'first segment' },
          { start: 3.5, duration: 3, text: 'second segment' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      TRANSCRIPT_API_URL: 'https://api.transcriptapi.io/transcript?video_id={videoId}',
      TRANSCRIPT_API_KEY: 'key',
    });
    assert.equal(transcripts[0].text, 'first segment second segment');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a spent custom quota falls back to Supadata', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes('captions.example.com')) {
      return new Response('{"error":"limit_exceeded"}', { status: 429 });
    }
    return new Response(JSON.stringify({ content: 'supadata captions', lang: 'en' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      TRANSCRIPT_API_URL: 'https://captions.example.com/{videoId}',
      SUPADATA_API_KEY: 'supadata-key',
    });

    assert.equal(calls.length, 2);
    assert.match(calls[1], /supadata\.ai/);
    assert.equal(transcripts[0].provider, 'supadata');
    assert.equal(transcripts[0].text, 'supadata captions');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('piped fetches the stream, then the caption track as VTT', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/streams/')) {
      return new Response(
        JSON.stringify({
          subtitles: [
            { url: 'https://proxy.example.com/timedtext?v=1&fmt=ttml&lang=de', code: 'de' },
            { url: 'https://proxy.example.com/timedtext?v=1&fmt=ttml&lang=en', code: 'en', autoGenerated: false },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('WEBVTT\nKind: captions\nLanguage: en\n\n00:00:01.000 --> 00:00:03.000\nPiped caption', {
      status: 200,
      headers: { 'Content-Type': 'text/vtt' },
    });
  };

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      PIPED_API_URL: 'https://piped.example.com/',
    });

    assert.equal(calls[0], 'https://piped.example.com/streams/dQw4w9WgXcQ');
    assert.match(calls[1], /fmt=vtt/);
    assert.equal(transcripts[0].provider, 'piped');
    assert.equal(transcripts[0].lang, 'en');
    assert.equal(transcripts[0].text, 'Piped caption');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('piped without caption tracks is unavailable, not an error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ subtitles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      PIPED_API_URL: 'https://piped.example.com',
    });
    assert.equal(transcripts[0].status, 'unavailable');
    assert.match(transcripts[0].error, /no captions/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a dead piped instance only costs the transcript', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('bad gateway', { status: 502 });

  try {
    const transcripts = await readTranscripts(youtubeBookmark(), {
      PIPED_API_URL: 'https://piped.example.com',
    });
    assert.equal(transcripts[0].status, 'unavailable');
    assert.match(transcripts[0].error, /502/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
