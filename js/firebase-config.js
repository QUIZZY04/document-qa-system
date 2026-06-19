// Firebase SDK Imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";

import { getFirestore } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

import { getStorage } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js";

import { getAuth } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";

const firebaseConfig = {

  apiKey: "AIzaSyBMMwRCiPedXsMN9V9InvFv89OypyPiOHk",
  authDomain: "robotic-af198.firebaseapp.com",
  databaseURL: "https://robotic-af198-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "robotic-af198",
  storageBucket: "robotic-af198.firebasestorage.app",
  messagingSenderId: "129207344993",
  appId: "1:129207344993:web:23ab38b818838f4b216f20",
  measurementId: "G-WNV12Y24ZJ"

};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Services
const db = getFirestore(app);

const storage = getStorage(app);

const auth = getAuth(app);

// Export
export { app, db, storage, auth };