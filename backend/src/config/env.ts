import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const configuredOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const allowedOrigins = Array.from(
  new Set([
    configuredOrigin,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]),
);

export const env = {
  port: Number(process.env.PORT ?? 4000),
  origin: configuredOrigin,
  allowedOrigins,
  production: process.env.NODE_ENV === 'production',
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
};

