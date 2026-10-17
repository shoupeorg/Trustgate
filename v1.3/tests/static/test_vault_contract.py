import ast
from pathlib import Path

VAULT = Path(__file__).parents[2] / "contracts" / "trustgate_vault.py"


def _cls():
    mod = ast.parse(VAULT.read_text(encoding="utf-8"))
    return next(n for n in mod.body if isinstance(n, ast.ClassDef) and n.name == "TrustGateVault")


def _methods():
    return {n.name: n for n in _cls().body if isinstance(n, ast.FunctionDef)}


def test_public_interface():
    m = _methods()
    for name in ("create_vault", "top_up", "owner_reclaim", "request_commitment",
                 "withdraw", "get_vault", "get_request", "credit_of"):
        assert name in m, name
    assert [a.arg for a in m["request_commitment"].args.args] == [
        "self", "request_id", "vault_id", "payee", "amount",
        "deal_text", "agent_justification", "parent_request_id",
    ]


def test_runtime_and_safety_invariants():
    src = VAULT.read_text(encoding="utf-8")
    assert "run_nondet_default" in src and "run_nondet_unsafe" not in src
    # funds move only on ACCEPT, and validators must agree exactly on release
    assert 'judgment["decision"] == "ACCEPT" and judgment["risk"] != "HIGH"' in src
    assert '(mine["decision"] == "ACCEPT") != (decision == "ACCEPT")' in src
    # only the registered agent may request
    assert 'sender != vault["agent"]' in src


def test_create_vault_interface_and_optional_limits():
    m = _methods()
    assert [a.arg for a in m["create_vault"].args.args] == [
        "self", "vault_id", "agent", "mandate", "per_commitment_cap", "total_cap", "payee_allowlist",
    ]
    src = VAULT.read_text(encoding="utf-8")
    # optional deterministic limits are enforced in layer 1
    assert "amount would exceed the owner's total spend cap" in src
    assert "payee is not on the owner's payee allowlist" in src
    # amounts are compared as ints before any u256 conversion (no overflow on huge input)
    assert "amount > int(self.credits.get(sender" in src
    assert "amount > int(funds)" in src
