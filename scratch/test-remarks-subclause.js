async function run() {
  console.log("Testing remarks applicability on sub-clause query on deployed Firebase function...");
  try {
    const response = await fetch("https://asia-south1-robotic-af198.cloudfunctions.net/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "who is approving authority under clause 4.2 for Rs 26 lakh?" })
    });
    const data = await response.json();
    console.log("\nQuery: \"who is approving authority under clause 4.2 for Rs 26 lakh?\"");
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
