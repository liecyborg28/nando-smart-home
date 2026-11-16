# Agent Skills

Three portable skills teach an agent how to use the Nando Smart Home MCP tools well. They contain instructions only: no credentials and no API code (that stays in the server).

| Skill | Use it for |
|---|---|
| `skills/smart-home` | The main skill: find the device, inspect capabilities, read or control, handle the two-step confirmation, report results honestly. Has `references/` for device types, control rules and error codes, and safety rules. |
| `skills/device-management` | Read-only work: what devices exist, what they can do, their status, which one the user means, why something does not respond. |
| `skills/home-automation` | Several devices or several steps: scope, planning, partial failures, per-device reporting. |

Each `SKILL.md` has YAML frontmatter (`name`, `description`) and keeps its body short; detail lives in `references/` and is read only when needed (progressive disclosure). Validate with the skill-creator `quick_validate.py`.

## Loading

- **Claude / Claude Code**: copy the three folders into the skills directory (for example `~/.claude/skills/`), or package them with skill-creator's `package_skill.py`.
- **Agno or any other agent**: skills are plain Markdown. Load `SKILL.md` into the agent's instructions and expose the `references/` files on demand. A loader example is part of Phase 8.

## How they were evaluated

The cases in `skills/smart-home/evals/` run against a **simulated home** (`evals/mock-home/`): the real MCP tools, services, confirmation flow and verification over a fake, stateful fleet. Nothing physical is touched. Details: `skills/smart-home/evals/README.md`.

Findings so far (one run per configuration, so read them as evidence, not proof):

- A capable model already behaves well with the server alone, because the tool responses themselves say "NOT EXECUTED, ask the user", carry the untrusted-data notice and summarize verification.
- The skills add measurable discipline where the server cannot enforce it: asking before acting on a very broad request ("matiin semua perangkat"), checking capabilities before control, turning raw values into plain readings, and keeping the requested action in clarifying questions.
- The safety flow does not make the agent timid: after a clear "ya", it completes the confirmed action.
