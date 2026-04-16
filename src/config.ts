import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3030),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 chars (use `openssl rand -hex 32`)'),
  LLM_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_MARKING: z.string().optional(),
  OPENAI_MODEL_GENERATION: z.string().optional(),
  OPENAI_MODEL_EMBEDDING: z.string().default('text-embedding-3-small'),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_INITIAL_PASSWORD: z.string().min(8),
});

export type Config = z.infer<typeof ConfigSchema>;

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config: Config = parsed.data;
