const tests = [
    "tell me about clause 15(a)",
    "what does clause 15(b) cover",
    "approving authority under clause 10 B",
    "tell me about clause 15",
    "who is competent authority under clause 4.3",
    "clause 4.1 for 21 lakh",
    "what about 15(c)"
];

const clauseRegex = /\b(?:clause|cl|section|si|item|s\.no|no\.?|number)\s+(\d+\.\d+(?:\([a-z]\))?|\d+\s+[a-z]?|\d+(?:\([a-z]\))?|\d+)(?!\w)|(\b\d+\.\d+(?:\([a-z]\))?\b|\b\d+\([a-z]\)(?!\w))/gi;

for (const t of tests) {
    const clauseMatches = [];
    let match;
    clauseRegex.lastIndex = 0;
    while ((match = clauseRegex.exec(t)) !== null) {
        if (match[1]) clauseMatches.push(match[1].trim());
        else if (match[2]) clauseMatches.push(match[2].trim());
    }
    console.log(`Query: "${t}" -> Matches:`, clauseMatches);
}
