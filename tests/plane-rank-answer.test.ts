import { describe, it, expect } from "vitest";
import * as v from "valibot";
import { PlaneAnswerSchema, encodePlaneAnswer, planeAxes, RankAnswerSchema, encodeRankAnswer } from "../src/quiz-types";

describe("PlaneAnswerSchema pipeline", () => {
  it("decodes an x,y answer into a point", () => {
    expect(v.parse(PlaneAnswerSchema, "0.80,0.25")).toEqual({ x: 0.8, y: 0.25 });
  });

  it("rejects points outside the plane and malformed answers", () => {
    for (const answer of ["1.50,0.20", "-0.1,0.5", "0.5", "a,b", '["A"]', "0.5,0.5,0.5"]) {
      expect(v.safeParse(PlaneAnswerSchema, answer).success).toBe(false);
    }
  });
});

describe("encodePlaneAnswer", () => {
  it("snaps to the grid and clamps to the plane", () => {
    expect(encodePlaneAnswer(0.811, -0.2)).toBe("0.82,0.00");
    expect(encodePlaneAnswer(1.4, 0.499)).toBe("1.00,0.50");
  });

  it("round-trips through PlaneAnswerSchema", () => {
    expect(v.parse(PlaneAnswerSchema, encodePlaneAnswer(0.3, 0.7))).toEqual({ x: 0.3, y: 0.7 });
  });
});

describe("planeAxes", () => {
  it("reads the axis ends by label, whatever their order", () => {
    const options = [
      { label: "top", text: "Love" },
      { label: "left", text: "No" },
      { label: "right", text: "Yes" },
    ];
    expect(planeAxes(options)).toEqual({ left: "No", right: "Yes", bottom: "", top: "Love" });
  });
});

describe("RankAnswerSchema pipeline", () => {
  it("keeps the order of the labels", () => {
    expect(v.parse(RankAnswerSchema, encodeRankAnswer(["I", "D", "T"]))).toEqual(["I", "D", "T"]);
  });

  it("rejects repeated labels and single items", () => {
    expect(v.safeParse(RankAnswerSchema, '["I","I"]').success).toBe(false);
    expect(v.safeParse(RankAnswerSchema, '["I"]').success).toBe(false);
  });
});
