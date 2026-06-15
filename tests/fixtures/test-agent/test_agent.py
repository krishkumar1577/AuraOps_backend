#!/usr/bin/env python3
"""AuraOps MCP integration test agent — echoes input back."""

def handle(input_text: str, metadata: dict | None = None) -> str:
    meta = metadata or {}
    return f"echo: {input_text}" + (f" | meta={meta}" if meta else "")


if __name__ == "__main__":
    import sys
    prompt = sys.argv[1] if len(sys.argv) > 1 else "hello"
    print(handle(prompt))
