import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Lift the detector out of the server source rather than importing it — importing
// mcp-server.js boots the stdio loop and hangs.
const src = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf8');
// lift the detector + label helpers out of the server without booting it
const start = src.indexOf('const DYNAMIC_PATTERNS');
const end = src.indexOf('// Pair each field label');
const endBlock = src.indexOf('\n}', src.indexOf('function pairLabelsWithValues'));
const code = src.slice(start, src.indexOf('const CONNECT_BATCH_SIZE')) + '\n' +
  src.slice(src.indexOf('function isStatusBarTime'), endBlock + 2);
const mod = await import('data:text/javascript,' + encodeURIComponent(code + '\nexport { detectDynamicTypes, isFieldLabel, looksLikeFieldValue, pairLabelsWithValues };'));
const { detectDynamicTypes: detect, isFieldLabel, pairLabelsWithValues } = mod;

const shouldHit = ["Order no. 12345678","Order #1234","ORD-2026-0012","ORD2026001","Order: AB12CD34","#OD9921","Order no. 4521","12345678","ICL2602230000001234","IBAN AE07 0331 2345 6789 0123 456","Tracking ID: TRK88291","Ticket #A-1092","Policy no. PL-88213","Booking ref: XY9K2M","+971 58 585 8588","user@x.com","ď492.46","15 Feb 2026","12.5%","Debit card (4563)"];
const shouldMiss = ["Loan details","Repay","Transaction history","Outstanding balance","Continue","Send money","botim wallet","Bills & recharges","Level 2","Tier 1","iPhone15","Refund","Monthly","Amount due","Free for first 2 transactions","You receive","Choose beneficiary","UnionPay","Salary card","COVID19"];
const labels = ["Order no.","Order number","Order ID","Loan ID","Reference number","Transaction ID","IBAN","Tracking ID:"];
const notLabels = ["Loan details","Order no. 4521","Outstanding balance","Repay"];

let f=0;
console.log('--- SHOULD DETECT ---');
for (const t of shouldHit) { const d=detect(t); if(!d.length){console.log('  ❌ MISS  ', t); f++;} else console.log('  ✅', t.padEnd(38), d.join(',')); }
console.log('\n--- SHOULD NOT DETECT (false positives) ---');
for (const t of shouldMiss) { const d=detect(t); if(d.length){console.log('  ❌ FALSE+', t.padEnd(34), d.join(',')); f++;} }
console.log('  (none listed = clean)');
console.log('\n--- FIELD LABELS ---');
for (const t of labels) { const r=isFieldLabel(t); if(!r){console.log('  ❌ not recognised:', t); f++;} else console.log('  ✅ label:', t); }
for (const t of notLabels) { const r=isFieldLabel(t); if(r){console.log('  ❌ wrongly a label:', t); f++;} }
console.log('\n--- SPLIT LAYER PAIRING (the "Order no." case) ---');
const rows = [
  {id:'order-no-label', text:'Order no.',   rect:{x:20,y:100,width:80,height:16}, frameId:'F1', frameName:'Checkout'},
  {id:'order-no-value', text:'4521',        rect:{x:200,y:100,width:40,height:16}, frameId:'F1', frameName:'Checkout'},
  {id:'loan-id-label',  text:'Loan ID',     rect:{x:20,y:140,width:60,height:16}, frameId:'F1', frameName:'Checkout'},
  {id:'loan-id-value',  text:'AB12CD34',    rect:{x:20,y:162,width:90,height:16}, frameId:'F1', frameName:'Checkout'},
  {id:'unrelated',      text:'Repay',       rect:{x:20,y:400,width:50,height:16}, frameId:'F1', frameName:'Checkout'},
];
const { pairs, orphanLabels } = pairLabelsWithValues(rows);
for (const p of pairs) console.log(`  ✅ ${p.id} = "${p.text}"  ← label "${p.label}" (${p.relation})`);
if (!pairs.find(p=>p.id==='order-no-value')) { console.log('  ❌ order-no-value NOT paired'); f++; }
if (pairs.find(p=>p.id==='unrelated')) { console.log('  ❌ unrelated wrongly paired'); f++; }

// Regression: real naya2 layout. "Order no." has NO value on its row; the item
// below it is a sibling label that owns its own value to the right. Pairing the
// two was a live false positive.
console.log('\n--- LABEL COLUMN: must NOT pair a label with the next label ---');
const table = [
  {id:'order-no-label',   text:'Order no.',            rect:{x:6435,y:8740,width:63, height:17}, frameId:'F', frameName:'Order details'},
  {id:'txn-date-label',   text:'Transaction date',     rect:{x:6435,y:8775,width:112,height:17}, frameId:'F', frameName:'Order details'},
  {id:'txn-date-value',   text:'May 06, 2025',         rect:{x:6653,y:8775,width:95, height:17}, frameId:'F', frameName:'Order details'},
  {id:'benef-label',      text:'Beneficiary',          rect:{x:6435,y:8808,width:75, height:17}, frameId:'F', frameName:'Order details'},
  {id:'benef-value',      text:'Ahmed',                rect:{x:6646,y:8808,width:102,height:17}, frameId:'F', frameName:'Order details'},
];
const t2 = pairLabelsWithValues(table);
const wrong = t2.pairs.find(p=>p.id==='txn-date-label');
if (wrong) { console.log('  ❌ paired "Order no." with the label below it:', JSON.stringify(wrong)); f++; }
else console.log('  ✅ did not pair "Order no." with "Transaction date"');
if (!t2.orphanLabels.find(o=>o.labelId==='order-no-label')) { console.log('  ❌ "Order no." not reported as a label with no value'); f++; }
else console.log('  ✅ reported "Order no." as a field label whose value is missing');

// The filter that caused it: bare numbers were dropped before reaching Ditto.
console.log('\n--- PLACEHOLDER FILTER: bare numbers are real copy ---');
const { isPlaceholder } = await import('../figma-api.js');
for (const t of ['648476283017361','1234','2025','0003']) {
  if (isPlaceholder(t)) { console.log('  ❌ still filtering real value:', t); f++; }
  else console.log('  ✅ kept:', t);
}
for (const t of ['4','12','9:41','Button']) {
  if (!isPlaceholder(t)) { console.log('  ❌ mock junk no longer filtered:', t); f++; }
}
console.log('  ✅ mock junk (4, 12, 9:41, Button) still filtered');
console.log('\n' + (f ? `❌ ${f} failure(s)` : '✅ variablise-detection: all checks passed'));
process.exit(f ? 1 : 0);
