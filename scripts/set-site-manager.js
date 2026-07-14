// Sets the `manager` field on the `sites` table (task #174/#207, Facility Groups — Michael chose to
// group by manager/team, which needed a brand new field: confirmed nothing like this exists in any
// SiteLink report or the sites table before today). Two modes:
//   Single site:  node --env-file=.env scripts/set-site-manager.js L001 "Jane Smith"
//   Bulk from a JSON file mapping site code -> manager name:
//     node --env-file=.env scripts/set-site-manager.js --file managers.json
//     where managers.json looks like: { "L001": "Jane Smith", "L002": "Jane Smith", "L003": "Tom Lee" }
import { admin } from '../lib/supabaseAdmin.js';
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
let pairs = [];

if (args[0] === '--file') {
  const path = args[1];
  if (!path) { console.error('Usage: node scripts/set-site-manager.js --file managers.json'); process.exit(1); }
  const json = JSON.parse(readFileSync(path, 'utf8'));
  pairs = Object.entries(json).map(([code, manager]) => ({ code, manager }));
} else {
  const [code, manager] = args;
  if (!code || !manager) {
    console.error('Usage: node scripts/set-site-manager.js <siteCode> "<manager name>"');
    console.error('   or: node scripts/set-site-manager.js --file managers.json');
    process.exit(1);
  }
  pairs = [{ code, manager }];
}

let ok = 0, failed = 0;
for (const { code, manager } of pairs) {
  const { error } = await admin.from('sites').update({ manager }).eq('code', code);
  if (error) { console.error(`  ${code}: FAILED — ${error.message}`); failed++; }
  else { console.log(`  ${code} -> ${manager}`); ok++; }
}
console.log(`\nDone — ${ok} updated, ${failed} failed.`);
process.exit(failed ? 1 : 0);
