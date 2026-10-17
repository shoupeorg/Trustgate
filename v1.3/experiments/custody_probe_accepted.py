# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

#
# TrustGate V1.3 — payout probe variant: the transfer is emitted on ACCEPTED, not FINALIZED.
# (Investigation of the Studio Next payout issue; NOT the product contract.)
#
# Answers one question on GenLayer Studio Next (chain 61997):
#   can an Intelligent Contract hold GEN and release it?
#
# Two release paths are tested on purpose:
#   1. move_internal  -> credits another address inside the contract ledger.
#                        No child message, so it cannot hit the Studio Next
#                        fee-allocation issue reported by the Passport project.
#   2. withdraw       -> real native transfer from the contract to the caller.
#                        This is the path Passport reported failing on 61997
#                        with "fee no_matching_allocation".
#
# If (2) fails but (1) works, TrustGate v2 uses an internal ledger for the
# guarded "release" and treats the final withdrawal as a separate step.

import json
import genlayer as gl


def _pay(address, amount) -> None:
    # GenVM v0.6 reaches an account through the same proxy as a contract.
    gl.contract.get_at(address).emit_transfer(value=amount, on="accepted")


class CustodyProbe(gl.contract.Contract):
    ledger: gl.storage.TreeMap[str, gl.u256]
    total: gl.u256

    def __init__(self) -> None:
        self.total = gl.u256(0)

    @gl.public.write.payable
    def deposit(self) -> str:
        value = gl.message.value
        if value == gl.u256(0):
            return json.dumps({"ok": False, "reason": "send an amount greater than zero"})
        key = gl.message.sender_address.as_hex.lower()
        self.ledger[key] = self.ledger.get(key, gl.u256(0)) + value
        self.total = self.total + value
        return json.dumps({"ok": True, "balance": str(int(self.ledger[key]))})

    @gl.public.write
    def move_internal(self, to: str, amount: int) -> str:
        sender = gl.message.sender_address.as_hex.lower()
        value = gl.u256(amount)
        if value == gl.u256(0) or self.ledger.get(sender, gl.u256(0)) < value:
            raise gl.vm.UserError("insufficient ledger balance")
        target = to.strip().lower()
        self.ledger[sender] = self.ledger[sender] - value
        self.ledger[target] = self.ledger.get(target, gl.u256(0)) + value
        return json.dumps({"ok": True, "from": sender, "to": target, "amount": str(amount)})

    @gl.public.write
    def withdraw(self, amount: int) -> str:
        sender_addr = gl.message.sender_address
        sender = sender_addr.as_hex.lower()
        value = gl.u256(amount)
        if value == gl.u256(0) or self.ledger.get(sender, gl.u256(0)) < value:
            raise gl.vm.UserError("insufficient ledger balance")
        self.ledger[sender] = self.ledger[sender] - value
        self.total = self.total - value
        _pay(sender_addr, value)
        return json.dumps({"ok": True, "paid": str(amount), "to": sender})

    @gl.public.view
    def balance_of(self, address: str) -> str:
        return str(int(self.ledger.get(address.strip().lower(), gl.u256(0))))

    @gl.public.view
    def total_held(self) -> str:
        return str(int(self.total))
