function splitCellValues(val) {
    if (!val) return [];
    const clean = val.replace(/\s+/g, ' ').trim();
    
    // The second part is at the end of the string and is a complete limit description
    // It starts with 'Full', 'Upto', 'Up to', 'Rs', or a number, or '-'
    const match = clean.match(/(?:Full\s+Powers?|Upto\s+(?:Rs\.?\s*)?[\d.]+\s*(?:Lakh|Crore|Cr|er|1akh)?|Upto\s+lakh|Rs\.?\s*[\d.]+\s*(?:Lakh|Crore|Cr|er|1akh)?|NIL|-)$/i);
    
    if (match) {
        const second = match[0].trim();
        const first = clean.substring(0, clean.length - second.length).trim();
        if (first) {
            // Remove trailing dot or comma from first part
            return [first.replace(/[.,\s]+$/, ''), second];
        }
        return [second];
    }
    
    return [clean];
}

const testStrings = [
    "Upto Rs. 1 Cr full Powers",
    "Upto Rs.40 lakh. Full Powers",
    "- Upto Rs. 20 Lakh",
    "Upto lakh",
    "- Rs.10",
    "Full Powers Full Powers",
    "- Upto 501akh"
];

testStrings.forEach(s => {
    console.log(`String: "${s}"`);
    console.log("Parts: ", splitCellValues(s));
    console.log("------------------");
});
