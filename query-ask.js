const question = "who is approving authority under clause 4.1 for Rs 2100000";

async function query() {
    console.log(`Sending API request to http://localhost:5000/ask with query: "${question}"...`);
    const response = await fetch("http://localhost:5000/ask", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ question: question })
    });
    
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    console.log("=== API Response ===");
    console.log(`Source PDF:  ${data.sourcePdf}`);
    console.log(`Page Number: ${data.pageNumber}`);
    console.log(`Confidence:  ${data.confidence}`);
    console.log(`Clause:      ${data.clause}`);
    console.log(`Answer:\n${data.answer}`);
}

query().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
