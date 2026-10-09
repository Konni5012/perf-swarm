import { randomInt } from "node:crypto";
import type { ModelWeight } from "./types.js";

export function parseMix(input: string): ModelWeight[] {
  const mix = input.split(",").map((part) => {
    const index = part.lastIndexOf("=");
    if (index < 1) throw new Error("Model mix must be model=weight,model=weight (weights may be fractions).");
    const model = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    const fraction = raw.split("/");
    const weight = fraction.length === 2 ? Number(fraction[0]) / Number(fraction[1]) : Number(raw);
    if (!model || !Number.isFinite(weight) || weight <= 0 || fraction.length > 2) {
      throw new Error(`Invalid model weight: ${part}`);
    }
    return { model, weight };
  });
  if (new Set(mix.map((item) => item.model)).size !== mix.length) throw new Error("Use each model only once in the mix.");
  return mix;
}

/** Largest-remainder allocation preserves the pool size, then Fisher-Yates shuffles IDs. */
export function assignModels(count: number, mix: ModelWeight[], fallback: string, pick = randomInt): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error("Worker count must be 1–10000.");
  if (!mix.length) return Array<string>(count).fill(fallback);
  if (mix.some((item) => !Number.isFinite(item.weight) || item.weight <= 0)) throw new Error("Model weights must be positive.");
  const total = mix.reduce((sum, item) => sum + item.weight, 0);
  if (!Number.isFinite(total)) throw new Error("Model weights are too large.");
  const allocations = mix.map((item, index) => {
    const exact = count * (item.weight / total);
    return { ...item, index, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  const remaining = count - allocations.reduce((sum, item) => sum + item.count, 0);
  const ranked = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i++) ranked[i]!.count++;
  const models = allocations.flatMap((item) => Array<string>(item.count).fill(item.model));
  for (let i = models.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [models[i], models[j]] = [models[j]!, models[i]!];
  }
  return models;
}

export function workerIds(count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error("Worker count must be 1–10000.");
  const numbers = Array.from({ length: 10_000 }, (_, i) => i);
  // Partial shuffle avoids collision retries even at the maximum pool size.
  for (let i = 0; i < count; i++) {
    const j = i + randomInt(numbers.length - i);
    [numbers[i], numbers[j]] = [numbers[j]!, numbers[i]!];
  }
  return numbers.slice(0, count).map((id) => `worker-${String(id).padStart(4, "0")}`);
}

const names = ["Mica", "Nori", "Pico", "Sable", "Taro", "Vela", "Kite", "Lumen", "Oxo", "Rook", "Moss", "Zeno"];
export function workerNames(count: number, pick = randomInt): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error("Worker count must be 1–10000.");
  const shuffled = [...names];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = pick(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
  return Array.from({ length: count }, (_, i) => `${shuffled[i % shuffled.length]}${i >= shuffled.length ? "-" + (Math.floor(i / shuffled.length) + 1) : ""}`);
}
