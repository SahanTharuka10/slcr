// Optional Firebase Realtime Database + Supabase browser adapter.
// The app continues to work locally when config values are blank.
(function () {
    const config = window.CRICPRO_CLOUD_CONFIG || {};
    const firebaseConfig = config.firebase || {};
    const supabaseConfig = config.supabase || {};

    const FIREBASE_APP_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js";
    const FIREBASE_DB_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js";
    const SUPABASE_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

    let firebaseReadyPromise = null;
    let supabaseReadyPromise = null;
    let firebaseDb = null;
    let supabaseClient = null;

    function isConfigured(value) {
        return typeof value === "string" && value.trim().length > 0;
    }

    function hasFirebaseConfig() {
        return isConfigured(firebaseConfig.apiKey) &&
            isConfigured(firebaseConfig.databaseURL) &&
            isConfigured(firebaseConfig.projectId);
    }

    function hasSupabaseConfig() {
        return isConfigured(supabaseConfig.url) && isConfigured(supabaseConfig.anonKey);
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                existing.addEventListener("load", resolve, { once: true });
                existing.addEventListener("error", reject, { once: true });
                if (existing.dataset.loaded === "true") resolve();
                return;
            }

            const script = document.createElement("script");
            script.src = src;
            script.async = false;
            script.onload = () => {
                script.dataset.loaded = "true";
                resolve();
            };
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(script);
        });
    }

    async function ensureFirebase() {
        if (!hasFirebaseConfig()) return null;
        if (firebaseDb) return firebaseDb;
        if (!firebaseReadyPromise) {
            firebaseReadyPromise = (async () => {
                await loadScript(FIREBASE_APP_URL);
                await loadScript(FIREBASE_DB_URL);

                if (!window.firebase) throw new Error("Firebase SDK unavailable");
                const app = window.firebase.apps && window.firebase.apps.length
                    ? window.firebase.app()
                    : window.firebase.initializeApp(firebaseConfig);

                firebaseDb = window.firebase.database(app);
                return firebaseDb;
            })().catch((error) => {
                console.warn("[Cloud] Firebase disabled:", error.message);
                firebaseReadyPromise = null;
                return null;
            });
        }
        return firebaseReadyPromise;
    }

    async function ensureSupabase() {
        if (!hasSupabaseConfig()) return null;
        if (supabaseClient) return supabaseClient;
        if (!supabaseReadyPromise) {
            supabaseReadyPromise = (async () => {
                await loadScript(SUPABASE_URL);
                if (!window.supabase) throw new Error("Supabase SDK unavailable");
                supabaseClient = window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey);
                return supabaseClient;
            })().catch((error) => {
                console.warn("[Cloud] Supabase disabled:", error.message);
                supabaseReadyPromise = null;
                return null;
            });
        }
        return supabaseReadyPromise;
    }

    function activeMatchPath(matchId) {
        return `liveMatches/${matchId}`;
    }

    async function syncLiveMatch(match) {
        if (!match || !match.id) return false;
        const db = await ensureFirebase();
        if (!db) return false;

        const activeStatuses = ["setup", "scheduled", "live", "paused"];
        const payload = {
            ...match,
            cloudUpdatedAt: Date.now()
        };

        await db.ref(`matches/${match.id}`).set(payload);
        if (match.publishLive !== false && activeStatuses.includes(match.status)) {
            await db.ref(activeMatchPath(match.id)).set(payload);
        } else {
            await db.ref(activeMatchPath(match.id)).remove();
        }
        return true;
    }

    async function removeLiveMatch(matchId) {
        const db = await ensureFirebase();
        if (!db || !matchId) return false;
        await Promise.all([
            db.ref(`matches/${matchId}`).remove(),
            db.ref(activeMatchPath(matchId)).remove()
        ]);
        return true;
    }

    async function getLiveMatches() {
        const db = await ensureFirebase();
        if (!db) return [];
        const snap = await db.ref("liveMatches").once("value");
        const val = snap.val() || {};
        return Object.values(val).filter(Boolean);
    }

    async function subscribeLiveMatches(callback) {
        const db = await ensureFirebase();
        if (!db || typeof callback !== "function") return null;

        const ref = db.ref("liveMatches");
        const handler = (snap) => {
            const val = snap.val() || {};
            callback(Object.values(val).filter(Boolean));
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function saveSupabaseRecord(table, row) {
        const client = await ensureSupabase();
        if (!client || !table || !row || !row.id) return false;
        const { error } = await client.from(table).upsert(row, { onConflict: "id" });
        if (error) {
            console.warn(`[Cloud] Supabase ${table} upsert failed:`, error.message);
            return false;
        }
        return true;
    }

    async function getSupabaseRecords(table) {
        const client = await ensureSupabase();
        if (!client || !table) return [];
        const { data, error } = await client.from(table).select("*");
        if (error) {
            console.warn(`[Cloud] Supabase ${table} fetch failed:`, error.message);
            return [];
        }
        return (data || []).map((row) => ({
            ...(row.data || {}),
            id: (row.data && row.data.id) || row.id
        }));
    }

    async function sendBroadcast(payload) {
        if (!payload) return false;
        const db = await ensureFirebase();
        if (!db) return false;

        const id = payload.matchId || payload.tournamentId || "global";
        await db.ref(`broadcastCommands/${id}`).set({
            ...payload,
            timestamp: Date.now()
        });
        return true;
    }

    async function subscribeBroadcast(id, callback) {
        const db = await ensureFirebase();
        if (!db || !id || typeof callback !== "function") return null;

        let lastTimestamp = 0;
        const ref = db.ref(`broadcastCommands/${id}`);
        const handler = (snap) => {
            const payload = snap.val();
            if (!payload || !payload.timestamp || payload.timestamp === lastTimestamp) return;
            lastTimestamp = payload.timestamp;
            callback(payload);
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    window.CricproCloud = {
        hasFirebaseConfig,
        hasSupabaseConfig,
        ensureFirebase,
        ensureSupabase,
        syncLiveMatch,
        removeLiveMatch,
        getLiveMatches,
        subscribeLiveMatches,
        saveSupabaseRecord,
        getSupabaseRecords,
        sendBroadcast,
        subscribeBroadcast
    };
})();
