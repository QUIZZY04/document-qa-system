function normalize(question) {
    let q = question.toLowerCase()
        .replace(/(?:रुपये|रुपए|रुपया|रु\.?|रू\.?)/g, 'rs')
        .replace(/(?:लाख|ल\b)/g, 'lakh')
        .replace(/(?:करोड़|करोड|सीआर\b)/g, 'crore')
        .replace(/(?:क्लॉज|क्लाज|धारा)/g, 'clause');
    let prev;
    do {
        prev = q;
        q = q
            // 1. Spacing around parentheses: e.g. "1 ( c )" -> "1(c)", "1 (c)" -> "1(c)"
            .replace(/(\d+)\s*\(\s*([a-z])\s*\)/gi, '$1($2)')
            .replace(/(\d+)\s*\(\s*(i+|v|x)\s*\)/gi, '$1($2)')
            .replace(/([a-z])\s*\(\s*(i+|v|x)\s*\)/gi, '$1($2)')
            
            // 2. Pre-combine single letters/numbers with space/dot/dash/slash: e.g. "1 c" -> "1(c)", "1-c" -> "1(c)", "1.c" -> "1(c)"
            .replace(/\b(\d+)\s*(?:sub\s*[-]?\s*clause|part|section|item|no\.?|[-/])\s*([a-z])\b/gi, '$1($2)')
            .replace(/\b(\d+)\s+([a-z])\b/gi, '$1($2)')
            .replace(/\b(\d+)\s*\.\s*([a-z])\b/gi, '$1($2)')
            
            // 2b. Combine digit-letter with space-subitem: e.g. "1c ii" -> "1(c)(ii)", "1c-ii" -> "1(c)(ii)"
            .replace(/\b(\d+)([a-z])\s*(?:sub\s*[-]?\s*clause|part|section|item|no\.?|[-/])?\s*\(?\s*(i+|v|x|[a-z])\s*\)?(?!\w)/gi, '$1($2)($3)')
            
            // 3. Double nest matching: "1(c) ii" or "1(c) (ii)" or "1(c) part ii" -> "1(c)(ii)"
            .replace(/(\d+)\s*\(\s*([a-z])\s*\)\s*(?:sub\s*[-]?\s*clause|part|section|item|no\.?|[-/])?\s*\(?\s*(i+|v|x|[a-z])\s*\)?(?!\w)/gi, '$1($2)($3)')
            
            // 4. Decimal sub-clause matching: "22.2 iii" or "22.2(iii)" or "22.2-iii" -> "22.2(iii)"
            .replace(/(\d+\.\d+)\s*(?:sub\s*[-]?\s*clause|part|section|item|no\.?|[-/])?\s*\(?\s*(i+|v|x|[a-z])\s*\)?(?!\w)/gi, '$1($2)')
            
            // 5. Spacing cleanup inside double parenthesis: e.g. "1(c)( ii)" -> "1(c)(ii)"
            .replace(/(\d+)\s*\(\s*([a-z])\s*\)\s*\(\s*(i+|v|x|[a-z])\s*\)/gi, '$1($2)($3)');
    } while (q !== prev);
    return q;
}

const clauseRegex = /\b(?:clause|cl|section|si|item|s\.no|no\.?|number)\s+(\d+(?:\.\d+)?(?:\([a-z\d]+\)){0,2}|\d+\s*[a-z]?|\d+)(?!\w)|((?<!\w)\d+(?:\.\d+)?(?:\([a-z\d]+\)){1,2}(?!\w))/gi;

function extractClauses(normalizedQ) {
    const clauseMatches = [];
    let match;
    while ((match = clauseRegex.exec(normalizedQ)) !== null) {
        if (match[1]) clauseMatches.push(match[1]);
        else if (match[2]) clauseMatches.push(match[2]);
    }
    return clauseMatches;
}

const testStrings = [
    "who is approving authority under clause 1 c ii for Rs 15 lakh",
    "who is approving authority under clause 1 (c) ii for Rs 15 lakh",
    "who is approving authority under clause 1 (c) (ii) for Rs 15 lakh",
    "who is approving authority under clause 1c ii for Rs 15 lakh",
    "who is approving authority under clause 1 c (ii) for Rs 15 lakh",
    "who is approving authority under clause 22.2(iii) for Rs 15 lakh",
    "who is approving authority under clause 22.2 iii for Rs 15 lakh",
    "who is approving authority under clause 22.2 (iii) for Rs 15 lakh",
];

testStrings.forEach(s => {
    const norm = normalize(s);
    const clauses = extractClauses(norm);
    console.log(`Original: "${s}"`);
    console.log(`Normalized: "${norm}"`);
    console.log(`Extracted:`, clauses);
    console.log("------------------");
});
