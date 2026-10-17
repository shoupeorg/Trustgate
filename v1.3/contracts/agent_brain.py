# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

#
# TrustGate V1.3 - demo agent brain (NOT part of the product).
#
# Gives the live demo agent (scripts/demo-agent.mjs) an LLM without any off-chain
# AI provider: the agent sends a prompt, the leader runs it on GenLayer's model and
# returns a JSON object. This is the *agent's* thinking (which offers to request,
# how much, whether to accept a counterproposal). It decides nothing about funds:
# every payment still goes through TrustGateVault, where validators judge it.
#
# Validators only check that the leader returned a JSON object. The agent's
# opinions are not meant to be reproducible; the vault's verdicts are.

import json
import genlayer as gl

MAX_PROMPT = 12000


class AgentBrain(gl.contract.Contract):
    thoughts: gl.u256

    def __init__(self) -> None:
        self.thoughts = gl.u256(0)

    @gl.public.write
    def think(self, prompt: str) -> str:
        if prompt.strip() == "" or len(prompt) > MAX_PROMPT:
            raise gl.vm.UserError("prompt must be 1-%d characters" % MAX_PROMPT)

        # Returned as a JSON string: model output can contain floats, which are not
        # GenLayer calldata encodable.
        def leader_fn():
            result = gl.nondet.exec_prompt(prompt, response_format="json")
            if not isinstance(result, dict):
                raise gl.vm.UserError("model did not return a JSON object")
            return json.dumps(result)

        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return) or not isinstance(leader_result.calldata, str):
                return False
            try:
                return isinstance(json.loads(leader_result.calldata), dict)
            except Exception:
                return False

        answer = gl.vm.run_nondet_default(leader_fn, validator_fn)
        self.thoughts = self.thoughts + gl.u256(1)
        return answer

    @gl.public.view
    def thought_count(self) -> str:
        return str(int(self.thoughts))
