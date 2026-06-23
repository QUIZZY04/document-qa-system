require('dotenv').config();
const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

function parseLimitToLakh(raw) {
    if (!raw) return 0;
    let s = raw.toString().toUpperCase()
        .replace(/RS\.?\s*/g, '').replace(/UPTO\s*/g, '').replace(/,/g, '').trim();
    if (!s || s === '-' || s === 'NIL') return 0;
    if (s.includes('FULL') || s.includes('POWER')) return Infinity;
    // OCR: digit-O → digit-0
    s = s.replace(/(\d)[O]/gi, '$10').replace(/[O](\d)/gi, '0$1');
    s = s.replace(/LAKHSH?|1AKH|LAKH/gi, 'LAKH').replace(/CRORE|CR\b/gi, 'CRORE').replace(/\s+/g, ' ').trim();
    let m;
    m = s.match(/^([\d.]+)\s*CRORE$/i); if (m) return parseFloat(m[1]) * 100;
    m = s.match(/^([\d.]+)\s*LAKH$/i);  if (m) return parseFloat(m[1]);
    m = s.match(/^([\d.]+)$/);           if (m) return parseFloat(m[1]);
    console.log('    [UNPARSED]', JSON.stringify(s));
    return 0;
}

async function run() {
    const snap = await db.collection('chunks').where('pageNumber', '==', 8).get();
    snap.forEach(doc => {
        const text = doc.data().text || '';
        const lines = text.split('\n');
        for (const line of lines) {
            if (!/\[SI:\s*4\.3/i.test(line)) continue;
            console.log('\nMATCHED LINE:\n', line);
            const cols = ['ED','GM','AGM','DGM','SM'];
            for (const c of cols) {
                const m = line.match(new RegExp(`\\[${c}:\\s*([^\\]]+)\\]`, 'i'));
                const raw = m ? m[1].trim() : 'NOT FOUND';
                const lakh = parseLimitToLakh(raw);
                console.log(`  ${c}: "${raw}" → ${lakh === Infinity ? 'Full Powers' : lakh + 'L'}`);
            }
        }
    });
}
run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
