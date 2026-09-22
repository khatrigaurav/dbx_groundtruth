"""Pure statistics for rater agreement and judge-vs-ground-truth quality.

No DB or MLflow imports — stdlib only — so this module is unit-testable in isolation and
reused by metrics_service. Every function takes plain numbers/lists and returns plain values
(or None when a metric is mathematically undefined for the given data).

Conventions:
  * Binary labels are 1 = pass, 0 = fail.
  * "gold" is the reference/ground-truth label; "pred" is the rater being scored against it.
  * Parallel lists (gold[i] pairs with pred[i]) are already filtered to co-observed units.
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from itertools import combinations

# --- inter-rater agreement (n raters, missing data) --------------------------


def krippendorff_alpha(unit_ratings: list[list[float]], level: str = "nominal") -> float | None:
    """unit_ratings: one list of numeric values per unit (item), across raters (missing omitted).

    Returns alpha in (-inf, 1], or None if undefined (fewer than 2 pairable values).
    level: "nominal" or "ordinal".
    """
    coincidence: dict[tuple[float, float], float] = defaultdict(float)
    for values in unit_ratings:
        m = len(values)
        if m < 2:
            continue
        w = 1.0 / (m - 1)
        for i in range(m):
            for j in range(m):
                if i != j:
                    coincidence[(values[i], values[j])] += w

    if not coincidence:
        return None

    values_set = sorted({v for pair in coincidence for v in pair})
    n_c = {c: sum(coincidence.get((c, k), 0.0) for k in values_set) for c in values_set}
    n = sum(n_c.values())
    if n < 2:
        return None

    def delta_sq(c: float, k: float) -> float:
        if c == k:
            return 0.0
        if level == "ordinal":
            lo, hi = (c, k) if c < k else (k, c)
            between = sum(n_c[g] for g in values_set if lo <= g <= hi)
            return (between - (n_c[c] + n_c[k]) / 2.0) ** 2
        return 1.0  # nominal

    d_observed = 0.0
    d_expected = 0.0
    for c, k in combinations(values_set, 2):
        d = delta_sq(c, k)
        d_observed += coincidence.get((c, k), 0.0) * d
        d_expected += n_c[c] * n_c[k] * d
    if d_expected == 0:
        return 1.0  # all agree (no expected disagreement) → perfect
    return 1.0 - (n - 1) * (d_observed / d_expected)


# --- binary classifier quality (judge vs gold) -------------------------------


def binary_scores(gold: list[int], pred: list[int]) -> dict:
    """Confusion matrix + standard classifier metrics for a judge vs a gold label.

    Metrics that are undefined for the data (e.g. precision with no predicted positives)
    come back as None rather than 0, so the UI can distinguish "0.0" from "N/A".
    """
    n = len(gold)
    tp = fp = fn = tn = 0
    for g, p in zip(gold, pred):
        if p == 1 and g == 1:
            tp += 1
        elif p == 1 and g == 0:
            fp += 1
        elif p == 0 and g == 1:
            fn += 1
        else:
            tn += 1

    def _safe(num: int, den: int) -> float | None:
        return num / den if den else None

    accuracy = _safe(tp + tn, n)
    precision = _safe(tp, tp + fp)
    recall = _safe(tp, tp + fn)               # sensitivity / TPR
    specificity = _safe(tn, tn + fp)          # TNR
    f1 = (2 * precision * recall / (precision + recall)
          if precision and recall else (0.0 if (precision == 0 or recall == 0) and n else None))
    balanced_accuracy = ((recall + specificity) / 2
                         if recall is not None and specificity is not None else None)

    # Matthews correlation coefficient — robust to class imbalance.
    mcc_den = math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    mcc = ((tp * tn - fp * fn) / mcc_den) if mcc_den else None

    # Cohen's kappa (chance-corrected agreement) from the same confusion cells.
    po = _safe(tp + tn, n)
    if n:
        p_pred_pos = (tp + fp) / n
        p_gold_pos = (tp + fn) / n
        pe = p_pred_pos * p_gold_pos + (1 - p_pred_pos) * (1 - p_gold_pos)
        kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0
    else:
        kappa = None

    return {
        "n": n, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "accuracy": accuracy, "precision": precision, "recall": recall,
        "specificity": specificity, "f1": f1, "balanced_accuracy": balanced_accuracy,
        "mcc": mcc, "cohen_kappa": kappa,
    }


# --- ordinal / Likert quality (judge score vs human score) -------------------


def quadratic_weighted_kappa(gold: list[float], pred: list[float],
                             min_rating: int = 1, max_rating: int = 5) -> float | None:
    """QWK — the standard agreement metric for graded/ordinal scoring. Ratings are rounded
    to the nearest integer bin. Returns None if undefined."""
    def _r(x: float) -> int:
        return max(min_rating, min(max_rating, int(round(x))))

    g = [_r(x) for x in gold]
    p = [_r(x) for x in pred]
    n = len(g)
    if n == 0:
        return None
    k = max_rating - min_rating + 1
    idx = lambda r: r - min_rating  # noqa: E731

    obs = [[0.0] * k for _ in range(k)]
    for a, b in zip(g, p):
        obs[idx(a)][idx(b)] += 1

    g_hist = [g.count(min_rating + i) for i in range(k)]
    p_hist = [p.count(min_rating + i) for i in range(k)]
    exp = [[g_hist[i] * p_hist[j] / n for j in range(k)] for i in range(k)]

    denom = (k - 1) ** 2
    num = den = 0.0
    for i in range(k):
        for j in range(k):
            w = (i - j) ** 2 / denom if denom else 0.0
            num += w * obs[i][j]
            den += w * exp[i][j]
    if den == 0:
        return 1.0
    return 1.0 - num / den


def _ranks(xs: list[float]) -> list[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1  # average rank for ties, 1-based
        for t in range(i, j + 1):
            ranks[order[t]] = avg
        i = j + 1
    return ranks


def pearson(x: list[float], y: list[float]) -> float | None:
    n = len(x)
    if n < 2:
        return None
    mx = sum(x) / n
    my = sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0:
        return None  # no variance → correlation undefined
    return sxy / math.sqrt(sxx * syy)


def spearman(x: list[float], y: list[float]) -> float | None:
    """Rank correlation between judge and human scores (monotonic agreement)."""
    if len(x) < 2:
        return None
    return pearson(_ranks(x), _ranks(y))


def error_metrics(gold: list[float], pred: list[float]) -> dict:
    """MAE, RMSE, and mean signed bias (pred - gold; + = judge scores higher than humans)."""
    n = len(gold)
    if n == 0:
        return {"n": 0, "mae": None, "rmse": None, "bias": None}
    diffs = [p - g for g, p in zip(gold, pred)]
    mae = sum(abs(d) for d in diffs) / n
    rmse = math.sqrt(sum(d * d for d in diffs) / n)
    bias = sum(diffs) / n
    return {"n": n, "mae": mae, "rmse": rmse, "bias": bias}


# --- uncertainty -------------------------------------------------------------


def bootstrap_ci(gold: list[float], pred: list[float], stat_fn,
                 n_boot: int = 1000, alpha: float = 0.05, seed: int = 12345
                 ) -> tuple[float | None, float | None]:
    """Paired bootstrap 95% CI for a statistic computed over (gold, pred).

    Resamples unit indices with replacement; recomputes stat_fn each time. Returns
    (lo, hi) percentile bounds, or (None, None) when too few valid resamples exist.
    """
    n = len(gold)
    if n < 3:
        return (None, None)
    rng = random.Random(seed)
    stats: list[float] = []
    for _ in range(n_boot):
        idx = [rng.randrange(n) for _ in range(n)]
        gs = [gold[i] for i in idx]
        ps = [pred[i] for i in idx]
        try:
            s = stat_fn(gs, ps)
        except Exception:  # noqa: BLE001 — a degenerate resample just gets skipped
            s = None
        if s is not None and not math.isnan(s):
            stats.append(s)
    if len(stats) < n_boot * 0.5:
        return (None, None)
    stats.sort()
    lo = stats[int((alpha / 2) * len(stats))]
    hi = stats[min(len(stats) - 1, int((1 - alpha / 2) * len(stats)))]
    return (lo, hi)


# --- trust gate --------------------------------------------------------------

# Minimum gold-labeled units before we're willing to render a verdict at all.
MIN_GOLD_FOR_GATE = 15


def trust_gate(scale: str, scorecard: dict) -> dict:
    """Turn a judge scorecard into a PASS / REVIEW / FAIL trust verdict, à la the
    "gate merges on eval pass rates" pattern. Thresholds are deliberately conservative.
    Returns {verdict, reason}."""
    n = scorecard.get("n") or 0
    if n < MIN_GOLD_FOR_GATE:
        return {"verdict": "insufficient",
                "reason": f"Only {n} gold-labeled item(s) — need ≥{MIN_GOLD_FOR_GATE} for a verdict."}

    if scale == "likert":
        rho = scorecard.get("spearman")
        qwk = scorecard.get("qwk")
        mae = scorecard.get("mae")
        if rho is not None and qwk is not None and mae is not None:
            if rho >= 0.7 and qwk >= 0.6 and mae <= 0.5:
                return {"verdict": "pass", "reason": "Strong ordinal agreement with the human panel."}
            if rho >= 0.4 and qwk >= 0.4 and mae <= 1.0:
                return {"verdict": "review", "reason": "Moderate agreement — spot-check before trusting."}
        return {"verdict": "fail", "reason": "Weak agreement with human scores."}

    f1 = scorecard.get("f1")
    kappa = scorecard.get("cohen_kappa")
    if f1 is not None and kappa is not None:
        if f1 >= 0.8 and kappa >= 0.6:
            return {"verdict": "pass", "reason": "Strong agreement with the human panel."}
        if f1 >= 0.6 and kappa >= 0.4:
            return {"verdict": "review", "reason": "Moderate agreement — spot-check before trusting."}
    return {"verdict": "fail", "reason": "Weak agreement with the human panel."}
