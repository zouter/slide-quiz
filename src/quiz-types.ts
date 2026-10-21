/**
 * Shared schemas and types for the quiz engine.
 *
 * Schemas are the single source of truth — TypeScript types are derived
 * from them via v.InferOutput. Used by QuizManager (client) and
 * referenced by serverless functions (server).
 */
import * as v from "valibot";

// ── Boundary schemas (source of truth) ──

/**
 * - `choice`: pick one option, bar chart results
 * - `multi`: pick any number of options, bar chart of % of respondents
 * - `text`: free text, word cloud results
 * - `plane`: place one point on two axes, scatter results
 * - `rank`: put all options in order, bars of the share of the highest possible score
 * - `thumbs`: thumbs up, down or neither for every option, ranked by ups minus downs
 */
export const QuizTypeSchema = v.optional(v.picklist(["choice", "multi", "text", "plane", "rank", "thumbs"]), "choice");
export type QuizType = v.InferOutput<typeof QuizTypeSchema>;

export const VoteStateSchema = v.object({
  votes: v.record(v.string(), v.number()),
  total: v.number(),
});
export type VoteState = v.InferOutput<typeof VoteStateSchema>;

export const QuestionPayloadSchema = v.object({
  quizId: v.string(),
  question: v.string(),
  type: QuizTypeSchema,
  options: v.optional(v.array(v.object({ label: v.string(), text: v.string() })), []),
  /** Shown under the question on the audience page (free text and multi-select) */
  hint: v.optional(v.string()),
  /** Multi-select: respondents may add answers of their own */
  own: v.optional(v.boolean()),
});
export type QuestionPayload = v.InferOutput<typeof QuestionPayloadSchema>;

export const SyncPayloadSchema = v.object({
  activeQuestionId: v.nullable(v.string()),
  sessionId: v.string(),
  results: v.record(v.string(), VoteStateSchema),
  question: v.optional(QuestionPayloadSchema),
  questionIndex: v.optional(v.number()),
  totalCount: v.optional(v.number()),
  /** Increases with every broadcast from one presenter tab. Absent from functions older than 0.7.2. */
  seq: v.optional(v.number()),
  /** The claim of a presenter tab that took control; phones then follow only the highest claim. */
  control: v.optional(v.number()),
});
export type SyncPayload = v.InferOutput<typeof SyncPayloadSchema>;

export const AnswerPayloadSchema = v.object({
  quizId: v.string(),
  answer: v.string(),
  sessionId: v.string(),
});
export type AnswerPayload = v.InferOutput<typeof AnswerPayloadSchema>;

export const QuizOptionSchema = v.object({
  label: v.string(),
  text: v.string(),
  correct: v.optional(v.boolean()),
});

/**
 * Audience groups: one question, asked once, whose answer puts each respondent
 * in a group. Results of every other question are then split by group, in the
 * group's colour. The presenter does the split from the answers it already
 * holds, so nothing extra crosses the wire.
 */
export const GroupsConfigSchema = v.object({
  quizId: v.pipe(v.string(), v.minLength(1)),
  question: v.string(),
  options: v.pipe(
    v.array(v.object({ label: v.string(), text: v.string(), color: v.string() })),
    v.minLength(1),
  ),
});
export type GroupsConfig = v.InferOutput<typeof GroupsConfigSchema>;
export type GroupDef = GroupsConfig["options"][number];

/**
 * Named voters (for instance the speakers): their phones open the audience page
 * with a fixed session id, or they pick the audience-group option whose label is
 * that session id. Their answers count like anyone's, once per voter, and the
 * results also show their portrait on what they chose; in a split by audience
 * group they count as respondents without a group.
 */
export const NamedVoterSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  photo: v.optional(v.string()),
});
export type NamedVoter = v.InferOutput<typeof NamedVoterSchema>;

/** quizId → named voter's session id → their raw answer. */
export type VoterAnswers = Record<string, Record<string, string>>;

/** Counts per group label; respondents who named no group count under "". */
export type GroupCounts = Record<string, number>;
export type QuizOption = v.InferOutput<typeof QuizOptionSchema>;

/** Pipeline: JSON string → parsed array of quiz options. */
export const JsonQuizOptionsSchema = v.pipe(
  v.optional(v.string(), "[]"),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    try {
      return JSON.parse(dataset.value);
    } catch {
      addIssue({ message: "Invalid JSON" });
      return NEVER;
    }
  }),
  v.array(QuizOptionSchema),
);

/**
 * Pipeline: a multi-select answer as it travels in `AnswerPayload.answer`
 * (a JSON array of option labels) → a sorted, de-duplicated list of labels.
 * The wire format stays a plain string, so the serverless functions need no
 * change; only the presenter decodes it.
 */
export const MultiAnswerSchema = v.pipe(
  v.string(),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    try {
      return JSON.parse(dataset.value);
    } catch {
      addIssue({ message: "Invalid JSON" });
      return NEVER;
    }
  }),
  v.array(v.string()),
  v.minLength(1),
  v.transform((labels) => [...new Set(labels)].sort()),
);

/**
 * Answers of their own, on multi-select questions that allow them, travel among
 * the option labels with this prefix. The presenter counts them tidied up (one
 * spacing, lower case, at most OWN_MAX_LENGTH characters), at most OWN_MAX_PER
 * respondent, so the vote map stays bounded.
 */
export const OWN_PREFIX = "+";
export const OWN_MAX_LENGTH = 60;
export const OWN_MAX_PER = 3;
/** Answers added by anyone that one respondent's thumbs up count for, on a thumbs question. */
export const OWN_MAX_AGREED = 20;

/** An answer of one's own as it travels and is counted, or null if empty. */
export function ownAnswer(text: string): string | null {
  const tidy = text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, OWN_MAX_LENGTH).trim();
  return tidy ? OWN_PREFIX + tidy : null;
}

export function isOwnAnswer(key: string): boolean {
  return key.startsWith(OWN_PREFIX);
}

/** Shown on the audience page for multi-select questions that allow answers of one's own. */
export const OWN_HINT = "Add your own";

/**
 * A text question with `own` takes several answers from one person: they go
 * as a JSON list of texts, each counted, at most TEXT_MAX_PER.
 */
export const TEXT_MAX_PER = 10;
export const TEXT_MAX_LENGTH = 100;
export const TextsAnswerSchema = v.array(v.string());

export function encodeTextsAnswer(texts: string[]): string {
  return JSON.stringify(texts);
}

/** Encode selected option labels as a multi-select answer string. */
export function encodeMultiAnswer(labels: string[]): string {
  return JSON.stringify([...new Set(labels)].sort());
}

/**
 * A plane question names its four axis ends as options with these labels:
 * `left` and `right` for the horizontal axis, `bottom` and `top` for the
 * vertical one.
 */
export const PLANE_AXES = ["left", "right", "bottom", "top"] as const;
export type PlaneAxes = Record<(typeof PLANE_AXES)[number], string>;

/** The axis-end texts of a plane question; an end without an option is blank. */
export function planeAxes(options: { label: string; text: string }[]): PlaneAxes {
  const text = (end: string) => options.find((o) => o.label === end)?.text ?? "";
  return { left: text("left"), right: text("right"), bottom: text("bottom"), top: text("top") };
}

/** Points snap to a grid of this many steps per axis, which bounds the vote map. */
export const PLANE_STEPS = 50;

/** Encode a point (0..1 on both axes, y upwards) as a plane answer string, snapped to the grid. */
export function encodePlaneAnswer(x: number, y: number): string {
  const snap = (value: number) => (Math.round(Math.min(1, Math.max(0, value)) * PLANE_STEPS) / PLANE_STEPS).toFixed(2);
  return `${snap(x)},${snap(y)}`;
}

/**
 * Pipeline: a plane answer as it travels in `AnswerPayload.answer` ("x,y",
 * both 0..1) → the point. Like multi-select, the wire format stays a plain
 * string; only the presenter decodes it.
 */
export const PlaneAnswerSchema = v.pipe(
  v.string(),
  v.regex(/^\d(\.\d+)?,\d(\.\d+)?$/),
  v.transform((answer) => answer.split(",").map(Number) as [number, number]),
  v.check(([x, y]) => x <= 1 && y <= 1, "Point outside the plane"),
  v.transform(([x, y]) => ({ x, y })),
);

/**
 * Pipeline: a rank answer as it travels in `AnswerPayload.answer` (a JSON
 * array of every option label, first = most important) → the labels in order.
 */
export const RankAnswerSchema = v.pipe(
  v.string(),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    try {
      return JSON.parse(dataset.value);
    } catch {
      addIssue({ message: "Invalid JSON" });
      return NEVER;
    }
  }),
  v.array(v.string()),
  v.minLength(2),
  v.check((labels) => new Set(labels).size === labels.length, "Repeated option"),
);

/** Encode an order of option labels (first = most important) as a rank answer string. */
export function encodeRankAnswer(labels: string[]): string {
  return JSON.stringify(labels);
}

/**
 * Points per position in a ranking of `n` options: first gets n - 1, last 0.
 * A respondent can give at most n - 1 points to one option.
 */
export function rankPoints(position: number, n: number): number {
  return n - 1 - position;
}

/**
 * Pipeline: a thumbs answer as it travels in `AnswerPayload.answer` (a JSON
 * object of option label → 1 for thumbs up, -1 for thumbs down; options left
 * neutral are absent) → that object.
 */
export const ThumbsAnswerSchema = v.pipe(
  v.string(),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    try {
      return JSON.parse(dataset.value);
    } catch {
      addIssue({ message: "Invalid JSON" });
      return NEVER;
    }
  }),
  v.record(v.string(), v.picklist([1, -1])),
);

/** Encode thumbs per option label (1 up, -1 down, 0 neutral) as a thumbs answer string. */
export function encodeThumbsAnswer(thumbs: Record<string, number>): string {
  const marked = Object.entries(thumbs).filter(([, mark]) => mark === 1 || mark === -1);
  return JSON.stringify(Object.fromEntries(marked.sort(([a], [b]) => a.localeCompare(b))));
}

/** The vote key a thumb counts toward: the option label with + for up, - for down. */
export function thumbsKey(label: string, mark: number): string {
  return `${label}${mark > 0 ? "+" : "-"}`;
}

/** An option's thumbs up minus thumbs down. */
export function thumbsScore(votes: Record<string, number>, label: string): number {
  return (votes[thumbsKey(label, 1)] || 0) - (votes[thumbsKey(label, -1)] || 0);
}

/** Shown on thumbs question slides and on the audience page. */
export const THUMBS_HINT = "Thumbs up or down for any of them";

/** Shown on thumbs results slides. */
export const THUMBS_RESULTS_NOTE = "Ranked by thumbs up minus thumbs down";

/** Shown on rank question slides and on the audience page. */
export const RANK_HINT = "Put them in order, most important first";

/** Shown on rank results slides. */
export const RANK_RESULTS_NOTE = "Share of the highest possible score";

/** Shown on plane question slides and on the audience page. */
export const PLANE_HINT = "Tap where you stand";

/** Shown on multi-select question slides and on the audience page. */
export const MULTI_HINT = "Select all that apply";

/** Shown on multi-select results slides: the bars add up to more than 100%. */
export const MULTI_RESULTS_NOTE = `${MULTI_HINT} · % of respondents`;

/** "1 response", "12 responses". */
export function responsesText(total: number): string {
  return `${total} ${total === 1 ? "response" : "responses"}`;
}

/** The words after each count in the line under results. */
export const AUDIENCE_LABELS = { connected: "connected", responded: "responded" } as const;

/**
 * "12 connected · 9 responded": the line under results. Connected is the
 * number of open audience pages (presence); responded is this question's total.
 */
export function audienceText(online: number, total: number): string {
  return `${online} ${AUDIENCE_LABELS.connected} · ${total} ${AUDIENCE_LABELS.responded}`;
}

export const QuizEndpointsSchema = v.object({
  answer: v.string(),
  sync: v.string(),
  /** Optional: lists the answers people added to a thumbs question, for others to vote on. */
  own: v.optional(v.string()),
});
export type QuizEndpoints = v.InferOutput<typeof QuizEndpointsSchema>;

// ── Errors ──

/**
 * Where an error came from:
 * - `connection`: the WebSocket to AnyCable could not be established or was closed
 * - `sync`: the presenter's POST to the sync serverless function failed
 * - `answer`: a participant's POST to the answer serverless function failed
 * - `invalid-payload`: a message arrived that does not match its schema (dev builds only)
 * - `outdated-audience-page`: an audience page older than the deck answered a question
 *   it does not support (a multi-select question as single choice)
 */
export const QuizErrorKindSchema = v.picklist(["connection", "sync", "answer", "invalid-payload", "outdated-audience-page"]);
export type QuizErrorKind = v.InferOutput<typeof QuizErrorKindSchema>;

export interface QuizError {
  kind: QuizErrorKind;
  /** Human-readable description, safe to show on screen */
  message: string;
  /** Underlying error, HTTP status, or raw payload when available */
  cause?: unknown;
  /** Extra context: URL, quizGroupId, etc. */
  context?: Record<string, unknown>;
}

export type QuizErrorHandler = (error: QuizError) => void;

/**
 * Optional error hook. Called for every error the quiz engine detects, in
 * addition to the on-screen banner. Use it to forward errors to your own
 * monitoring (Sentry, Datadog, console) — slide-quiz never reports anywhere itself.
 */
const OnErrorSchema = v.optional(v.custom<QuizErrorHandler>((x) => typeof x === "function"));

// ── Constructor config schemas ──

export const QuizManagerConfigSchema = v.object({
  wsUrl: v.pipe(v.string(), v.minLength(1)),
  quizGroupId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.optional(v.string()),
  endpoints: v.optional(v.partial(QuizEndpointsSchema)),
  onError: OnErrorSchema,
  /** Survey mode: a phone keeps its identity and answers across visits and ignores the presenter */
  survey: v.optional(v.boolean()),
  /** With survey: the presenter's live questions still reach the phone */
  live: v.optional(v.boolean()),
});
export type QuizManagerConfig = v.InferOutput<typeof QuizManagerConfigSchema>;

export const ParticipantConfigSchema = v.object({
  wsUrl: v.pipe(v.string(), v.minLength(1)),
  quizGroupId: v.pipe(v.string(), v.minLength(1)),
  /** A fixed session id, for a named voter's phone */
  sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
  questions: v.optional(v.array(QuestionPayloadSchema)),
  endpoints: v.optional(v.partial(QuizEndpointsSchema)),
  brandText: v.optional(v.string()),
  footerText: v.optional(v.string()),
  /** CSS colour for buttons and highlights, usually the deck's accent */
  accent: v.optional(v.string()),
  onError: OnErrorSchema,
  /**
   * Survey mode: people go through `questions` at their own pace with Back
   * and Next, before or during the talk; the page keeps their identity and
   * answers on the device and never shows results.
   */
  survey: v.optional(v.boolean()),
  /**
   * With survey: the presenter's other questions are asked live, in a Live tab
   * beside the survey's; the page switches to it when one opens.
   */
  live: v.optional(v.boolean()),
});
export type ParticipantConfig = v.InferOutput<typeof ParticipantConfigSchema>;

// ── sessionStorage schemas ──

/** One participant's latest answer to one quiz, as the presenter counted it. */
export const SessionVoteSchema = v.object({
  answer: v.string(),
  keys: v.array(v.string()),
});
export type SessionVote = v.InferOutput<typeof SessionVoteSchema>;

export const PresenterStateSchema = v.object({
  activeQuestionId: v.optional(v.nullable(v.string())),
  results: v.optional(v.record(v.string(), VoteStateSchema)),
  /** quizId → sessionId → vote, so a refreshed presenter still knows who voted what */
  sessionVotes: v.optional(v.record(v.string(), v.record(v.string(), SessionVoteSchema))),
  /** Sequence number of the last sync broadcast, so it keeps increasing after a reload */
  seq: v.optional(v.number()),
  /** Named voters' answers, shown by portrait (they are counted as well) */
  voterAnswers: v.optional(v.record(v.string(), v.record(v.string(), v.string()))),
  /** This tab's claim to control, so a reload keeps it */
  control: v.optional(v.number()),
});

export const SubmittedAnswersSchema = v.record(v.string(), v.string());

// ── Internal types (no validation boundary) ──

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "closed";

export interface QuizState {
  activeQuestionId: string | null;
  results: Record<string, VoteState>;
  online: number;
  submitted: Record<string, string>;
  questions: QuestionPayload[];
  questionIndex: number;
  totalCount: number;
}

// ── Shared display computations ──

const MIN_FONT = 0.8;
const MAX_FONT = 3;

export interface WordSize {
  word: string;
  count: number;
  fontSize: number;
  isTop: boolean;
}

/** Compute font sizes for a word cloud from vote tallies. */
export function computeWordSizes(votes: Record<string, number>): WordSize[] {
  const entries = Object.entries(votes);
  if (entries.length === 0) return [];

  const maxCount = Math.max(...entries.map(([, c]) => c));
  return entries.map(([word, count]) => ({
    word,
    count,
    fontSize: maxCount > 1
      ? MIN_FONT + ((count - 1) / (maxCount - 1)) * (MAX_FONT - MIN_FONT)
      : (MIN_FONT + MAX_FONT) / 2,
    isTop: count === maxCount,
  }));
}

// ── Stream name builders ──

export function resultsStream(quizGroupId: string): string {
  return `quiz:${quizGroupId}:results`;
}

export function syncStream(quizGroupId: string): string {
  return `quiz:${quizGroupId}:sync`;
}
