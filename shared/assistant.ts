/** Public assistant contract. Credentials and provider internals never enter these types. */
export const ASSISTANT_DEFAULT_MODEL = 'gpt-6.1-sol';
export const ASSISTANT_LIMITS = {
  messageCharacters: 4000, turns: 8, contextCharacters: 48000,
  requestTimeoutMs: 60000, previewTtlMs: 15 * 60 * 1000, conversationTtlMs: 30 * 60 * 1000,
  maxOutputTokens: 6000,
} as const;

export type AssistantJson = null | boolean | number | string | AssistantJson[] | { [key: string]: AssistantJson };
export type AssistantEvidenceKind = 'dns-benchmark' | 'dns' | 'connectivity' | 'internet' | 'playback' | 'system-stats' | 'inventory';
export interface AssistantEvidence {
  id: string;
  kind: AssistantEvidenceKind;
  title: string;
  observedAt: number;
  vantage: string;
  complete: boolean;
  summary: string;
  facts: { [key: string]: AssistantJson };
  limitations: string[];
  sourceId?: string;
}
export interface AssistantFinding {
  id: string;
  severity: 'info' | 'attention' | 'warning';
  title: string;
  detail: string;
  evidenceIds: string[];
  nextStep: string;
}
export interface AssistantContext {
  generatedAt: number;
  includeIdentifiers: boolean;
  evidence: AssistantEvidence[];
  findings: AssistantFinding[];
  missingEvidence: string[];
  omitted: { jobs: number; stats: number; playback: number; assets: number };
}
export interface AssistantOptions {
  available: boolean;
  provider: 'OpenAI';
  model: string;
  reason: string | null;
  limits: typeof ASSISTANT_LIMITS;
}
export interface AssistantPreview {
  previewId: string;
  createdAt: number;
  expiresAt: number;
  context: AssistantContext;
  /** Exact evidence text sent with the question and the in-memory conversation. */
  outboundEvidence: string;
  disclosure: string[];
}
export interface AssistantAnswer {
  summary: string;
  findings: { title: string; explanation: string; confidence: 'measured' | 'likely' | 'uncertain'; evidenceIds: string[] }[];
  actions: { priority: 'high' | 'medium' | 'low'; title: string; why: string; steps: string[]; verification: string; tradeoff: string; evidenceIds: string[] }[];
  limitations: string[];
  followUpQuestions: string[];
}
export interface AssistantReply {
  requestId: string;
  conversationId: string;
  previewId: string;
  answer: AssistantAnswer;
  model: string;
  createdAt: number;
  turnsRemaining: number;
  usage: { inputTokens: number | null; outputTokens: number | null };
}
export interface AssistantChatRequest {
  requestId: string;
  previewId: string;
  conversationId?: string;
  message: string;
  confirmed: true;
}
