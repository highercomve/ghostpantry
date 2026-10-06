import type { FoodMatch } from "./foodSuggestions.ts";

export type TextEvidence = { label: string; phrase: string; fuzzy: boolean };
export type Recognition = {
  label: string | null;
  state: "supported" | "review" | "unknown";
  reason: string;
  suggestions: {
    label: string;
    source: "text + image" | "text" | "image" | "local example";
    score?: number;
  }[];
  evidence: TextEvidence[];
};
// Food words only. Brand names deliberately have no category mapping.
const ALIASES: Record<string, string[]> = {
  chicken: ["raw chicken"],
  steak: ["beef steaks", "beef steak"],
  fish: ["fresh fish"],
  "chili peppers": ["hot peppers"],
  "icing sugar": ["powdered sugar"],
  "french fries": ["frozen fries"],
  "frozen fish": ["frozen fish fillets"],
  "ready-made meals": ["frozen meals"],
  juice: ["fruit juice"],
  "dried herbs": ["hierbas secas"],
  broth: ["caldo", "stock"],
  "sliced deli meat": ["deli meat", "cold cuts", "fiambre"],
  "heavy cream": ["whipping cream", "double cream"],
  leftovers: ["leftover food", "sobras"],
  pasta: [
    "capellini",
    "fettuccine",
    "tagliatelle",
    "farfalle",
    "fusilli",
    "tallarines",
    "pastas",
  ],
  "rice noodles": [
    "rice pasta",
    "rice vermicelli",
    "fideos de arroz",
    "pasta de arroz",
    "noodles de arroz",
  ],
  "ramen noodles": ["ramen", "instant noodles", "fideos instantaneos"],
  "baby pasta": ["pasta para bebes", "pasta infantil"],
  "risotto rice": ["risotto", "arborio", "arroz para risotto"],
  rice: ["arroz"],
  eggs: ["huevos", "huevo", "eggs", "egg"],
  milk: ["leche", "latte"],
  cheese: ["queso", "formaggio"],
  yogurt: ["yoghurt", "yogur"],
  butter: ["mantequilla", "manteca"],
  flour: ["harina", "farina"],
  oats: ["avena"],
  lentils: ["lentejas"],
  chickpeas: ["garbanzos"],
  beans: ["porotos", "frijoles", "dry beans", "dried beans"],
  "canned tuna": ["atun en lata"],
  tuna: ["atun"],
  bread: ["pan", "pane"],
  "tomato sauce": ["salsa de tomate", "passata"],
  coffee: ["cafe"],
  tea: ["te", "tea bags"],
  sugar: ["azucar"],
  salt: ["sal"],
  "olive oil": ["aceite de oliva"],
  "cooking oil": ["aceite vegetal", "vegetable oil"],
};
export function normalizeFoodText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 6 || b.length < 6 || Math.abs(a.length - b.length) > 1)
    return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
export function foodTextEvidence(
  text: string,
  labels: string[],
): TextEvidence[] {
  const vocabulary = new Map(
    labels.map((label) => [normalizeFoodText(label), label]),
  );
  const phrases: { label: string; phrase: string; words: string[] }[] = [];
  for (const [canonical, label] of vocabulary) {
    for (const phrase of [canonical, ...(ALIASES[canonical] ?? [])])
      phrases.push({ label, phrase, words: phrase.split(" ") });
  }
  phrases.sort(
    (a, b) =>
      b.words.length - a.words.length || b.phrase.length - a.phrase.length,
  );
  const found = new Map<string, TextEvidence>();
  for (const line of text.slice(0, 16384).split("\n").slice(0, 256)) {
    const normalized = normalizeFoodText(line);
    if (
      /^(ingredients?|ingredientes?|nutrition|nutricion|contains|contiene|allergens?)\b/.test(
        normalized,
      )
    )
      continue;
    const words = normalized.split(" ").slice(0, 128),
      covered = new Set<number>();
    for (const candidate of phrases) {
      for (let i = 0; i <= words.length - candidate.words.length; i++) {
        const actual = words.slice(i, i + candidate.words.length);
        if (actual.some((_, offset) => covered.has(i + offset))) continue;
        const exact = actual.every(
          (word, offset) => word === candidate.words[offset],
        );
        // Fuzzy OCR is limited to one long word, never short food words or brands.
        const fuzzy =
          !exact &&
          candidate.words.length === 1 &&
          oneEdit(actual[0], candidate.words[0]);
        if (!exact && !fuzzy) continue;
        const previous = found.get(candidate.label);
        if (!previous || (previous.fuzzy && exact))
          found.set(candidate.label, {
            label: candidate.label,
            phrase: actual.join(" "),
            fuzzy,
          });
        actual.forEach((_, offset) => covered.add(i + offset));
      }
    }
  }
  return [...found.values()].slice(0, 32);
}
export function recognizeFood(
  text: string,
  labels: string[],
  matches: FoodMatch[],
  background = 1,
): Recognition {
  const evidence = foodTextEvidence(text, labels);
  const ranked = [...matches].sort(
    (a, b) => b.score + (b.adjustment ?? 0) - (a.score + (a.adjustment ?? 0)),
  );
  const first = ranked[0],
    second = ranked[1];
  const best = first ? first.score + (first.adjustment ?? 0) : -1;
  const strong =
    !!first &&
    best > background + 0.03 &&
    (!second || best - second.score - (second.adjustment ?? 0) >= 0.035);
  const suggestions: Recognition["suggestions"] = evidence.map((item) => {
    const visual = ranked.find((match) => match.label === item.label);
    return {
      label: item.label,
      source: visual && visual.score > background ? "text + image" : "text",
      score: visual?.score,
    };
  });
  for (const match of ranked.slice(0, 5))
    if (!suggestions.some((item) => item.label === match.label)) {
      suggestions.push({
        label: match.label,
        source: (match.adjustment ?? 0) > 0 ? "local example" : "image",
        score: match.score,
      });
    }
  if (evidence.length === 1 && !evidence[0].fuzzy) {
    const conflict = strong && first.label !== evidence[0].label;
    return {
      label: evidence[0].label,
      state: conflict ? "review" : "supported",
      reason: conflict
        ? "Text and image disagree. Confirm the package label."
        : "Food keyword found. Confirm before adding inventory.",
      suggestions,
      evidence,
    };
  }
  if (evidence.length > 0)
    return {
      label: null,
      state: "review",
      reason:
        "Several food words or uncertain OCR. Choose the actual package category.",
      suggestions,
      evidence,
    };
  if (strong)
    return {
      label: first.label,
      state: "review",
      reason: "Visual suggestion only. No readable food keyword; confirm it.",
      suggestions,
      evidence,
    };
  return {
    label: null,
    state: "unknown",
    reason: "Neither text nor image gives a clear category.",
    suggestions,
    evidence,
  };
}
