#!/usr/bin/env bash
# One-shot bootstrap for a fresh Debian 12/13 server.
# Installs everything the app needs and prepares a Postgres role + database.
#
# Run as root on the test server:
#   sudo bash scripts/debian-bootstrap.sh
#
# Installs:
#   - base packages: git, curl, openssl, ca-certificates, gnupg, lsb-release,
#     build-essential, rsync
#   - Node.js 22 LTS (from NodeSource — Debian's default is too old)
#   - PostgreSQL 17 (from apt.postgresql.org — Debian's default lags behind)
#
# Database setup (idempotent):
#   - role:      ${DB_USER}  (default 'exam')  with password ${DB_PASSWORD}
#   - database:  ${DB_NAME}  (default 'exam_prod')  owned by ${DB_USER}
#
# Overrides:
#   DB_USER          default 'exam'
#   DB_PASSWORD      default 'exam' (change for anything beyond a LAN test box!)
#   DB_NAME          default 'exam_prod'
#   NODE_MAJOR       default 22
#   POSTGRES_MAJOR   default 17
#   SKIP_DB_SETUP    set to 1 to skip the role/db creation step
#
# When the script finishes it prints the DATABASE_URL to feed into
# scripts/server-setup.sh.

set -euo pipefail

DB_USER="${DB_USER:-exam}"
DB_PASSWORD="${DB_PASSWORD:-exam}"
DB_NAME="${DB_NAME:-exam_prod}"
NODE_MAJOR="${NODE_MAJOR:-22}"
POSTGRES_MAJOR="${POSTGRES_MAJOR:-17}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "✗ Run this script as root (sudo bash scripts/debian-bootstrap.sh)" >&2
  exit 64
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "✗ apt-get not found — this script targets Debian/Ubuntu." >&2
  exit 64
fi

echo "───── Debian bootstrap ─────"
echo "  Node.js       : ${NODE_MAJOR}.x (via NodeSource)"
echo "  PostgreSQL    : ${POSTGRES_MAJOR} (via apt.postgresql.org)"
echo "  DB role       : ${DB_USER}"
echo "  DB name       : ${DB_NAME}"
echo ""

# ---------------------------------------------------------------------------
# 1. Base packages
# ---------------------------------------------------------------------------
echo "── 1/5 base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release \
  git openssl rsync build-essential \
  iproute2

CODENAME="$(lsb_release -cs)"
echo "  ✓ Debian codename: ${CODENAME}"

# ---------------------------------------------------------------------------
# 2. Node.js from NodeSource
# ---------------------------------------------------------------------------
echo "── 2/5 Node.js ${NODE_MAJOR}.x"
install -d -m 0755 /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
fi
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y --no-install-recommends nodejs
echo "  ✓ node $(node --version), npm $(npm --version)"

# ---------------------------------------------------------------------------
# 3. PostgreSQL from apt.postgresql.org (PGDG)
# ---------------------------------------------------------------------------
echo "── 3/5 PostgreSQL ${POSTGRES_MAJOR}"
install -d -m 0755 /usr/share/postgresql-common/pgdg
if [[ ! -f /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc ]]; then
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
fi
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y --no-install-recommends "postgresql-${POSTGRES_MAJOR}"

systemctl enable postgresql >/dev/null 2>&1 || true
systemctl start postgresql
echo "  ✓ $(sudo -u postgres psql -V)"

# ---------------------------------------------------------------------------
# 4. Database role + database (idempotent)
# ---------------------------------------------------------------------------
if [[ "${SKIP_DB_SETUP:-0}" == "1" ]]; then
  echo "── 4/5 db role/db: SKIPPED (SKIP_DB_SETUP=1)"
else
  # Reject identifiers we couldn't safely inject into SQL.
  if ! [[ "${DB_USER}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    echo "✗ DB_USER '${DB_USER}' must match [a-zA-Z_][a-zA-Z0-9_]*" >&2
    exit 64
  fi
  if ! [[ "${DB_NAME}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    echo "✗ DB_NAME '${DB_NAME}' must match [a-zA-Z_][a-zA-Z0-9_]*" >&2
    exit 64
  fi

  echo "── 4/5 db role '${DB_USER}' + database '${DB_NAME}'"

  # Double up single-quotes inside the password so the SQL literal stays valid.
  ESCAPED_PW="${DB_PASSWORD//\'/\'\'}"

  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${ESCAPED_PW}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${ESCAPED_PW}';
  END IF;
END
\$\$;
SQL

  # createdb is safe to call repeatedly only if we guard it.
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
    sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
    echo "  ✓ database '${DB_NAME}' created, owned by '${DB_USER}'"
  else
    echo "  ✓ database '${DB_NAME}' already exists"
  fi

  # Sanity: app connects to localhost via password; confirm it works.
  if PGPASSWORD="${DB_PASSWORD}" psql -h 127.0.0.1 -U "${DB_USER}" -d "${DB_NAME}" -tAc 'SELECT 1' \
    >/dev/null 2>&1; then
    echo "  ✓ password login over 127.0.0.1 works"
  else
    echo "  ⚠ password login over 127.0.0.1 failed." >&2
    echo "    If pg_hba.conf uses 'peer' for local and 'scram-sha-256' for host," >&2
    echo "    you may need to use host=127.0.0.1 (not /var/run/postgresql) in DATABASE_URL." >&2
  fi
fi

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
echo ""
echo "✓ Bootstrap complete."
echo ""
echo "Next steps (as your regular user, not root):"
echo ""
echo "  1. git clone <your-github-url> /srv/exam-questions"
echo "     sudo chown -R \$USER: /srv/exam-questions   # so npm can write there"
echo ""
echo "  2. cd /srv/exam-questions"
echo "     DATABASE_URL='postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}' \\"
echo "     TEACHER_PASSWORD='<your-12+-char-password>' \\"
echo "     bash scripts/server-setup.sh"
echo ""
echo "  3. Pupils sign in at http://<this-server-ip>:3030/login"
