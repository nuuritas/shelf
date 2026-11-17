/**
 * Shared domain types for Shelf.
 *
 * Everything here describes data that crosses module boundaries or is stored
 * in SQLite / returned by the AI. Runtime validation stays in the modules that
 * read untrusted input (X, the AI endpoint); these types document the shapes
 * those modules produce.
 */

export interface Env {
  APP_PASSWORD: string;
  APP_SECRET?: string;
  /** Named provider preset: opencode, claude, openai, cloudflare, or custom. */
  AI_PROVIDER?: string;
  /** API key for the OpenAI-compatible endpoint in `AI_BASE_URL`. */
  AI_API_KEY?: string;
  /** Older name for `AI_API_KEY`; still read so old deployments keep working. */
  OPENCODE_API_KEY?: string;
  SHARE_TOKEN?: string;
  GITHUB_TOKEN?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  SUMMARY_LANGUAGE?: string;
  /** Contact URI for VAPID; defaults to the public repository URL. */
  PUSH_CONTACT?: string;
  /** Canonical host; legacy hosts in `REDIRECT_HOSTS` 308-redirect here. */
  CANONICAL_HOST?: string;
  /** Comma-separated hosts that should move to `CANONICAL_HOST`. */
  REDIRECT_HOSTS?: string;
  X_BEARER_TOKEN?: string;
  X_PROVIDER?: string;
  BOOKMARKS: DurableObjectNamespace;
  FX_API_BASE?: string;
  X_API_BASE?: string;
  REQUEST_TIMEOUT_MS?: string;
  LINK_TIMEOUT_MS?: string;
  /** Cloudflare Workers AI binding, used for X video transcription. */
  AI?: WorkersAi;
  /** Supadata key, used for YouTube captions. Optional: without it only X is transcribed. */
  SUPADATA_API_KEY?: string;
  /**
   * Any transcript service, used before Supadata. A URL template with
   * `{videoId}` and/or `{url}`, for example
   * `https://example.com/transcript?url={url}`.
   */
  TRANSCRIPT_API_URL?: string;
  /** Token for `TRANSCRIPT_API_URL`, if the service needs one. */
  TRANSCRIPT_API_KEY?: string;
  /**
   * Header that carries `TRANSCRIPT_API_KEY`. Defaults to
   * `Authorization: Bearer <key>`; set `x-api-key` or `X-API-Key` for services
   * that use a raw key header.
   */
  TRANSCRIPT_API_HEADER?: string;
  /**
   * Base URL of a Piped API instance, for example
   * `https://api.piped.private.coffee`. Keyless best-effort YouTube captions;
   * instances are volunteer-run, so treat this as a free fallback.
   */
  PIPED_API_URL?: string;
}

/** The small part of the Workers AI binding this app uses. */
export interface WorkersAi {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Language of the primary summary and the default for the library. */
export type SummaryLanguage = 'tr' | 'en';

/** Per-deployment preferences stored in the Durable Object, not in env. */
export interface StoredSettings {
  /** Empty means the built-in prompt in `src/ai.ts`. */
  summaryPrompt: string;
  summaryLanguage: SummaryLanguage;
  /**
   * The name the native apps show for this deployment. Empty means the app's
   * own "Your library" fallback; the library's link and address never change.
   */
  workspaceName: string;
  /** The reader's switch for new summaries; the key itself still comes from env. */
  summariesEnabled: boolean;
}

/** A browser or Android push endpoint, as stored in the DO. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The payload `/api/notifications/next` hands to a service worker. */
export interface PushNotification {
  title: string;
  body: string;
  url: string;
}

export interface Author {
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  verified: boolean;
}

export interface MediaVariant {
  url: string | null;
  container: string | null;
  bitrate: number | null;
}

export interface MediaItem {
  type: 'photo' | 'video' | 'gif';
  url: string;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  altText: string | null;
  durationMs: number | null;
  variants: MediaVariant[];
}

export interface XArticle {
  id: string | null;
  title: string;
  previewText: string;
  createdAt: string | null;
  modifiedAt: string | null;
  url: string | null;
  coverUrl: string | null;
  text: string;
}

export interface Metrics {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  quotes: number | null;
  views: number | null;
  bookmarks: number | null;
}

/** A normalized X post, including the quoted post it carries. */
export interface Quote {
  tweetId: string;
  url: string | null;
  text: string;
  createdAt?: string | null;
  lang?: string | null;
  isNoteTweet?: boolean;
  provider?: string;
  author?: Author | null;
  media: MediaItem[];
  metrics?: Metrics;
  article?: XArticle | null;
  quote?: Quote | null;
}

/** The main post returned by the readers; a quote with required metadata. */
export interface XPost extends Quote {
  createdAt: string | null;
  lang: string | null;
  isNoteTweet: boolean;
  provider: string;
  author: Author | null;
  metrics: Metrics;
  quote: Quote | null;
}

export interface ParsedXUrl {
  tweetId: string;
  username: string | null;
  canonicalUrl: string;
}

/** Anything collectImages can pull images out of. */
export interface ImageSource {
  media?: MediaItem[] | null;
  article?: XArticle | null;
  quote?: Quote | null;
}

export interface CollectedImage {
  url: string;
  altText: string | null;
  label: string;
  type: string;
}

export type LinkKind = 'web' | 'github';

export interface LinkRead {
  url: string;
  finalUrl: string;
  kind: LinkKind;
  title: string;
  siteName: string;
  description: string;
  text: string;
  publishedAt?: string | null;
  error?: string;
}

export type TranscriptSource = 'x' | 'youtube';
export type TranscriptStatus = 'done' | 'unavailable' | 'failed';

/** A transcript read from a video attached to a post or linked from it. */
export interface VideoTranscript {
  /** The post or page the video lives on. */
  url: string;
  source: TranscriptSource;
  provider: 'workers-ai' | 'supadata' | 'custom' | 'piped' | 'local' | null;
  lang: string | null;
  text: string;
  durationSec: number | null;
  bytes: number | null;
  status: TranscriptStatus;
  error: string | null;
  at: string;
}

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  canonicalUrl: string;
  apiUrl: string;
}

export interface TopicRef {
  slug: string;
  name: string;
}

/** A label as typed by the reader; `slug` is its filter link. */
export interface LabelName {
  slug: string;
  name: string;
}

/** A label the archive knows, with how many bookmarks carry it. */
export interface LabelSummary extends LabelName {
  count: number;
}

/** The minimal topic shape sent to the filing prompt. */
export interface Topic {
  slug: string;
  name: string;
  description: string;
}

/** How the library is filtered by archive state. */
export type ArchiveView = 'active' | 'archived' | 'all';

/** A topic with its rolling synthesis, as rendered in the library. */
export interface TopicSummary extends Topic {
  overview: string;
  overviewAt: string | null;
  /** Active (non-archived) items. */
  count: number;
  archivedCount: number;
}

/** A row from the `topics` SQLite table (`SELECT *`). */
export type TopicRow = {
  slug: string;
  name: string;
  description: string;
  overview: string | null;
  overview_at: string | null;
  overview_count: number;
  created_at: string;
  updated_at: string;
};

export interface SummaryVersion {
  version: number;
  instruction: string;
  summary: string;
  model: string | null;
  createdAt: string;
}

export type BookmarkKind = 'post' | 'note';

export type NoteFormat = 'markdown' | 'html';

/** Who wrote an agent note; stored as JSON on the row. */
export interface NoteAgent {
  name: string;
  model: string;
  tool: string;
}

/** A validated agent note on its way to the Durable Object. */
export interface NoteInput {
  format: NoteFormat;
  content: string;
  title: string;
  summary: string | null;
  sourceUrl: string | null;
  clientId: string | null;
  /** Target an existing note by its short ref; wins over `clientId`. */
  ref: string | null;
  agent: NoteAgent | null;
  /** Null when the post did not carry the field: an update keeps what is there. */
  labels: LabelName[] | null;
}

export interface Bookmark {
  /** Short, human-friendly handle used to refer to the bookmark (e.g. "k7f3"). */
  ref: string;
  tweetId: string;
  url: string;
  text: string;
  /** `post` for a saved URL, `note` for content written by an AI agent. */
  kind: BookmarkKind;
  /** Source format of a note; `text` for saved URLs. */
  format: 'text' | NoteFormat;
  title: string | null;
  /** Authored markdown/HTML for a note; null for saved URLs. */
  content: string | null;
  agent: NoteAgent | null;
  /** External source URL for a note, or null. */
  sourceUrl: string | null;
  createdAt: string | null;
  savedAt: string;
  provider: string | null;
  author: Author | null;
  media: MediaItem[];
  quote: Quote | null;
  article: XArticle | null;
  links: LinkRead[];
  /** Spoken content from videos attached to or linked from the post. */
  transcripts: VideoTranscript[];
  metrics: Metrics;
  summary: string | null;
  summaryStatus: string;
  summaryError: string | null;
  summarizedAt: string | null;
  /** English translation of the primary summary, generated on demand. */
  summaryEn: string | null;
  summaryEnStatus: string | null;
  summaryEnError: string | null;
  summaryEnAt: string | null;
  /** Set when the bookmark is archived; archived items leave the default views. */
  archivedAt: string | null;
  topics?: TopicRef[];
  /** The reader's tags, alphabetically; empty when the post carries none. */
  labels: LabelName[];
  versions?: SummaryVersion[];
  versionStatus?: string | null;
  versionError?: string | null;
}

/** A row from the `bookmarks` SQLite table (`SELECT *`). */
export type BookmarkRow = {
  tweet_id: string;
  ref: string | null;
  url: string;
  kind?: string | null;
  format?: string | null;
  title?: string | null;
  content?: string | null;
  agent_json?: string | null;
  author_name: string | null;
  author_username: string | null;
  author_avatar_url: string | null;
  author_verified: number;
  text: string;
  created_at: string | null;
  saved_at: string;
  provider: string | null;
  media_json: string;
  quote_json: string;
  article_json: string;
  links_json: string;
  transcripts_json: string;
  metrics_json: string;
  summary: string | null;
  summary_status: string;
  summary_error: string | null;
  summary_started_at: number | null;
  /** Automatic retries already spent; reset by a manual re-summarize. */
  summary_attempts?: number | null;
  /** Earliest time the alarm may pick this pending summary up again. */
  summary_retry_at?: number | null;
  summarized_at: string | null;
  summary_en: string | null;
  summary_en_status: string | null;
  summary_en_error: string | null;
  summary_en_started_at: number | null;
  summary_en_at: string | null;
  archived_at: string | null;
  version_status?: string | null;
  version_instruction?: string | null;
  version_error?: string | null;
  topics_status: string;
  topics_at: string | null;
};

/* ------------------------------------------------------------------ *
 * Durable Object JSON responses.
 * ------------------------------------------------------------------ */

/** Canonical platform of a saved bookmark, resolved from its URL. */
export type BookmarkSource = 'x' | 'linkedin' | 'youtube' | 'other';

/**
 * The library/API source filter; `all` includes every row. The three platform
 * values are URL hosts, while `web` and `note` are filters over a row's shape
 * (a saved page, an agent artifact), not platforms `sourceOfUrl` can return.
 */
export type SourceFilter = 'all' | 'x' | 'linkedin' | 'youtube' | 'web' | 'note';

export interface ListResult {
  bookmarks: Bookmark[];
  total: number;
  query: string;
  topic: string | null;
  /** Label slug the list is filtered to, or null. */
  label: string | null;
  /** UTC day filter (`YYYY-MM-DD`) when the library is showing one day. */
  day: string | null;
  view: ArchiveView;
  /** Counts under the same query/topic/day, ignoring the archive filter. */
  activeTotal: number;
  archivedTotal: number;
  /** Finished summaries that still have no English version. */
  missingEnglish: number;
  limit: number;
  offset: number;
}

export interface CalendarDay {
  /** UTC date, `YYYY-MM-DD` (matches the dates shown on cards). */
  date: string;
  count: number;
}

export interface CalendarResult {
  /** `YYYY-MM` */
  month: string;
  days: CalendarDay[];
  total: number;
}

export interface TopicListResult {
  topics: TopicSummary[];
}

export interface LabelListResult {
  labels: LabelSummary[];
}

export interface TopicPageResult {
  topic: TopicSummary | null;
  bookmarks: Bookmark[];
  total: number;
}

export interface SaveResult {
  created: boolean;
  bookmark: Bookmark | null;
}

export interface GetResult {
  bookmark: Bookmark;
}

export interface DeleteResult {
  deleted: boolean;
}

export interface SummarizeResult {
  queued: boolean;
}

export interface ArchiveResult {
  archived: boolean;
  bookmark: Bookmark | null;
}

export interface TranslateAllResult {
  queued: number;
}

export interface StatsResult {
  total: number;
  archived: number;
  summarized: number;
  /** Summaries written since the first day of the current UTC month. */
  summarizedThisMonth: number;
  translated: number;
  pending: number;
  topics: number;
  bytes?: number;
  rows?: Record<string, number>;
}

export interface StoreTranscriptsResult {
  stored: number;
  queued: boolean;
}

export interface ReindexResult {
  topics: TopicSummary[];
  assigned: number;
}

/* ------------------------------------------------------------------ *
 * Knowledge-layer AI responses.
 * ------------------------------------------------------------------ */

export interface BootstrapItem {
  id: string;
  author: string | null;
  date: string;
  text: string | null;
  summary: string | null;
}

export interface BootstrapTopic {
  slug: string;
  name: string;
  description: string;
  itemIds: string[];
}

export interface TopicOverviewItem {
  date: string;
  author: string | null;
  text: string | null;
  summary: string | null;
}

export interface TopicOverviewInput {
  topic: Topic;
  items: TopicOverviewItem[];
  previous: string;
}

export interface ClassifiedTopic {
  slug: string;
  name: string;
  description: string;
}

export interface ClassifyResult {
  slugs: string[];
  created: ClassifiedTopic | null;
  confidence: number;
}

export interface ClassifyInput {
  post: Bookmark;
  summary: string;
  topics: Topic[];
}

/* ------------------------------------------------------------------ *
 * OpenAI-compatible chat completions (the parts we consume).
 * ------------------------------------------------------------------ */

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatImagePart {
  type: 'image_url';
  image_url: {
    url: string;
    detail: string;
  };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  max_completion_tokens: number;
  reasoning_effort: string;
  temperature: number;
  stream: boolean;
}

export interface ChatResponseContentPart {
  type?: string;
  text?: string;
}

export interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | ChatResponseContentPart[] };
    finish_reason?: string;
  }>;
  error?: { message?: string };
  message?: string;
}

export interface SummaryResult {
  text: string;
  model: string;
  imagesUsed: number;
}
