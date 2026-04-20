import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const outputPath = path.join(rootDir, 'env.js');
const envPaths = ['.env', '.env.local'].map((file) => path.join(rootDir, file));

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        const key = line.slice(0, separatorIndex).trim();
        const value = line
          .slice(separatorIndex + 1)
          .trim()
          .replace(/^['"]|['"]$/g, '');
        return [key, value];
      }),
  );
}

const fileEnv = Object.assign({}, ...envPaths.map(parseEnvFile));

const envConfig = {
  SUPABASE_URL: process.env.SUPABASE_URL || fileEnv.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || fileEnv.SUPABASE_ANON_KEY || '',
};

const fileContents = `window.__ENV__ = Object.freeze(${JSON.stringify(envConfig, null, 2)});\n`;

await fsp.writeFile(outputPath, fileContents, 'utf8');

const configuredKeys = Object.entries(envConfig)
  .filter(([, value]) => value)
  .map(([key]) => key);

if (configuredKeys.length === 0) {
  console.warn('Wrote env.js with empty Supabase values. Set SUPABASE_URL and SUPABASE_ANON_KEY before serving the app.');
} else {
  console.log(`Wrote env.js with: ${configuredKeys.join(', ')}`);
}
