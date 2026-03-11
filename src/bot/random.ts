export type WeightedBucket<T> = { weight: number; value: T };

export function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randInt(min: number, max: number): number {
  return Math.floor(randFloat(min, max + 1));
}

export function pickWeighted<T>(buckets: WeightedBucket<T>[]): T {
  const total = buckets.reduce((s, b) => s + b.weight, 0);
  if (total <= 0) throw new Error("pickWeighted: total weight <= 0");
  let r = Math.random() * total;
  for (const b of buckets) {
    r -= b.weight;
    if (r <= 0) return b.value;
  }
  return buckets[buckets.length - 1]!.value;
}
