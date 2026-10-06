import test from "node:test";
import assert from "node:assert/strict";
import { splitSuggestions } from "../src/foodSuggestions.ts";

test("egg photo has one stronger label, not five detected foods", () => {
  const matches = [
    { label: "eggs", score: 0.749 },
    { label: "yogurt", score: 0.667 },
    { label: "milk", score: 0.659 },
    { label: "rice", score: 0.654 },
    { label: "cheese", score: 0.647 },
  ];
  const result = splitSuggestions(matches, 0.68);
  assert.deepEqual(
    result.stronger.map((match) => match.label),
    ["eggs"],
  );
  assert.equal(result.alternatives.length, 4);
  assert.equal(matches.length, 5);
});

test("nearby food matches remain available on crowded shelves", () => {
  const result = splitSuggestions(
    [
      { label: "pasta", score: 0.73 },
      { label: "rice noodles", score: 0.71 },
      { label: "risotto rice", score: 0.7 },
      { label: "yogurt", score: 0.62 },
    ],
    0.65,
  );
  assert.equal(result.stronger.length, 3);
  assert.equal(result.alternatives.length, 1);
});

test("background winning yields no stronger food suggestion", () => {
  const result = splitSuggestions([{ label: "pasta", score: 0.627 }], 0.681);
  assert.equal(result.stronger.length, 0);
  assert.equal(result.alternatives.length, 1);
  assert.deepEqual(splitSuggestions([]), { stronger: [], alternatives: [] });
});

test("local corrections affect the grouping without changing cosine scores", () => {
  const matches = [
    { label: "pasta", score: 0.73, adjustment: -0.12 },
    { label: "rice noodles", score: 0.69, adjustment: 0.12 },
  ];
  assert.deepEqual(
    splitSuggestions(matches, 0.65).stronger.map((match) => match.label),
    ["rice noodles"],
  );
  assert.equal(matches[1].score, 0.69);
});
