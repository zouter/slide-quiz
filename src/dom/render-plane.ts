import * as v from "valibot";
import type { VoteState, GroupDef, GroupCounts } from "../quiz-types";
import { JsonQuizOptionsSchema, PlaneAnswerSchema, planeAxes } from "../quiz-types";
import { html, type Child } from "./html";
import { audienceLine, renderGroupLegend, updateTotal } from "./render-results";
import { renderResultsQR } from "./render-results-qr";
import { CLS } from "./selectors";

/**
 * The plane of a `data-quiz-type="plane"` question: a square field crossed by
 * both axes, with the text of each axis end beside it. Results slides fill
 * its points container; question slides leave it empty while people answer.
 */
export function renderPlaneFigure(rawOptions: string | undefined): Child {
  const parsed = v.safeParse(JsonQuizOptionsSchema, rawOptions);
  const axes = planeAxes(parsed.success ? parsed.output : []);

  return html`
    <div class="sq-plane__figure">
      <span class="sq-plane__end sq-plane__end--top">${axes.top}</span>
      <div class="sq-plane__field">
        <span class="sq-plane__end sq-plane__end--left">${axes.left}</span>
        <span class="sq-plane__end sq-plane__end--right">${axes.right}</span>
        <div class="${CLS.planePoints}"></div>
      </div>
      <span class="sq-plane__end sq-plane__end--bottom">${axes.bottom}</span>
    </div>
  `;
}

/**
 * Inject the scatter of answers into a
 * `<section data-quiz-results data-quiz-type="plane">` slide.
 */
export async function renderPlane(
  slide: HTMLElement,
  quizUrl?: string,
  groups?: GroupDef[],
): Promise<void> {
  const quizId = slide.dataset.quizResults!;
  const question = slide.dataset.quizQuestion || "";

  const qrBlock = await renderResultsQR(quizUrl, slide);

  const fragment = html`
    <div class="${CLS.plane}" data-sq-quiz="${quizId}">
      ${question ? html`<h2 class="sq-plane__title">${question}</h2>` : null}
      ${renderGroupLegend(groups)}
      <div class="sq-results__body">
        <div class="sq-plane__main">
          ${renderPlaneFigure(slide.dataset.quizOptions)}
          <p class="${CLS.resultsTotal}">${audienceLine()}</p>
        </div>
        ${qrBlock}
      </div>
    </div>
  `;

  slide.appendChild(fragment);
}

type Breakdown = Record<string, GroupCounts>;

/** Update the points with the current vote state (no animation). */
export function updatePlane(wrapper: HTMLElement, state: VoteState, breakdown?: Breakdown, groups?: GroupDef[]): void {
  renderPoints(wrapper, state, false, breakdown, groups);
}

/** Animate the points in when the results slide becomes visible. */
export function animatePlane(wrapper: HTMLElement, state: VoteState, breakdown?: Breakdown, groups?: GroupDef[]): void {
  renderPoints(wrapper, state, true, breakdown, groups);
}

/**
 * The dots on one grid point: one per audience group present there, in the
 * group's colour, side by side; without groups, one dot for everyone.
 */
function pointDots(key: string, count: number, breakdown?: Breakdown, groups?: GroupDef[]) {
  if (!groups?.length) return [{ id: key, count, color: "" }];
  const counts = breakdown?.[key] ?? {};
  return [...groups.map((g) => [g.label, g.color]), ["", ""]]
    .filter(([label]) => (counts[label] || 0) > 0)
    .map(([label, color]) => ({ id: `${key}|${label}`, count: counts[label], color }));
}

/**
 * One dot per grid point that people chose (per audience group, when the
 * deck defines groups); a dot's area grows with the number of people on it.
 */
function renderPoints(
  wrapper: HTMLElement,
  state: VoteState,
  animate: boolean,
  breakdown?: Breakdown,
  groups?: GroupDef[],
): void {
  const container = wrapper.querySelector<HTMLElement>(`.${CLS.planePoints}`);
  if (!container) return;
  updateTotal(wrapper, state);

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shown = new Set<string>();
  let i = 0;
  for (const [key, count] of Object.entries(state.votes)) {
    if (count <= 0) continue;
    const parsed = v.safeParse(PlaneAnswerSchema, key);
    if (!parsed.success) continue;

    const dots = pointDots(key, count, breakdown, groups);
    dots.forEach(({ id, count: n, color }, j) => {
      shown.add(id);
      let dot = container.querySelector<HTMLElement>(`[data-point="${CSS.escape(id)}"]`);
      if (!dot) {
        dot = document.createElement("span");
        dot.className = CLS.planePoint;
        dot.dataset.point = id;
        dot.style.left = `${parsed.output.x * 100}%`;
        dot.style.top = `${(1 - parsed.output.y) * 100}%`;
        if (animate && !prefersReducedMotion) {
          dot.style.opacity = "0";
          dot.style.transitionDelay = `${Math.min(i * 0.04, 1.2)}s`;
          const el = dot;
          requestAnimationFrame(() => {
            el.style.opacity = "";
          });
        }
        container.appendChild(dot);
      }
      // Groups sharing a point sit side by side around it.
      dot.style.setProperty("--sq-plane-offset", String(j - (dots.length - 1) / 2));
      dot.style.setProperty("--sq-plane-scale", String(Math.sqrt(n)));
      if (color) dot.style.background = color;
      dot.title = String(n);
      i++;
    });
  }

  // A point nobody holds any more (someone moved theirs) disappears.
  for (const dot of container.querySelectorAll<HTMLElement>(`.${CLS.planePoint}`)) {
    if (!shown.has(dot.dataset.point || "")) dot.remove();
  }
}
