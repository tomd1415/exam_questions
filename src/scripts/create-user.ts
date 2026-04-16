/**
 * CLI to create a user. Usage:
 *   tsx src/scripts/create-user.ts \
 *     --role teacher --username tom --display-name "Mr Duguid" \
 *     --pseudonym TEA-0001 --password "hunter2"
 */
import { parseArgs } from 'node:util';
import { pool } from '../db/pool.js';
import { hashPassword } from '../lib/passwords.js';

const ROLES = new Set(['pupil', 'teacher', 'admin']);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      role: { type: 'string' },
      username: { type: 'string' },
      'display-name': { type: 'string' },
      pseudonym: { type: 'string' },
      password: { type: 'string' },
      'no-force-change': { type: 'boolean', default: false },
    },
  });

  const role = values.role;
  const username = values.username;
  const displayName = values['display-name'];
  const pseudonym = values.pseudonym;
  const password = values.password;
  const noForceChange = values['no-force-change'] ?? false;

  if (!role || !username || !displayName || !pseudonym || !password) {
    console.error(
      'Missing args. Required: --role --username --display-name --pseudonym --password',
    );
    process.exit(2);
  }
  if (!ROLES.has(role)) {
    console.error(`--role must be one of: ${[...ROLES].join(', ')}`);
    process.exit(2);
  }
  if (password.length < 12) {
    console.error('--password must be at least 12 characters');
    process.exit(2);
  }

  const passwordHash = await hashPassword(password);

  await pool.query(
    `INSERT INTO users
       (role, display_name, username, password_hash, must_change_password, pseudonym)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (username) DO UPDATE
       SET role                  = EXCLUDED.role,
           display_name          = EXCLUDED.display_name,
           password_hash         = EXCLUDED.password_hash,
           must_change_password  = EXCLUDED.must_change_password,
           updated_at            = now()`,
    [role, displayName, username, passwordHash, !noForceChange, pseudonym],
  );

  console.log(`User '${username}' (${role}) created or updated.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
