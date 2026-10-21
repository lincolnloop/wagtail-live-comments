# List available recipes
default:
    @just --list

# Roots passed to Ruff (Python only)
py_roots := "src tests/backend tests/e2e testproject"
# Roots passed to djlint (HTML templates)
template_roots := "src/wagtail_live_comments/templates testproject"

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

# Install all dependencies (Python + JavaScript)
install:
    uv sync --extra testing
    bun install

# Register pre-commit hooks (run once per clone)
pre-commit-install:
    uv run pre-commit install

# Run pre-commit on staged files (default) or pass e.g. `--all-files`
pre-commit *args:
    uv run pre-commit run {{args}}

# Install Playwright browsers (run once after install)
install-browsers:
    uv run playwright install chromium

# ---------------------------------------------------------------------------
# Testing
# ---------------------------------------------------------------------------

# Run backend and frontend tests
test *args:
    #!/usr/bin/env bash
    pytest_extra=""
    bun_extra=""
    if echo " {{ args }} " | grep -qw -- "-x"; then
        pytest_extra="-x"
        bun_extra="--bail"
    fi
    just test-backend $pytest_extra & just test-frontend $bun_extra
    wait

# Run all tests (including E2E)
test-all *args:
    #!/usr/bin/env bash
    pytest_extra=""
    bun_extra=""
    if echo " {{ args }} " | grep -qw -- "-x"; then
        pytest_extra="-x"
        bun_extra="--bail"
    fi
    just test-backend $pytest_extra & just test-frontend $bun_extra & just test-e2e $pytest_extra
    wait

# Run Python/Django tests
test-backend *args:
    uv run pytest tests/backend {{ args }}

# Run JavaScript tests with Bun
test-frontend *args:
    bun test tests/frontend {{ args }}

# Run JavaScript tests in watch mode
test-frontend-watch:
    bun test --watch tests/frontend

# Run E2E tests with Playwright (headless, artifacts captured on failure)
test-e2e *args:
    uv run pytest tests/e2e --ds=tests.e2e.settings \
        --screenshot=only-on-failure --video=retain-on-failure {{ args }}

# Run E2E tests in headed mode for interactive debugging
test-e2e-headed *args:
    uv run pytest tests/e2e --ds=tests.e2e.settings --headed {{ args }}

# Run backend tests against all supported Django/Wagtail version combinations
tox *args:
    uvx --with tox-uv tox {{ args }}

# Run backend tests against a single tox environment (e.g. just tox-env py312-django51-wagtail7)
tox-env env *args:
    uvx --with tox-uv tox -e {{ env }} {{ args }}

# Run Python tests with coverage report
coverage:
    uv run coverage run -m pytest tests/backend -n auto
    uv run coverage report

# Ruff, djlint, oxlint (scoped paths). Pass Ruff flags after the recipe name, e.g. `just lint --no-fix` (CI) or `just lint --fix`.
lint *args:
    uv run ruff check {{ py_roots }} {{ args }}
    uv run djlint {{ template_roots }} --lint
    bun run lint:check

# Apply Ruff and oxlint autofixes (same paths as `lint`).
lint-fix *args:
    uv run ruff check {{ py_roots }} --fix {{ args }}
    uv run djlint {{ template_roots }} --lint
    bun run lint

format *args: # Ruff format, djlint reformat, oxfmt (scoped paths)
    uv run ruff format {{ py_roots }} {{ args }}
    uv run djlint {{ template_roots }} --reformat
    bun run format

# ---------------------------------------------------------------------------
# Development
# ---------------------------------------------------------------------------

# Migrate, seed a demo page plus an admin/admin superuser, and run the dev server
run:
    uv run python testproject/manage.py migrate
    uv run python testproject/manage.py seed_demo
    uv run python testproject/manage.py runserver

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# Build the distributable wheel and sdist
build:
    uv build

# Remove build artefacts
clean:
    rm -rf dist/ build/ *.egg-info src/*.egg-info
