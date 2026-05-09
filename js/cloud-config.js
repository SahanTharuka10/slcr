// SLCRICKPRO cloud configuration.
// Fill these values after creating Firebase Realtime Database and Supabase projects.
// These browser keys are public keys. Keep service-role/admin keys out of frontend code.
window.CRICPRO_CLOUD_CONFIG = {
    // Leave empty when Firebase is not ready yet.
    firebase: {
        apiKey: "",
        authDomain: "",
        databaseURL: "",
        projectId: "",
        storageBucket: "",
        messagingSenderId: "",
        appId: ""
    },

    // Leave empty when Supabase is not ready yet.
    supabase: {
        url: "",
        anonKey: ""
    },

    // Optional Express backend fallback. Set to "" for Vercel + Firebase/Supabase only.
    backendUrl: "https://slcr.onrender.com"
};
