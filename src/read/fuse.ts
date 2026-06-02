export interface RankedItem {
  id: string;
}

export interface FusedItem<T extends RankedItem> {
  item: T;
  score: number;
}

export function rrf<T extends RankedItem>(
  lists: T[][],
  k = 60,
): Array<FusedItem<T>> {
  const byId = new Map<string, FusedItem<T>>();

  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1;
      const existing = byId.get(item.id);
      const score = 1 / (k + rank);

      if (existing) {
        existing.score += score;
      } else {
        byId.set(item.id, { item, score });
      }
    });
  }

  return [...byId.values()].sort((a, b) => b.score - a.score);
}
