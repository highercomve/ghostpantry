import test from "node:test";
import assert from "node:assert/strict";
import { foodTextEvidence, recognizeFood } from "../src/foodRecognition.ts";
const labels = [
  "pasta",
  "rice",
  "rice noodles",
  "risotto rice",
  "ramen noodles",
  "eggs",
  "milk",
];
test("food aliases identify the variant without assigning a category to brands", () => {
  assert.deepEqual(
    foodTextEvidence("Lucchetti Capellini", labels).map((x) => x.label),
    ["pasta"],
  );
  assert.deepEqual(foodTextEvidence("Lucchetti", labels), []);
  assert.deepEqual(
    foodTextEvidence("Rice pasta", labels).map((x) => x.label),
    ["rice noodles"],
  );
  assert.deepEqual(
    foodTextEvidence("FIDEOS DE ARROZ", labels).map((x) => x.label),
    ["rice noodles"],
  );
  assert.deepEqual(
    foodTextEvidence("Risotto rice", labels).map((x) => x.label),
    ["risotto rice"],
  );
});
test("word boundaries and ingredient headings prevent obvious false food matches", () => {
  assert.deepEqual(foodTextEvidence("breadth milkshake", labels), []);
  assert.deepEqual(foodTextEvidence("Ingredients: milk and eggs", labels), []);
});
test("uncertain OCR spelling stays subject to review", () => {
  const result = recognizeFood("Capellinl", labels, [], 0.7);
  assert.equal(result.evidence[0].fuzzy, true);
  assert.equal(result.state, "review");
  assert.equal(result.label, null);
});
test("weak text and visual evidence yields unknown, not a mandatory top label", () => {
  assert.equal(
    recognizeFood(
      "Lucchetti",
      labels,
      [
        { label: "milk", score: 0.65 },
        { label: "eggs", score: 0.64 },
      ],
      0.7,
    ).state,
    "unknown",
  );
});
test("clear keywords plus matching images support a label; disagreement is shown", () => {
  const matches = [
    { label: "pasta", score: 0.8 },
    { label: "milk", score: 0.65 },
  ];
  const good = recognizeFood("Capellini", labels, matches, 0.7);
  assert.equal(good.label, "pasta");
  assert.equal(good.state, "supported");
  assert.equal(good.suggestions[0].source, "text + image");
  const conflicting = recognizeFood("Rice pasta", labels, matches, 0.7);
  assert.equal(conflicting.state, "review");
  assert.equal(conflicting.label, "rice noodles");
});
test("multiple products in an overlapping crop do not become one confirmed package", () => {
  const result = recognizeFood("Pasta\nMilk", labels, [], 0.5);
  assert.equal(result.state, "review");
  assert.equal(result.label, null);
  assert.equal(result.evidence.length, 2);
});

test("household food aliases reuse the saved canonical categories", () => {
  const labels = [
    "chicken",
    "icing sugar",
    "french fries",
    "frozen fish",
    "cooking oil",
    "tea",
    "broth",
  ];
  const evidence = foodTextEvidence(
    "Raw chicken\nPowdered sugar\nFrozen fries\nFrozen fish fillets\nVegetable oil\nTea bags\nCaldo",
    labels,
  );
  assert.deepEqual(
    new Set(evidence.map((item) => item.label)),
    new Set(labels),
  );
});

test("phone rice and pasta variants offer a broad category for review", () => {
  const rice = [
    { label: "rice", score: 0.743 },
    { label: "risotto rice", score: 0.736 },
    { label: "basmati rice", score: 0.736 },
    { label: "rice flour", score: 0.723 },
    { label: "brown rice", score: 0.722 },
  ];
  const pasta = [
    { label: "macaroni", score: 0.741 },
    { label: "pasta", score: 0.735 },
    { label: "potato chips", score: 0.726 },
    { label: "baby pasta", score: 0.719 },
    { label: "corn flakes", score: 0.711 },
  ];
  for (const [category, matches] of [
    ["rice", rice],
    ["pasta", pasta],
  ] as const) {
    const result = recognizeFood(
      "",
      matches.map((x) => x.label),
      [...matches],
      0.69,
    );
    assert.equal(result.label, category);
    assert.equal(result.state, "review");
    assert.match(result.reason, /exact variety is uncertain/);
    assert.equal(
      recognizeFood(
        "",
        matches.map((x) => x.label),
        [...matches],
        0.8,
      ).state,
      "unknown",
    );
  }
});

test("rice noodles and rice flour do not form a rice-grain consensus", () => {
  const matches = [
    { label: "rice", score: 0.74 },
    { label: "rice noodles", score: 0.73 },
    { label: "rice flour", score: 0.72 },
  ];
  assert.equal(
    recognizeFood(
      "",
      matches.map((x) => x.label),
      matches,
      0.69,
    ).state,
    "unknown",
  );
  const disagreement = recognizeFood(
    "rice pasta",
    ["pasta", "rice noodles"],
    [
      { label: "pasta", score: 0.8 },
      { label: "rice noodles", score: 0.6 },
    ],
    0.7,
  );
  assert.equal(disagreement.state, "review");
});

test("compatible text and image varieties do not create a false conflict", () => {
  const result = recognizeFood(
    "Capellini",
    ["pasta", "spaghetti", "milk"],
    [
      { label: "spaghetti", score: 0.8 },
      { label: "milk", score: 0.6 },
    ],
    0.7,
  );
  assert.equal(result.label, "pasta");
  assert.equal(result.state, "supported");
});

test("family fallback does not promote an explicitly rejected parent", () => {
  const matches = [
    { label: "risotto rice", score: 0.74 },
    { label: "basmati rice", score: 0.735 },
    { label: "brown rice", score: 0.73 },
    { label: "rice", score: 0.73, adjustment: -0.12 },
  ];
  const result = recognizeFood(
    "",
    ["rice", ...matches.map((x) => x.label)],
    matches,
    0.69,
  );
  assert.equal(result.state, "unknown");
});
