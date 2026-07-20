// js/battleroom.js
import { auth, db } from "./firebase.js";
import { onAuthStateChanged }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const roomRef = doc(db, "rooms", ROOM_ID);
let myUid = null;
let myNickname = null;

function calcMySlot(room) {
    if (!room || !myUid) return null;
    if (room.player1_uid === myUid) return "player1";
    if (room.player2_uid === myUid) return "player2";
    if ((room.spectators ?? []).includes(myUid)) return "spectator";
    return null;
}

onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    myUid = user.uid;

    const userSnap = await getDoc(doc(db, "users", myUid));
    const userData = userSnap.data();
    myNickname = userData.nickname;

    await joinRoom();
    listenRoom();
    setupButtons();
});

async function joinRoom() {
    const roomSnap = await getDoc(roomRef);
    const room = roomSnap.data();

    if (calcMySlot(room)) return;

    if (room.game_started) {
        await joinAsSpectator(room);
        return;
    }

    if (!room.player1_uid) {
        await updateDoc(roomRef, { player1_uid: myUid, player1_name: myNickname });
    } else if (!room.player2_uid) {
        await updateDoc(roomRef, { player2_uid: myUid, player2_name: myNickname });
    } else {
        await joinAsSpectator(room);
    }
}

async function joinAsSpectator(room) {
    const spectators = room.spectators ?? [];
    if (spectators.includes(myUid)) return;

    await updateDoc(roomRef, {
        spectators: [...spectators, myUid],
        spectator_names: [...(room.spectator_names ?? []), myNickname]
    });
}

function listenRoom() {
    onSnapshot(roomRef, async (snap) => {
        const room = snap.data();
        if (!room) return;

        const mySlot = calcMySlot(room);
        document.getElementById("player1").innerText = "Player1: " + (room.player1_name ?? "대기");
        document.getElementById("player2").innerText = "Player2: " + (room.player2_name ?? "대기");

        renderSpectators(room);
        updateButtonsBySlot(room, mySlot);

        if (room.player1_ready && room.player2_ready && !room.game_started) {
            if (mySlot === "player1" || mySlot === "player2") {
                const firestoreSlot = mySlot === "player1" ? "p1" : "p2";
                const userSnap = await getDoc(doc(db, "users", myUid));
                const myEntry = userSnap.data()?.entry ?? [];
                const myEntryWithMax = myEntry.map(pkmn => ({ ...pkmn, maxHp: pkmn.hp }));

                await updateDoc(roomRef, {
                    [`${firestoreSlot}_entry`]: myEntryWithMax,
                    [`${firestoreSlot}_active_idx`]: 0,
                });

                if (mySlot === "player1") {
                    await updateDoc(roomRef, { game_started: true, game_started_at: Date.now() });
                }
            }
        }

        if (room.game_started && mySlot) {
            const roomNumber = ROOM_ID.replace("battleroom", "");
            if (mySlot === "spectator") {
                location.href = `../games/battleroom${roomNumber}.html?spectator=true`;
            } else {
                location.href = `../games/battleroom${roomNumber}.html`;
            }
        }
    });
}

function updateButtonsBySlot(room, mySlot) {
    const isPlayer = mySlot === "player1" || mySlot === "player2";

    const readyBtn = document.getElementById("readyBtn");
    const leaveBtn = document.getElementById("leaveBtn");

    if (readyBtn) readyBtn.style.display = isPlayer ? "inline-block" : "none";
    if (leaveBtn) leaveBtn.disabled = isPlayer && !!room.game_started;
}

function renderSpectators(room) {
    const el = document.getElementById("spectator-list");
    if (!el) return;
    const names = room.spectator_names ?? [];
    el.innerText = names.length > 0 ? "관전자: " + names.join(", ") : "관전자 없음";
}

function setupButtons() {
  document.getElementById("readyBtn").onclick = async () => {
    const roomSnap = await getDoc(roomRef);
    const mySlot = calcMySlot(roomSnap.data());
    if (mySlot === "player1") await updateDoc(roomRef, { player1_ready: true });
    if (mySlot === "player2") await updateDoc(roomRef, { player2_ready: true });
  };
  
  document.getElementById("leaveBtn").onclick = async () => {
    const roomSnap = await getDoc(roomRef);
    const room = roomSnap.data();
    const mySlot = calcMySlot(room);
    const isPlayer = mySlot === "player1" || mySlot === "player2";
    
    if (isPlayer && room.game_started) {
      return;
    }
    await leaveRoom(mySlot, room);
  };
}

async function leaveRoom(mySlot, room) {
    if (mySlot === "player1" || mySlot === "player2") {
        const spectators = room.spectators ?? [];
        const spectatorNames = room.spectator_names ?? [];

        if (spectators.length > 0) {
            const randIdx = Math.floor(Math.random() * spectators.length);
            await updateDoc(roomRef, {
                [`${mySlot}_uid`]: spectators[randIdx],
                [`${mySlot}_name`]: spectatorNames[randIdx],
                [`${mySlot}_ready`]: false,
                spectators: spectators.filter((_, i) => i !== randIdx),
                spectator_names: spectatorNames.filter((_, i) => i !== randIdx)
            });
        } else {
            await updateDoc(roomRef, {
                [`${mySlot}_uid`]: null,
                [`${mySlot}_name`]: null,
                [`${mySlot}_ready`]: false
            });
        }
    } else {
        await updateDoc(roomRef, {
            spectators: (room.spectators ?? []).filter(u => u !== myUid),
            spectator_names: (room.spectator_names ?? []).filter(n => n !== myNickname)
        });
    }
    location.href = "../main.html";
}