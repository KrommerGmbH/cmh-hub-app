import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const srcManifestPath = resolve(rootDir, 'manifest.json');
const distDir = resolve(rootDir, 'dist');
const distManifestPath = resolve(distDir, 'manifest.json');

const rawManifest = readFileSync(srcManifestPath, 'utf-8');
const manifest = JSON.parse(rawManifest);

// 환경값 CMH_EXT_DEV_ORIGIN 이 있으면 그 origin 의 /* 를 matches 와 host_permissions 에 더한다 (시험용 · 배포판에는 없음)
const devOrigin = process.env.CMH_EXT_DEV_ORIGIN?.trim();

if (devOrigin) {
  if (!devOrigin.startsWith('https://')) {
    console.error(`[copy-manifest] CMH_EXT_DEV_ORIGIN 은 https:// 로 시작해야 합니다: ${devOrigin}`);
    process.exit(1);
  }

  const normalizedOrigin = devOrigin.replace(/\/+$/, '');
  const pattern = `${normalizedOrigin}/*`;

  const contentScript = manifest.content_scripts?.[0];
  if (contentScript && Array.isArray(contentScript.matches)) {
    if (!contentScript.matches.includes(pattern)) {
      contentScript.matches.push(pattern);
    }
  }

  if (Array.isArray(manifest.host_permissions)) {
    if (!manifest.host_permissions.includes(pattern)) {
      manifest.host_permissions.push(pattern);
    }
  }
}

mkdirSync(distDir, { recursive: true });
writeFileSync(distManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
console.log(`[copy-manifest] manifest.json -> dist/manifest.json 복사 완료`);
