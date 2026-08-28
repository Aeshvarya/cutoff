"""Vercel's entry point.

The application is the same one uvicorn serves locally -- this file only
re-exports it so the platform's Python runtime can find an ASGI app.
"""

from cutoff.api.main import app

__all__ = ["app"]
