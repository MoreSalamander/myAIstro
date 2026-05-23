"""
Lightweight write-protection for the public-facing API.

When the env var `MYAISTRO_WRITE_PASSWORD` is set, every endpoint that
mutates the SOT must include an `X-Write-Password` header whose value
matches. If the var is unset, writes are unrestricted (local-dev mode).

Comparison is constant-time via `secrets.compare_digest` to avoid timing
side-channels.

The intended deployment shape:
- Owner runs the backend locally with the env var set.
- A Tailscale Funnel (or Cloudflare Tunnel) exposes the dev server's
  port to the internet.
- The owner pastes the password into the UI on their own device once;
  it persists in localStorage and the frontend's `writeFetch` helper
  attaches it on every mutation request as `X-Write-Password`.
- Visitors with the public URL can read/quiz/chat/guest-classroom,
  but every mutation endpoint (ingest, re-summarize, vault sync,
  audit-run-once, persistent classroom) 401s without the header.

Public read endpoints are intentionally NOT gated — sharing a SOT for
read is the whole point of the tunnel posture. Only mutation needs
protection.
"""

import os
import secrets

from fastapi import Header, HTTPException, status


def _expected_password() -> str | None:
    pw = os.getenv("MYAISTRO_WRITE_PASSWORD")
    if pw is None:
        return None
    pw = pw.strip()
    return pw if pw else None


def require_write_password(
    x_write_password: str | None = Header(default=None),
) -> None:
    """
    FastAPI dependency. Pass via `Depends(require_write_password)` on any
    mutation endpoint.

    - No env password set → allows the request (dev mode).
    - Env password set + header matches → allows.
    - Env password set + header missing/wrong → 401.
    """
    expected = _expected_password()
    if expected is None:
        return

    if not x_write_password or not secrets.compare_digest(
        x_write_password, expected
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Write access requires a valid X-Write-Password header.",
        )


def write_protection_status() -> dict:
    """
    Public, non-secret status: whether write-protection is currently
    enabled. Used by the UI to decide whether to surface the unlock chip.
    """
    return {"enabled": _expected_password() is not None}
