// js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCiAFkXZPlkB3PYqMEkxHUor4w9twYOGGs",
  authDomain: "eden-98094.firebaseapp.com",
  projectId: "eden-98094",
  storageBucket: "eden-98094.firebasestorage.app",
  messagingSenderId: "185087039241",
  appId: "1:185087039241:web:d4c7099326f660ff2ca5d8"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);