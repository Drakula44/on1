/* One Trainer — find the 1 in salsa. Vanilla JS, no build step. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const audio = $("audio");
  const HIT_MS = 80;            // tap within ±80 ms (real time) of a 1 = hit
  const HIST_MS = 300;          // tap histogram range
  const LS = "onetrainer.";

  // ---------- storage (never throws) ----------
  const store = {
    get(k, def) {
      try { const v = localStorage.getItem(LS + k); return v == null ? def : JSON.parse(v); }
      catch (_) { return def; }
    },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };

  // ---------- state ----------
  const S = {
    index: [], song: null, entry: null,
    beats: [],          // [{t, count}] with offset applied
    ones: [], fives: [],
    bounds: [],         // 8-count boundaries (times of 1s + last end)
    offset: 0,          // count shift in beats (F = +4)
    A: null, B: null, loop: false, snap: true,
    hide: false, reveal: false,
    click1: false, click5: false, clickAll: false, clickVol: 0.6,
    peaks: null, peaksRate: 0,
    activePreset: null,
    claveMode: "off",   // off | auto | son32 | son23 | rumba32 | rumba23 (saved per song)
    clave: { hits: [], slots: [], grid: [], label: "" },
    claveClick: false, claveVol: 0.6,
    tapTarget: "one",   // "one" = score taps against the 1s, "clave" = against the clave hits
    yt: {},             // songs/youtube.json: {id: {videoId, offset}}
    audioUrl: "", localOk: false, ranges: true, blobUrl: null, blobFor: null,
    lock: null, key: null, encrypted: false, // static build: <script id="ot-lock">, the AES key, this song's audio is .enc
    clickLatency: 0,    // ms added to click/clave times (saved per source: local / yt)
  };

  const fmt = (t, dec = 0) => {
    if (t == null || !isFinite(t)) return "–";
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, "0")}`;
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const rate = () => P.rate() || 1;
  const dur = () => P.duration() || (S.song && S.song.duration) || 0;

  // ---------- players: one interface over <audio> and the YouTube IFrame player ----------
  // { kind, time(), paused(), running(), duration(), rate(), play(), pause(), seek(t), setRate(v) }
  // running() = the clock is advancing (playing and not buffering). Events go through emit().
  const handlers = {};
  const on = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); };
  const emit = (src, ev) => { if (src === P) (handlers[ev] || []).forEach((fn) => fn()); };

  const local = {
    kind: "local",
    time: () => audio.currentTime,
    paused: () => audio.paused,
    running: () => !audio.paused,
    duration: () => (isFinite(audio.duration) && audio.duration) || 0,
    rate: () => audio.playbackRate || 1,
    play() { return audio.play(); },
    pause() { audio.pause(); },
    seek(t) { audio.currentTime = t; },
    setRate(v) { applyPitch(); audio.playbackRate = v; return v; },
    snapRate: (v) => v,
    stepRate: (v, dir) => v + dir * 0.05,
    load(src) { audio.src = src; applyPitch(); audio.playbackRate = +$("speed").value; },
    unload() { audio.pause(); if (audio.getAttribute("src")) { audio.removeAttribute("src"); audio.load(); } },
  };
  for (const ev of ["play", "pause", "seeking", "ended"]) audio.addEventListener(ev, () => emit(local, ev));
  audio.addEventListener("loadedmetadata", () => emit(local, "loaded"));

  // YouTube. getCurrentTime() is coarse and lags, so the clock is interpolated:
  // song time = anchor + (performance.now() - anchorAt) × rate, and each new sample from the
  // player nudges the anchor towards it (time constant TAU). The output never runs backwards
  // while playing. Big disagreements (> HARD s: seek, stall) re-anchor at once.
  // PLAYING alone doesn't mean the music moves: during a pre-roll ad (or a stall) the API can say
  // PLAYING while the content time stands still, and getCurrentTime() still extrapolates for up
  // to 1 s past the last post (www-widgetapi.js), so the clock used to run on through the ad and
  // the counter got ahead of the music. So the clock is "live" only while the iframe keeps posting
  // a moving content time: on PLAYING it starts at once (provisionally); if no new time is posted
  // within STALL s it snaps back and freezes, and re-anchors hard once the main video moves.
  const YT_TAU = 0.5, YT_HARD = 0.3, YT_STALL = 0.75;
  const yt = {
    kind: "yt", player: null, ready: false, error: null, state: -1, videoId: null, offset: 0, wantPlay: false,
    baseOffset: 0, nudge: 0,  // offset = youtube.json offset + the user's per-song nudge (song time = YouTube time + offset)
    rates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], r: 1,
    anchor: 0, anchorAt: 0, lastRaw: null, lastSampleAt: 0, lastOut: -Infinity,
    seekTarget: null, seekAt: 0,
    live: false, gatePost: null, lastPost: null, lastPostAt: 0, liveFrom: 0, waitSince: 0,
    log: null,           // set to [] to record [perfNow, raw, smoothed] per call (tests)
    raw() { return this.player.getCurrentTime() + this.offset; },
    // the content time as last posted by the iframe (not extrapolated); getCurrentTime() if that field is gone
    posted() {
      const v = this.player.playerInfo && this.player.playerInfo.currentTime;
      return typeof v === "number" ? v : this.player.getCurrentTime();
    },
    // is the player on our video? (an ad or a stale cue reports another id / length)
    onMain() {
      try {
        const vd = this.player.getVideoData && this.player.getVideoData();
        if (vd && vd.video_id && vd.video_id !== this.videoId) return false;
        const d = this.player.getDuration(), want = S.song && S.song.duration;
        if (d > 0 && want && Math.abs(d + this.offset - want) > 5) return false;
      } catch (_) { /* treat as main */ }
      return true;
    },
    // PLAYING began (or a seek): run at once, but only until STALL s pass without a new posted time
    startLive(now) {
      this.live = true; this.lastPost = this.posted(); this.lastPostAt = now; this.liveFrom = now;
    },
    watch(now) {
      // called on every time(): opens / closes the "live" gate from the iframe's posted content time
      const post = this.posted();
      const moved = post !== this.lastPost;
      if (moved) { this.lastPost = post; this.lastPostAt = now; }
      if (this.state !== 1) return;
      if (!this.live) {
        if (moved && Math.abs(post - this.gatePost) > 0.01 && this.onMain()) {
          const raw = this.raw();
          if (this.seekTarget != null && Math.abs(raw - this.seekTarget) > 1 && now - this.seekAt < 2000) return; // stale pre-seek post
          // the main video is moving: take its position, hard
          this.live = true; this.seekTarget = null; this.waitSince = 0;
          this.anchor = raw; this.anchorAt = now; this.lastRaw = raw; this.lastSampleAt = now; this.lastOut = -Infinity;
        }
      } else if (now - this.lastPostAt > YT_STALL * 1000 / Math.min(1, this.r) || !this.onMain()) {
        // PLAYING, but the content time stands still (ad, stall). Freeze where the music is: at the
        // seek target, at the play position if nothing was posted since, or just past the last post.
        const fresh = this.lastPostAt > this.liveFrom;
        const at = this.seekTarget != null ? this.seekTarget
          : Math.min(this.est(now), this.lastPost + this.offset + (fresh ? 0.3 * this.r : 0));
        this.live = false; this.gatePost = post; this.waitSince = now;
        this.anchor = at; this.anchorAt = now; this.lastRaw = null; this.lastOut = -Infinity;
      }
    },
    est(now) { return this.anchor + (now - this.anchorAt) / 1000 * this.r; },
    rebase(now) {
      // take the player's position as truth (after play/pause/buffer); ignore it while a seek is still in flight
      if (!this.ready) return;
      const raw = this.raw();
      if (this.seekTarget != null && Math.abs(raw - this.seekTarget) > 1 && now - this.seekAt < 2000) return;
      this.seekTarget = null;
      this.anchor = raw; this.anchorAt = now; this.lastRaw = raw; this.lastSampleAt = now; this.lastOut = -Infinity;
    },
    sample(now) {
      const raw = this.raw();
      if (raw === this.lastRaw) return;
      const dt = (now - this.lastSampleAt) / 1000;
      this.lastRaw = raw; this.lastSampleAt = now;
      if (this.seekTarget != null) {
        if (Math.abs(raw - this.seekTarget) > 1 && now - this.seekAt < 2000) return; // stale pre-seek value
        this.seekTarget = null;
      }
      if (this.state !== 1) { this.anchor = raw; this.anchorAt = now; return; }
      if (!this.live) return; // PLAYING but not moving yet: the clock stays frozen
      const err = raw - this.est(now);
      if (Math.abs(err) > YT_HARD) { this.anchor = raw; this.anchorAt = now; this.lastOut = -Infinity; return; }
      this.anchor += err * (1 - Math.exp(-Math.max(0, dt) / YT_TAU));
    },
    time() {
      if (!this.ready) return this.seekTarget != null ? this.seekTarget : this.anchor;
      const now = performance.now();
      this.watch(now);
      this.sample(now);
      let out;
      if (this.state === 1 && this.live) { out = Math.max(this.est(now), this.lastOut); this.lastOut = out; }
      else out = this.anchor;
      if (this.log) this.log.push([now, this.player.getCurrentTime() + this.offset, out]);
      return out;
    },
    paused() { return !(this.state === 1 || ((this.state === 3 || this.state === -1 || this.state === 5) && this.wantPlay)); },
    running() { if (this.ready) this.time(); return this.ready && this.state === 1 && this.live; },
    // PLAYING, but no content time moving yet (ad, start-up, stall)
    waiting() { return this.ready && this.state === 1 && !this.live; },
    setNudge(n) {
      // keep the music where it is and move the app clock: song time = YouTube time + offset
      n = Math.round(n * 1000) / 1000;
      const d = n - this.nudge;
      this.nudge = n; this.offset = this.baseOffset + n;
      this.anchor += d; this.lastRaw = null; this.lastOut = -Infinity;
      if (this.seekTarget != null) this.seekTarget += d;
    },
    duration() { const d = this.ready && this.player.getDuration(); return d ? d + this.offset : 0; },
    rate() { return this.r; },
    play() {
      if (this.error) { flashInfo("YouTube: " + this.error); return Promise.resolve(); }
      this.wantPlay = true;
      if (this.ready) this.player.playVideo();
      return Promise.resolve();
    },
    pause() { this.wantPlay = false; if (this.ready) this.player.pauseVideo(); },
    seek(t) {
      const now = performance.now();
      this.anchor = t; this.anchorAt = now; this.lastOut = -Infinity;
      this.seekTarget = t; this.seekAt = now;
      if (this.state === 1) this.startLive(now);
      if (this.ready) this.player.seekTo(Math.max(0, t - this.offset), true);
      emit(this, "seeking");
    },
    snapRate(v) {
      const ok = this.rates.filter((x) => x >= 0.5 - 1e-6 && x <= 1.25 + 1e-6);
      return ok.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), 1);
    },
    stepRate(v, dir) {
      const ok = this.rates.filter((x) => x >= 0.5 - 1e-6 && x <= 1.25 + 1e-6);
      const nxt = dir > 0 ? ok.find((x) => x > v + 1e-6) : ok.slice().reverse().find((x) => x < v - 1e-6);
      return nxt != null ? nxt : v;
    },
    setRate(v) {
      v = this.snapRate(v);
      const now = performance.now();
      if (this.state === 1 && this.live) { this.anchor = this.est(now); this.anchorAt = now; }
      this.r = v;
      if (this.ready) this.player.setPlaybackRate(v);
      return v;
    },
    async load(videoId, offset, startAt, nudge) {
      this.error = null;
      this.videoId = videoId; this.baseOffset = offset || 0; this.nudge = nudge || 0; this.offset = this.baseOffset + this.nudge; this.wantPlay = false;
      this.anchor = startAt || 0; this.anchorAt = performance.now(); this.lastOut = -Infinity; this.lastRaw = null; this.live = false;
      this.seekTarget = startAt ? startAt : null; this.seekAt = performance.now();
      $("ytPane").hidden = false;
      $("ytStatus").textContent = "loading YouTube player…";
      const YTns = await loadYTApi();
      if (this.videoId !== videoId) return;
      const start = Math.max(0, (startAt || 0) - this.offset);
      if (this.player && this.ready) {
        this.state = -1;
        this.player.cueVideoById({ videoId, startSeconds: start });
        $("ytStatus").textContent = "";
        return;
      }
      if (this.player) return; // still creating; onReady cues this.videoId
      this.player = new YTns.Player("ytPlayer", {
        width: 356, height: 200, videoId,
        playerVars: { playsinline: 1, rel: 0, disablekb: 1, fs: 0, start: Math.floor(start) },
        events: {
          onReady: () => {
            this.ready = true;
            if (this.player.getVideoData && this.player.getVideoData().video_id !== this.videoId) this.player.cueVideoById(this.videoId);
            this.updateRates();
            this.setRate(this.r);
            if (this.seekTarget != null) this.player.seekTo(Math.max(0, this.seekTarget - this.offset), true);
            $("ytStatus").textContent = "";
            if (this.wantPlay) this.player.playVideo();
            emit(this, "loaded");
          },
          onStateChange: (e) => this.onState(e.data),
          onPlaybackRateChange: (e) => {
            const now = performance.now();
            if (this.state === 1 && this.live) { this.anchor = this.est(now); this.anchorAt = now; }
            this.r = e.data || 1;
            emit(this, "ratechange");
          },
          onError: (e) => {
            const msg = { 2: "bad video id", 5: "HTML5 player error", 100: "video not found or private", 101: "embedding disabled by the owner", 150: "embedding disabled by the owner" }[e.data] || "error " + e.data;
            this.error = msg; this.wantPlay = false;
            $("ytStatus").innerHTML = `<span class="conf-low">YouTube can't play this video here: ${escapeHtml(msg)}.</span>` +
              (S.localOk ? " Switch the source to the local mp3." : " Run the app locally with the mp3 to practise this song.");
            console.warn("YouTube player error", e.data, msg);
            emit(this, "pause");
          },
        },
      });
    },
    onState(st) {
      const prev = this.state;
      this.state = st;
      const now = performance.now(), wasLive = this.live;
      if (st !== 1) this.live = false;
      if (st === 1) { this.rebase(now); if (prev !== 1) this.startLive(now); this.wantPlay = true; this.updateRates(); emit(this, "play"); }
      else if (st === 2) { this.rebase(now); this.wantPlay = false; emit(this, "pause"); }
      else if (st === 3) { if (prev === 1 && wasLive) { this.anchor = this.est(now); this.anchorAt = now; } }
      else if (st === 0) { this.wantPlay = false; this.rebase(now); emit(this, "ended"); emit(this, "pause"); }
      else if (st === 5) { emit(this, "loaded"); }
    },
    updateRates() {
      try {
        const rs = this.player.getAvailablePlaybackRates();
        if (rs && rs.length > 1) this.rates = rs.slice().sort((a, b) => a - b);
      } catch (_) { /* keep the defaults */ }
    },
    unload() {
      this.wantPlay = false; this.videoId = null;
      if (this.ready) { try { this.player.stopVideo(); } catch (_) { /* ignore */ } }
      $("ytPane").hidden = true;
    },
  };
  let ytApi = null;
  function loadYTApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (!ytApi) {
      ytApi = new Promise((res, rej) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(window.YT); };
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        s.onerror = () => rej(new Error("could not load the YouTube IFrame API (offline?)"));
        document.head.appendChild(s);
        setTimeout(() => rej(new Error("YouTube IFrame API timed out")), 20000);
      }).catch((err) => { ytApi = null; $("ytStatus").textContent = err.message; throw err; });
    }
    return ytApi;
  }
  let P = local;

  // index of last element with value <= t (arr sorted, getter f)
  function bsearch(arr, t, f = (x) => x) {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (f(arr[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function nearest(arr, t) {
    if (!arr.length) return -1;
    const i = bsearch(arr, t);
    if (i < 0) return 0;
    if (i >= arr.length - 1) return arr.length - 1;
    return t - arr[i] <= arr[i + 1] - t ? i : i + 1;
  }

  // ---------- encrypted audio (the static build from build_site.py) ----------
  // index.html carries <script id="ot-lock"> {salt, iterations, check}; songs/<audio>.enc is
  // a 12-byte IV + AES-GCM ciphertext. The key is PBKDF2-SHA256(password). serve.py has no lock.
  const LOCK_TOKEN = "one-trainer:ok";
  const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const bytesb64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
  function aesOpen(key, buf) {
    const u = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: u.subarray(0, 12) }, key, u.subarray(12));
  }
  async function keyOk(key) {
    try { return new TextDecoder().decode(await aesOpen(key, b64bytes(S.lock.check))) === LOCK_TOKEN; }
    catch (_) { return false; }
  }
  async function deriveKey(pw) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64bytes(S.lock.salt), iterations: S.lock.iterations },
      base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }
  // resolves once the songs are unlocked (S.key) or the user picked "YouTube only" (S.key stays null)
  async function unlock() {
    const saved = store.get("key", null);
    if (saved && saved.salt === S.lock.salt && window.crypto && crypto.subtle) {
      try {
        const k = await crypto.subtle.importKey("raw", b64bytes(saved.key), "AES-GCM", true, ["decrypt"]);
        if (await keyOk(k)) { S.key = k; return; }
      } catch (_) { /* ask again */ }
    }
    if (saved) { try { localStorage.removeItem(LS + "key"); } catch (_) { /* ignore */ } }
    const gate = $("lockGate"), msg = $("lockMsg"), go = $("lockGo");
    gate.hidden = false;
    if (!(window.crypto && crypto.subtle)) {
      msg.textContent = "This browser can't decrypt here (needs https).";
      go.disabled = true;
    }
    $("lockPw").focus();
    return new Promise((resolve) => {
      $("lockForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const pw = $("lockPw").value;
        if (!pw || go.disabled) return;
        msg.className = "lock-msg busy"; msg.textContent = "Checking…"; go.disabled = true;
        let k = null;
        try { k = await deriveKey(pw); } catch (err) { console.warn("key derivation failed:", err); }
        const good = !!k && await keyOk(k);
        go.disabled = false;
        if (!good) { msg.className = "lock-msg"; msg.textContent = "Wrong password."; $("lockPw").select(); return; }
        S.key = k;
        if ($("lockRemember").checked) {
          try { store.set("key", { salt: S.lock.salt, key: bytesb64(await crypto.subtle.exportKey("raw", k)) }); } catch (_) { /* ignore */ }
        }
        gate.hidden = true; $("lockPw").value = ""; resolve();
      });
      $("lockSkip").addEventListener("click", () => { gate.hidden = true; $("lockPw").value = ""; resolve(); });
    });
  }

  // ---------- song loading ----------
  async function loadIndex() {
    try {
      const y = await fetch("songs/youtube.json", { cache: "no-store" });
      S.yt = y.ok ? await y.json() : {};
    } catch (_) { S.yt = {}; }
    try {
      const r = await fetch("songs/index.json", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      S.index = await r.json();
    } catch (err) {
      // no index: list the songs that have a YouTube mapping
      console.warn("songs/index.json unavailable, using songs/youtube.json:", err);
      S.index = Object.keys(S.yt).map((id) => ({ id, title: id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), json: id + ".json", audio: id + ".mp3" }));
    }
    const sel = $("song");
    sel.innerHTML = "";
    S.index.forEach((e, i) => {
      const o = document.createElement("option");
      o.value = i; o.textContent = `${e.title}${e.artist ? " — " + e.artist : ""}`;
      sel.appendChild(o);
    });
    const last = store.get("song", null);
    const i = Math.max(0, S.index.findIndex((e) => e.id === last));
    sel.value = i;
    if (S.index.length) await loadSong(i);
    else $("meta").textContent = "No songs in songs/index.json";
  }

  async function loadSong(i) {
    const e = S.index[i];
    S.entry = e;
    store.set("song", e.id);
    P.pause();
    const r = await fetch("songs/" + e.json, { cache: "no-store" });
    S.song = await r.json();
    if (S.entry !== e) return;
    S.offset = store.get("offset." + e.id, 0);
    S.claveMode = CLAVE_MODES.includes(store.get("clave." + e.id, "off")) ? store.get("clave." + e.id, "off") : "off";
    $("claveMode").value = S.claveMode;
    S.A = S.B = null; S.loop = false; S.activePreset = null; S.peaks = null;
    S.audioUrl = "songs/" + (e.audio || S.song.audio || e.id + ".mp3");
    S.encrypted = !!S.lock && /\.enc$/i.test(S.audioUrl);
    const head = S.encrypted && !S.key ? { ok: false, ranges: false } : await headInfo(S.audioUrl);
    S.localOk = head.ok; S.ranges = head.ranges;
    if (S.entry !== e) return;
    const ytOk = !!(S.yt[e.id] && S.yt[e.id].videoId);
    let src = store.get("source." + e.id, null);
    if ((src === "local" && !S.localOk) || (src === "yt" && !ytOk)) src = null;
    if (!src) src = S.localOk || !ytOk ? "local" : "yt";
    rebuildBeats();
    renderMeta(); renderPresets(); renderUserPresets(); updateLoopUI();
    resetTaps(true);
    setSource(src, false, 0);
    loadPeaks(e);
  }
  async function headInfo(url) {
    try {
      const r = await fetch(url, { method: "HEAD", cache: "no-store" });
      return { ok: r.ok, ranges: /bytes/i.test(r.headers.get("accept-ranges") || "") };
    } catch (_) { return { ok: false, ranges: false }; }
  }
  // Without Range support (e.g. `python -m http.server`) the browser can't seek in a streamed mp3,
  // so fetch it whole and play it from a blob: URL. Encrypted audio is always fetched whole and decrypted.
  async function localSrc(e) {
    if (S.ranges && !S.encrypted) return S.audioUrl;
    if (S.blobFor !== S.audioUrl) {
      const url = S.audioUrl, r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      const b = S.encrypted
        ? new Blob([await aesOpen(S.key, await r.arrayBuffer())], { type: /\.mp3\.enc$/i.test(url) ? "audio/mpeg" : "" })
        : await r.blob();
      if (url !== S.audioUrl) return null;
      if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
      S.blobUrl = URL.createObjectURL(b); S.blobFor = S.audioUrl;
    }
    return S.entry === e ? S.blobUrl : null;
  }

  // switch between the local mp3 and YouTube; keeps the position
  function setSource(src, save = true, at = P.time()) {
    const e = S.entry, map = S.yt[e.id];
    if (src === "yt" && !(map && map.videoId)) src = "local";
    if (save) store.set("source." + e.id, src);
    const sel = $("source");
    sel.value = src;
    sel.options[0].disabled = !S.localOk;
    sel.options[1].disabled = !(map && map.videoId);
    P.pause();
    if (src === "yt") {
      local.unload();
      P = yt;
      yt.load(map.videoId, +map.offset || 0, at, store.get("ytNudge." + e.id, 0)).catch((err) => console.warn(err));
    } else {
      yt.unload();
      P = local;
      if (S.localOk) {
        localSrc(e).then((u) => { if (u && P === local && S.entry === e) { local.load(u); if (at) audio.currentTime = at; } })
          .catch((err) => {
            console.warn("audio load failed:", err);
            if (S.entry === e) $("meta").insertAdjacentHTML("beforeend", ` · <span class="conf-low">${S.encrypted ? "could not decrypt" : "could not load"} ${escapeHtml(S.audioUrl)}</span>`);
          });
      }
      else { local.unload(); $("meta").insertAdjacentHTML("beforeend", S.encrypted ? ` · <span class="conf-low">songs are locked (reload to enter the password)</span>` : ` · <span class="conf-low">no audio file (${escapeHtml(S.audioUrl)}) and no YouTube mapping</span>`); }
    }
    document.body.classList.toggle("src-yt", P === yt);
    showYtNudge();
    $("srcNote").hidden = P !== yt;
    $("play").textContent = "▶ Play";
    S.clickLatency = store.get("clickLatency." + P.kind, 0);
    $("clickLat").value = S.clickLatency; $("clickLat-out").textContent = fmtMs(S.clickLatency);
    setSpeed(+$("speed").value);
    clickSched.resync = true; claveSched.resync = true; tapState.resync = true;
    draw();
  }
  const fmtMs = (v) => `${v > 0 ? "+" : ""}${Math.round(v)} ms`;

  function rebuildBeats() {
    const off = S.offset;
    S.beats = S.song.beats.map((b) => ({ t: b.t, count: ((b.count - 1 + off) % 8 + 8) % 8 + 1 }));
    S.ones = S.beats.filter((b) => b.count === 1).map((b) => b.t);
    S.fives = S.beats.filter((b) => b.count === 5).map((b) => b.t);
    if (off === 0 && S.song.eight_counts && S.song.eight_counts.length) {
      S.bounds = S.song.eight_counts.map((e) => e.start);
      S.bounds.push(S.song.eight_counts[S.song.eight_counts.length - 1].end);
    } else {
      S.bounds = S.ones.slice();
      const last = S.beats[S.beats.length - 1];
      if (last && last.t > S.bounds[S.bounds.length - 1]) S.bounds.push(last.t);
    }
    const o = ((off % 8) + 8) % 8;
    $("offsetinfo").textContent = o ? `counting shifted ${o > 4 ? o - 8 : "+" + o} beat${Math.abs(o > 4 ? o - 8 : o) === 1 ? "" : "s"}${o === 4 ? " (1↔5 swapped)" : ""}` : "";
    buildClave();
    clickSched.resync = true; tapState.resync = true;
  }

  // ---------- clave ----------
  // 16 slots per 8-count: slot = 2*(count-1) + (offbeat ? 1 : 0), so 1 = 0, 1& = 1, 2 = 2, ... 8& = 15
  const CLAVE = {
    son32: { name: "Son 3-2", slots: [0, 3, 6, 10, 12] },     // 1, 2&, 4 | 6, 7
    son23: { name: "Son 2-3", slots: [2, 4, 8, 11, 14] },     // 2, 3 | 5, 6&, 8
    rumba32: { name: "Rumba 3-2", slots: [0, 3, 7, 10, 12] }, // 1, 2&, 4& | 6, 7
    rumba23: { name: "Rumba 2-3", slots: [2, 4, 8, 11, 15] }, // 2, 3 | 5, 6&, 8&
  };
  const CLAVE_MODES = ["off", "auto", "son32", "son23", "rumba32", "rumba23"];
  const SLOT_LABELS = Array.from({ length: 16 }, (_, k) => (k % 2 ? "&" : String(k / 2 + 1)));

  // Clave hit times from the beat grid. count(i) gives the 1–8 count of beat i.
  // Offbeats are the midpoint between two beats (skipped across gaps, e.g. a break with no beats).
  function claveFromGrid(slots, count) {
    const B = S.beats, set = new Set(slots), hits = [];
    const gaps = B.slice(1).map((b, i) => b.t - B[i].t).sort((a, b) => a - b);
    const maxGap = 2 * (gaps[gaps.length >> 1] || 0.5);
    for (let i = 0; i < B.length; i++) {
      const base = 2 * (count(i) - 1);
      if (set.has(base)) hits.push(B[i].t);
      if (set.has(base + 1) && i + 1 < B.length && B[i + 1].t - B[i].t <= maxGap) hits.push((B[i].t + B[i + 1].t) / 2);
    }
    return hits;
  }
  // slot (0–15) of time t in the current (user-shifted) counting, rounded to the nearest half beat
  function slotAt(t, floor) {
    const i = bsearch(S.beats, t + 1e-3, (b) => b.t);
    if (i < 0) return null;
    const b = S.beats[i], n = S.beats[i + 1];
    if (!n) return 2 * (b.count - 1);
    const f = (t - b.t) / (n.t - b.t);
    if (floor) return 2 * (b.count - 1) + (f >= 0.5 ? 1 : 0);
    if (f < 0.25) return 2 * (b.count - 1);
    if (f < 0.75) return 2 * (b.count - 1) + 1;
    return 2 * (n.count - 1);
  }
  function buildClave() {
    const mode = S.claveMode, c = S.song && S.song.clave;
    let hits = [], label = "", note = "";
    if (!S.song || mode === "off") { /* none */ }
    else if (mode === "auto") {
      const key = c && typeof c.pattern === "string" && typeof c.direction === "string"
        ? c.pattern.toLowerCase() + c.direction.replace(/[^23]/g, "") : "";
      const conf = c && c.confidence != null && isFinite(+c.confidence) ? ` · conf ${(+c.confidence).toFixed(2)}` : "";
      if (c && Array.isArray(c.hits) && c.hits.length) {
        hits = c.hits.map(Number).filter(isFinite).sort((a, b) => a - b);
        note = `from JSON${CLAVE[key] ? ` (${CLAVE[key].name})` : ""}${conf}`;
      } else if (CLAVE[key]) {
        // pattern + direction are relative to the JSON's own counting, so ignore the user's shift
        const orig = S.song.beats;
        hits = claveFromGrid(CLAVE[key].slots, (i) => orig[i].count);
        note = `from JSON: ${CLAVE[key].name}${conf}`;
      } else {
        hits = claveFromGrid(CLAVE.son23.slots, (i) => S.beats[i].count);
        note = c ? "unrecognised clave in JSON, using Son 2-3" : "not detected, using Son 2-3";
      }
    } else {
      hits = claveFromGrid(CLAVE[mode].slots, (i) => S.beats[i].count);
    }
    // which slots the hits fall on in the user's counting (for the mini grid)
    const hitSlots = hits.map((t) => slotAt(t));
    const hist = new Array(16).fill(0);
    hitSlots.forEach((k) => { if (k != null) hist[k]++; });
    const mx = Math.max(...hist);
    const grid = hist.map((n) => mx > 0 && n >= 0.3 * mx);
    const gridKey = grid.map((x, k) => (x ? k : -1)).filter((k) => k >= 0).join();
    const match = Object.values(CLAVE).find((p) => p.slots.join() === gridKey);
    if (mode !== "off") label = match ? match.name : "custom";
    S.clave = { hits, hitSlots, grid, label, note };
    claveSched.resync = true; tapState.resync = true;
    if (S.tapTarget === "clave") tapState.hitOnes = new Set();
    renderClaveUI();
  }
  function setClaveMode(m, save = true) {
    S.claveMode = CLAVE_MODES.includes(m) ? m : "off";
    if (save && S.entry) store.set("clave." + S.entry.id, S.claveMode);
    $("claveMode").value = S.claveMode;
    buildClave();
    if (S.tapTarget === "clave") resetTaps(false);
    draw();
  }
  function cycleClave() { setClaveMode(CLAVE_MODES[(CLAVE_MODES.indexOf(S.claveMode) + 1) % CLAVE_MODES.length]); }
  function renderClaveUI() {
    const on = S.claveMode !== "off";
    let info = "";
    if (on) {
      info = `${S.clave.hits.length} hits`;
      if (S.claveMode === "auto") info = `${S.clave.label} in your count · ${S.clave.note} · ` + info;
      else if (S.offset) info = `in your shifted count · ` + info;
    }
    $("claveInfo").textContent = info;
    $("claveInfo").classList.toggle("conf-low", S.claveMode === "auto" && /not detected|unrecognised/.test(S.clave.note));
    const cells = $("claveGrid").children;
    for (let k = 0; k < 16; k++) cells[k].classList.toggle("on", !!S.clave.grid[k]);
    $("claveGrid").hidden = !on;
  }

  function renderMeta() {
    const s = S.song, c = s.confidence || {};
    const lvl = c.one_vs_five || "?";
    const bpm = s.tempo && (s.tempo.bpm || s.tempo.bpm_from_beats);
    $("meta").innerHTML =
      `<b>${bpm ? Math.round(bpm) : "?"}</b> bpm · key <b>${s.key || "?"}</b> · ` +
      `1-vs-5 confidence <b class="conf-${lvl}">${lvl}</b>` +
      (c.one_vs_five_margin != null ? ` (margin ${(+c.one_vs_five_margin).toFixed(2)})` : "") +
      (lvl === "low" ? ` — <span class="conf-low">verify by ear, <kbd>F</kbd> swaps 1↔5</span>` : "");
    $("meta").title = s.method ? Object.entries(s.method).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
  }

  // ---------- waveform peaks (songs/<id>.peaks.json from make_peaks.py; else decode the local mp3 once) ----------
  async function loadPeaks(e) {
    try {
      const r = await fetch(`songs/${e.id}.peaks.json`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (S.entry !== e) return;
        S.peaks = Float32Array.from(j.peaks, (v) => v / 100); S.peaksRate = j.rate;
        drawTimeline();
        return;
      }
    } catch (_) { /* fall through */ }
    if (S.entry === e && S.localOk) localSrc(e).then((u) => { if (u) decodePeaks(u, e); }).catch((err) => console.warn(err));
  }
  async function decodePeaks(src, e) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const buf = await (await fetch(src)).arrayBuffer();
      if (S.entry !== e) return;
      const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 2, 22050);
      const ab = await off.decodeAudioData(buf);
      if (S.entry !== e) return;
      const per = 100; // peaks per second
      const ch = ab.getChannelData(0), ch2 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : null;
      const step = ab.sampleRate / per, n = Math.floor(ch.length / step);
      const p = new Float32Array(n);
      let mx = 1e-9;
      for (let i = 0; i < n; i++) {
        let m = 0;
        const a = Math.floor(i * step), b = Math.floor((i + 1) * step);
        for (let j = a; j < b; j += 4) {
          const v = Math.abs(ch[j] + (ch2 ? ch2[j] : 0));
          if (v > m) m = v;
        }
        p[i] = m; if (m > mx) mx = m;
      }
      for (let i = 0; i < n; i++) p[i] /= mx;
      S.peaks = p; S.peaksRate = per;
      drawTimeline();
    } catch (err) {
      console.warn("waveform unavailable:", err);
    }
  }

  // ---------- transport ----------
  function applyPitch() {
    audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true;
  }
  // per-song manual YouTube offset, on top of youtube.json's (fix a song by ear)
  function setYtNudge(n) {
    n = clamp(Math.round(n * 1000) / 1000, -30, 30);
    if (S.entry) store.set("ytNudge." + S.entry.id, n);
    yt.setNudge(n);
    showYtNudge();
    clickSched.resync = true; claveSched.resync = true; tapState.resync = true;
    draw();
  }
  function showYtNudge() {
    $("ytNudge-out").textContent = (yt.nudge >= 0 ? "+" : "−") + Math.abs(yt.nudge).toFixed(2) + " s";
  }
  let syncShownAt = 0;
  function showYtSync() {
    const now = performance.now();
    if (P !== yt || now - syncShownAt < 200) return;
    syncShownAt = now;
    if (!yt.ready || yt.error) { $("ytSync").textContent = ""; return; }
    const ytT = yt.waiting() ? yt.posted() + yt.offset : yt.raw(), app = yt.time(), d = (app - ytT) * 1000;
    const st = yt.waiting() ? `<span class="wait">waiting for the video to move (ad? buffering?) ${((now - yt.waitSince) / 1000).toFixed(1)} s</span>`
      : ({ 1: "playing", 2: "paused", 3: "buffering", 5: "cued", 0: "ended", "-1": "not started" }[yt.state] || "state " + yt.state);
    $("ytSync").innerHTML = `sync: YouTube ${ytT.toFixed(2)} s · app ${app.toFixed(2)} s · Δ ${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(0)} ms · ${st}`;
  }
  function togglePlay() {
    ensureCtx();
    if (P.paused()) {
      const t = P.time();
      if (S.loop && S.A != null && S.B != null && (t < S.A || t >= S.B)) seek(S.A);
      P.play().catch((e) => console.warn(e));
    } else P.pause();
  }
  function seek(t) {
    P.seek(clamp(t, 0, Math.max(0, dur() - 0.05)));
    clickSched.resync = true; claveSched.resync = true; tapState.resync = true;
    draw();
  }
  // dir: ±1 for the [ ] keys (YouTube only has a few rates, so step to the next one)
  function setSpeed(v, dir = 0) {
    if (dir) v = P.stepRate(+$("speed").value, dir);
    v = clamp(Math.round(P.snapRate(v) * 100) / 100, 0.5, 1.25);
    $("speed").value = v; $("speed-out").textContent = v.toFixed(2) + "×";
    P.setRate(v);
    clickSched.resync = true; claveSched.resync = true;
  }
  function seekEight(dir) {
    const t = P.time(), b = S.bounds;
    const i = bsearch(b, t + 0.05);
    // ← goes to the start of this 8-count (or the previous one if we're right at its start)
    let j = dir < 0 ? (i >= 0 && t - b[i] > 0.4 ? i : i - 1) : i + 1;
    j = clamp(j, 0, b.length - 1);
    seek(b.length ? b[j] : t + dir * 3);
  }

  // ---------- A-B loop ----------
  function snapT(t) {
    const i = nearest(S.bounds, t);
    return i < 0 ? t : S.bounds[i];
  }
  function setA(t = P.time()) {
    S.A = S.snap ? snapT(t) : t;
    if (S.B != null && S.B <= S.A) S.B = null;
    S.activePreset = null; updateLoopUI();
  }
  function setB(t = P.time()) {
    let b = S.snap ? snapT(t) : t;
    if (S.A != null && b <= S.A) {
      if (!S.snap) return;
      const i = bsearch(S.bounds, S.A + 0.01);
      b = S.bounds[Math.min(i + 1, S.bounds.length - 1)];
      if (b <= S.A) return;
    }
    S.B = b;
    if (S.A != null) S.loop = true;
    S.activePreset = null; updateLoopUI();
  }
  function loopThisEight() {
    const t = P.time(), i = Math.max(0, bsearch(S.bounds, t + 0.02)); // pickup -> first 8-count
    if (i >= S.bounds.length - 1) return;
    setLoop(S.bounds[i], S.bounds[i + 1], null, false);
  }
  function setLoop(a, b, presetKey, jump = true) {
    S.A = a; S.B = b; S.loop = true; S.activePreset = presetKey;
    updateLoopUI();
    if (jump || P.time() < a || P.time() >= b) seek(a);
  }
  function shiftBoundary(t, dir) {
    const b = S.bounds, i = nearest(b, t);
    if (i < 0) return t;
    if (Math.abs(b[i] - t) < 0.03) return b[clamp(i + dir, 0, b.length - 1)];
    // not on a boundary: move by the length of the local 8-count
    const k = clamp(bsearch(b, t), 0, b.length - 2);
    return t + dir * (b[k + 1] - b[k]);
  }
  function nudgeLoop(dir) {
    if (S.A == null || S.B == null) { loopThisEight(); return; }
    const a = shiftBoundary(S.A, dir), b = shiftBoundary(S.B, dir);
    if (a === S.A || b <= a) return;
    const inside = P.time() >= S.A && P.time() < S.B;
    S.A = a; S.B = b; S.activePreset = null; updateLoopUI();
    if (S.loop && inside) seek(a); // restart at the new loop start
  }
  function updateLoopUI() {
    $("loopToggle").textContent = "Loop: " + (S.loop ? "on" : "off");
    $("loopToggle").classList.toggle("on", S.loop);
    $("snap").checked = S.snap;
    let info = "";
    if (S.A != null || S.B != null) {
      info = `A ${fmt(S.A, 2)} → B ${fmt(S.B, 2)}`;
      if (S.A != null && S.B != null) {
        const n = countEights(S.A, S.B);
        info += ` · ${(S.B - S.A).toFixed(1)}s${n ? ` · ${n} × 8` : ""}`;
      }
    }
    $("abinfo").textContent = info;
    document.querySelectorAll(".preset").forEach((el) => el.classList.toggle("active", el.dataset.key === S.activePreset));
    draw();
  }
  function countEights(a, b) {
    const i = S.bounds.findIndex((x) => Math.abs(x - a) < 0.03);
    const j = S.bounds.findIndex((x) => Math.abs(x - b) < 0.03);
    return i >= 0 && j > i ? j - i : 0;
  }

  // ---------- presets ----------
  const KIND_COLORS = { intro: "#5b6475", cuerpo: "#3f6d5a", mambo: "#7a4f8c", montuno: "#8c6a2f", coro: "#8c6a2f", break: "#a33a3a", outro: "#5b6475", section: "#3f5a7a" };
  function sectionColor(s) {
    const k = (s.kind || s.label || "").toLowerCase().replace(/[^a-z]/g, "");
    return KIND_COLORS[k] || KIND_COLORS[Object.keys(KIND_COLORS).find((x) => k.startsWith(x))] || "#4a5568";
  }
  function allPresets() {
    const js = (S.song.presets || []).map((p, i) => ({ ...p, key: "j" + i }));
    const us = userPresets().map((p, i) => ({ ...p, key: "u" + i, user: true }));
    return js.concat(us);
  }
  function presetRow(p, n) {
    const el = document.createElement("div");
    el.className = "preset"; el.dataset.key = p.key;
    const col = p.kind === "break" ? KIND_COLORS.break : p.user ? "var(--accent)" : sectionColor({ label: p.name, kind: p.kind === "section" ? p.name : p.kind });
    el.style.borderLeftColor = col;
    el.innerHTML = `<span>${n <= 9 ? `<kbd>${n}</kbd> ` : ""}${escapeHtml(p.name)}</span><span class="t">${fmt(p.start)}–${fmt(p.end)}${p.user ? ' <span class="x" title="delete">✕</span>' : ""}</span>`;
    el.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("x")) { deleteUserPreset(+p.key.slice(1)); return; }
      ensureCtx();
      setLoop(p.start, p.end, p.key);
    });
    return el;
  }
  function renderPresets() {
    const box = $("presets"); box.innerHTML = "";
    allPresets().filter((p) => !p.user).forEach((p, i) => box.appendChild(presetRow(p, i + 1)));
    if (!box.children.length) box.textContent = "No presets in this song's JSON.";
  }
  function renderUserPresets() {
    const box = $("userPresets"); box.innerHTML = "";
    const base = (S.song.presets || []).length;
    allPresets().filter((p) => p.user).forEach((p, i) => box.appendChild(presetRow(p, base + i + 1)));
    if (!box.children.length) box.innerHTML = '<span class="abinfo">Set A and B, then save.</span>';
    updatePresetActive();
  }
  function updatePresetActive() {
    document.querySelectorAll(".preset").forEach((el) => el.classList.toggle("active", el.dataset.key === S.activePreset));
  }
  function userPresets() { return S.entry ? store.get("presets." + S.entry.id, []) : []; }
  function saveUserPreset() {
    if (S.A == null || S.B == null) { flashInfo("Set A and B first"); return; }
    const list = userPresets();
    const name = $("presetName").value.trim() || `${fmt(S.A, 1)}–${fmt(S.B, 1)}`;
    list.push({ name, start: S.A, end: S.B, kind: "user" });
    store.set("presets." + S.entry.id, list);
    $("presetName").value = "";
    S.activePreset = "u" + (list.length - 1);
    renderUserPresets();
  }
  function deleteUserPreset(i) {
    const list = userPresets(); list.splice(i, 1);
    store.set("presets." + S.entry.id, list);
    S.activePreset = null; renderUserPresets();
  }
  function jumpPreset(n) {
    const p = allPresets()[n - 1];
    if (p) setLoop(p.start, p.end, p.key);
  }
  function flashInfo(msg) {
    const el = $("abinfo"), old = el.textContent;
    el.textContent = msg; setTimeout(() => { if (el.textContent === msg) el.textContent = old; }, 1500);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------- clicks (WebAudio, scheduled ahead against P.time()) ----------
  let ctx = null;
  const clickSched = { next: 0, resync: true };
  function ensureCtx() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function playClick(when, kind) {
    const vol = S.clickVol * (kind === 1 ? 1 : kind === 5 ? 0.45 : 0.25);
    if (vol <= 0) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = kind === 1 ? "square" : "sine";
    o.frequency.value = kind === 1 ? 1760 : kind === 5 ? 1175 : 880;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol * 0.5, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, when + (kind === 1 ? 0.06 : 0.04));
    o.connect(g).connect(ctx.destination);
    o.start(when); o.stop(when + 0.08);
  }
  function scheduleClicks() {
    if (!ctx || !P.running() || !(S.click1 || S.click5 || S.clickAll)) { clickSched.resync = true; return; }
    const t = P.time(), r = rate(), lat = S.clickLatency / 1000, ahead = (0.15 + Math.max(0, -lat)) * r;
    if (clickSched.resync) { clickSched.next = bsearch(S.beats, t - 0.005, (b) => b.t) + 1; clickSched.resync = false; }
    while (clickSched.next < S.beats.length && S.beats[clickSched.next].t < t + ahead) {
      const b = S.beats[clickSched.next++];
      if (S.loop && S.B != null && b.t >= S.B - 0.005) { continue; }
      const kind = b.count === 1 ? 1 : b.count === 5 ? 5 : 0;
      const want = (kind === 1 && S.click1) || (kind === 5 && S.click5) || S.clickAll;
      if (!want) continue;
      const d = (b.t - t) / r + lat;   // seconds from now, with the user's click offset
      if (d < -0.01) continue;
      playClick(ctx.currentTime + Math.max(0, d), S.click1 || S.clickAll ? kind : 5);
    }
  }

  // woody clave: a short 2.5 kHz sine ping plus a band-passed noise tick
  let noiseBuf = null;
  function playClave(when) {
    const vol = S.claveVol;
    if (vol <= 0) return;
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 2500;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol * 0.6, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0005, when + 0.045);
    o.connect(g).connect(ctx.destination);
    o.start(when); o.stop(when + 0.06);
    const n = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), gn = ctx.createGain();
    n.buffer = noiseBuf; bp.type = "bandpass"; bp.frequency.value = 2500; bp.Q.value = 6;
    gn.gain.setValueAtTime(vol * 0.9, when);
    gn.gain.exponentialRampToValueAtTime(0.0005, when + 0.02);
    n.connect(bp).connect(gn).connect(ctx.destination);
    n.start(when); n.stop(when + 0.03);
  }
  const claveSched = { next: 0, resync: true };
  function scheduleClave() {
    const H = S.clave.hits;
    if (!ctx || !P.running() || !S.claveClick || !H.length) { claveSched.resync = true; return; }
    const t = P.time(), r = rate(), lat = S.clickLatency / 1000, ahead = (0.15 + Math.max(0, -lat)) * r;
    if (claveSched.resync) { claveSched.next = bsearch(H, t - 0.005) + 1; claveSched.resync = false; }
    while (claveSched.next < H.length && H[claveSched.next] < t + ahead) {
      const h = H[claveSched.next++];
      if (S.loop && S.B != null && h >= S.B - 0.005) continue;
      const d = (h - t) / r + lat;
      if (d < -0.01) continue;
      playClave(ctx.currentTime + Math.max(0, d));
    }
  }

  // ---------- tap test ----------
  const tapState = { resync: true, nextOne: 0, hitOnes: new Set() };
  const emptyStats = () => ({ taps: 0, hits: 0, fives: 0, stray: 0, missed: 0, errs: [] });
  let stLoop = emptyStats(), stLast = null, stSession = emptyStats(), histErrs = [];

  function resetTaps(all) {
    stLoop = emptyStats(); stLast = null;
    if (all) { stSession = emptyStats(); histErrs = []; }
    tapState.hitOnes = new Set(); tapState.resync = true;
    renderTapStats();
  }
  function tap(ev) {
    if (!S.song || !P.running()) return;
    const r = rate();
    const lag = ev && ev.timeStamp ? Math.max(0, performance.now() - ev.timeStamp) / 1000 : 0;
    const lat = (+$("latency").value || 0) / 1000;
    const t = P.time() - (lag + lat) * r;
    const T = tapTargets(), onClave = S.tapTarget === "clave";
    const i1 = nearest(T, t), i5 = onClave ? -1 : nearest(S.fives, t);
    const e1 = i1 >= 0 ? (t - T[i1]) / r * 1000 : Infinity;   // real-time ms
    const e5 = i5 >= 0 ? (t - S.fives[i5]) / r * 1000 : Infinity;
    let kind;
    if (Math.abs(e1) <= HIT_MS && !tapState.hitOnes.has(i1)) { kind = "hit"; tapState.hitOnes.add(i1); }
    else if (Math.abs(e5) <= HIT_MS) kind = "five";
    else kind = "stray";
    for (const st of [stLoop, stSession]) {
      st.taps++;
      if (kind === "hit") { st.hits++; st.errs.push(e1); } else if (kind === "five") st.fives++; else st.stray++;
    }
    if (Math.abs(e1) <= HIST_MS) histErrs.push(e1);
    if (Math.abs(e5) <= HIST_MS && kind === "five") histErrs.push(NaN);
    const fl = $("counter-hidden");
    fl.classList.add("flash"); setTimeout(() => fl.classList.remove("flash"), 90);
    renderTapStats();
  }
  // what taps are scored against: the 1s, or the clave hits
  const tapTargets = () => (S.tapTarget === "clave" ? S.clave.hits : S.ones);
  function setTapTarget(v) {
    S.tapTarget = v === "clave" ? "clave" : "one";
    store.set("tapTarget", S.tapTarget);
    $("tapTarget").value = S.tapTarget;
    const what = S.tapTarget === "clave" ? "clave hit" : "1";
    $("tapWhat").textContent = S.tapTarget === "clave" ? "the clave" : "the 1";
    $("hiddenHint").innerHTML = `tap <kbd>J</kbd> on every ${what} you hear · <kbd>R</kbd> to reveal`;
    resetTaps(true); draw();
  }
  // count targets that passed without a hit (only while the counter is hidden = training)
  function trackMisses() {
    const T = tapTargets();
    if (!T.length) return;
    const t = P.time(), r = rate(), win = HIT_MS / 1000 * r;
    if (tapState.resync) {
      tapState.nextOne = bsearch(T, t - win) + 1; tapState.resync = false; return;
    }
    if (!P.running()) return;
    while (tapState.nextOne < T.length && T[tapState.nextOne] + win < t) {
      const i = tapState.nextOne++;
      if (S.hide && !tapState.hitOnes.has(i)) { stLoop.missed++; stSession.missed++; renderTapStats(); }
      tapState.hitOnes.delete(i);
    }
  }
  function onLoopWrap() {
    if (stLoop.taps || stLoop.missed) stLast = stLoop;
    stLoop = emptyStats();
    tapState.hitOnes = new Set();
    renderTapStats();
  }
  function statLine(st) {
    const tot1 = st.hits + st.missed;
    const pct = tot1 ? Math.round(100 * st.hits / tot1) : null;
    const mean = st.errs.length ? st.errs.reduce((a, b) => a + b, 0) / st.errs.length : null;
    const sd = st.errs.length > 1 ? Math.sqrt(st.errs.reduce((a, b) => a + (b - mean) ** 2, 0) / (st.errs.length - 1)) : null;
    const clave = S.tapTarget === "clave";
    return `<b>${st.hits}</b> hits` + (pct != null ? ` (${pct}% of ${clave ? "clave hits" : "1s"})` : "") +
      (clave ? "" : ` · <span class="conf-medium">${st.fives}</span> on the 5`) +
      ` · ${st.stray} stray · <span class="conf-low">${st.missed}</span> missed` +
      (mean != null ? `<br><span class="abinfo">timing ${mean >= 0 ? "+" : ""}${mean.toFixed(0)} ms${sd != null ? ` ± ${sd.toFixed(0)}` : ""} (${mean >= 0 ? "late" : "early"})</span>` : "");
  }
  function renderTapStats() {
    const el = $("tapstats");
    if (S.tapTarget === "clave" && !S.clave.hits.length) {
      el.innerHTML = `Pick a clave pattern (<kbd>V</kbd>) to tap along to the clave.`;
    } else if (!stSession.taps && !stSession.missed) {
      el.innerHTML = `No taps yet. Hide the counter (<kbd>H</kbd>), play, tap <kbd>J</kbd> on every ${S.tapTarget === "clave" ? "clave hit" : "1"}. Hit = within ±${HIT_MS} ms.`;
    } else {
      el.innerHTML =
        `<div>This ${S.loop ? "loop" : "run"}: ${statLine(stLoop)}</div>` +
        (stLast ? `<div class="abinfo" style="margin-top:4px">Last loop: ${statLine(stLast).replace(/<br>.*/, "")}</div>` : "") +
        `<div style="margin-top:6px">Session: ${statLine(stSession)}</div>`;
    }
    drawHist();
  }

  // ---------- drawing ----------
  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, c.clientWidth), h = c.clientHeight || +c.getAttribute("height");
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [g, w, h];
  }
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  let COL = {};
  function readColors() { COL = { one: css("--one"), five: css("--five"), beat: css("--beat"), fg: css("--fg"), dim: css("--dim"), accent: css("--accent"), line: css("--line"), clave: css("--clave") }; }
  // clave markers are hidden only when the counter is hidden and you're tapping the clave
  const showClave = () => S.clave.hits.length > 0 && (!S.hide || S.reveal || S.tapTarget !== "clave");

  function drawWave(g, x0, w, h, t0, t1, alpha) {
    if (!S.peaks) return;
    const p = S.peaks, pr = S.peaksRate, mid = h / 2;
    g.fillStyle = `rgba(160,170,190,${alpha})`;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((t0 + (t1 - t0) * x / w) * pr), b = Math.max(a + 1, Math.floor((t0 + (t1 - t0) * (x + 1) / w) * pr));
      let m = 0;
      for (let i = Math.max(0, a); i < Math.min(p.length, b); i++) if (p[i] > m) m = p[i];
      const hh = m * (h * 0.42);
      g.fillRect(x0 + x, mid - hh, 1, hh * 2);
    }
  }

  function drawTimeline() {
    const c = $("timeline");
    const [g, w, h] = fitCanvas(c);
    g.clearRect(0, 0, w, h);
    if (!S.song) return;
    const D = dur() || 1, X = (t) => t / D * w;
    const top = 18, bh = h - top;
    // sections
    (S.song.sections || []).forEach((s) => {
      g.fillStyle = sectionColor(s); g.globalAlpha = 0.45;
      g.fillRect(X(s.start), 0, X(s.end) - X(s.start), h);
      g.globalAlpha = 1;
      g.fillStyle = COL.line; g.fillRect(X(s.start), 0, 1, h);
      g.fillStyle = COL.fg; g.font = "11px -apple-system, sans-serif";
      const lw = X(s.end) - X(s.start);
      if (lw > 30) { g.save(); g.beginPath(); g.rect(X(s.start), 0, lw - 2, top); g.clip(); g.fillText(s.label, X(s.start) + 3, 12); g.restore(); }
    });
    drawWave(g, 0, w, h + top / 2, 0, D, 0.55);
    // breaks
    (S.song.breaks || []).forEach((b) => {
      g.fillStyle = "rgba(255,77,77,0.35)";
      g.fillRect(X(b.start), top, Math.max(2, X(b.end) - X(b.start)), bh);
      g.fillStyle = COL.one; g.font = "bold 10px -apple-system, sans-serif";
      g.fillText("BREAK", X(b.start) + 2, h - 4);
    });
    // 1s
    if (!S.hide || S.reveal) {
      g.fillStyle = COL.one;
      S.ones.forEach((t) => g.fillRect(X(t), top, 1, 7));
    }
    // clave hits (bottom band)
    if (showClave()) {
      g.fillStyle = COL.clave;
      S.clave.hits.forEach((t) => g.fillRect(X(t), h - 6, 1, 6));
    }
    // A-B
    if (S.A != null) {
      const b = S.B != null ? S.B : S.A;
      g.fillStyle = S.loop ? "rgba(255,201,77,0.22)" : "rgba(255,201,77,0.10)";
      g.fillRect(X(S.A), top, Math.max(2, X(b) - X(S.A)), bh);
      g.fillStyle = COL.accent; g.fillRect(X(S.A), top, 2, bh);
      if (S.B != null) g.fillRect(X(S.B) - 2, top, 2, bh);
    }
    // playhead
    g.fillStyle = COL.fg; g.fillRect(X(P.time()) - 1, 0, 2, h);
  }

  const ZOOM_BEFORE = 2.0, ZOOM_AFTER = 5.0; // seconds of song time around the playhead
  function drawZoom() {
    const c = $("zoom");
    const [g, w, h] = fitCanvas(c);
    g.clearRect(0, 0, w, h);
    if (!S.song) return;
    const t = P.time(), t0 = t - ZOOM_BEFORE, t1 = t + ZOOM_AFTER;
    const X = (x) => (x - t0) / (t1 - t0) * w;
    const show = !S.hide || S.reveal;
    // section/break backgrounds
    (S.song.breaks || []).forEach((b) => { if (b.end > t0 && b.start < t1) { g.fillStyle = "rgba(255,77,77,0.18)"; g.fillRect(X(b.start), 0, X(b.end) - X(b.start), h); } });
    if (S.A != null && S.B != null) { g.fillStyle = "rgba(255,201,77,0.08)"; g.fillRect(X(S.A), 0, X(S.B) - X(S.A), h); }
    drawWave(g, 0, w, h, t0, t1, 0.35);
    // beats
    const i0 = Math.max(0, bsearch(S.beats, t0, (b) => b.t));
    g.textAlign = "center";
    for (let i = i0; i < S.beats.length && S.beats[i].t <= t1; i++) {
      const b = S.beats[i], x = X(b.t);
      const one = show && b.count === 1, five = show && b.count === 5;
      g.fillStyle = one ? COL.one : five ? COL.five : COL.beat;
      const bw = one ? 4 : five ? 3 : 1.5, bh = one ? h - 26 : five ? h * 0.55 : h * 0.35;
      g.fillRect(x - bw / 2, h - 22 - bh, bw, bh);
      g.font = (one ? "bold 18px" : five ? "bold 15px" : "12px") + " -apple-system, sans-serif";
      g.fillText(show ? String(b.count) : "•", x, h - 5);
    }
    // clave hits: amber line + diamond
    if (showClave()) {
      const H = S.clave.hits;
      for (let i = Math.max(0, bsearch(H, t0)); i < H.length && H[i] <= t1; i++) {
        const x = X(H[i]), y = 28;
        g.fillStyle = "rgba(255,159,26,0.35)"; g.fillRect(x - 0.75, y, 1.5, h - 22 - y);
        g.fillStyle = COL.clave;
        g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 6, y); g.lineTo(x, y + 7); g.lineTo(x - 6, y); g.closePath(); g.fill();
      }
    }
    // A/B markers
    g.fillStyle = COL.accent;
    if (S.A != null && S.A >= t0 && S.A <= t1) { g.fillRect(X(S.A) - 1, 0, 2, h); g.font = "bold 11px sans-serif"; g.fillText("A", X(S.A) + 7, 12); }
    if (S.B != null && S.B >= t0 && S.B <= t1) { g.fillRect(X(S.B) - 1, 0, 2, h); g.font = "bold 11px sans-serif"; g.fillText("B", X(S.B) - 7, 12); }
    // playhead
    g.fillStyle = COL.fg; g.fillRect(X(t) - 1, 0, 2, h);
    g.textAlign = "start";
  }

  function drawHist() {
    const c = $("taphist");
    const [g, w, h] = fitCanvas(c);
    g.clearRect(0, 0, w, h);
    const X = (ms) => (ms + HIST_MS) / (2 * HIST_MS) * w;
    g.fillStyle = "rgba(110,231,160,0.12)"; g.fillRect(X(-HIT_MS), 0, X(HIT_MS) - X(-HIT_MS), h);
    g.fillStyle = COL.one; g.fillRect(X(0) - 0.5, 0, 1, h);
    const bins = 30, cnt = new Array(bins).fill(0);
    histErrs.forEach((e) => { if (isFinite(e)) cnt[clamp(Math.floor((e + HIST_MS) / (2 * HIST_MS) * bins), 0, bins - 1)]++; });
    const mx = Math.max(1, ...cnt), bw = w / bins;
    g.fillStyle = COL.fg;
    cnt.forEach((n, i) => { if (n) g.fillRect(i * bw + 1, h - 12 - (h - 16) * n / mx, bw - 2, (h - 16) * n / mx); });
    g.fillStyle = COL.dim; g.font = "10px -apple-system, sans-serif";
    g.fillText(`-${HIST_MS} ms early`, 2, h - 2);
    g.textAlign = "end"; g.fillText(`late +${HIST_MS} ms`, w - 2, h - 2); g.textAlign = "start";
  }

  // big counter + dots
  const dots = [];
  function buildDots() {
    const box = $("dots"); box.innerHTML = "";
    for (let i = 1; i <= 8; i++) {
      const s = document.createElement("span");
      if (i === 1) s.className = "d1"; if (i === 5) s.className = "d5";
      box.appendChild(s); dots.push(s);
    }
  }
  function buildClaveGrid() {
    const box = $("claveGrid"); box.innerHTML = "";
    SLOT_LABELS.forEach((l, k) => {
      const s = document.createElement("span");
      s.textContent = l; if (k % 2) s.className = "and";
      box.appendChild(s);
    });
  }
  let lastClaveKey = "";
  function drawClave(t, hidden) {
    let flash = false, hitSlot = null, now = null;
    if (S.claveMode !== "off" && !hidden) {
      const H = S.clave.hits, k = bsearch(H, t + 0.005);
      if (k >= 0 && t - H[k] < 0.12 * rate()) { flash = true; hitSlot = S.clave.hitSlots[k]; }
      now = slotAt(t, true);
    }
    if (S.claveMode !== "off" && hidden && S.tapTarget !== "clave") {
      const H = S.clave.hits, k = bsearch(H, t + 0.005);
      flash = k >= 0 && t - H[k] < 0.12 * rate();
    }
    const key = `${flash}|${hitSlot}|${now}|${hidden}|${S.claveMode}|${S.tapTarget}`;
    if (key === lastClaveKey) return;
    lastClaveKey = key;
    $("claveFlash").classList.toggle("lit", flash);
    $("claveFlash").hidden = S.claveMode === "off" || (hidden && S.tapTarget === "clave");
    $("claveGrid").style.visibility = hidden ? "hidden" : "visible";
    const cells = $("claveGrid").children;
    for (let k = 0; k < 16; k++) { cells[k].classList.toggle("now", k === now); cells[k].classList.toggle("hit", k === hitSlot); }
  }
  let lastCount = null, lastSection = "";
  function drawCounter() {
    const t = P.time();
    const i = bsearch(S.beats, t + 0.01, (b) => b.t);
    let count = null;
    if (i >= 0) {
      const b = S.beats[i], nxt = S.beats[i + 1];
      const gap = nxt ? nxt.t - b.t : 0.45;
      if (t - b.t < Math.max(0.8, gap * 1.5)) count = b.count;
    }
    if (count !== lastCount) {
      lastCount = count;
      const el = $("counter");
      el.textContent = count == null ? "–" : count;
      el.classList.toggle("one", count === 1);
      el.classList.toggle("five", count === 5);
      dots.forEach((d, k) => d.classList.toggle("now", count === k + 1));
    }
    const hidden = S.hide && !S.reveal;
    $("counter-hidden").hidden = !hidden;
    $("dots").style.visibility = hidden ? "hidden" : "visible";
    drawClave(t, hidden);
    // section label
    let sec = "";
    if (S.song) {
      const s = (S.song.sections || []).find((x) => t >= x.start && t < x.end);
      const br = (S.song.breaks || []).find((x) => t >= x.start && t < x.end);
      sec = (s ? s.label : "") + (br ? " · BREAK" : "");
    }
    if (sec !== lastSection) { lastSection = sec; $("section-now").textContent = sec; }
  }

  function draw() {
    if (!S.song) return;
    drawCounter(); drawZoom(); drawTimeline();
    $("time").textContent = `${fmt(P.time(), 1)} / ${fmt(dur())}`;
  }

  // ---------- main loop ----------
  function frame() {
    if (S.song) {
      if (S.loop && S.A != null && S.B != null && S.B > S.A && P.running() && P.time() >= S.B) {
        P.seek(S.A);
        clickSched.resync = true; claveSched.resync = true; tapState.resync = true;
        onLoopWrap();
      }
      trackMisses();
      scheduleClicks(); scheduleClave();
      draw();
      showYtSync();
    }
    requestAnimationFrame(frame);
  }
  // keep clicks scheduled when the tab is in the background (rAF pauses there)
  setInterval(() => { if (document.hidden && S.song) { scheduleClicks(); scheduleClave(); } }, 50);

  // ---------- UI wiring ----------
  function setHide(v) {
    S.hide = v; S.reveal = false; $("hide").checked = v;
    $("counter-hidden").hidden = !v;
    if (v) { stLoop = emptyStats(); tapState.hitOnes = new Set(); tapState.resync = true; renderTapStats(); }
    draw();
  }
  function toggleReveal() {
    if (!S.hide) return;
    S.reveal = !S.reveal; draw();
  }
  function setClick(which, v) {
    S[which] = v; $(which).checked = v; ensureCtx(); clickSched.resync = true;
  }
  function shiftCount(d) {
    S.offset = ((S.offset + d) % 8 + 8) % 8;
    store.set("offset." + S.entry.id, S.offset);
    rebuildBeats(); draw(); drawTimeline();
  }
  function timelineTime(ev, c, zoom) {
    const r = c.getBoundingClientRect(), f = (ev.clientX - r.left) / r.width;
    if (zoom) { const t = P.time(); return t - ZOOM_BEFORE + f * (ZOOM_BEFORE + ZOOM_AFTER); }
    return f * dur();
  }

  function wire() {
    $("song").addEventListener("change", (e) => loadSong(+e.target.value));
    $("play").addEventListener("click", togglePlay);
    $("speed").addEventListener("input", (e) => setSpeed(+e.target.value));
    $("setA").addEventListener("click", () => setA());
    $("setB").addEventListener("click", () => setB());
    $("loopToggle").addEventListener("click", () => { S.loop = !S.loop; updateLoopUI(); });
    $("loop8").addEventListener("click", loopThisEight);
    $("loopPrev").addEventListener("click", () => nudgeLoop(-1));
    $("loopNext").addEventListener("click", () => nudgeLoop(1));
    $("snap").addEventListener("change", (e) => { S.snap = e.target.checked; });
    $("hide").addEventListener("change", (e) => setHide(e.target.checked));
    for (const k of ["click1", "click5", "clickAll"]) $(k).addEventListener("change", (e) => setClick(k, e.target.checked));
    $("clickVol").addEventListener("input", (e) => { S.clickVol = +e.target.value; store.set("clickVol", S.clickVol); });
    $("claveMode").addEventListener("change", (e) => { setClaveMode(e.target.value); e.target.blur(); });
    $("claveClick").addEventListener("change", (e) => { S.claveClick = e.target.checked; store.set("claveClick", S.claveClick); ensureCtx(); claveSched.resync = true; });
    $("claveVol").addEventListener("input", (e) => { S.claveVol = +e.target.value; store.set("claveVol", S.claveVol); });
    $("tapTarget").addEventListener("change", (e) => { setTapTarget(e.target.value); e.target.blur(); });
    $("flip").addEventListener("click", () => shiftCount(4));
    $("nudgeL").addEventListener("click", () => shiftCount(-1));
    $("nudgeR").addEventListener("click", () => shiftCount(1));
    $("savePreset").addEventListener("click", saveUserPreset);
    $("presetName").addEventListener("keydown", (e) => { if (e.key === "Enter") saveUserPreset(); });
    $("tapReset").addEventListener("click", () => resetTaps(true));
    $("latency").addEventListener("change", (e) => store.set("latency", +e.target.value || 0));
    $("timeline").addEventListener("click", (e) => {
      const t = timelineTime(e, e.currentTarget, false);
      if (e.shiftKey) setA(t); else if (e.altKey) setB(t); else seek(t);
    });
    $("zoom").addEventListener("click", (e) => seek(timelineTime(e, e.currentTarget, true)));
    // buttons must not keep focus, or Space would re-trigger them
    document.querySelectorAll("button, input[type=checkbox], input[type=range]").forEach((b) => b.addEventListener("mouseup", () => setTimeout(() => b.blur(), 0)));

    const resync = () => { clickSched.resync = true; claveSched.resync = true; tapState.resync = true; };
    on("play", () => { $("play").textContent = "❚❚ Pause"; resync(); });
    on("pause", () => { $("play").textContent = "▶ Play"; resync(); });
    on("seeking", resync);
    on("loaded", () => { setSpeed(+$("speed").value); draw(); drawTimeline(); });
    on("ratechange", () => { $("speed").value = P.rate(); $("speed-out").textContent = P.rate().toFixed(2) + "×"; resync(); });
    on("ended", () => { $("play").textContent = "▶ Play"; });
    audio.addEventListener("error", () => {
      if (P === local && audio.getAttribute("src")) $("meta").insertAdjacentHTML("beforeend", ` · <span class="conf-low">audio failed to load: ${escapeHtml(audio.src)}</span>`);
    });
    $("source").addEventListener("change", (e) => { setSource(e.target.value); e.target.blur(); });
    for (const b of document.querySelectorAll("[data-ytnudge]")) {
      b.addEventListener("click", () => {
        const d = +b.dataset.ytnudge;
        setYtNudge(d === 0 ? 0 : yt.nudge + d);
        b.blur();
      });
    }
    $("clickLat").addEventListener("input", (e) => {
      S.clickLatency = +e.target.value; $("clickLat-out").textContent = fmtMs(S.clickLatency);
      store.set("clickLatency." + P.kind, S.clickLatency); resync();
    });
    window.addEventListener("resize", draw);

    document.addEventListener("keydown", onKey);
  }

  function onKey(e) {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = (tag === "input" && !["checkbox", "range", "button"].includes(e.target.type)) || tag === "textarea" || tag === "select";
    if (typing) { if (e.key === "Escape") e.target.blur(); return; }
    if (!$("lockGate").hidden) return;
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key;
    let handled = true;
    if (k === " ") togglePlay();
    else if (k === "ArrowLeft") e.shiftKey ? shiftCount(-1) : seekEight(-1);
    else if (k === "ArrowRight") e.shiftKey ? shiftCount(1) : seekEight(1);
    else if (k === "[") setSpeed(0, -1);
    else if (k === "]") setSpeed(0, 1);
    else if (k === "a" || k === "A") setA();
    else if (k === "b" || k === "B") setB();
    else if (k === "l" || k === "L") { S.loop = !S.loop; updateLoopUI(); }
    else if (k === "c" || k === "C") loopThisEight();
    else if (k === ",") nudgeLoop(-1);
    else if (k === ".") nudgeLoop(1);
    else if (k === "s" || k === "S") { S.snap = !S.snap; updateLoopUI(); }
    else if (k === "h" || k === "H") setHide(!S.hide);
    else if (k === "r" || k === "R") toggleReveal();
    else if (k === "j" || k === "J") { if (!e.repeat) tap(e); }
    else if (k === "k" || k === "K") setClick("click1", !S.click1);
    else if (k === "v" || k === "V") cycleClave();
    else if (k === "f" || k === "F") shiftCount(4);
    else if (k === "p" || k === "P") saveUserPreset();
    else if (/^[1-9]$/.test(k)) jumpPreset(+k);
    else if (k === "0") { if (S.A != null) seek(S.A); else seek(0); }
    else if (k === "Home") seek(0);
    else handled = false;
    if (handled) e.preventDefault();
  }

  // ---------- boot ----------
  readColors(); buildDots(); buildClaveGrid(); wire();
  S.claveVol = store.get("claveVol", 0.6); $("claveVol").value = S.claveVol;
  S.claveClick = !!store.get("claveClick", false); $("claveClick").checked = S.claveClick;
  setTapTarget(store.get("tapTarget", "one"));
  S.clickVol = store.get("clickVol", 0.6); $("clickVol").value = S.clickVol;
  $("latency").value = store.get("latency", 0);
  setSpeed(1);
  try { const l = $("ot-lock"); if (l) S.lock = JSON.parse(l.textContent); } catch (err) { console.error("bad ot-lock:", err); }
  (S.lock ? unlock() : Promise.resolve()).then(loadIndex).catch((err) => { console.error(err); $("meta").textContent = "Could not load songs/index.json — run `python serve.py` and open http://localhost:8000"; });
  requestAnimationFrame(frame);
  window.oneTrainer = { S, CLAVE, yt, local, player: () => P }; // for poking at the state from the console
})();
