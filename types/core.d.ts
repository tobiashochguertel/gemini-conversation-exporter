// Type declarations for gemini-conversation-exporter core module.
// These mirror the JSDoc typedefs in src/core.js.

/** Thinking/reasoning data extracted from candidate[37]. */
export interface Thinking {
  /** Full thinking text as Markdown. */
  text: string;
  /** Thinking step texts (one per section). */
  steps: string[];
}

/** A single web search citation. */
export interface WebCitation {
  /** Citation display text (usually a Markdown link). */
  text: string | null;
  /** Gemini source ID (e.g. `spp_…`). */
  sourceId: string | null;
}

/** An extension/tool result entry. */
export interface ExtensionResult {
  /** Original position in candidate[12]. */
  index: number;
  /** Raw, opaque extension/tool payload. */
  raw: unknown;
}

/** A feedback/rating group. */
export interface FeedbackGroup {
  /** Original position in turn[3][1]. */
  index: number;
  /** Raw feedback/rating array. */
  raw: unknown[];
}

/** A structured conversation turn. */
export interface Turn {
  /** Gemini conversation ID (`c_…`). */
  conversationId: string | null;
  /** Response ID (`r_…`). */
  responseId: string | null;
  /** Parent response ID. */
  parentResponseId: string | null;
  /** Selected candidate ID (`rc_…`). */
  candidateId: string | null;
  /** Parent candidate ID. */
  parentCandidateId: string | null;
  /** User prompt as Markdown. */
  userMarkdown: string;
  /** Assistant response as Markdown. */
  assistantMarkdown: string;
  /** ISO 8601 timestamp. */
  timestamp: string | null;
  /** Model name (e.g. "3.6 Flash Extended"). Present only if available. */
  model?: string;
  /** Response language code (e.g. "DE"). Present only if available. */
  language?: string;
  /** Thinking/reasoning data. Present only if the turn has thinking. */
  thinking?: Thinking;
  /** Web search citations. Present only if citations exist. */
  webCitations?: WebCitation[];
  /** Extension/tool results. Present only if extensions exist. */
  extensions?: ExtensionResult[];
  /** Feedback/rating groups. Present only if feedback exists. */
  feedback?: FeedbackGroup[];
  /** Zero-based index in the raw history. */
  sourceIndex: number;
}

/** Diagnostics produced by validateConversation. */
export interface Diagnostics {
  fingerprint: string;
  duplicateBodies: unknown[];
  timestampRegressions: unknown[];
  markdownWarnings: unknown[];
}

/** Options for renderMarkdown. */
export interface RenderMarkdownOptions {
  title: string;
  sourceUrl: string;
  conversationId: string;
  exportedAt: string;
  turns: Turn[];
  diagnostics: Diagnostics;
  includeMetadata?: boolean;
  includeOutline?: boolean;
}

/** Options for renderJson. */
export interface RenderJsonOptions {
  title: string;
  sourceUrl: string;
  conversationId: string;
  exportedAt: string;
  turns: Turn[];
  diagnostics: Diagnostics;
  includeMetadata?: boolean;
}

/** Parsed history page from the hNvQHb RPC. */
export interface HistoryPage {
  rawTurns: unknown[][];
  cursor: string | null;
}

/** The Core module exported by src/core.js. */
export interface CoreModule {
  readonly HISTORY_RPC_ID: string;

  accountScopedPath(pathname: string, targetPath: string): string;
  cleanDocumentTitle(documentTitle: string): string;
  collectHistoryPages(
    adapter: unknown,
    maxPages?: number,
  ): Promise<HistoryPage[]>;
  conversationIdFromPath(pathname: string): string | null;
  extractTurn(rawTurn: unknown[], sourceIndex: number): Turn;
  fnv1a(input: string): string;
  historyToChronologicalTurns(rawTurnsNewestFirst: unknown[][]): Turn[];
  parseBatchexecuteResponse(rawResponse: string, rpcId?: string): unknown;
  parseHistoryPage(rawResponse: string): HistoryPage;
  renderMarkdown(options: RenderMarkdownOptions): string;
  renderJson(options: RenderJsonOptions): string;
  safeFilename(title: string, extension?: string): string;
  turnPreview(markdown: string): string;
  validateConversation(turns: Turn[]): Diagnostics;
}

declare const Core: CoreModule;
export default Core;
