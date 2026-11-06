/**
 * Shared domain types for X Bookmark Vault.
 *
 * Everything here describes data that crosses module boundaries or is stored
 * in SQLite / returned by the AI. Runtime validation stays in the modules that
 * read untrusted input (X, the AI endpoint); these types document the shapes
 * those modules produce.
 */

export interface Env {
  APP_PASSWORD: string;
  APP_SECRET?: string;
  OPENCODE_API_KEY?: string;
  SHARE_TOKEN?: string;
  GITHUB_TOKEN?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  SUMMARY_LANGUAGE?: string;
  X_BEARER_TOKEN?: string;
  X_PROVIDER?: string;
  BOOKMARKS: DurableObjectNamespace;
  FX_API_BASE?: string;
  X_API_BASE?: string;
  REQUEST_TIMEOUT_MS?: string;
  LINK_TIMEOUT_MS?: string;
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

/** The minimal topic shape sent to the filing prompt. */
export interface Topic {
  slug: string;
  name: string;
  description: string;
}

/** A topic with its rolling synthesis, as rendered in the library. */
export interface TopicSummary extends Topic {
  overview: string;
  overviewAt: string | null;
  count: number;
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

export interface Bookmark {
  tweetId: string;
  url: string;
  text: string;
  createdAt: string | null;
  savedAt: string;
  provider: string | null;
  author: Author | null;
  media: MediaItem[];
  quote: Quote | null;
  article: XArticle | null;
  links: LinkRead[];
  metrics: Metrics;
  summary: string | null;
  summaryStatus: string;
  summaryError: string | null;
  summarizedAt: string | null;
  topics?: TopicRef[];
  versions?: SummaryVersion[];
  versionStatus?: string | null;
  versionError?: string | null;
}

/** A row from the `bookmarks` SQLite table (`SELECT *`). */
export type BookmarkRow = {
  tweet_id: string;
  url: string;
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
  metrics_json: string;
  summary: string | null;
  summary_status: string;
  summary_error: string | null;
  summary_started_at: number | null;
  summarized_at: string | null;
  version_status?: string | null;
  version_instruction?: string | null;
  version_error?: string | null;
  topics_status: string;
  topics_at: string | null;
};

/* ------------------------------------------------------------------ *
 * Durable Object JSON responses.
 * ------------------------------------------------------------------ */

export interface ListResult {
  bookmarks: Bookmark[];
  total: number;
  query: string;
  topic: string | null;
  limit: number;
  offset: number;
}

export interface TopicListResult {
  topics: TopicSummary[];
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

export interface StatsResult {
  total: number;
  summarized: number;
  pending: number;
  topics: number;
  bytes?: number;
  rows?: Record<string, number>;
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
