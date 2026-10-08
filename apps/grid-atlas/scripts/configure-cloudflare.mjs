import { readFile, writeFile } from 'node:fs/promises';
const databaseId = process.env.D1_DATABASE_ID;
if (!databaseId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(databaseId) || /^0{8}-/.test(databaseId)) {
  throw new Error('실제 D1_DATABASE_ID가 필요합니다. Cloudflare에서 새 Grid Atlas 데이터베이스를 만든 후 설정하세요.');
}
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
config.d1_databases[0].database_id = databaseId;
const cadence = process.env.GRID_ATLAS_REFRESH_CADENCE || 'weekly';
if (!['weekly', 'monthly'].includes(cadence)) throw new Error('GRID_ATLAS_REFRESH_CADENCE는 weekly 또는 monthly여야 합니다.');
config.vars.SCHEDULE_ENABLED = process.env.ENABLE_GRID_ATLAS_REFRESH === 'true' ? 'true' : 'false';
config.vars.SCHEDULE_CADENCE = cadence;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (accountId) {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID 형식 오류');
  config.account_id = accountId;
}
await writeFile(new URL('../wrangler.deploy.json', import.meta.url), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log('wrangler.deploy.json 생성 완료. 사이트 게시·갱신 일정 활성화는 별도 실행입니다.');
