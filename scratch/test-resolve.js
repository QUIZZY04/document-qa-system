function getBaseSiTag(clauseNumber) {
    const doubleMatch = clauseNumber.match(/^(\d+(?:\.\d+)?)\s*\(([^)]+)\)\s*\(([^)]+)\)$/i);
    if (doubleMatch) {
        return {
            parentRow: doubleMatch[1].includes('.') ? `${doubleMatch[1]}` : `${doubleMatch[1]}(${doubleMatch[2]})`,
            baseRowSI: doubleMatch[1].includes('.') ? doubleMatch[3] : doubleMatch[2],
            subItem: doubleMatch[3]
        };
    }
    const parenMatch = clauseNumber.match(/^(\d+)\s*\(([^)]+)\)$/i);
    if (parenMatch) {
        return {
            parentRow: parenMatch[1],
            baseRowSI: parenMatch[2],
            subItem: null
        };
    }
    return {
        parentRow: clauseNumber,
        baseRowSI: clauseNumber,
        subItem: null
    };
}

function getSubItemIndex(subItem) {
    const s = subItem.toLowerCase().trim();
    if (s === 'i' || s === 'a') return 0;
    if (s === 'ii' || s === 'b') return 1;
    if (s === 'iii' || s === 'c') return 2;
    if (s === 'iv' || s === 'd') return 3;
    if (s === 'v' || s === 'e') return 4;
    return 0;
}

function splitCellValues(val) {
    if (!val) return [];
    const clean = val.replace(/\s+/g, ' ').trim();
    const match = clean.match(/(?:Full\s+Powers?|Upto\s+(?:Rs\.?\s*)?[\d.]+\s*(?:Lakh|Crore|Cr|er|1akh)?|Upto\s+lakh|Rs\.?\s*[\d.]+\s*(?:Lakh|Crore|Cr|er|1akh)?|NIL|-)$/i);
    if (match) {
        const second = match[0].trim();
        const first = clean.substring(0, clean.length - second.length).trim();
        if (first) {
            return [first.replace(/[.,\s]+$/, ''), second];
        }
        return [second];
    }
    return [clean];
}

function getSubItemRow(row, subItem) {
    const idx = getSubItemIndex(subItem);
    const splitField = (fieldVal) => {
        const parts = splitCellValues(fieldVal);
        if (parts.length === 0) return '';
        if (parts.length === 1) return parts[0];
        return parts[idx] || parts[parts.length - 1];
    };
    return {
        Nature: row.Nature,
        ED: splitField(row.ED),
        GM: splitField(row.GM),
        AGM: splitField(row.AGM),
        DGM: splitField(row.DGM),
        SM: splitField(row.SM)
    };
}

function extractClauseRow(chunks, clauseNumber) {
    const { baseRowSI, subItem } = getBaseSiTag(clauseNumber);
    const siRe = new RegExp(`\\[SI:\\s*${baseRowSI.replace('.', '\\.')}(?:\\)|\\.|\\s*\\]|\\s*\\(|\\s*\\||\\s+\\w)`, 'i');
    
    for (const chunk of chunks) {
        for (const line of (chunk.text || '').split('\n')) {
            if (!siRe.test(line)) continue;
            const extract = (key) => {
                const m = line.match(new RegExp(`\\[${key}:\\s*([^\\]]+)\\]`, 'i'));
                return m ? m[1].trim() : null;
            };
            let row = { 
                Nature: extract('Nature of Power') || '', 
                ED: extract('ED') || '',
                GM: extract('GM') || '', 
                AGM: extract('AGM') || '', 
                DGM: extract('DGM') || '', 
                SM: extract('SM') || '' 
            };
            if (row.ED || row.GM || row.AGM || row.DGM || row.SM) {
                if (subItem) {
                    row = getSubItemRow(row, subItem);
                }
                return row;
            }
        }
    }
    return null;
}

function parseLimitToLakh(raw) {
    if (!raw) return 0;
    let s = raw.toString().toUpperCase()
        .replace(/RS\.?\s*/g, '').replace(/UPTO\s*/g, '').replace(/,/g, '')
        .replace(/[.]+$/, '').trim();
    if (!s || s === '-' || s === 'NIL') return 0;
    if (s.includes('FULL') || s.includes('POWER')) return Infinity;
    if (s === 'LAKH') return 10; // "Upto lakh" maps to 10
    
    s = s.replace(/\bSO\b/g, '50')
         .replace(/\bS(\d)/g, '5$1')
         .replace(/(\d)[O]/gi, '$10')
         .replace(/[O](\d)/gi, '0$1')
         .replace(/[O]\b/g, '0');
    s = s.replace(/LAKHSH?|1AKH|LAKH/gi, 'LAKH').replace(/CRORE|CR\b/gi, 'CRORE')
         .replace(/\s+/g, ' ').trim();
    let m;
    m = s.match(/^([\d.]+)\s*CRORE$/i); if (m) return parseFloat(m[1]) * 100;
    m = s.match(/^([\d.]+)\s*LAKH$/i);  if (m) return parseFloat(m[1]);
    m = s.match(/^([\d.]+)$/);           if (m) return parseFloat(m[1]);
    return 0;
}

const AUTHORITY_ORDER = ['SM', 'DGM', 'AGM', 'GM', 'ED'];
const AUTHORITY_NAMES = {
    SM: 'Senior Manager (SM)', DGM: 'Deputy General Manager (DGM)',
    AGM: 'Additional General Manager (AGM)', GM: 'General Manager (GM)',
    ED: 'Executive Director (ED)'
};

function resolveAuthority(clauseRow, targetLakh) {
    for (const key of AUTHORITY_ORDER) {
        const limitLakh = parseLimitToLakh(clauseRow[key] || '');
        if (limitLakh >= targetLakh)
            return { key, name: AUTHORITY_NAMES[key], limitLakh, limitText: clauseRow[key] || '' };
    }
    const last = AUTHORITY_ORDER[AUTHORITY_ORDER.length - 1];
    return { key: last, name: AUTHORITY_NAMES[last], limitLakh: Infinity, limitText: 'Full Powers' };
}

// Mock chunk data from Page 3 of the PDF
const chunks = [
    {
        text: `[SI: 1. Works: annroval] | [Nature of Power: Technical and administrative of cost estimates]\n[SI: c) All townshin i) ii)] | [Nature of Power: works relating to repair & maintenance / nlant area/ mine.area Alteration/Modification Maintenance/ Repair] | [ED: Upto Rs. 1 Cr full Powers] | [GM: Upto Rs.40 lakh. Full Powers] | [AGM: - Upto Rs. 20 Lakh] | [DGM: Upto lakh] | [SM: - Rs.10]`
    }
];

// Test cases for resolving authority
const testCases = [
    { clause: "1(c)(i)", target: 50, label: "1(c)(i), Rs 50 Lakh" },
    { clause: "1(c)(i)", target: 200, label: "1(c)(i), Rs 2 Crore" },
    { clause: "1(c)(ii)", target: 15, label: "1(c)(ii), Rs 15 Lakh" },
    { clause: "1(c)(ii)", target: 5, label: "1(c)(ii), Rs 5 Lakh" }
];

testCases.forEach(tc => {
    const row = extractClauseRow(chunks, tc.clause);
    console.log(`\n=== Test Case: ${tc.label} ===`);
    console.log("Extracted Row:", JSON.stringify(row, null, 2));
    if (row) {
        const res = resolveAuthority(row, tc.target);
        console.log(`Resolved: ${res.name} (Limit: ${res.limitText})`);
    } else {
        console.log("No row found!");
    }
});
