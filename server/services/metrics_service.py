"""Agreement metrics across the full rater panel (LLM judges + human reviewers).

Krippendorff's alpha is the headline: it handles any number of raters, missing data (raters
needn't score every item), and both nominal (binary pass/fail) and ordinal (Likert 1–5) scales.
Implemented directly (coincidence-matrix method) to avoid an extra dependency in the app image.
"""

from __future__ import annotations

from collections import defaultdict
from itertools import combinations

from sqlalchemy.orm import Session

from server.database import Item, JudgmentKind, Project, ProjectScale


def krippendorff_alpha(unit_ratings: list[list[float]], level: str = "nominal") -> float | None:
    """unit_ratings: one list of numeric values per unit (item), across raters (missing omitted).

    Returns alpha in (-inf, 1], or None if undefined (fewer than 2 pairable values).
    level: "nominal" or "ordinal".
    """
    # Coincidence matrix over observed value pairs within units that have >= 2 ratings.
    coincidence: dict[tuple[float, float], float] = defaultdict(float)
    for values in unit_ratings:
        m = len(values)
        if m < 2:
            continue
        w = 1.0 / (m - 1)
        # Ordered pairs of DISTINCT rater slots within the unit (i != j).
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


def _value_for(judgment, scale: ProjectScale) -> float | None:
    if scale == ProjectScale.LIKERT:
        if judgment.score is not None:
            return float(judgment.score)
        if judgment.verdict is not None:  # judge gave categorical → map to poles
            return 5.0 if judgment.verdict.value == "pass" else 1.0
        return None
    if judgment.verdict is not None:
        return 1.0 if judgment.verdict.value == "pass" else 0.0
    return None


def project_metrics(db: Session, project_id: str) -> dict:
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        return {"detail": "Project not found."}
    scale = project.scale
    level = "ordinal" if scale == ProjectScale.LIKERT else "nominal"

    items = db.query(Item).filter(Item.project_id == project_id).all()

    # Build per-unit (response) rater→value maps; a rater is an llm judge_key or a human id.
    units: list[dict[str, float]] = []
    per_rater_vals: dict[str, list[float]] = defaultdict(list)
    rater_labels: dict[str, str] = {}
    for it in items:
        for r in it.responses:
            row: dict[str, float] = {}
            for j in r.judgments:
                if j.kind == JudgmentKind.LLM:
                    rater = f"llm:{j.judge_key or 'judge'}"
                    rater_labels[rater] = f"AI · {j.judge_key or 'judge'}"
                else:
                    if not j.rater_id:
                        continue
                    rater = f"human:{j.rater_id}"
                    rater_labels[rater] = j.rater_id  # frontend maps id→email
                val = _value_for(j, scale)
                if val is None:
                    continue
                row[rater] = val
                per_rater_vals[rater].append(val)
            if row:
                units.append(row)

    def alpha_over(raters: set[str] | None) -> float | None:
        matrix = []
        for row in units:
            vals = [v for rr, v in row.items() if raters is None or rr in raters]
            matrix.append(vals)
        return krippendorff_alpha(matrix, level)

    human_raters = {r for r in per_rater_vals if r.startswith("human:")}
    n_units_multi = sum(1 for row in units if len(row) >= 2)

    per_rater = [
        {
            "rater": r,
            "label": rater_labels.get(r, r),
            "kind": "llm" if r.startswith("llm:") else "human",
            "n": len(vals),
            "mean": round(sum(vals) / len(vals), 3) if vals else None,
            "pass_rate": (round(sum(1 for v in vals if v >= (3 if level == "ordinal" else 1)) / len(vals), 3)
                          if vals and level == "nominal" else None),
        }
        for r, vals in sorted(per_rater_vals.items())
    ]

    return {
        "scale": scale.value,
        "level": level,
        "n_raters": len(per_rater_vals),
        "n_units_multi_rated": n_units_multi,
        "alpha_all": alpha_over(None),
        "alpha_humans": alpha_over(human_raters) if len(human_raters) >= 2 else None,
        "per_rater": per_rater,
    }
