const question = "what is the margin of purchase preference for Class-I local suppliers?";
const isHindiQuery = /[\u0900-\u097F]/.test(question) ||
    /\b(kaun|kya|kab|kaise|kis|kiske|kiski|kiska|hai|hain|ko|se|mein|me|par|ke|ki|ka|liye|tha|the|thi|raha|rahe|rahi|hoga|hoge|hogi|batao|bataiye|samjhaye|samjhao|chahiye|kar|sakte|sakta|sakti)\b/i.test(question);

console.log("isHindiQuery:", isHindiQuery);

const words = question.split(/\s+/);
for (const word of words) {
    const cleanWord = word.replace(/[?,.]/g, '');
    const isMatch = /\b(kaun|kya|kab|kaise|kis|kiske|kiski|kiska|hai|hain|ko|se|mein|me|par|ke|ki|ka|liye|tha|the|thi|raha|rahe|rahi|hoga|hoge|hogi|batao|bataiye|samjhaye|samjhao|chahiye|kar|sakte|sakta|sakti)\b/i.test(cleanWord);
    if (isMatch) {
        console.log(`Matched word: "${cleanWord}"`);
    }
}
