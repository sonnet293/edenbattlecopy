// js/login.js
import { auth } from "./firebase.js";
import { signInWithEmailAndPassword, onAuthStateChanged }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const message = document.getElementById("message");

onAuthStateChanged(auth, (user) => {
    if (user) {
        window.location.href = "main.html";
    }
});

loginBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    try {
        await signInWithEmailAndPassword(auth, email, password);

        window.location.href = "main.html";
    } catch (error) {
        message.textContent = "이메일과 비밀번호를 확인해주세요.";
        console.error(error);
    }
});