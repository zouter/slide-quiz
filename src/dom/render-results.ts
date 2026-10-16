import * as v from "valibot";
import type { VoteState, GroupDef, GroupCounts } from "../quiz-types";
import { JsonQuizOptionsSchema, QuizTypeSchema, MULTI_RESULTS_NOTE, RANK_RESULTS_NOTE, AUDIENCE_LABELS } from "../quiz-types";
import { html, type Child } from "./html";
import { renderResultsQR } from "./render-results-qr";
import { CLS } from "./selectors";

/**
 * Inject results bar chart into a `<section data-quiz-results>` slide.
 * Reads data-quiz-results (quizId) and data-quiz-options for options metadata.
 */
export async function renderResults(
  slide: HTMLElement,
  quizUrl?: string,
  groups?: GroupDef[],
): Promise<void> {
  const quizId = slide.dataset.quizResults!;
  const question = slide.dataset.quizQuestion || "";
  const quizType = v.parse(QuizTypeSchema, slide.dataset.quizType);
  const note = quizType === "multi" ? MULTI_RESULTS_NOTE : quizType === "rank" ? RANK_RESULTS_NOTE : null;
  const parsed = v.safeParse(JsonQuizOptionsSchema, slide.dataset.quizOptions);
  if (!parsed.success) {
    console.warn(`[slide-quiz] Invalid data-quiz-options on results "${quizId}"`);
    return;
  }

  const qrBlock = await renderResultsQR(quizUrl, slide);
  // The audience may still be voting here, so the correct option is
  // highlighted only once this fragment is shown (see syncCorrectReveal).
  const hasCorrect = parsed.output.some((opt) => opt.correct);

  const fragment = html`
    <div class="${CLS.results}" data-sq-quiz="${quizId}" data-quiz-type="${quizType}">
      ${question ? html`<h2 class="sq-results__title">${question}</h2>` : null}
      ${note ? html`<p class="sq-results__note">${note}</p>` : null}
      ${renderGroupLegend(groups)}
      <div class="sq-results__body">
        <div class="sq-results__bars">
          ${parsed.output.map(
            (opt) => html`
              <div class="${CLS.resultBar}" data-option="${opt.label}" data-correct="${opt.correct ? "true" : "false"}">
                <div class="sq-result-bar__label">
                  <span class="sq-result-bar__letter">${opt.label}</span>
                  <span class="sq-result-bar__text">${opt.text}</span>
                </div>
                <div class="sq-result-bar__track">
                  <div class="${CLS.resultBarFill}" style="width: 0%"></div>
                </div>
                <div class="sq-result-bar__stats">
                  <span class="${CLS.resultBarPct}">0%</span>
                  <span class="${CLS.resultBarCount}">0</span>
                </div>
              </div>
            `,
          )}
          <p class="${CLS.resultsTotal}">${audienceLine()}</p>
        </div>
        ${qrBlock}
      </div>
      ${hasCorrect ? html`<span class="fragment ${CLS.revealCorrect}"></span>` : null}
    </div>
  `;

  slide.appendChild(fragment);
}

/** A colour key for the audience groups, when the deck defines them. */
export function renderGroupLegend(groups?: GroupDef[]): Child {
  if (!groups?.length) return null;
  return html`
    <div class="${CLS.groupLegend}">
      ${groups.map(
        (g) => html`<span class="sq-groups-legend__item"><i style="background: ${g.color}"></i>${g.text}</span>`,
      )}
    </div>
  `;
}

/**
 * Split a bar's fill into one segment per audience group, in the groups'
 * order, each in its group's colour; respondents without a group come last.
 */
export function fillGroupSegments(fill: HTMLElement, counts?: GroupCounts, groups?: GroupDef[]): void {
  if (!groups?.length) return;
  const segments: HTMLElement[] = [];
  for (const [label, color] of [...groups.map((g) => [g.label, g.color]), ["", ""]]) {
    const count = counts?.[label] || 0;
    if (count <= 0) continue;
    const segment = document.createElement("span");
    segment.className = CLS.resultBarSegment;
    segment.style.flexGrow = String(count);
    if (color) segment.style.background = color;
    segments.push(segment);
  }
  fill.replaceChildren(...segments);
}

/**
 * The value behind one bar as a percentage. Choice and multi-select: share of
 * respondents. Rank: share of the highest possible score, where a respondent
 * gives an option at most (number of options - 1) points.
 */
function barPercent(wrapper: HTMLElement, count: number, state: VoteState): number {
  const options = wrapper.querySelectorAll(`.${CLS.resultBar}`).length;
  const perRespondent = wrapper.dataset.quizType === "rank" ? Math.max(1, options - 1) : 1;
  return Math.round((count / ((state.total || 1) * perRespondent)) * 100);
}

/**
 * Update result bars with current vote state.
 */
export function updateResultBars(
  wrapper: HTMLElement,
  state: VoteState,
  breakdown?: Record<string, GroupCounts>,
  groups?: GroupDef[],
): void {
  const bars = wrapper.querySelectorAll<HTMLElement>(`.${CLS.resultBar}`);
  updateTotal(wrapper, state);

  for (const bar of bars) {
    const key = bar.dataset.option || "";
    const count = state.votes[key] || 0;
    const pct = barPercent(wrapper, count, state);

    const fill = bar.querySelector<HTMLElement>(`.${CLS.resultBarFill}`);
    const pctEl = bar.querySelector<HTMLElement>(`.${CLS.resultBarPct}`);
    const countEl = bar.querySelector<HTMLElement>(`.${CLS.resultBarCount}`);

    if (fill) {
      fill.style.width = `${pct}%`;
      fillGroupSegments(fill, breakdown?.[key], groups);
    }
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (countEl) countEl.textContent = wrapper.dataset.quizType === "rank" ? "" : String(count);
  }
}

/**
 * Animate result bars entrance when slide becomes visible.
 */
export function animateResultBars(
  wrapper: HTMLElement,
  state: VoteState,
  breakdown?: Record<string, GroupCounts>,
  groups?: GroupDef[],
): void {
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const bars = wrapper.querySelectorAll<HTMLElement>(`.${CLS.resultBar}`);
  updateTotal(wrapper, state);

  let i = 0;
  for (const bar of bars) {
    const key = bar.dataset.option || "";
    const count = state.votes[key] || 0;
    const pct = barPercent(wrapper, count, state);

    const fill = bar.querySelector<HTMLElement>(`.${CLS.resultBarFill}`);
    const pctEl = bar.querySelector<HTMLElement>(`.${CLS.resultBarPct}`);
    const countEl = bar.querySelector<HTMLElement>(`.${CLS.resultBarCount}`);

    if (fill) {
      fillGroupSegments(fill, breakdown?.[key], groups);
      if (prefersReducedMotion) {
        fill.style.width = `${pct}%`;
      } else {
        fill.style.transitionDelay = `${i * 0.15}s`;
        requestAnimationFrame(() => {
          fill.style.width = `${pct}%`;
        });
      }
    }

    if (pctEl) pctEl.textContent = `${pct}%`;
    if (countEl) countEl.textContent = wrapper.dataset.quizType === "rank" ? "" : String(count);
    i++;
  }
}

/**
 * "N connected · M responded" under bars or a word cloud. The connected count
 * is a `CLS.online` span, which the plugin's online subscription keeps current.
 */
export function audienceLine(): DocumentFragment {
  return html`<span class="${CLS.online}">0</span> ${AUDIENCE_LABELS.connected} · <span class="${CLS.resultsResponded}">0</span> ${AUDIENCE_LABELS.responded}`;
}

/** Set the responded count in the line under results. */
export function updateTotal(wrapper: HTMLElement, state: VoteState): void {
  const el = wrapper.querySelector<HTMLElement>(`.${CLS.resultsResponded}`);
  if (el) el.textContent = String(state.total);
}

/**
 * Highlight the correct option once the slide's reveal fragment is shown.
 * Reveal.js marks shown fragments `visible`, also when navigating backwards.
 */
export function syncCorrectReveal(slide: HTMLElement): void {
  const marker = slide.querySelector(`.${CLS.revealCorrect}`);
  if (!marker) return;
  const revealed = marker.classList.contains("visible");
  for (const bar of slide.querySelectorAll<HTMLElement>(`.${CLS.resultBar}[data-correct="true"]`)) {
    bar.classList.toggle(CLS.resultBarCorrect, revealed);
  }
}
