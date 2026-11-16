"""Check the Agno <-> Nando connection WITHOUT a language model (no Anthropic key needed).

    NANDO_TOKEN=<read token> NANDO_MCP_URL=http://localhost:3000/mcp python smoke_test.py

It connects, lists the tools Agno discovered, makes one real read-only call, loads the skills,
and checks the failure modes. It never controls a device: the one control call it makes uses a
device id that does not exist, and is expected to be refused before anything happens.
"""

from __future__ import annotations

import asyncio
import os
import sys

from nando_smart_home import (
    CONTROL_TOOLS,
    READ_TOOLS,
    ConfigError,
    NandoConnectionError,
    connect_nando,
    nando_skills,
    nando_tools,
)

ok = True


def check(label: str, passed: bool, detail: str = "") -> None:
    global ok
    ok = ok and passed
    print(f"[{'PASS' if passed else 'FAIL'}] {label}" + (f" - {detail}" if detail else ""))


def text_of(result: object) -> str:
    return str(getattr(result, "content", result))


async def expect_connection_error(label: str, must_mention: str, **kwargs: object) -> None:
    tools = nando_tools(**kwargs)  # type: ignore[arg-type]
    try:
        await asyncio.wait_for(connect_nando(tools, **{k: v for k, v in kwargs.items() if k in ("url", "token")}), timeout=30)  # type: ignore[arg-type]
        check(f"{label}: raises instead of continuing with no tools", False)
    except NandoConnectionError as exc:
        check(f"{label}: raises NandoConnectionError with a useful reason", must_mention in str(exc), str(exc)[:110])
        check(f"{label}: error never contains the token", "nsh_" not in str(exc))


async def main() -> None:
    # 1. Connect and discover tools.
    tools = await connect_nando(nando_tools())
    try:
        names = sorted(tools.functions.keys())
        check("discovers exactly the read tools by default", names == sorted(READ_TOOLS), f"{len(names)} tools")

        # 2. One real, read-only call.
        overview = text_of(await tools.functions["get_smart_home_overview"].entrypoint())
        check("get_smart_home_overview returns data", "untrusted" in overview.lower(), f"{len(overview)} chars")
    finally:
        await tools.close()

    # 3. The server, not the client, enforces scope: a read token asking for a control tool is refused.
    wide = await connect_nando(nando_tools(allow_control=True))
    try:
        has = set(CONTROL_TOOLS) <= set(wide.functions.keys())
        check("control tools are discovered when asked for", has)
        refused = text_of(await wide.functions["turn_on_device"].entrypoint(deviceId="does-not-exist"))
        check("read token cannot control (refused by the server before any lookup)", "not permitted" in refused.lower() or "AUTHORIZATION" in refused.upper(), refused[:100].replace("\n", " "))
    finally:
        await wide.close()

    # 4. Skills load through Agno's native support.
    loaded = sorted(s.name for s in nando_skills().get_all_skills())
    check("skills load", {"smart-home", "device-management", "home-automation"} <= set(loaded), ", ".join(loaded))

    # 5. Failure modes must be loud and explain themselves.
    await expect_connection_error("wrong token", "token was rejected", token="nsh_0000000000000000." + "A" * 43)
    await expect_connection_error("server not running", "not reachable", url="http://localhost:1/mcp")
    saved = os.environ.pop("NANDO_TOKEN", None)  # the test itself runs with a token set
    try:
        nando_tools()
        check("missing token raises ConfigError", False)
    except ConfigError as exc:
        check("missing token raises ConfigError", "NANDO_TOKEN" in str(exc))
    finally:
        if saved is not None:
            os.environ["NANDO_TOKEN"] = saved


if __name__ == "__main__":
    asyncio.run(main())
    print("\nALL OK" if ok else "\nFAILED")
    sys.exit(0 if ok else 1)
