// Reciprocal Rank Fusion (RRF) — merge ranked lexical + semantic result lists
// into one fused, de-duplicated ranking.
//
// Source: clowder-architecture-design.md §4.5 / §7.6 —
//   "RRF 融合公式：score(d) = Σ 1/(k + rank_i(d))，k=60（标准 RRF 常数）"
//   "去重：同一 anchor 在 lexical 和 semantic 都出现时，RRF 累加两路 score，
//    只保留一条。"
//
// Pattern from Clowder hybrid-search.ts rrfFuse (per-list 1/(k+rank) accumulation
// into a shared map), re-authored to take N labelled lists and a stable tiebreak.

// Standard RRF constant. Source: §4.5 "k=60（标准 RRF 常数）" — Cormack et al.
// 2009 recommend k=60 to damp the influence of very high ranks.
export const RRF_K = 60;

/** A single ranked list of anchors (best first). */
export interface RankedList {
  anchors: readonly string[];
}

/** A fused result: an anchor and its accumulated RRF score. */
export interface FusedResult {
  anchor: string;
  score: number;
}

/**
 * fuseByRrf — fuse any number of ranked anchor lists by Reciprocal Rank Fusion.
 *
 * For each list, an anchor at zero-based rank `i` contributes `1/(k + i + 1)`.
 * Contributions across lists accumulate per anchor (so an anchor appearing in
 * both lexical and semantic results ranks above one in a single list). The
 * result is sorted by descending score; ties break on first-seen order to keep
 * fusion deterministic.
 *
 * @param lists ranked lists to fuse (each best-first, de-duplicated internally)
 * @param k     RRF constant (defaults to RRF_K = 60)
 */
export function fuseByRrf(lists: readonly RankedList[], k: number = RRF_K): FusedResult[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;

  for (const list of lists) {
    for (let i = 0; i < list.anchors.length; i++) {
      const anchor = list.anchors[i];
      const contribution = 1 / (k + i + 1);
      scores.set(anchor, (scores.get(anchor) ?? 0) + contribution);
      if (!firstSeen.has(anchor)) {
        firstSeen.set(anchor, order++);
      }
    }
  }

  return [...scores.entries()]
    .map(([anchor, score]) => ({ anchor, score }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      // Deterministic tiebreak: earlier first-seen anchor wins.
      return (firstSeen.get(a.anchor) ?? 0) - (firstSeen.get(b.anchor) ?? 0);
    });
}
