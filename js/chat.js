// js/chat.js
// 관전자 전용 채팅. battleroom1.html처럼 ?spectator=true 로 들어온 사람만 사용 가능.
import { auth, db } from "./firebase.js";
import { onAuthStateChanged }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const roomRef = doc(db, "rooms", ROOM_ID);
const isSpectatorView = new URLSearchParams(location.search).get("spectator") === "true";

const renderedIds = new Set();
let myUid = null;

// "(행동)" 부분만 강조 span으로 감싸고 나머지는 텍스트 노드로 추가.
// innerHTML을 쓰지 않아서 메시지에 HTML/스크립트가 들어와도 그대로 실행되지 않음(XSS 방지).
function appendFormattedText(container, text) {
  const regex = /\((.+?)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const span = document.createElement("span");
    span.className = "chat-action";
    span.textContent = `(${match[1]})`;
    container.appendChild(span);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function appendMessage(container, nickname, text) {
  const div = document.createElement("div");
  div.className = "chat-message";

  const nickSpan = document.createElement("span");
  nickSpan.className = "chat-nick";
  nickSpan.textContent = `${nickname}:`;
  div.appendChild(nickSpan);
  div.appendChild(document.createTextNode(" "));
  appendFormattedText(div, text);

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function subscribeChannel(gameStartedAt, container) {
  const ref = collection(db, "rooms", ROOM_ID, "chat_spectator");
  const q = gameStartedAt > 0
    ? query(ref, orderBy("ts"), where("ts", ">=", gameStartedAt))
    : query(ref, orderBy("ts"));

  onSnapshot(q, (snap) => {
    snap.docs.forEach((d) => {
      if (renderedIds.has(d.id)) return;
      renderedIds.add(d.id);
      const { nickname, text } = d.data();
      appendMessage(container, nickname, text);
    });
  });
}

async function sendChat(nickname) {
  const input = document.getElementById("spectator-chat-input");
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  const ref = collection(db, "rooms", ROOM_ID, "chat_spectator");
  await addDoc(ref, { uid: myUid, nickname, text, ts: Date.now() });
  input.value = "";
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !isSpectatorView) return; // 관전자가 아니면 채팅 자체를 켜지 않음
  myUid = user.uid;

  const section = document.getElementById("spectator-chat-section");
  if (section) section.style.display = "block";

  const userSnap = await getDoc(doc(db, "users", myUid));
  const nickname = userSnap.data()?.nickname ?? myUid.slice(0, 6);

  const roomSnap = await getDoc(roomRef);
  const gameStartedAt = roomSnap.data()?.game_started_at ?? 0;

  const container = document.getElementById("spectator-chat-messages");
  if (container) subscribeChannel(gameStartedAt, container);

  const sendBtn = document.getElementById("spectator-chat-send-btn");
  if (sendBtn) sendBtn.onclick = () => sendChat(nickname);

  const inputEl = document.getElementById("spectator-chat-input");
  if (inputEl) {
    inputEl.addEventListener("keypress", (e) => {
      if (e.key === "Enter") sendChat(nickname);
    });
  }
});