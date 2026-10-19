import * as v from "valibot";
import type { NamedVoter } from "../quiz-types";
import { MultiAnswerSchema, PlaneAnswerSchema, RankAnswerSchema } from "../quiz-types";
import { CLS } from "./selectors";

/** A named voter's portrait, or their initial; a rank answer adds the place they gave. */
function voterMark(voter: NamedVoter, place?: number): HTMLElement {
  const mark = document.createElement("span");
  mark.className = CLS.voter;
  mark.title = voter.name;
  if (voter.photo) {
    const img = document.createElement("img");
    img.src = voter.photo;
    img.alt = voter.name;
    mark.append(img);
  } else {
    mark.textContent = voter.name.slice(0, 1);
  }
  if (place !== undefined) {
    const badge = document.createElement("b");
    badge.textContent = String(place);
    mark.append(badge);
  }
  return mark;
}

/** The options a named voter's answer picks (with their place, for a ranking). */
function picks(quizType: string | undefined, answer: string): Map<string, number | undefined> {
  if (quizType === "multi") {
    const parsed = v.safeParse(MultiAnswerSchema, answer);
    return new Map((parsed.success ? parsed.output : []).map((label) => [label, undefined]));
  }
  if (quizType === "rank") {
    const parsed = v.safeParse(RankAnswerSchema, answer);
    return new Map((parsed.success ? parsed.output : []).map((label, i) => [label, i + 1]));
  }
  return new Map([[answer, undefined]]);
}

/**
 * Show named voters on a results wrapper: beside each bar they picked (with
 * their place on rank questions), or at their point on a plane.
 */
export function updateVoterMarks(
  wrapper: HTMLElement,
  voters: NamedVoter[] | undefined,
  answers: Record<string, string> | undefined,
): void {
  if (!voters?.length) return;
  const answered = voters.filter((voter) => answers?.[voter.sessionId]);

  const points = wrapper.querySelector<HTMLElement>(`.${CLS.planePoints}`);
  if (points) {
    points.querySelectorAll(`.${CLS.voter}`).forEach((el) => el.remove());
    for (const voter of answered) {
      const parsed = v.safeParse(PlaneAnswerSchema, answers![voter.sessionId]);
      if (!parsed.success) continue;
      const mark = voterMark(voter);
      mark.style.left = `${parsed.output.x * 100}%`;
      mark.style.top = `${(1 - parsed.output.y) * 100}%`;
      points.append(mark);
    }
    return;
  }

  for (const bar of wrapper.querySelectorAll<HTMLElement>(`.${CLS.resultBar}`)) {
    let marks = bar.querySelector<HTMLElement>(`.${CLS.resultBarVoters}`);
    if (!marks) {
      marks = document.createElement("div");
      marks.className = CLS.resultBarVoters;
      bar.append(marks);
    }
    const label = bar.dataset.option || "";
    marks.replaceChildren(
      ...answered.flatMap((voter) => {
        const chosen = picks(wrapper.dataset.quizType, answers![voter.sessionId]);
        return chosen.has(label) ? [voterMark(voter, chosen.get(label))] : [];
      }),
    );
  }
}
