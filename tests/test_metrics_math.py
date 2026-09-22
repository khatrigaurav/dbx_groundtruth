"""Unit tests for the pure metric math (no DB/MLflow needed)."""

from __future__ import annotations

import math

from server.services import metrics_math as MM


# --- binary classifier quality ----------------------------------------------

def test_binary_perfect_agreement():
    s = MM.binary_scores([1, 1, 0, 0, 1], [1, 1, 0, 0, 1])
    assert s["f1"] == 1.0
    assert s["cohen_kappa"] == 1.0
    assert s["mcc"] == 1.0
    assert s["accuracy"] == 1.0


def test_binary_confusion_and_rates():
    # gold vs pred → tp=2 fp=1 fn=1 tn=1
    s = MM.binary_scores([1, 1, 1, 0, 0], [1, 1, 0, 0, 1])
    assert (s["tp"], s["fp"], s["fn"], s["tn"]) == (2, 1, 1, 1)
    assert math.isclose(s["precision"], 2 / 3)
    assert math.isclose(s["recall"], 2 / 3)
    assert math.isclose(s["f1"], 2 / 3)
    assert math.isclose(s["specificity"], 0.5)
    assert s["mcc"] is not None


def test_binary_undefined_precision_is_none():
    # judge never predicts pass → precision undefined, not 0
    s = MM.binary_scores([1, 0, 1, 0], [0, 0, 0, 0])
    assert s["precision"] is None


# --- ordinal / Likert quality -----------------------------------------------

def test_qwk_perfect_and_imperfect():
    assert math.isclose(MM.quadratic_weighted_kappa([1, 3, 5, 2, 4], [1, 3, 5, 2, 4]), 1.0)
    assert MM.quadratic_weighted_kappa([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) < 0


def test_spearman_monotonic():
    assert math.isclose(MM.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
    assert math.isclose(MM.spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1.0)
    assert MM.spearman([1], [1]) is None  # too few points


def test_error_metrics_bias_sign():
    e = MM.error_metrics([3, 3, 3], [4, 4, 4])  # judge scores higher than humans
    assert e["bias"] == 1.0
    assert e["mae"] == 1.0
    assert math.isclose(e["rmse"], 1.0)


# --- agreement ---------------------------------------------------------------

def test_krippendorff_perfect_and_none():
    assert math.isclose(MM.krippendorff_alpha([[1, 1], [0, 0], [1, 1]], "nominal"), 1.0)
    assert MM.krippendorff_alpha([[1], [0]], "nominal") is None  # no pairable values


# --- uncertainty & gate ------------------------------------------------------

def test_bootstrap_ci_bounds():
    gold = [1, 1, 1, 0, 0, 0, 1, 0, 1, 0]
    pred = [1, 1, 0, 0, 0, 1, 1, 0, 1, 0]
    lo, hi = MM.bootstrap_ci(gold, pred, lambda g, p: MM.binary_scores(g, p)["f1"], n_boot=300)
    assert lo is not None and 0.0 <= lo <= hi <= 1.0


def test_bootstrap_ci_too_few_units():
    assert MM.bootstrap_ci([1, 0], [1, 0], lambda g, p: 1.0) == (None, None)


def test_trust_gate_verdicts():
    assert MM.trust_gate("binary", {"n": 20, "f1": 0.9, "cohen_kappa": 0.7})["verdict"] == "pass"
    assert MM.trust_gate("binary", {"n": 20, "f1": 0.65, "cohen_kappa": 0.45})["verdict"] == "review"
    assert MM.trust_gate("binary", {"n": 20, "f1": 0.3, "cohen_kappa": 0.1})["verdict"] == "fail"
    assert MM.trust_gate("binary", {"n": 5, "f1": 0.9, "cohen_kappa": 0.9})["verdict"] == "insufficient"
    assert MM.trust_gate("likert", {"n": 30, "spearman": 0.8, "qwk": 0.7, "mae": 0.4})["verdict"] == "pass"
