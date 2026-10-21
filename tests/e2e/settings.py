import os
import tempfile

from tests.backend.settings import *  # noqa: F403

# The live server must serve static files (JS, CSS) so the browser can load
# live-comments.js and its stylesheet.
# Django's StaticFilesHandler (used by pytest-django's live_server) only
# serves static files when DEBUG is True.
DEBUG = True

ALLOWED_HOSTS = ["localhost", "127.0.0.1"]

# pytest-playwright 0.7+ runs an asyncio event loop. Django's synchronous DB
# operations detect it and raise SynchronousOnlyOperation. Since we are not
# doing async DB work — we just happen to be in a thread where an event loop
# exists — this guard can be safely disabled for E2E tests.
os.environ["DJANGO_ALLOW_ASYNC_UNSAFE"] = "1"

# Use a file-based SQLite database instead of :memory: so the live server
# thread can share the same database as the test thread.
# :memory: creates a per-connection database — each thread sees an empty DB.
_E2E_DB = os.path.join(tempfile.gettempdir(), "wagtail_live_comments_e2e.db")
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": _E2E_DB,
        "OPTIONS": {
            # None = true autocommit in Python's sqlite3 module.
            # The default isolation_level="" uses implicit deferred transactions,
            # which means the live server's thread may not see data committed by
            # the test thread until its open transaction ends.  True autocommit
            # makes every committed write immediately visible to all connections.
            "isolation_level": None,
            # "timeout": 20,
        },
        "TEST": {
            "NAME": _E2E_DB,
        },
    }
}
