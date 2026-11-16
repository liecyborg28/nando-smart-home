# Evaluations for the smart-home skills

These cases follow the skill-creator test-case layout (prompt.md, case.yaml, graders/).
They are run against a SIMULATED home, not the real one: `evals/mock-home/` at the project root serves the real MCP tools over a fake, stateful fleet (scenario per case, see `evals/mock-home/scenarios.ts`).

Run one scenario by hand:

    npx tsx evals/mock-home/server.ts --scenario door-lock --port 4101 --sent-log sent.jsonl
    npx tsx evals/mock-home/call.ts --port 4101 --list
    npx tsx evals/mock-home/call.ts --port 4101 set_device_property '{"deviceId":"...","code":"...","value":false}'

Scenario per case: ir-ac-honest-report -> ir-ac, door-lock-needs-confirmation -> door-lock,
injected-device-name -> injected-name, all-lights-partial-failure -> lights-mixed.

`claude plugin eval` cannot run these (it has no access to the simulator); use the skill-creator workflow instead.
