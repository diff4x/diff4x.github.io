/**
 * audio-player.js —— 悬浮音乐播放器模块（按需懒加载）
 */
import { $, saveMediaPosition } from './shared-utils.js';

let pagehideBound = false;

function bindPagehideSave() {
    if (pagehideBound) return;
    pagehideBound = true;
    window.addEventListener('pagehide', () => {
        if (window._isBombing) return;
        const a = document.getElementById('_audio');
        if (a) saveMediaPosition(a);
    });
}

export function openAudioPlayer(_song, _level, ctx) {
    const { store, emitEvent, adjSearchRight } = ctx;
    bindPagehideSave();
    saveMediaPosition($("#_audio"));

    const oldAudio = $("#audio"); if (oldAudio) oldAudio.remove();
    const oldBtn = $("#audio_btn"); if (oldBtn) oldBtn.remove();

    let playMode = 'list';
    let songs = store.playlist || [];
    let currentSongIndex = Math.max(0, songs.indexOf(_song));

    const stage = document.getElementById('stage');
    stage.insertAdjacentHTML('beforeend', `<div id="audio"> <div class="audio-progress"><div class="audio-progress-bar" id="a_bar"></div></div> <div class="audio_div"> <div class="header" id="a_hdr">${(_level && _level.includes("audio/")) ? (_level.split("audio/")[1] || "未分类/") : "未分类/"}</div> <ul class="playlist" id="_playlist"></ul><br> <button id="btn_prv">Prev</button><button id="btn_nxt">Next</button><br> <button id="btn_favs">Favorite Songs</button><button id="btn_all">All</button><br> <button id="btn_shf">Shuffle</button><button id="btn_slp">Single Loop</button><button id="btn_llp">List Loop</button><br> <button id="fav">+Fav-</button><audio id="_audio" controls></audio><button id="btn_cls">destroy</button> </div> </div>`);
    document.body.insertAdjacentHTML('beforeend', `<button id="audio_btn" title="单击显隐, 双击销毁"> 🎵 </button>`);

    const playerContainer = $("#audio"), progressBar = $("#a_bar"), header = $("#a_hdr"),
        playlistElement = $("#_playlist"), audioPlayer = $("#_audio"),
        prevButton = $("#btn_prv"), nextButton = $("#btn_nxt"),
        favListBtn = $("#btn_favs"), allBtn = $("#btn_all"),
        shuffleButton = $("#btn_shf"), singleLoopButton = $("#btn_slp"), listLoopButton = $("#btn_llp"),
        favBtn = $("#fav"), buttonElement = $("#audio_btn"), closeBtn = $("#btn_cls"),
        progressContainer = playerContainer.querySelector('.audio-progress');
    audioPlayer.volume = 0.15;

    const renderListHTML = (list) => list.map((s, i) =>
        `<li data-idx="${i}" data-path="${s.includes('/') ? s : _level + s}" title="${s.includes('/') ? s.split(s.split('/').pop())[0].split('audio/')[1] : ''}">${s.split('/').pop()}</li>`
    ).join('');

    const loadPlaylist = (newSongs, titleText) => {
        if (!newSongs || newSongs.length === 0) return;
        songs = newSongs; currentSongIndex = 0; header.textContent = titleText;
        playlistElement.innerHTML = renderListHTML(songs);
        playlistElement.firstElementChild.click();
    };

    playlistElement.onclick = (e) => {
        if (e.target.tagName === 'LI') {
            currentSongIndex = parseInt(e.target.dataset.idx);
            playSong();
        }
    };

    progressContainer.onclick = (e) => {
        const percent = (e.clientY - progressContainer.getBoundingClientRect().top) / progressContainer.clientHeight;
        audioPlayer.currentTime = percent * audioPlayer.duration;
    };
    prevButton.onclick = () => {
        currentSongIndex = playMode === 'shuffle' ? Math.floor(Math.random() * songs.length) : (currentSongIndex - 1 + songs.length) % songs.length;
        playSong();
    };
    nextButton.onclick = () => {
        currentSongIndex = playMode === 'shuffle' ? Math.floor(Math.random() * songs.length) : (currentSongIndex + 1) % songs.length;
        playSong();
    };
    favListBtn.onclick = () => loadPlaylist(store.favList, 'Favorite Songs');
    allBtn.onclick = () => {
        if (!window.data || window.data.length === 0) return;
        const allSongs = [];
        for (let i = 3; i < window.data.length; i += 4) {
            if (window.data[i] === "audio") allSongs.push(window.data[i - 1]);
        }
        loadPlaylist(allSongs, 'All');
    };
    const updateModeUI = () => {
        shuffleButton.classList.toggle("active2", playMode === 'shuffle');
        singleLoopButton.classList.toggle("active2", playMode === 'single');
        listLoopButton.classList.toggle("active2", playMode === 'list');
    };
    shuffleButton.onclick = () => { playMode = playMode === 'shuffle' ? 'list' : 'shuffle'; updateModeUI(); };
    singleLoopButton.onclick = () => { playMode = playMode === 'single' ? 'list' : 'single'; updateModeUI(); };
    listLoopButton.onclick = () => { playMode = playMode === 'list' ? 'single' : 'list'; updateModeUI(); };
    favBtn.onclick = () => {
        let items = store.favList || [];
        const currentSrc = decodeURIComponent(audioPlayer.src);
        let purePath = currentSrc.includes('/audio/') ? "audio/" + currentSrc.split('/audio/')[1] : currentSrc;
        if (items.includes(purePath)) {
            items = items.filter(item => item !== purePath);
            favBtn.classList.remove("active");
        } else {
            items.push(purePath);
            favBtn.classList.add("active");
        }
        store.favList = items;
        backfill();
        emitEvent('UPDATE_FAV_LIST', null, 'side');
    };
    closeBtn.onclick = () => {
        saveMediaPosition(audioPlayer);
        playerContainer.remove();
        buttonElement.remove();
        if ($("#search") && $("#side")) $("#search").style.right = ($("#side").offsetWidth + 4) + "px";
    };
    buttonElement.onclick = () => {
        if (!$("#audio")) return;
        playerContainer.style.display = playerContainer.style.display !== 'none' ? 'none' : 'block';
        if (typeof adjSearchRight === 'function') adjSearchRight();
    };
    buttonElement.ondblclick = closeBtn.onclick;
    audioPlayer.ontimeupdate = () => {
        progressBar.style.height = (audioPlayer.currentTime / audioPlayer.duration) * 100 + "%";
    };

    audioPlayer.onended = () => {
        if (playMode === 'single') audioPlayer.play().catch(() => { });
        else nextButton.click();
    };
    const syncUIState = () => {
        const currentSrc = decodeURIComponent(audioPlayer.src);
        let purePath = currentSrc.includes('/audio/') ? "audio/" + currentSrc.split('/audio/')[1] : currentSrc;
        favBtn.classList.toggle("active", (store.favList || []).includes(purePath));
        const listItems = Array.from(playlistElement.children);
        listItems.forEach((item, index) => item.classList.toggle("current", index === currentSongIndex));

        const currentLi = listItems[currentSongIndex];
        if (currentLi) {
            const originalDisplay = playerContainer.style.display;
            playerContainer.style.display = "block";
            currentLi.scrollIntoView({ block: 'center' });
            playerContainer.style.display = originalDisplay;
        }
    };
    const backfill = () => {
        const favItems = store.favList || [];
        Array.from(playlistElement.children).forEach(item => {
            item.classList.toggle("fav", favItems.some(f => f.endsWith(item.textContent)));
        });
    };
    const playSong = () => {
        const targetLi = playlistElement.children[currentSongIndex];
        if (!targetLi) return;
        saveMediaPosition(audioPlayer);
        audioPlayer.src = targetLi.dataset.path;
        audioPlayer.play().catch(() => { });
        syncUIState();
        backfill();
    };

    updateModeUI();
    if (typeof adjSearchRight === 'function') adjSearchRight();

    playlistElement.innerHTML = renderListHTML(songs);
    backfill();
    playSong();
}

export function playFavList(ctx) {
    const { store } = ctx;
    const existingPlayer = $("#audio");
    const existingHeader = existingPlayer ? existingPlayer.querySelector('.header') : null;
    if (existingPlayer && existingHeader && existingHeader.textContent === 'Favorite Songs') {
        if (existingPlayer.style.display === 'none') {
            const toggleBtn = $("#audio_btn");
            if (toggleBtn) toggleBtn.click();
        }
        return;
    }
    if (!Array.isArray(store.favList) || store.favList.length === 0) return;
    store.resource_type = "audio";
    const firstFav = store.favList[0];
    store.song_path = firstFav;
    if (!existingPlayer) {
        const fileName = firstFav.split("/").pop();
        const dir = firstFav.includes("/") ? firstFav.substring(0, firstFav.lastIndexOf('/') + 1) : "audio/";
        openAudioPlayer(fileName, dir, ctx);
    }
    setTimeout(() => {
        const buttons = document.querySelectorAll('#audio button');
        const favListBtn = Array.from(buttons).find(b => b.textContent === 'Favorite Songs');
        if (favListBtn) favListBtn.click();
        const playerContainer = $("#audio");
        if (playerContainer && playerContainer.style.display === 'none') {
            const toggleBtn = $("#audio_btn");
            if (toggleBtn) toggleBtn.click();
        }
    }, 50);
}

export function playPresetAudio(payload, ctx) {
    const { store, emitEvent } = ctx;
    store.resource_type = "audio";
    store.song_path = payload;
    const fileName = payload.split('/').pop();
    const dir = payload.substring(0, payload.lastIndexOf('/') + 1);

    openAudioPlayer(fileName, dir, ctx);

    setTimeout(() => {
        const slpBtn = document.getElementById("btn_slp");
        if (slpBtn && !slpBtn.classList.contains("active2")) slpBtn.click();
        const playerContainer = document.getElementById("audio");
        if (playerContainer && playerContainer.style.display !== 'none') {
            const toggleBtn = document.getElementById("audio_btn");
            if (toggleBtn) toggleBtn.click();
        }
    }, 100);

    emitEvent('#audio a', payload, 'side');
    emitEvent('show_current', null, 'side');
}
