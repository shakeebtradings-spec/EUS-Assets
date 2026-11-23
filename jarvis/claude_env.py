"""Environment for every spawned Claude Code child."""
import os


def child_env(extra: dict | None = None) -> dict:
    """Copy of os.environ with every ANTHROPIC_* variable removed, so the CLI
    can only use the subscription login and never bill an API key."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("ANTHROPIC_")}
    if extra:
        env.update(extra)
    return env
