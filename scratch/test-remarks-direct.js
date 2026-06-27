async function run() {
  console.log("Testing remarks queries on deployed Firebase function...");
  try {
    const response = await fetch("https://asia-south1-robotic-af198.cloudfunctions.net/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "what are the remarks for clause 4.2?" })
    });
    const data = await response.json();
    console.log("\nQuery: \"what are the remarks for clause 4.2?\"");
    console.log("--------------------------------------------------------------------------------");
    console.log("Answer:", data.answer);
    console.log("--------------------------------------------------------------------------------");
    console.log("Confidence:", data.confidence);
    console.log("Clause:", data.clause);
  } catch (err) {
    console.error("Error running verification:", err);
  }
}

run().then(() => process.exit(0));
