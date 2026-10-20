/**
 * Shared class-name constants and selector helpers.
 *
 * Single source of truth: the same constants are interpolated into
 * html`` templates (render-*.ts) and into querySelector calls
 * (plugin.ts, update/animate functions).
 */

// ── Class names (used in both templates and selectors) ──

export const CLS = {
  question: "sq-question",
  results: "sq-results",
  wordcloud: "sq-wordcloud",
  online: "sq-online",
  answered: "sq-answered",

  resultBar: "sq-result-bar",
  resultBarCorrect: "sq-result-bar--correct",
  resultBarFill: "sq-result-bar__fill",
  /** The thumbs-down part of a thumbs bar; its thumbs-up part is resultBarFill */
  resultBarFillDown: "sq-result-bar__fill--down",
  /** One audience group's part of a bar */
  resultBarSegment: "sq-result-bar__segment",
  groupLegend: "sq-groups-legend",
  /** Answers the audience added themselves, on a results slide */
  ownAnswers: "sq-results__own",
  /** A named voter's portrait on a results slide */
  voter: "sq-voter",
  resultBarVoters: "sq-result-bar__voters",
  /** Any element that should show the join QR code */
  join: "sq-join",
  resultBarPct: "sq-result-bar__pct",
  resultBarCount: "sq-result-bar__count",
  resultsTotal: "sq-results__total",
  /** The responded count inside the line under results */
  resultsResponded: "sq-results__responded",
  /** Empty Reveal.js fragment; once shown, the correct option is highlighted */
  revealCorrect: "sq-reveal-correct",

  syncError: "sq-sync-error",
  /** The button that makes this deck window the one phones follow */
  control: "sq-control",
  /** The error banner as a small pill; removed when the presenter clicks it */
  syncErrorCompact: "sq-sync-error--compact",

  wordcloudCloud: "sq-wordcloud__cloud",
  wordcloudWord: "sq-wordcloud__word",
  wordcloudWordTop: "sq-wordcloud__word--top",

  plane: "sq-plane",
  planePoints: "sq-plane__points",
  planePoint: "sq-plane__point",
} as const;

// ── Selector helpers (composite class + data-attribute queries) ──

export function findWordcloud(parent: HTMLElement, quizId: string) {
  return parent.querySelector<HTMLElement>(`.${CLS.wordcloud}[data-sq-quiz="${quizId}"]`);
}

export function findPlane(parent: HTMLElement, quizId: string) {
  return parent.querySelector<HTMLElement>(`.${CLS.plane}[data-sq-quiz="${quizId}"]`);
}

export function findAllPlanes(parent: HTMLElement, quizId: string) {
  return parent.querySelectorAll<HTMLElement>(`.${CLS.plane}[data-sq-quiz="${quizId}"]`);
}

export function findResults(parent: HTMLElement, quizId: string) {
  return parent.querySelector<HTMLElement>(`.${CLS.results}[data-sq-quiz="${quizId}"]`);
}

export function findAllOnline(parent: HTMLElement) {
  return parent.querySelectorAll<HTMLElement>(`.${CLS.online}`);
}

export function findAllAnswered(parent: HTMLElement, quizId: string) {
  return parent.querySelectorAll<HTMLElement>(`.${CLS.answered}[data-sq-quiz="${quizId}"]`);
}

export function findAllWordclouds(parent: HTMLElement, quizId: string) {
  return parent.querySelectorAll<HTMLElement>(`.${CLS.wordcloud}[data-sq-quiz="${quizId}"]`);
}

export function findAllResults(parent: HTMLElement, quizId: string) {
  return parent.querySelectorAll<HTMLElement>(`.${CLS.results}[data-sq-quiz="${quizId}"]`);
}

export function findAllInjected(parent: HTMLElement) {
  return parent.querySelectorAll(`.${CLS.question}, .${CLS.results}, .${CLS.wordcloud}, .${CLS.plane}`);
}
