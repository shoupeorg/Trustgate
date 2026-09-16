import ast
from pathlib import Path


CONTRACT_PATH = Path(__file__).parents[2] / "contracts" / "trustgate.py"


def _contract_class():
    module = ast.parse(CONTRACT_PATH.read_text(encoding="utf-8"))
    return next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "TrustGate")


def _method(name):
    return next(node for node in _contract_class().body if isinstance(node, ast.FunctionDef) and node.name == name)


def test_stable_public_inspection_interfaces_are_preserved():
    assert [argument.arg for argument in _method("inspect_deal").args.args] == [
        "self", "inspection_id", "task", "contract_terms",
        "requested_permissions", "payment_conditions",
        "evidence_requirements", "instructions",
    ]
    assert [argument.arg for argument in _method("inspect_revision").args.args] == [
        "self", "inspection_id", "parent_inspection_id", "task",
        "contract_terms", "requested_permissions", "payment_conditions",
        "evidence_requirements", "instructions",
    ]


def test_stable_report_storage_and_reads_are_preserved():
    source = CONTRACT_PATH.read_text(encoding="utf-8")
    assert "reports: gl.storage.TreeMap[str, str]" in source
    assert '"deal_package"' in source
    assert '"report"' in source
    assert "def get_report(" in source
    assert "def get_last_report(" in source
    assert "def get_last_inspection_id(" in source
