#!/usr/bin/env bash
# Idempotent installer for the production systemd unit. Run on the
# Debian VM as root (or via sudo) the first time you switch from
# `nohup npm run start` (the server-setup.sh approach) to systemd.
# Re-run after pulling a new commit that touches
# scripts/systemd/exam-questions.service to refresh the unit on disk.
#
#   sudo bash scripts/install-systemd.sh
#
# What it does — in this order, each step skipped if already done:
#
#   1. Create the `exam` system user (no shell, no home, no login).
#   2. Create /etc/exam-questions/ (mode 0750, root:exam) and an empty
#      /etc/exam-questions/env (mode 0640, root:exam) if missing. The
#      service can READ the env file but cannot write it back.
#   3. Create /opt/exam-questions/releases/ (owned by exam:exam) so a
#      deploy can drop a release directory and flip the `current`
#      symlink without root.
#   4. Copy scripts/systemd/exam-questions.service into
#      /etc/systemd/system/ and `systemctl daemon-reload`.
#
# It does NOT enable or start the service — that's deliberate. The
# first time you run the installer you'll usually want to populate
# /etc/exam-questions/env and confirm /opt/exam-questions/current
# points at a built release before flipping the service on. The next
# steps the script prints at the end walk through that.

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "  ✗ install-systemd.sh must run as root (try: sudo bash $0)" >&2
  exit 64
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="${ROOT_DIR}/scripts/systemd/exam-questions.service"
UNIT_DST="/etc/systemd/system/exam-questions.service"
RUN_USER="exam"
RUN_GROUP="exam"
ENV_DIR="/etc/exam-questions"
ENV_FILE="${ENV_DIR}/env"
DEPLOY_DIR="/opt/exam-questions"
RELEASES_DIR="${DEPLOY_DIR}/releases"

echo "───── exam-questions systemd installer ─────"

# 1. system user
if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "── 1/4 creating system user '${RUN_USER}'"
  adduser --system --group --no-create-home --disabled-login \
    --shell /usr/sbin/nologin "${RUN_USER}" >/dev/null
else
  echo "── 1/4 system user '${RUN_USER}' already exists ✓"
fi

# 2. env file
if [[ ! -d "${ENV_DIR}" ]]; then
  echo "── 2/4 creating ${ENV_DIR}/ (mode 0750, root:${RUN_GROUP})"
  install -d -m 0750 -o root -g "${RUN_GROUP}" "${ENV_DIR}"
else
  chown root:"${RUN_GROUP}" "${ENV_DIR}"
  chmod 0750 "${ENV_DIR}"
  echo "── 2/4 ${ENV_DIR}/ already exists ✓ (perms reset)"
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "       creating empty ${ENV_FILE} (mode 0640, root:${RUN_GROUP})"
  install -m 0640 -o root -g "${RUN_GROUP}" /dev/null "${ENV_FILE}"
  echo "       ⚠  populate this file with NODE_ENV, DATABASE_URL,"
  echo "          SESSION_SECRET, and (for Phase 3+) LLM_ENABLED +"
  echo "          OPENAI_API_KEY before starting the service."
else
  chown root:"${RUN_GROUP}" "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
  echo "       ${ENV_FILE} already exists ✓ (perms reset)"
fi

# 3. release dir
if [[ ! -d "${DEPLOY_DIR}" ]]; then
  echo "── 3/4 creating ${DEPLOY_DIR}/ (owned by ${RUN_USER}:${RUN_GROUP})"
  install -d -m 0755 -o "${RUN_USER}" -g "${RUN_GROUP}" "${DEPLOY_DIR}"
fi
if [[ ! -d "${RELEASES_DIR}" ]]; then
  install -d -m 0755 -o "${RUN_USER}" -g "${RUN_GROUP}" "${RELEASES_DIR}"
  echo "       created ${RELEASES_DIR}/"
else
  echo "── 3/4 ${RELEASES_DIR}/ already exists ✓"
fi

# 4. unit file
if [[ ! -f "${UNIT_SRC}" ]]; then
  echo "  ✗ unit source not found at ${UNIT_SRC}" >&2
  echo "    (are you running this from the project repo root?)" >&2
  exit 65
fi
echo "── 4/4 installing ${UNIT_DST}"
install -m 0644 "${UNIT_SRC}" "${UNIT_DST}"
systemctl daemon-reload
echo "       systemctl daemon-reload done ✓"

cat <<EOF

──────────────────────────────────────────────────────────
Installer finished. Service is INSTALLED but NOT YET ENABLED.

Next steps (in order):

  1. Populate the env file (add NODE_ENV, DATABASE_URL, SESSION_SECRET,
     and any LLM env vars). Use \`sudo -e ${ENV_FILE}\`.

  2. Drop a built release into ${RELEASES_DIR}/<timestamp>/ and point
     the \`current\` symlink at it:

       cd ${DEPLOY_DIR}
       sudo -u ${RUN_USER} mkdir releases/\$(date -u +%Y%m%dT%H%M%SZ)
       # rsync your build there (dist/, node_modules/, package.json, etc.)
       sudo -u ${RUN_USER} ln -sfn releases/<timestamp> current

  3. Enable + start the service:

       sudo systemctl enable --now exam-questions
       sudo systemctl status exam-questions

  4. Tail logs while you smoke-test:

       sudo journalctl -u exam-questions -f
──────────────────────────────────────────────────────────
EOF
