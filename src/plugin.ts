/**
 * Reveal.js Slide Quiz plugin core.
 *
 * Scans slides for data-quiz-id / data-quiz-results attributes,
 * injects DOM, listens to slidechanged, and bridges state from QuizManager.
 */
import * as v from "valibot";
import type { QuestionPayload, PresenterQuizManager, QuizErrorHandler } from "./quiz-manager";
import { getQuizPresenter, removeQuizPresenter } from "./quiz-manager";
import { QuizEndpointsSchema, JsonQuizOptionsSchema, QuizTypeSchema, GroupsConfigSchema, NamedVoterSchema } from "./quiz-types";
import type { GroupDef } from "./quiz-types";
import { updateVoterMarks } from "./dom/render-voters";
import { renderQR, displayUrl } from "./dom/render-qr";
import { animateCount } from "./dom/animate";
import { renderQuestion, questionHint } from "./dom/render-question";
import { renderResults, updateResultBars, animateResultBars, syncCorrectReveal } from "./dom/render-results";
import { renderWordCloud, updateWordCloud, animateWordCloud } from "./dom/render-wordcloud";
import { renderPlane, updatePlane, animatePlane } from "./dom/render-plane";
import {
  CLS,
  findWordcloud,
  findPlane,
  findAllPlanes,
  findResults,
  findAllOnline,
  findAllAnswered,
  findAllWordclouds,
  findAllResults,
  findAllInjected,
} from "./dom/selectors";

export const SlideQuizConfigSchema = v.object({
  wsUrl: v.pipe(v.string(), v.minLength(1)),
  quizGroupId: v.pipe(v.string(), v.minLength(1)),
  quizUrl: v.optional(v.string()),
  endpoints: v.optional(v.partial(QuizEndpointsSchema)),
  titleText: v.optional(v.string()),
  hintText: v.optional(v.string()),
  /** Audience groups: a question asked once whose answer splits all results by group. */
  groups: v.optional(GroupsConfigSchema),
  /** Voters (e.g. the speakers) shown by portrait on the results instead of counted */
  voters: v.optional(v.array(NamedVoterSchema)),
  /** Receives every error the engine detects. Wire to your own monitoring. */
  onError: v.optional(v.custom<QuizErrorHandler>((x) => typeof x === "function")),
});

export type SlideQuizConfig = v.InferOutput<typeof SlideQuizConfigSchema>;

// Minimal Reveal.js API surface we need (avoids hard dep on reveal.js types)
interface RevealApi {
  getConfig(): Record<string, unknown>;
  getRevealElement(): HTMLElement;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
  sync(): void;
}

/**
 * Add the deck's accent colour to the audience page URL, so the page matches
 * the slides. The participant widget applies it only if it is a valid colour.
 */
function withAccent(quizUrl: string | undefined, accent: string): string | undefined {
  if (!quizUrl || !accent) return quizUrl;
  const url = new URL(quizUrl, location.href);
  url.searchParams.set("accent", accent);
  return url.toString();
}

/** The audience groups results are split by; a named voter picked as a group shows by portrait instead. */
function countedGroups(config: SlideQuizConfig): GroupDef[] | undefined {
  const voters = new Set(config.voters?.map((voter) => voter.sessionId));
  return config.groups?.options.filter((group) => !voters.has(group.label));
}

export function createPlugin() {
  let deck: RevealApi | null = null;
  let config: SlideQuizConfig;
  let manager: PresenterQuizManager | null = null;
  const unsubs: (() => void)[] = [];

  // Track which results slides have been animated
  const animatedResults = new Set<string>();

  // ── Event Handlers ──

  function onSlideChanged(event: unknown) {
    if (!manager) return;
    const ev = event as Record<string, unknown>;
    const slide = ev.currentSlide;
    if (!(slide instanceof HTMLElement)) return;
    syncCorrectReveal(slide);

    // Quiz question slide — activate it
    const quizId = slide.dataset.quizId;
    if (quizId) {
      manager.setActiveQuestion(quizId);
    }

    // Quiz results slide — activate + animate on first visit
    const resultsId = slide.dataset.quizResults;
    if (resultsId) {
      manager.setActiveQuestion(resultsId);
    }

    // Any other slide may keep a question open (`data-quiz-open`), so the
    // audience can still answer, for instance while its section is presented.
    const openId = slide.dataset.quizOpen;
    if (!quizId && !resultsId && openId) {
      manager.setActiveQuestion(openId);
    }

    // Non-quiz slide — clear active question so participants see waiting state
    if (!quizId && !resultsId && !openId) {
      manager.clearActiveQuestion();
    }
    if (resultsId && !animatedResults.has(resultsId)) {
      animatedResults.add(resultsId);
      const state = manager.getQuizState(resultsId);
      const breakdown = manager.getGroupBreakdown(resultsId);
      const groups = countedGroups(config);
      const wordcloud = findWordcloud(slide, resultsId);
      const plane = findPlane(slide, resultsId);
      const voterAnswers = manager.store.voterAnswers.get()[resultsId];
      if (wordcloud) {
        animateWordCloud(wordcloud, state);
      } else if (plane) {
        animatePlane(plane, state, breakdown, groups);
        updateVoterMarks(plane, config.voters, voterAnswers);
      } else {
        const bars = findResults(slide, resultsId);
        if (bars) {
          animateResultBars(bars, state, breakdown, groups);
          updateVoterMarks(bars, config.voters, voterAnswers);
        }
      }
    }
  }

  function onFragment(event: unknown) {
    const fragment = (event as { fragment?: unknown }).fragment;
    const slide = fragment instanceof Element ? fragment.closest("section") : null;
    if (slide) syncCorrectReveal(slide);
  }

  // ── Plugin Interface ──

  return {
    id: "slide-quiz",

    init: async (reveal: RevealApi): Promise<void> => {
      deck = reveal;
      const raw = deck.getConfig().slideQuiz ?? {};
      const parsed = v.safeParse(SlideQuizConfigSchema, raw);
      if (!parsed.success) {
        // Name the failing fields, and show the error where the quiz should be
        const flat = v.flatten(parsed.issues);
        const fields = Object.entries(flat.nested ?? {}).map(([key, msgs]) => `${key}: ${msgs?.[0]}`);
        const message =
          `Invalid slideQuiz config (${fields.join("; ") || flat.root?.[0] || "not an object"}). ` +
          "Set it in Reveal.initialize({ slideQuiz: { wsUrl, quizGroupId, quizUrl } }).";
        console.warn(`[slide-quiz] ${message}`);
        for (const slide of deck.getRevealElement().querySelectorAll<HTMLElement>(
          "section[data-quiz-id], section[data-quiz-results]",
        )) {
          const box = document.createElement("div");
          box.className = "sq-config-error";
          box.setAttribute("data-sq-injected", "");
          box.textContent = `slide-quiz: ${message}`;
          slide.appendChild(box);
        }
        return;
      }
      config = parsed.output;

      // Initialize QuizManager in presenter mode
      manager = getQuizPresenter({
        wsUrl: config.wsUrl,
        quizGroupId: config.quizGroupId,
        endpoints: config.endpoints,
        onError: config.onError,
      });

      const revealEl = deck.getRevealElement();
      const quizUrl = withAccent(
        config.quizUrl,
        getComputedStyle(revealEl).getPropertyValue("--sq-accent").trim(),
      );

      // Inject DOM into quiz question slides
      const questionSlides = revealEl.querySelectorAll<HTMLElement>(
        "section[data-quiz-id]",
      );
      const renderPromises: Promise<void>[] = [];
      const allQuestions: QuestionPayload[] = [];

      // The audience-group question has no slide of its own; it is asked
      // first, on the slides that keep it open.
      if (config.voters) manager.setNamedVoters(config.voters.map((voter) => voter.sessionId));
      if (config.groups) {
        const { quizId, question, options } = config.groups;
        manager.setGroupQuiz(quizId);
        allQuestions.push({ quizId, question, type: "choice", options: options.map(({ label, text }) => ({ label, text })) });
      }

      // A join QR code anywhere in the deck, e.g. on the opening slides.
      for (const el of revealEl.querySelectorAll<HTMLElement>("[data-quiz-join]")) {
        if (!quizUrl) break;
        const size = Number(el.dataset.quizJoin) || 200;
        renderPromises.push(
          renderQR(quizUrl, size, el.closest("section") ?? el)
            .then((img) => {
              const url = document.createElement("p");
              url.className = "sq-join__url";
              url.textContent = displayUrl(quizUrl);
              el.classList.add(CLS.join);
              el.setAttribute("data-sq-injected", "");
              el.replaceChildren(img, url);
            })
            .catch((err) => console.warn("[slide-quiz] Failed to render join QR code:", err)),
        );
      }
      for (const slide of questionSlides) {
        const p = renderQuestion(slide, quizUrl, config.titleText, config.hintText).catch(
          (err) => console.warn("[slide-quiz] Failed to render question slide:", err),
        );
        renderPromises.push(p);

        // Extract question data for broadcasting to participants
        const quizId = slide.dataset.quizId!;
        const question = slide.dataset.quizQuestion || "";
        const quizType = v.parse(QuizTypeSchema, slide.dataset.quizType);

        const hint = questionHint(slide, quizType, config.hintText);
        const own = (quizType === "multi" || quizType === "thumbs") && slide.dataset.quizOwn !== undefined ? true : undefined;

        if (quizType === "text") {
          allQuestions.push({ quizId, question, type: quizType, options: [], hint });
        } else {
          const optionsParsed = v.safeParse(
            JsonQuizOptionsSchema,
            slide.dataset.quizOptions,
          );
          if (optionsParsed.success) {
            allQuestions.push({
              quizId,
              question,
              type: quizType,
              options: optionsParsed.output.map((o) => ({
                label: o.label,
                text: o.text,
              })),
              hint,
              own,
            });
          }
        }
      }

      // Inject DOM into quiz results slides
      // Also extract questions from results-only slides (no matching question slide)
      const knownQuizIds = new Set(allQuestions.map(q => q.quizId));

      for (const slide of revealEl.querySelectorAll<HTMLElement>(
        "section[data-quiz-results]",
      )) {
        const resultType = v.parse(QuizTypeSchema, slide.dataset.quizType);
        if (resultType === "text") {
          renderPromises.push(
            renderWordCloud(slide, quizUrl).catch(
              (err) => console.warn("[slide-quiz] Failed to render word cloud slide:", err),
            ),
          );
        } else if (resultType === "plane") {
          renderPromises.push(
            renderPlane(slide, quizUrl, countedGroups(config)).catch(
              (err) => console.warn("[slide-quiz] Failed to render plane slide:", err),
            ),
          );
        } else {
          renderPromises.push(
            renderResults(slide, quizUrl, countedGroups(config)).catch(
              (err) => console.warn("[slide-quiz] Failed to render results slide:", err),
            ),
          );
        }

        // Register question from results slide if no matching question slide exists
        const quizId = slide.dataset.quizResults!;
        if (!knownQuizIds.has(quizId)) {
          const question = slide.dataset.quizQuestion || "";
          if (resultType === "text") {
            allQuestions.push({ quizId, question, type: resultType, options: [] });
          } else {
            const optionsParsed = v.safeParse(
              JsonQuizOptionsSchema,
              slide.dataset.quizOptions,
            );
            if (optionsParsed.success) {
              allQuestions.push({
                quizId,
                question,
                type: resultType,
                options: optionsParsed.output.map((o) => ({
                  label: o.label,
                  text: o.text,
                })),
                own: (resultType === "multi" || resultType === "thumbs") && slide.dataset.quizOwn !== undefined ? true : undefined,
              });
            }
          }
          knownQuizIds.add(quizId);
        }
      }

      // Pass extracted questions to manager for sync broadcast
      manager.setQuestions(allQuestions);

      // Wait for all QR codes to render (individual failures already caught above)
      await Promise.all(renderPromises);

      // Subscribe to store changes
      unsubs.push(
        manager.store.online.subscribe(count => {
          for (const el of findAllOnline(revealEl)) animateCount(el, count);
        }),
        manager.store.results.subscribe(results => {
          for (const [quizId, quizState] of Object.entries(results)) {
            for (const el of findAllAnswered(revealEl, quizId)) animateCount(el, quizState.total);
            if (animatedResults.has(quizId)) {
              // A changed group answer changes every quiz's split, so all are redrawn.
              const breakdown = manager!.getGroupBreakdown(quizId);
              const groups = countedGroups(config);
              for (const el of findAllWordclouds(revealEl, quizId)) updateWordCloud(el, quizState);
              for (const el of findAllPlanes(revealEl, quizId)) updatePlane(el, quizState, breakdown, groups);
              for (const el of findAllResults(revealEl, quizId)) updateResultBars(el, quizState, breakdown, groups);
            }
          }
        }),
        manager.store.voterAnswers.subscribe((answers) => {
          for (const [quizId, quizAnswers] of Object.entries(answers)) {
            if (!animatedResults.has(quizId)) continue;
            for (const el of [...findAllResults(revealEl, quizId), ...findAllPlanes(revealEl, quizId)]) {
              updateVoterMarks(el, config.voters, quizAnswers);
            }
          }
        }),
        manager.store.syncError.subscribe(() => renderErrorBanner()),
        manager.store.connectionError.subscribe(() => renderErrorBanner()),
        manager.store.audienceWarning.subscribe(() => renderErrorBanner()),
      );

      // The window the presenter presents from takes control; every other
      // window then stops moving the phones. A small dot that names itself on
      // hover, never focused, like the banner.
      const controlButton = document.createElement("button");
      controlButton.className = CLS.control;
      controlButton.setAttribute("data-sq-injected", "");
      controlButton.tabIndex = -1;
      controlButton.addEventListener("mousedown", (e) => e.preventDefault());
      controlButton.addEventListener("click", () => manager?.takeControl());
      revealEl.appendChild(controlButton);
      unsubs.push(
        manager.store.control.subscribe((state) => {
          controlButton.dataset.state = state;
          controlButton.textContent = state === "mine" ? "In control" : "Take control";
          controlButton.title =
            state === "mine" ? "Phones follow this window"
            : state === "other" ? "Another window moves the phones; click to take over"
            : "Make this the only window that moves the phones";
        }),
      );

      // Answers are kept across reloads of the presenter's window; this
      // forgets them all, after asking. Small, beside the control dot.
      const resetButton = document.createElement("button");
      resetButton.className = CLS.reset;
      resetButton.setAttribute("data-sq-injected", "");
      resetButton.tabIndex = -1;
      resetButton.textContent = "\u21BA";
      resetButton.title = "Reset all quiz answers";
      resetButton.addEventListener("mousedown", (e) => e.preventDefault());
      resetButton.addEventListener("click", () => {
        if (window.confirm("Reset all quiz answers? Phones can then answer every question again.")) manager?.resetResults();
      });
      revealEl.appendChild(resetButton);

      // Connection problems come first: without a WebSocket nothing else matters.
      // The slides are on the projector, so the banner starts as a small pill
      // and shows the full message only when the presenter clicks it.
      function renderErrorBanner() {
        if (!manager) return;
        const error =
          manager.store.connectionError.get() ??
          manager.store.syncError.get() ??
          manager.store.audienceWarning.get();
        let banner = revealEl.querySelector<HTMLElement>(`.${CLS.syncError}`);
        if (error) {
          if (!banner) {
            banner = document.createElement("button");
            banner.className = `${CLS.syncError} ${CLS.syncErrorCompact}`;
            banner.setAttribute("data-sq-injected", "");
            // Never keep focus: a focused button swallows Reveal's arrow keys
            banner.tabIndex = -1;
            banner.addEventListener("mousedown", (e) => e.preventDefault());
            banner.addEventListener("click", () => {
              banner!.classList.toggle(CLS.syncErrorCompact);
              banner!.blur();
              renderErrorBanner();
            });
            revealEl.appendChild(banner);
          }
          banner.textContent = banner.classList.contains(CLS.syncErrorCompact)
            ? "⚠ Live quiz problem · details"
            : `⚠ ${error}`;
          banner.title = error;
          banner.style.display = "";
        } else if (banner) {
          banner.style.display = "none";
        }
      }

      // Listen for slide changes; "ready" covers the slide the deck opens on.
      deck.on("ready", onSlideChanged);
      deck.on("slidechanged", onSlideChanged);
      deck.on("fragmentshown", onFragment);
      deck.on("fragmenthidden", onFragment);
    },

    destroy: () => {
      if (!deck) return;

      deck.off("ready", onSlideChanged);
      deck.off("slidechanged", onSlideChanged);
      deck.off("fragmentshown", onFragment);
      deck.off("fragmenthidden", onFragment);

      for (const unsub of unsubs) unsub();
      unsubs.length = 0;

      // Disconnect WebSocket and remove from singleton cache
      if (manager) {
        removeQuizPresenter(config.quizGroupId);
        manager.disconnect();
        manager = null;
      }

      // Remove injected DOM
      const revealEl = deck.getRevealElement();
      for (const el of findAllInjected(revealEl)) {
        el.remove();
      }

      animatedResults.clear();
      deck = null;
    },
  };
}
