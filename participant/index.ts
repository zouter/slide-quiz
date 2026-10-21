/**
 * Standalone participant widget for slide-quiz.
 * No Reveal.js dependency — designed for a mobile-friendly audience page.
 *
 * Usage (dynamic — questions come from presenter via sync):
 *   import { createParticipantUI } from 'slide-quiz/participant';
 *   import 'slide-quiz/participant.css';
 *
 *   createParticipantUI('#quiz-root', {
 *     wsUrl: 'wss://your-cable.anycable.io/cable',
 *     quizGroupId: 'my-talk',
 *   });
 *
 * Usage (static — backward compatible):
 *   createParticipantUI('#quiz-root', {
 *     wsUrl: 'wss://your-cable.anycable.io/cable',
 *     quizGroupId: 'my-talk',
 *     questions: [
 *       {
 *         quizId: 'q1',
 *         question: 'Which metric is NOT included?',
 *         options: [
 *           { label: 'A', text: 'Time to First Value' },
 *           { label: 'B', text: 'GitHub stars' },
 *         ]
 *       }
 *     ]
 *   });
 */
import "./participant.css";
import * as v from "valibot";
import { getQuizParticipant } from "../src/quiz-manager";
import type { ParticipantQuizManager, QuestionPayload } from "../src/quiz-manager";
import {
  ParticipantConfigSchema,
  MultiAnswerSchema,
  encodeMultiAnswer,
  MULTI_HINT,
  PlaneAnswerSchema,
  encodePlaneAnswer,
  planeAxes,
  PLANE_HINT,
  RankAnswerSchema,
  encodeRankAnswer,
  RANK_HINT,
  ThumbsAnswerSchema,
  encodeThumbsAnswer,
  THUMBS_HINT,
  ownAnswer,
  isOwnAnswer,
  OWN_HINT,
  OWN_MAX_LENGTH,
  OWN_MAX_PER,
} from "../src/quiz-types";
import type { ParticipantConfig } from "../src/quiz-types";
import { CLS } from "./selectors";

export type { ParticipantConfig };

export function createParticipantUI(
  selector: string,
  rawConfig: unknown,
): { destroy: () => void } {
  const parsed = v.safeParse(ParticipantConfigSchema, rawConfig);
  if (!parsed.success) {
    throw new Error(
      `[slide-quiz] Invalid participant config: ${parsed.issues[0].message}`,
    );
  }
  const config = parsed.output;

  const root = document.querySelector<HTMLElement>(selector)!;
  if (!root) {
    throw new Error(`[slide-quiz] Element not found: ${selector}`);
  }

  const { brandText, footerText = "Powered by AnyCable" } = config;

  // The deck's accent colour, so the phone matches the slides. Only a valid
  // CSS colour is applied; the value comes from a URL parameter.
  const accentApplied = !!config.accent && CSS.supports("color", config.accent);
  if (accentApplied) document.documentElement.style.setProperty("--sq-p-accent", config.accent!);

  // ── Build DOM ──
  root.innerHTML = "";
  root.classList.add(CLS.participant);

  // Brand
  if (brandText) {
    const brand = document.createElement("p");
    brand.className = "sq-participant__brand";
    brand.textContent = brandText;
    root.appendChild(brand);
  }

  // Stats
  const stats = document.createElement("div");
  stats.className = "sq-participant__stats";

  const onlineEl = document.createElement("span");
  onlineEl.className = "sq-participant__online";
  onlineEl.textContent = "0";

  const answeredEl = document.createElement("span");
  answeredEl.className = "sq-participant__answered";
  answeredEl.textContent = "0";

  // Hidden while waiting: "answered" only means something for a live question
  const answeredWrap = document.createElement("span");
  answeredWrap.append(" \u00b7 ", answeredEl, " answered");
  answeredWrap.hidden = true;

  stats.append(onlineEl, " online", answeredWrap);
  root.appendChild(stats);

  // Waiting message
  const waiting = document.createElement("div");
  waiting.className = "sq-participant__waiting";

  const waitingTitle = document.createElement("p");
  waitingTitle.className = "sq-participant__waiting-title";
  waitingTitle.textContent = "Waiting for the next question\u2026";

  const DEFAULT_HINT = "The presenter will advance to a quiz slide shortly.";
  const CONNECTION_HINT = "Can't connect to the quiz server. Check your network, or let the presenter know.";
  const waitingHint = document.createElement("p");
  waitingHint.className = "sq-participant__waiting-hint";
  waitingHint.textContent = DEFAULT_HINT;

  waiting.append(waitingTitle, waitingHint);
  root.appendChild(waiting);

  // Footer (created early so question sections are inserted before it)
  let footerEl: HTMLElement | null = null;
  if (footerText) {
    footerEl = document.createElement("p");
    footerEl.className = "sq-participant__footer";
    footerEl.textContent = footerText;
    root.appendChild(footerEl);
  }

  // ── QuizManager ──
  const manager: ParticipantQuizManager = getQuizParticipant({
    wsUrl: config.wsUrl,
    quizGroupId: config.quizGroupId,
    sessionId: config.sessionId,
    endpoints: config.endpoints,
    onError: config.onError,
    survey: config.survey,
    live: config.live,
  });

  // A survey shows no counts: people answer without seeing the results.
  if (config.survey) stats.hidden = true;

  // Question sections (keyed by quizId)
  const sectionEls: Record<string, HTMLElement> = {};
  // Track which quizIds have been rendered to avoid re-rendering on every sync
  const renderedQuizIds = new Set<string>();
  // The answer last shown per quiz, so the UI changes only when it does:
  // resets on voted → not-voted, and leaves unsent multi-select ticks alone
  const previouslyVoted = new Map<string, string>();
  let currentQuestions: QuestionPayload[] = [];
  let currentActiveQuizId: string | null = null;
  // Multi-select: the options currently ticked on screen, per quiz
  const multiSelections: Record<string, Set<string>> = {};
  // Plane: the point currently placed on screen, per quiz
  const planeSelections: Record<string, { x: number; y: number }> = {};
  // Rank: the order currently on screen, per quiz (option labels, first = most important)
  const rankOrders: Record<string, string[]> = {};
  // Thumbs: the thumb currently set per option on screen, per quiz (1 up, -1 down; absent = neutral)
  const thumbsMarks: Record<string, Record<string, number>> = {};

  function decodeThumbs(answer: string | null): Record<string, number> {
    if (!answer) return {};
    const parsed = v.safeParse(ThumbsAnswerSchema, answer);
    return parsed.success ? { ...parsed.output } : {};
  }

  function rankAnswer(answer: string | null): string[] | undefined {
    if (!answer) return undefined;
    const parsed = v.safeParse(RankAnswerSchema, answer);
    return parsed.success ? parsed.output : undefined;
  }

  /**
   * A stored ranking, fitted to the options the section asks now: options no
   * longer asked drop out and new ones join at the end, so every option on
   * screen has a place and can be moved.
   */
  function decodeRank(answer: string | null, section: HTMLElement): string[] | undefined {
    const order = rankAnswer(answer);
    if (!order) return undefined;
    const labels = [...section.querySelectorAll<HTMLElement>(`.${CLS.rankItem}`)].map((item) => item.dataset.answer ?? "");
    return [...order.filter((label) => labels.includes(label)), ...labels.filter((label) => !order.includes(label))];
  }

  /** A fresh random order, so the order shown does not suggest an answer. */
  function shuffled<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function decodePlane(answer: string | null): { x: number; y: number } | undefined {
    if (!answer) return undefined;
    const parsed = v.safeParse(PlaneAnswerSchema, answer);
    return parsed.success ? parsed.output : undefined;
  }

  function decodeMulti(answer: string | null): string[] {
    if (!answer) return [];
    const parsed = v.safeParse(MultiAnswerSchema, answer);
    return parsed.success ? parsed.output : [];
  }

  function optionText(section: HTMLElement, label: string): string {
    return section.querySelector(`[data-answer="${CSS.escape(label)}"] .${CLS.btnText}`)?.textContent || label;
  }

  const CHANGE_HINT: Record<string, string> = {
    choice: "Tap another option to change your answer.",
    multi: "Change your picks and submit again to update them.",
    text: "Edit it and submit again to change your answer.",
    plane: "Tap elsewhere and submit again to move your point.",
    rank: "Reorder and submit again to change your answer.",
    thumbs: "Change your thumbs and submit again to update them.",
  };

  function showStatus(section: HTMLElement, text: string) {
    const statusEl = section.querySelector<HTMLElement>(`.${CLS.status}`)!;
    statusEl.classList.remove(CLS.statusError);
    statusEl.textContent = text;
  }

  /** "X — submitted!", plus a line saying the answer can still be changed. */
  function showSubmitted(section: HTMLElement, text: string) {
    showStatus(section, "");
    const statusEl = section.querySelector<HTMLElement>(`.${CLS.status}`)!;
    const strong = document.createElement("strong");
    strong.textContent = text;
    const note = document.createElement("span");
    note.className = "sq-participant__status-note";
    note.textContent = CHANGE_HINT[section.dataset.quizType || "choice"];
    statusEl.append(strong, " \u2014 submitted!", note);
  }

  /** A failed send. Says whether an earlier answer still counts. */
  function showSendError(section: HTMLElement, quizId: string) {
    showStatus(
      section,
      manager.hasVoted(quizId)
        ? "Couldn't send your change. Your earlier answer still counts; try again."
        : "Couldn't send your answer. Try again.",
    );
    section.querySelector(`.${CLS.status}`)!.classList.add(CLS.statusError);
  }

  /**
   * Answers of one's own show as ticked buttons after the options; untick one
   * and it goes.
   */
  function syncOwnButtons(section: HTMLElement, selected: Set<string>) {
    const options = section.querySelector<HTMLElement>(".sq-participant__options");
    if (!options) return;
    for (const b of options.querySelectorAll<HTMLButtonElement>(".sq-participant__btn--own")) {
      if (!selected.has(b.dataset.answer || "")) b.remove();
    }
    for (const key of selected) {
      if (!isOwnAnswer(key) || options.querySelector(`[data-answer="${CSS.escape(key)}"]`)) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `${CLS.btn} sq-participant__btn--own`;
      btn.dataset.answer = key;
      const text = document.createElement("span");
      text.className = CLS.btnText;
      text.textContent = key.slice(1);
      const check = document.createElement("span");
      check.className = "sq-participant__check";
      check.setAttribute("aria-hidden", "true");
      btn.append(text, check);
      options.append(btn);
    }
  }

  /** Reflect the ticked options on the buttons and the submit button. */
  function renderMultiSelection(quizId: string) {
    const section = sectionEls[quizId];
    if (!section) return;
    const selected = multiSelections[quizId] ?? new Set<string>();
    syncOwnButtons(section, selected);
    for (const b of section.querySelectorAll<HTMLButtonElement>(`.${CLS.btn}`)) {
      const on = selected.has(b.dataset.answer || "");
      b.classList.toggle(CLS.btnSelected, on);
      b.classList.remove(CLS.btnFaded);
      b.setAttribute("aria-pressed", String(on));
    }
    const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`);
    if (submitBtn) {
      submitBtn.disabled =
        selected.size === 0 ||
        encodeMultiAnswer([...selected]) === manager.getVotedAnswer(quizId);
    }
  }

  /** Show the placed point on the plane and enable Submit when it differs from the vote. */
  function renderPlaneSelection(quizId: string) {
    const section = sectionEls[quizId];
    if (!section) return;
    const point = planeSelections[quizId];
    const marker = section.querySelector<HTMLElement>(`.${CLS.planeMarker}`);
    if (marker) {
      marker.hidden = !point;
      if (point) {
        marker.style.left = `${point.x * 100}%`;
        marker.style.top = `${(1 - point.y) * 100}%`;
      }
    }
    const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`);
    if (submitBtn) {
      submitBtn.disabled =
        !point || encodePlaneAnswer(point.x, point.y) === manager.getVotedAnswer(quizId);
    }
  }

  function renderPlaneInput(q: QuestionPayload, section: HTMLElement) {
    const hint = document.createElement("p");
    hint.className = "sq-participant__hint";
    hint.textContent = q.hint ?? PLANE_HINT;
    section.appendChild(hint);

    const axes = planeAxes(q.options);
    const end = (side: string, text: string) => {
      const span = document.createElement("span");
      span.className = `sq-participant__plane-end sq-participant__plane-end--${side}`;
      span.textContent = text;
      return span;
    };
    const field = document.createElement("div");
    field.className = CLS.planeField;
    field.setAttribute("aria-label", `${axes.left} to ${axes.right}, ${axes.bottom} to ${axes.top}`);
    const marker = document.createElement("span");
    marker.className = CLS.planeMarker;
    marker.hidden = true;
    field.append(end("left", axes.left), end("right", axes.right), marker);

    const figure = document.createElement("div");
    figure.className = "sq-participant__plane";
    figure.append(end("top", axes.top), field, end("bottom", axes.bottom));
    section.appendChild(figure);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = `${CLS.submit} sq-participant__submit--multi`;
    submitBtn.textContent = "Submit";
    submitBtn.disabled = true;
    section.appendChild(submitBtn);
  }

  /** Lay the items out in the current order and enable Submit when it differs from the vote. */
  function renderRankOrder(quizId: string) {
    const section = sectionEls[quizId];
    if (!section) return;
    const list = section.querySelector<HTMLElement>(`.${CLS.rankList}`);
    const order = rankOrders[quizId] ?? [];
    if (list) {
      order.forEach((label, i) => {
        const item = list.querySelector<HTMLElement>(`[data-answer="${CSS.escape(label)}"]`);
        if (!item) return;
        list.appendChild(item);
        item.querySelector(".sq-participant__rank-position")!.textContent = String(i + 1);
        item.querySelector<HTMLButtonElement>("[data-move='-1']")!.disabled = i === 0;
        item.querySelector<HTMLButtonElement>("[data-move='1']")!.disabled = i === order.length - 1;
      });
    }
    const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`);
    if (submitBtn) submitBtn.disabled = encodeRankAnswer(order) === manager.getVotedAnswer(quizId);
  }

  function renderRankInput(q: QuestionPayload, section: HTMLElement) {
    const hint = document.createElement("p");
    hint.className = "sq-participant__hint";
    hint.textContent = q.hint ?? RANK_HINT;
    section.appendChild(hint);

    const list = document.createElement("ol");
    list.className = CLS.rankList;
    for (const opt of q.options) {
      const item = document.createElement("li");
      item.className = CLS.rankItem;
      item.dataset.answer = opt.label;
      const position = document.createElement("span");
      position.className = "sq-participant__rank-position";
      const text = document.createElement("span");
      text.className = CLS.btnText;
      text.textContent = opt.text;
      const move = (step: number, symbol: string, name: string) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sq-participant__rank-move";
        button.dataset.move = String(step);
        button.textContent = symbol;
        button.setAttribute("aria-label", `Move ${opt.text} ${name}`);
        return button;
      };
      item.append(position, text, move(-1, "\u25B2", "up"), move(1, "\u25BC", "down"));
      list.appendChild(item);
    }
    section.appendChild(list);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = `${CLS.submit} sq-participant__submit--multi`;
    submitBtn.textContent = "Submit";
    section.appendChild(submitBtn);
  }

  /**
   * One row of a thumbs question: down, neutral (pressed until a thumb is
   * given, so no option asks for a choice) and up. An answer one just added
   * has only a thumbs up, and goes when it is taken away; one added by anyone
   * that the own endpoint lists (shared) has neutral and up.
   */
  function thumbsItem(label: string, optionText: string, kind: "option" | "own" | "shared"): HTMLElement {
    const item = document.createElement("li");
    item.className = "sq-participant__thumbs-item";
    item.dataset.answer = label;
    item.dataset.kind = kind;
    const text = document.createElement("span");
    text.className = CLS.btnText;
    text.textContent = optionText;
    const thumb = (mark: number, symbol: string, name: string) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${CLS.thumb} sq-participant__thumb--${mark > 0 ? "up" : mark < 0 ? "down" : "neutral"}`;
      button.dataset.thumb = String(mark);
      button.textContent = symbol;
      button.setAttribute("aria-label", `${name} for ${optionText}`);
      button.setAttribute("aria-pressed", "false");
      return button;
    };
    item.append(text);
    if (kind === "option") item.append(thumb(-1, "\u{1F44E}", "Thumbs down"));
    if (kind !== "own") item.append(thumb(0, "–", "Neutral"));
    item.append(thumb(1, "\u{1F44D}", "Thumbs up"));
    return item;
  }

  // When the own endpoint was last asked, per quiz.
  const sharedAsked: Record<string, number> = {};

  /** Add the answers others added as rows to vote on; one's own just added become such rows too once listed. */
  async function loadShared(quizId: string) {
    const list = sectionEls[quizId]?.querySelector<HTMLElement>(`.${CLS.thumbsList}`);
    if (!manager.endpoints.own || !list || Date.now() - (sharedAsked[quizId] ?? 0) < 15_000) return;
    sharedAsked[quizId] = Date.now();
    let answers: string[] = [];
    try {
      const url = `${manager.endpoints.own}?quizGroupId=${encodeURIComponent(config.quizGroupId)}&quizId=${encodeURIComponent(quizId)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return;
      const body = (await res.json()) as { answers?: unknown };
      answers = Array.isArray(body.answers) ? body.answers.filter((a): a is string => typeof a === "string" && isOwnAnswer(a)) : [];
    } catch {
      return;
    }
    for (const key of shuffled(answers)) {
      const row = list.querySelector<HTMLElement>(`[data-answer="${CSS.escape(key)}"]`);
      if (row && row.dataset.kind !== "own") continue;
      const shared = thumbsItem(key, key.slice(1), "shared");
      if (row) row.replaceWith(shared);
      else list.append(shared);
    }
    renderThumbs(quizId);
  }

  /** Show each option's thumb and enable Submit when the thumbs differ from the vote. */
  function renderThumbs(quizId: string) {
    const section = sectionEls[quizId];
    if (!section) return;
    const marks = thumbsMarks[quizId] ?? {};
    // An answer just added is a row with a thumbs up; take it away and the row goes.
    const list = section.querySelector<HTMLElement>(`.${CLS.thumbsList}`);
    if (list) {
      for (const item of list.querySelectorAll<HTMLElement>("[data-kind='own']")) {
        if (!((item.dataset.answer ?? "") in marks)) item.remove();
      }
      for (const key of Object.keys(marks)) {
        if (isOwnAnswer(key) && !list.querySelector(`[data-answer="${CSS.escape(key)}"]`)) list.append(thumbsItem(key, key.slice(1), "own"));
      }
    }
    for (const button of section.querySelectorAll<HTMLButtonElement>(`.${CLS.thumb}`)) {
      const label = button.closest<HTMLElement>("[data-answer]")?.dataset.answer ?? "";
      const mark = Number(button.dataset.thumb);
      button.setAttribute("aria-pressed", String(mark === 0 ? !(label in marks) : marks[label] === mark));
    }
    const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`);
    if (submitBtn) submitBtn.disabled = encodeThumbsAnswer(marks) === manager.getVotedAnswer(quizId);
  }

  function renderThumbsInput(q: QuestionPayload, section: HTMLElement) {
    const hint = document.createElement("p");
    hint.className = "sq-participant__hint";
    hint.textContent = q.hint ?? THUMBS_HINT;
    section.appendChild(hint);

    const list = document.createElement("ul");
    list.className = CLS.thumbsList;
    for (const opt of q.options) list.appendChild(thumbsItem(opt.label, opt.text, "option"));
    section.appendChild(list);

    if (q.own) {
      const own = document.createElement("div");
      own.className = "sq-participant__input-wrapper sq-participant__own";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = OWN_MAX_LENGTH;
      input.className = CLS.input;
      input.placeholder = OWN_HINT;
      const add = document.createElement("button");
      add.type = "button";
      add.className = "sq-participant__add";
      add.textContent = "Add";
      own.append(input, add);
      section.appendChild(own);
    }

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = `${CLS.submit} sq-participant__submit--multi`;
    submitBtn.textContent = "Submit";
    section.appendChild(submitBtn);
  }

  // ── Survey and live tabs ──
  // With live questions beside the survey, a tab bar switches between them;
  // the Live tab shows the presenter's open question, or waits for one.
  const surveyIds = new Set((config.questions ?? []).map((q) => q.quizId));
  let tab: "survey" | "live" = "survey";
  let liveQuizId: string | null = null;
  const tabs = document.createElement("div");
  tabs.className = "sq-participant__tabs";
  tabs.setAttribute("role", "tablist");
  const tabButton = (name: "survey" | "live", text: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sq-participant__tab";
    button.dataset.tab = name;
    button.setAttribute("role", "tab");
    button.textContent = text;
    button.addEventListener("click", () => {
      tab = name;
      refresh();
    });
    return button;
  };
  tabs.append(tabButton("survey", "Beforehand"), tabButton("live", "Live"));
  if (config.survey && config.live) root.insertBefore(tabs, waiting);

  /** Show the open tab: the survey step, or the live question. */
  function refresh() {
    if (!config.survey) return;
    const liveOpen = liveQuizId !== null && !surveyIds.has(liveQuizId) && !!sectionEls[liveQuizId];
    for (const button of tabs.querySelectorAll<HTMLElement>(".sq-participant__tab")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
      button.classList.toggle("sq-participant__tab--alert", button.dataset.tab === "live" && liveOpen && tab !== "live");
    }
    if (tab === "survey") {
      surveyNav.hidden = false;
      showSurveyStep(surveyStep);
      return;
    }
    surveyNav.hidden = true;
    surveyDone.hidden = true;
    showQuestion(liveOpen ? liveQuizId : null);
    waitingTitle.textContent = "Waiting for the next live question\u2026";
    waitingHint.textContent = "The presenter will open it during the talk.";
  }

  // ── Survey: the questions in turn, with Back and Next ──
  // A section counts as touched once someone works its controls; Next then
  // sends a change they have not submitted, but never an untouched default
  // (such as a ranking's shuffled order).
  let surveyStep = 0;
  const surveyNav = document.createElement("div");
  surveyNav.className = "sq-participant__survey-nav";
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "sq-participant__survey-back";
  backBtn.textContent = "Back";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = `${CLS.submit} sq-participant__survey-next`;
  surveyNav.append(backBtn, nextBtn);
  const surveyDone = document.createElement("div");
  surveyDone.className = "sq-participant__survey-done";
  surveyDone.innerHTML = "<p class=\"sq-participant__waiting-title\">Thank you!</p><p class=\"sq-participant__waiting-hint\">Your answers are saved. You can go back and change them until the talk.</p>";

  function showSurveyStep(step: number) {
    const questions = config.questions ?? [];
    surveyStep = Math.max(0, Math.min(step, questions.length));
    try {
      localStorage.setItem(`quiz-survey-step-${config.quizGroupId}`, String(surveyStep));
    } catch {
      /* ignore */
    }
    const done = surveyStep === questions.length;
    showQuestion(done ? null : questions[surveyStep].quizId);
    if (!done) {
      const num = sectionEls[questions[surveyStep].quizId]?.querySelector(".sq-participant__number");
      if (num) num.textContent = `${surveyStep + 1} of ${questions.length}`;
    }
    waiting.style.display = "none";
    surveyDone.hidden = !done;
    backBtn.disabled = surveyStep === 0;
    nextBtn.hidden = done;
    nextBtn.textContent = surveyStep === questions.length - 1 ? "Finish" : "Next";
    window.scrollTo({ top: 0 });
  }

  function startSurvey() {
    root.insertBefore(surveyDone, footerEl);
    root.insertBefore(surveyNav, footerEl);
    for (const section of Object.values(sectionEls)) {
      const touch = (event: Event) => {
        if (!(event.target as Element).closest(`.${CLS.submit}`)) section.dataset.touched = "1";
      };
      section.addEventListener("click", touch);
      section.addEventListener("input", touch);
    }
    backBtn.addEventListener("click", () => showSurveyStep(surveyStep - 1));
    nextBtn.addEventListener("click", () => {
      const quizId = config.questions?.[surveyStep]?.quizId;
      const section = quizId ? sectionEls[quizId] : undefined;
      const submit = section?.querySelector<HTMLButtonElement>(`.${CLS.submit}`);
      if (section?.dataset.touched && submit && !submit.disabled) submit.click();
      showSurveyStep(surveyStep + 1);
    });
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(`quiz-survey-step-${config.quizGroupId}`)) || 0;
    } catch {
      /* ignore */
    }
    showSurveyStep(saved);
  }

  function renderQuestionSections(questions: QuestionPayload[]) {
    for (const q of questions) {
      if (renderedQuizIds.has(q.quizId)) continue;
      renderedQuizIds.add(q.quizId);

      const section = document.createElement("div");
      section.className = `sq-participant__section ${CLS.sectionHidden}`;
      section.dataset.quizId = q.quizId;
      section.dataset.quizType = q.type || "choice";

      const number = document.createElement("p");
      number.className = "sq-participant__number";
      // Label set dynamically by showQuestion
      section.appendChild(number);

      const title = document.createElement("h2");
      title.className = "sq-participant__question";
      title.textContent = q.question;
      section.appendChild(title);

      const isText = (q.type || "choice") === "text";
      const isMulti = q.type === "multi";

      // A hint of the question's own under it; the other types place theirs with their input.
      if (q.hint && (isText || (q.type ?? "choice") === "choice")) {
        const hint = document.createElement("p");
        hint.className = "sq-participant__hint";
        hint.textContent = q.hint;
        section.appendChild(hint);
      }

      if (q.type === "plane") {
        renderPlaneInput(q, section);
      } else if (q.type === "rank") {
        renderRankInput(q, section);
      } else if (q.type === "thumbs") {
        renderThumbsInput(q, section);
      } else if (isText) {
        const inputWrapper = document.createElement("div");
        inputWrapper.className = "sq-participant__input-wrapper";

        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = 100;
        input.className = CLS.input;
        input.placeholder = "Type your answer...";

        const submitBtn = document.createElement("button");
        submitBtn.type = "button";
        submitBtn.className = CLS.submit;
        submitBtn.textContent = "Submit";

        inputWrapper.append(input, submitBtn);
        section.appendChild(inputWrapper);
      } else {
        const optionsDiv = document.createElement("div");
        optionsDiv.className = "sq-participant__options";

        for (const opt of q.options) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = CLS.btn;
          btn.dataset.answer = opt.label;
          const btnLabel = document.createElement("span");
          btnLabel.className = "sq-participant__btn-label";
          btnLabel.textContent = opt.label;
          const btnText = document.createElement("span");
          btnText.className = CLS.btnText;
          btnText.textContent = opt.text;
          btn.append(btnLabel, btnText);
          if (isMulti) {
            // A checkbox mark, so several picks read as allowed
            const check = document.createElement("span");
            check.className = "sq-participant__check";
            check.setAttribute("aria-hidden", "true");
            btn.append(check);
            btn.setAttribute("aria-pressed", "false");
          }
          optionsDiv.appendChild(btn);
        }

        if (isMulti) {
          const hint = document.createElement("p");
          hint.className = "sq-participant__hint";
          hint.textContent = q.hint ?? MULTI_HINT;
          section.appendChild(hint);
        }
        section.appendChild(optionsDiv);

        if (isMulti && q.own) {
          const own = document.createElement("div");
          own.className = "sq-participant__input-wrapper sq-participant__own";
          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = OWN_MAX_LENGTH;
          input.className = CLS.input;
          input.placeholder = OWN_HINT;
          const add = document.createElement("button");
          add.type = "button";
          add.className = "sq-participant__add";
          add.textContent = "Add";
          own.append(input, add);
          section.appendChild(own);
        }

        if (isMulti) {
          const submitBtn = document.createElement("button");
          submitBtn.type = "button";
          submitBtn.className = `${CLS.submit} sq-participant__submit--multi`;
          submitBtn.textContent = "Submit";
          submitBtn.disabled = true;
          section.appendChild(submitBtn);
        }
      }

      const status = document.createElement("p");
      status.className = CLS.status;
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      section.appendChild(status);

      // Insert before footer if it exists, otherwise append
      if (footerEl) {
        root.insertBefore(section, footerEl);
      } else {
        root.appendChild(section);
      }
      sectionEls[q.quizId] = section;

      // Bind click handlers for this section
      bindClickHandlers(q, section);

      // A vote restored from sessionStorage arrives before the section exists;
      // show it now that the section does.
      const voted = manager.getVotedAnswer(q.quizId);
      if (voted) {
        applyVotedUI(q.quizId, voted);
        previouslyVoted.set(q.quizId, voted);
      }
    }

    currentQuestions = questions;

    // The active quiz id can arrive one sync before its question. The id does
    // not change when the question lands, so show it now that its section exists.
    if (config.survey) refresh();
    else if (currentActiveQuizId) showQuestion(currentActiveQuizId);
  }

  function bindClickHandlers(q: QuestionPayload, section: HTMLElement) {

    if (section.dataset.quizType === "thumbs") {
      const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`)!;
      thumbsMarks[q.quizId] ??= decodeThumbs(manager.getVotedAnswer(q.quizId));
      renderThumbs(q.quizId);

      const changed = () => {
        renderThumbs(q.quizId);
        const voted = manager.getVotedAnswer(q.quizId);
        if (!voted) showStatus(section, "");
        else if (encodeThumbsAnswer(thumbsMarks[q.quizId]) === voted) showVotedThumbs(section, voted);
        else showStatus(section, "Not sent yet. Tap Submit to update your thumbs.");
      };

      // A thumb toggles: tapping the one already set, or neutral, makes the
      // option neutral again. One listener for the list, so rows of one's own
      // added later work too.
      section.querySelector(`.${CLS.thumbsList}`)!.addEventListener("click", (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(`.${CLS.thumb}`);
        const label = button?.closest<HTMLElement>("[data-answer]")?.dataset.answer;
        if (!button || !label) return;
        const marks = thumbsMarks[q.quizId];
        const mark = Number(button.dataset.thumb);
        if (mark === 0 || marks[label] === mark) delete marks[label];
        else marks[label] = mark;
        changed();
      });

      // An answer of one's own comes with a thumbs up.
      const ownInput = section.querySelector<HTMLInputElement>(`.sq-participant__own .${CLS.input}`);
      const addOwn = () => {
        const key = ownAnswer(ownInput?.value ?? "");
        const marks = thumbsMarks[q.quizId];
        // At most a few of one's own; agreeing with others' is not limited here.
        const added = section.querySelectorAll(`.${CLS.thumbsList} [data-kind='own']`).length;
        if (!key || (!(key in marks) && added >= OWN_MAX_PER)) return;
        marks[key] = 1;
        ownInput!.value = "";
        changed();
      };
      section.querySelector(".sq-participant__add")?.addEventListener("click", addOwn);
      ownInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addOwn();
      });

      submitBtn.addEventListener("click", async () => {
        const answer = encodeThumbsAnswer(thumbsMarks[q.quizId]);
        if (answer === manager.getVotedAnswer(q.quizId)) return;

        submitBtn.disabled = true;
        showStatus(section, "Sending...");

        const ok = await manager.submitAnswer(q.quizId, answer);

        if (ok) showVotedThumbs(section, answer);
        else showSendError(section, q.quizId);
        renderThumbs(q.quizId);
      });
    } else if (section.dataset.quizType === "rank") {
      const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`)!;
      rankOrders[q.quizId] ??= decodeRank(manager.getVotedAnswer(q.quizId), section) ?? shuffled(q.options.map((o) => o.label));
      renderRankOrder(q.quizId);

      for (const button of section.querySelectorAll<HTMLButtonElement>(".sq-participant__rank-move")) {
        button.addEventListener("click", () => {
          const label = button.closest<HTMLElement>(`.${CLS.rankItem}`)?.dataset.answer;
          const order = rankOrders[q.quizId];
          const from = order.indexOf(label ?? "");
          const to = from + Number(button.dataset.move);
          if (from < 0 || to < 0 || to >= order.length) return;
          [order[from], order[to]] = [order[to], order[from]];
          renderRankOrder(q.quizId);

          const voted = manager.getVotedAnswer(q.quizId);
          if (!voted) showStatus(section, "");
          else if (encodeRankAnswer(order) === voted) showVotedRank(section, voted);
          else showStatus(section, "Not sent yet. Tap Submit to update your order.");
        });
      }

      submitBtn.addEventListener("click", async () => {
        const answer = encodeRankAnswer(rankOrders[q.quizId]);
        if (answer === manager.getVotedAnswer(q.quizId)) return;

        submitBtn.disabled = true;
        showStatus(section, "Sending...");

        const ok = await manager.submitAnswer(q.quizId, answer);

        if (ok) showVotedRank(section, answer);
        else showSendError(section, q.quizId);
        renderRankOrder(q.quizId);
      });
    } else if (section.dataset.quizType === "plane") {
      const field = section.querySelector<HTMLElement>(`.${CLS.planeField}`)!;
      const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`)!;

      field.addEventListener("pointerdown", (e) => {
        const box = field.getBoundingClientRect();
        const clamp = (value: number) => Math.min(1, Math.max(0, value));
        planeSelections[q.quizId] = {
          x: clamp((e.clientX - box.left) / box.width),
          y: clamp(1 - (e.clientY - box.top) / box.height),
        };
        renderPlaneSelection(q.quizId);

        const point = planeSelections[q.quizId];
        const voted = manager.getVotedAnswer(q.quizId);
        if (!voted) showStatus(section, "");
        else if (encodePlaneAnswer(point.x, point.y) === voted) showSubmitted(section, "Your point");
        else showStatus(section, "Not sent yet. Tap Submit to move your point.");
      });

      submitBtn.addEventListener("click", async () => {
        const point = planeSelections[q.quizId];
        if (!point) return;
        const answer = encodePlaneAnswer(point.x, point.y);
        if (answer === manager.getVotedAnswer(q.quizId)) return;

        submitBtn.disabled = true;
        showStatus(section, "Sending...");

        const ok = await manager.submitAnswer(q.quizId, answer);

        if (ok) showSubmitted(section, "Your point");
        else showSendError(section, q.quizId);
        renderPlaneSelection(q.quizId);
      });
    } else if (section.dataset.quizType === "multi") {
      const buttons = () => section.querySelectorAll<HTMLButtonElement>(`.${CLS.btn}`);
      const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`)!;
      multiSelections[q.quizId] ??= new Set(decodeMulti(manager.getVotedAnswer(q.quizId)));

      const changed = () => {
        renderMultiSelection(q.quizId);
        const voted = manager.getVotedAnswer(q.quizId);
        if (!voted) showStatus(section, "");
        else if (encodeMultiAnswer([...multiSelections[q.quizId]]) === voted) showVotedMulti(section, voted);
        else showStatus(section, "Not sent yet. Tap Submit to update your answer.");
      };

      // One listener for the options, so answers of one's own added later work too.
      section.querySelector(".sq-participant__options")!.addEventListener("click", (event) => {
        const btn = (event.target as Element).closest<HTMLButtonElement>(`.${CLS.btn}`);
        const label = btn?.dataset.answer;
        if (!btn || btn.disabled || !label) return;
        const selected = multiSelections[q.quizId];
        if (selected.has(label)) selected.delete(label);
        else selected.add(label);
        changed();
      });

      const ownInput = section.querySelector<HTMLInputElement>(`.sq-participant__own .${CLS.input}`);
      const addOwn = () => {
        const key = ownAnswer(ownInput?.value ?? "");
        const selected = multiSelections[q.quizId];
        if (!key || [...selected].filter(isOwnAnswer).length >= OWN_MAX_PER) return;
        selected.add(key);
        ownInput!.value = "";
        changed();
      };
      section.querySelector(".sq-participant__add")?.addEventListener("click", addOwn);
      ownInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addOwn();
      });

      submitBtn.addEventListener("click", async () => {
        const labels = [...multiSelections[q.quizId]];
        if (labels.length === 0) return;
        const answer = encodeMultiAnswer(labels);
        if (answer === manager.getVotedAnswer(q.quizId)) return;

        submitBtn.disabled = true;
        for (const b of buttons()) b.disabled = true;
        showStatus(section, "Sending...");

        const ok = await manager.submitAnswer(q.quizId, answer);

        for (const b of buttons()) b.disabled = false;
        if (ok) showVotedMulti(section, answer);
        else showSendError(section, q.quizId);
        renderMultiSelection(q.quizId);
      });
    } else if (section.dataset.quizType === "text") {
      const input = section.querySelector<HTMLInputElement>(`.${CLS.input}`)!;
      const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`)!;

      async function submitText() {
        const answer = input.value.trim();
        if (!answer || answer === manager.getVotedAnswer(q.quizId)) return;

        input.disabled = true;
        submitBtn.disabled = true;
        showStatus(section, "Sending...");

        const ok = await manager.submitAnswer(q.quizId, answer);

        // Re-enable input (allow changing answer)
        input.disabled = false;
        submitBtn.disabled = false;

        // On failure the input keeps the new text so the participant can retry
        if (ok) showSubmitted(section, answer);
        else showSendError(section, q.quizId);
      }

      submitBtn.addEventListener("click", submitText);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitText();
      });
    } else {
      const buttons = section.querySelectorAll<HTMLButtonElement>(`.${CLS.btn}`);

      async function submitVote(answer: string) {
        // Disable during submission
        for (const b of buttons) {
          b.disabled = true;
          b.setAttribute("aria-disabled", "true");
          if (b.dataset.answer === answer) {
            b.classList.add(CLS.btnSelected);
            b.classList.remove(CLS.btnFaded);
          } else {
            b.classList.remove(CLS.btnSelected);
            b.classList.add(CLS.btnFaded);
          }
        }
        showStatus(section, "Sending...");

        const ok = await manager.submitAnswer(q.quizId, answer);

        // Re-enable buttons (allow changing vote)
        for (const b of buttons) {
          b.disabled = false;
          b.removeAttribute("aria-disabled");
        }

        if (ok) {
          showSubmitted(section, optionText(section, answer));
        } else {
          const previous = manager.getVotedAnswer(q.quizId);
          if (previous) {
            // Changing the vote failed; the previous one still counts, so show it.
            applyVotedUI(q.quizId, previous);
          } else {
            for (const b of buttons) {
              b.classList.remove(CLS.btnSelected, CLS.btnFaded);
            }
          }
          showSendError(section, q.quizId);
        }
      }

      for (const btn of buttons) {
        btn.addEventListener("click", () => {
          const answer = btn.dataset.answer;
          if (answer && answer !== manager.getVotedAnswer(q.quizId)) submitVote(answer);
        });
      }
    }
  }

  /** "N answered" counts the question on screen; 0 before its first answer or while waiting. */
  function updateAnswered() {
    const results = manager.store.results.get();
    answeredEl.textContent = String((currentActiveQuizId && results[currentActiveQuizId]?.total) || 0);
    answeredWrap.hidden = !currentActiveQuizId;
  }

  function showQuestion(quizId: string | null) {
    currentActiveQuizId = quizId;
    updateAnswered();
    for (const [id, el] of Object.entries(sectionEls)) {
      if (id === quizId) {
        el.classList.remove(CLS.sectionHidden);
        // What others added may have changed since the question was last shown.
        if (el.dataset.quizType === "thumbs" && el.querySelector(".sq-participant__own")) void loadShared(id);
        // Update "Question X of Y" label
        const num = el.querySelector(".sq-participant__number");
        if (num) {
          if (config.survey) {
            num.textContent = "";
          } else if (config.questions) {
            const idx = config.questions.findIndex(q => q.quizId === id);
            num.textContent = `Question ${idx + 1} of ${config.questions.length}`;
          } else {
            const idx = manager.store.questionIndex.get();
            const total = manager.store.totalCount.get();
            if (total > 0) {
              num.textContent = `Question ${idx + 1} of ${total}`;
            }
          }
        }
      } else {
        el.classList.add(CLS.sectionHidden);
      }
    }
    if (quizId) {
      waiting.style.display = "none";
    } else {
      waiting.style.display = "";
    }
  }

  function applyVotedUI(quizId: string, answer: string) {
    const section = sectionEls[quizId];
    if (!section) return;
    const isText = section.dataset.quizType === "text";

    if (section.dataset.quizType === "thumbs") {
      thumbsMarks[quizId] = decodeThumbs(answer);
      renderThumbs(quizId);
      showVotedThumbs(section, answer);
      return;
    }

    if (section.dataset.quizType === "rank") {
      const order = decodeRank(answer, section);
      if (order) rankOrders[quizId] = order;
      renderRankOrder(quizId);
      showVotedRank(section, answer);
      return;
    }

    if (section.dataset.quizType === "plane") {
      const point = decodePlane(answer);
      if (point) planeSelections[quizId] = point;
      renderPlaneSelection(quizId);
      showSubmitted(section, "Your point");
      return;
    }

    if (section.dataset.quizType === "multi") {
      const labels = decodeMulti(answer);
      multiSelections[quizId] = new Set(labels);
      renderMultiSelection(quizId);
      showVotedMulti(section, answer);
      return;
    }

    if (isText) {
      const input = section.querySelector<HTMLInputElement>(`.${CLS.input}`);
      if (input) input.value = answer;
    } else {
      const buttons = section.querySelectorAll<HTMLButtonElement>(`.${CLS.btn}`);
      for (const b of buttons) {
        if (b.dataset.answer === answer) {
          b.classList.add(CLS.btnSelected);
          b.classList.remove(CLS.btnFaded);
        } else {
          b.classList.remove(CLS.btnSelected);
          b.classList.add(CLS.btnFaded);
        }
      }
    }

    showSubmitted(section, isText ? answer : optionText(section, answer));
  }

  function showVotedRank(section: HTMLElement, answer: string) {
    showSubmitted(section, (rankAnswer(answer) ?? []).map((l) => optionText(section, l)).join(" > "));
  }

  function showVotedThumbs(section: HTMLElement, answer: string) {
    const marks = Object.entries(decodeThumbs(answer));
    const list = (mark: number) => marks.filter(([, m]) => m === mark).map(([l]) => optionText(section, l)).join(", ");
    const parts = [[1, "\u{1F44D}"], [-1, "\u{1F44E}"]].filter(([mark]) => list(mark as number)).map(([mark, symbol]) => `${symbol} ${list(mark as number)}`);
    showSubmitted(section, parts.length ? parts.join(" \u00b7 ") : "No thumbs");
  }

  function showVotedMulti(section: HTMLElement, answer: string) {
    showSubmitted(section, decodeMulti(answer).map((l) => optionText(section, l)).join(", "));
  }

  function resetQuizUI(quizId: string) {
    const section = sectionEls[quizId];
    if (!section) return;

    if (section.dataset.quizType === "thumbs") {
      thumbsMarks[quizId] = {};
      renderThumbs(quizId);
    } else if (section.dataset.quizType === "rank") {
      const question = currentQuestions.find((q) => q.quizId === quizId);
      rankOrders[quizId] = shuffled(question?.options.map((o) => o.label) ?? rankOrders[quizId] ?? []);
      renderRankOrder(quizId);
    } else if (section.dataset.quizType === "plane") {
      delete planeSelections[quizId];
      renderPlaneSelection(quizId);
    } else if (section.dataset.quizType === "multi") {
      multiSelections[quizId] = new Set();
      for (const b of section.querySelectorAll<HTMLButtonElement>(`.${CLS.btn}`)) b.disabled = false;
      renderMultiSelection(quizId);
    } else if (section.dataset.quizType === "text") {
      const input = section.querySelector<HTMLInputElement>(`.${CLS.input}`);
      const submitBtn = section.querySelector<HTMLButtonElement>(`.${CLS.submit}`);
      if (input) {
        input.value = "";
        input.disabled = false;
      }
      if (submitBtn) submitBtn.disabled = false;
    } else {
      const buttons = section.querySelectorAll<HTMLButtonElement>(`.${CLS.btn}`);
      for (const b of buttons) {
        b.disabled = false;
        b.removeAttribute("aria-disabled");
        b.classList.remove(CLS.btnSelected, CLS.btnFaded);
      }
    }

    showStatus(section, "");
  }

  // If questions provided statically, render them now
  if (config.questions) {
    renderQuestionSections(config.questions);
    if (config.survey) startSurvey();
  }
  refresh();

  // ── Sync timeout — detect when connected but no quiz data arrives ──
  let syncTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let syncReceived = false;

  function onSyncReceived() {
    if (syncReceived) return;
    syncReceived = true;
    if (syncTimeoutId) {
      clearTimeout(syncTimeoutId);
      syncTimeoutId = null;
    }
    // Reset hint to default in case warning was shown
    waitingHint.textContent = "The presenter will advance to a quiz slide shortly.";
    waitingHint.classList.remove("sq-participant__waiting-hint--warn");
  }

  function startSyncTimeout() {
    if (syncReceived || syncTimeoutId) return;
    syncTimeoutId = setTimeout(async () => {
      if (syncReceived) return;

      // Probe the sync endpoint to distinguish "presenter not started" from "functions broken"
      try {
        const res = await fetch(manager.endpoints.sync, { method: "GET" });
        if (res.status === 405) {
          // Functions are deployed — presenter just hasn't navigated to a quiz slide
          waitingHint.textContent = "The presenter hasn't started the quiz yet.";
        } else if (res.status === 404) {
          waitingHint.textContent =
            "Quiz functions are not deployed — let the presenter know to redeploy the site.";
          waitingHint.classList.add("sq-participant__waiting-hint--warn");
        } else {
          waitingHint.textContent =
            "Connected, but no quiz data received. Let the presenter know if this persists.";
          waitingHint.classList.add("sq-participant__waiting-hint--warn");
        }
      } catch {
        // Network error — likely running locally or CORS issue
        waitingHint.textContent =
          "Can't reach the quiz server — the site may need to be deployed.";
        waitingHint.classList.add("sq-participant__waiting-hint--warn");
      }
    }, 10_000);
  }

  // ── Store subscriptions ──
  const unsubs: (() => void)[] = [];
  unsubs.push(
    manager.store.questions.subscribe(qs => {
      if (qs.length > 0) onSyncReceived();
      if (!config.questions && qs.length > 0) renderQuestionSections([...qs]);
      // Live questions beside a survey come from the presenter.
      else if (config.live && qs.length > 0) renderQuestionSections(qs.filter((q) => !surveyIds.has(q.quizId)));
    }),
    manager.store.activeQuestionId.subscribe(id => {
      if (config.survey) {
        // A newly opened live question brings the phone to the Live tab.
        const opened = id !== null && id !== liveQuizId && !surveyIds.has(id);
        liveQuizId = id;
        if (opened) tab = "live";
        refresh();
        return;
      }
      if (id) onSyncReceived();
      showQuestion(id);
    }),
    // The presenter may renumber questions as its slides register (after a
    // refresh, the slide on screen registers first); keep the label current.
    manager.store.questionIndex.listen(() => showQuestion(currentActiveQuizId)),
    manager.store.totalCount.listen(() => showQuestion(currentActiveQuizId)),
    manager.store.online.subscribe(count => {
      onlineEl.textContent = String(count);
      if (count > 0) startSyncTimeout();
    }),
    manager.store.connectionError.subscribe(error => {
      if (error) {
        waitingHint.textContent = CONNECTION_HINT;
        waitingHint.classList.add("sq-participant__waiting-hint--warn");
      } else if (waitingHint.textContent === CONNECTION_HINT) {
        // Only undo our own message; the sync probe may have set a different hint.
        waitingHint.textContent = DEFAULT_HINT;
        waitingHint.classList.remove("sq-participant__waiting-hint--warn");
      }
    }),
    manager.store.results.subscribe(() => updateAnswered()),
    manager.store.submitted.subscribe(submitted => {
      const questionsToCheck = config.questions || currentQuestions;
      for (const q of questionsToCheck) {
        const voted = submitted[q.quizId];
        if (voted) {
          if (previouslyVoted.get(q.quizId) === voted) continue;
          applyVotedUI(q.quizId, voted);
          previouslyVoted.set(q.quizId, voted);
        } else if (previouslyVoted.has(q.quizId)) {
          resetQuizUI(q.quizId);
          previouslyVoted.delete(q.quizId);
        }
      }
    }),
  );

  // ── Cleanup on page hide ──
  function onPageHide() {
    manager.disconnect();
  }
  window.addEventListener("pagehide", onPageHide);

  // ── Return destroy handle ──
  return {
    destroy() {
      if (syncTimeoutId) clearTimeout(syncTimeoutId);
      for (const unsub of unsubs) unsub();
      window.removeEventListener("pagehide", onPageHide);
      manager.disconnect();
      root.innerHTML = "";
      root.classList.remove(CLS.participant);
      if (accentApplied) document.documentElement.style.removeProperty("--sq-p-accent");
    },
  };
}
