# Nando Smart Home with Agno

An [Agno](https://docs.agno.com) agent that looks after your home through the Nando MCP server. Nothing here is specific to Tuya: the agent only knows the MCP tools and the Agent Skills.

| File | What it is |
|---|---|
| `nando_smart_home.py` | The reusable part: `nando_tools()`, `connect_nando()`, `nando_skills()` |
| `run_agent.py` | A small interactive agent (read-only by default) |
| `smoke_test.py` | Checks the whole connection **without** a language model or API key |

Tested with `agno 3.2.0`, `mcp 2.3.0`, Python 3.12.

## Setup

```bash
cd examples/agno
uv venv --python 3.12 .venv          # or: python -m venv .venv
uv pip install -r requirements.txt   # or: pip install -r requirements.txt

# in the repository root: make a token (shown once)
npm run token -- create agno-read --scope read
```

```bash
export NANDO_TOKEN=nsh_...                          # the token above
export NANDO_MCP_URL=http://localhost:3000/mcp      # default; use https://your-domain/mcp in production
export ANTHROPIC_API_KEY=sk-ant-...                 # only for run_agent.py
```

## Try it

```bash
python smoke_test.py                                # no model needed; expect ALL OK
python run_agent.py --once "Which devices are online?"
python run_agent.py                                 # interactive
```

Control needs a **write** token and an explicit opt-in:

```bash
npm run token -- create agno-control --scope write
NANDO_TOKEN=<write token> python run_agent.py --allow-control
```

## How it works

**Connection.** Agno's `MCPTools` with `StreamableHTTPClientParams`, the token in an `Authorization: Bearer` header. Token and URL come from the environment, never from code.

**Skills.** Agno has native Agent Skills support (`Skills(loaders=[LocalSkills(path)])`), so the repository's `skills/` folder is loaded as is. Only each skill's name and description sit in the system prompt; the agent fetches the full instructions and references through `get_skill_instructions` / `get_skill_reference` when a request needs them. Unlike Claude Code, nothing is loaded automatically, so keep `skills=nando_skills()` on the `Agent`.

**Two locks on control.** `nando_tools()` exposes only the 7 read tools unless you pass `allow_control=True`. That is a convenience on the client; the real lock is the server, which checks the token's scope on every call. The smoke test proves it: a read token that asks for `turn_on_device` is refused with `AUTHORIZATION_FAILED`.

**High-impact actions** (locks, garage doors, valves, or everything if the server sets `CONFIRM_ALL_WRITES=true`) come back as `confirmation_required` with a one-time token. The skills tell the agent to ask you and only then repeat the call. See [security.md](../../docs/security.md#5-aksi-berdampak-tinggi).

## Things worth knowing

- **`MCPTools.connect()` does not raise when it fails.** With a wrong token or a server that is down, Agno logs an error and carries on with zero tools, so an agent would answer without ever looking at your home. `connect_nando()` checks `initialized` and raises `NandoConnectionError` with the likely cause (server unreachable, token rejected, host refused, rate limited). Use it instead of calling `connect()` directly.
- **Own the lifecycle.** Connect once, close in `finally` (see `run_agent.py`). Handing an unconnected `MCPTools` to an `Agent` makes it connect and disconnect on every run; Agno's own docs advise against that in production.
- **One toolkit, one connection.** `MCPTools` holds a session; create it once per process, not per question.
- **Two timeouts.** `timeout_seconds` is the MCP read timeout; `StreamableHTTPClientParams.timeout` is per HTTP operation. Tuya calls can take a couple of seconds, so keep both at 30.
- **Tool errors are returned to the model as text** (for example `Error AUTHORIZATION_FAILED: ...`), not raised in your code. The server's messages are written so the model can act on them.
- **Rate limits** are per token (see security.md). A chatty agent sharing one token with a dashboard shares its budget too; give each client its own token.

## Not covered

The natural-language behaviour of the agent (whether Claude picks the right tools for a given sentence) was **not** tested here, because that needs an `ANTHROPIC_API_KEY`. What was verified without one: connection, tool discovery, a real read call, scope enforcement, skills loading, failure handling, and that the skills, instructions and untrusted-data warning end up in the agent's system prompt.
