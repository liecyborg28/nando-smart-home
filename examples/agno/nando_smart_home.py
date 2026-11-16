"""Connect an Agno agent to Nando Smart Home.

Two helpers:

* ``nando_tools()``  - an ``MCPTools`` connected to the server's Streamable HTTP endpoint.
* ``nando_skills()`` - the repository's Agent Skills, loaded with Agno's native skills support.

Configuration comes from the environment, never from code:

    NANDO_MCP_URL   default http://localhost:3000/mcp
    NANDO_TOKEN     a token from `npm run token -- create <name> --scope read|write`
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from agno.skills import LocalSkills, Skills
from agno.tools.mcp import MCPTools, StreamableHTTPClientParams

DEFAULT_URL = "http://localhost:3000/mcp"

# Tools that only read. A token with the `read` scope can use exactly these.
READ_TOOLS = [
    "get_smart_home_overview",
    "list_devices",
    "get_device",
    "get_device_status",
    "get_multiple_device_status",
    "get_device_capabilities",
    "check_provider_connection",
]

# Tools that change the physical world. Needs a token with the `write` scope.
CONTROL_TOOLS = [
    "turn_on_device",
    "turn_off_device",
    "set_device_property",
    "execute_device_command",
]

SKILLS_DIR = Path(__file__).resolve().parents[2] / "skills"


class ConfigError(RuntimeError):
    """A required setting is missing. The message says which one, never its value."""


def nando_tools(
    *,
    allow_control: bool = False,
    url: str | None = None,
    token: str | None = None,
    read_timeout_seconds: int = 30,
) -> MCPTools:
    """Build the MCP toolkit. The caller owns its lifecycle (``await tools.connect()`` / ``close()``).

    ``allow_control=False`` (the default) only exposes the read tools to the model. That is a
    second lock on top of the server, which enforces the token's scope no matter what the client
    asks for: a read token can never control a device even if this list is widened.
    """
    token = token or os.environ.get("NANDO_TOKEN")
    if not token:
        raise ConfigError("NANDO_TOKEN is not set. Create one with: npm run token -- create <name> --scope read")

    params = StreamableHTTPClientParams(
        url=url or os.environ.get("NANDO_MCP_URL", DEFAULT_URL),
        headers={"Authorization": f"Bearer {token}"},
        timeout=read_timeout_seconds,  # per HTTP operation
        sse_read_timeout=300,
    )
    return MCPTools(
        server_params=params,
        transport="streamable-http",
        name="nando",
        timeout_seconds=read_timeout_seconds,  # MCP client read timeout
        include_tools=READ_TOOLS + (CONTROL_TOOLS if allow_control else []),
    )


class NandoConnectionError(RuntimeError):
    """The MCP server could not be reached or refused us. The message says why, never the token."""


async def _diagnose(url: str, token: str) -> str:
    """One cheap authenticated REST call to find out WHY the MCP connection failed."""
    base = url.rsplit("/mcp", 1)[0]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"{base}/api/integrations/tuya/status", headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        return f"the server at {base} is not reachable (is it running, is the URL right?)"
    if res.status_code == 401:
        return "the token was rejected (wrong, revoked or expired). Create a new one: npm run token -- create <name> --scope read"
    if res.status_code == 403:
        return "the request was refused (plain HTTP in production, or this Host is not in MCP_ALLOWED_HOSTS)"
    if res.status_code == 429:
        return "rate limited; wait a minute and try again"
    if res.status_code == 503:
        return "the server cannot verify tokens right now (its database is unreachable)"
    return f"the server answered HTTP {res.status_code} on REST but the MCP connection still failed"


async def connect_nando(tools: MCPTools, *, url: str | None = None, token: str | None = None) -> MCPTools:
    """Connect and FAIL LOUDLY.

    Agno's ``MCPTools.connect()`` does not raise when the server is down or the token is wrong: it
    logs an error and leaves ``functions`` empty, so an agent would silently run with no tools and
    could answer from imagination. This wrapper checks ``initialized`` and raises instead.
    """
    await tools.connect()
    if not tools.initialized or not tools.functions:
        reason = await _diagnose(
            url or os.environ.get("NANDO_MCP_URL", DEFAULT_URL),
            token or os.environ.get("NANDO_TOKEN", ""),
        )
        await tools.close()
        raise NandoConnectionError(f"Could not connect to Nando Smart Home: {reason}")
    return tools


def nando_skills() -> Skills:
    """Load the repository's Agent Skills (smart-home, device-management, home-automation).

    Agno reads each ``skills/<name>/SKILL.md``, keeps only name and description in the system
    prompt, and lets the agent fetch the full instructions and references when it needs them.
    """
    if not SKILLS_DIR.is_dir():
        raise ConfigError(f"Skills directory not found: {SKILLS_DIR}")
    return Skills(loaders=[LocalSkills(str(SKILLS_DIR))])
