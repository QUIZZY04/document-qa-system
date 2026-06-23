async function run() {
    try {
        const response = await fetch("http://localhost:5000/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: "show power under dop clause 20" })
        });
        const data = await response.json();
        console.log("Response:", JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(err);
    }
}

run();
