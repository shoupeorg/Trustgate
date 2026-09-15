def test_trustgate_contract_loads(direct_deploy):
    contract = direct_deploy("contracts/trustgate.py")

    assert contract.get_last_inspection_id() == ""
    assert contract.get_last_report() == ""
