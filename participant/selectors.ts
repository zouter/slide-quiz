/**
 * Shared class-name constants for the participant widget.
 *
 * Only classes used in both DOM construction and querySelector/classList
 * calls need to be here. Template-only classes are fine as raw strings.
 */

export const CLS = {
  participant: "sq-participant",
  sectionHidden: "sq-participant__section--hidden",
  status: "sq-participant__status",
  statusError: "sq-participant__status--error",
  input: "sq-participant__input",
  submit: "sq-participant__submit",
  btn: "sq-participant__btn",
  btnText: "sq-participant__btn-text",
  btnSelected: "sq-participant__btn--selected",
  btnFaded: "sq-participant__btn--faded",
  planeField: "sq-participant__plane-field",
  planeMarker: "sq-participant__plane-marker",
  rankList: "sq-participant__rank",
  rankItem: "sq-participant__rank-item",
  thumbsList: "sq-participant__thumbs",
  thumb: "sq-participant__thumb",
} as const;
