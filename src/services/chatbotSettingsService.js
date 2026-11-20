import OpenAI from "openai";
import pool from "../config/chatbotDb.js";
import { encryptSecret, decryptSecret } from "./secretCrypto.js";

const OPENAI_KEY = "openai_api_key";
const CACHE_MS = 60 * 1000;

let cache = { value: undefined, expires: 0 };

export const clearKeyCache = () => {
    cache = { value: undefined, expires: 0 };
};

// Key used by the AI: database (set from the frontend) first, .env as fallback.
export const getActiveOpenAIKey = async () => {
    if (cache.value !== undefined && Date.now() < cache.expires) {
        return cache.value;
    }

    let key = null;

    try {
        const { rows } = await pool.query(
            "SELECT encrypted_value FROM chatbot_settings WHERE setting_key = $1",
            [OPENAI_KEY]
        );

        if (rows.length > 0) {
            key = decryptSecret(rows[0].encrypted_value);
        }
    } catch (error) {
        // Table missing / wrong encryption key / DB hiccup: fall back to .env
        console.error("Could not load stored OpenAI key:", error.message);
    }

    if (!key) {
        key = process.env.OPENAI_API_KEY?.trim() || null;
    }

    cache = { value: key, expires: Date.now() + CACHE_MS };
    return key;
};

const mask = (last4) => `sk-••••••••••••${last4}`;

// Never returns the key itself, only whether one is set and its last 4 characters.
export const getKeyStatus = async () => {
    const { rows } = await pool.query(
        `SELECT last4, updated_by, updated_at
         FROM chatbot_settings WHERE setting_key = $1`,
        [OPENAI_KEY]
    );

    if (rows.length > 0) {
        return {
            configured: true,
            source: "database",
            masked: mask(rows[0].last4),
            updated_by: rows[0].updated_by,
            updated_at: rows[0].updated_at
        };
    }

    const envKey = process.env.OPENAI_API_KEY?.trim();

    return envKey
        ? {
            configured: true,
            source: "server_env",
            masked: mask(envKey.slice(-4)),
            updated_by: null,
            updated_at: null
        }
        : { configured: false, source: null, masked: null, updated_by: null, updated_at: null };
};

// Cheap authenticated call to check the key really works before storing it.
const verifyKeyWithOpenAI = async (key) => {
    try {
        await new OpenAI({ apiKey: key, maxRetries: 0, timeout: 15000 }).models.list();
    } catch (error) {
        const err = new Error(
            error.status === 401
                ? "OpenAI rejected this key. Please check it and try again."
                : "Could not verify the key with OpenAI right now. Please try again."
        );
        err.statusCode = error.status === 401 ? 400 : 502;
        throw err;
    }
};

export const saveOpenAIKey = async (rawKey, username) => {
    const key = String(rawKey || "").trim();

    if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) {
        const err = new Error("That does not look like a valid OpenAI API key (should start with sk-).");
        err.statusCode = 400;
        throw err;
    }

    await verifyKeyWithOpenAI(key);

    const encrypted = encryptSecret(key); // throws if SETTINGS_ENCRYPTION_KEY missing

    await pool.query(
        `INSERT INTO chatbot_settings (setting_key, encrypted_value, last4, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (setting_key) DO UPDATE
         SET encrypted_value = EXCLUDED.encrypted_value,
             last4 = EXCLUDED.last4,
             updated_by = EXCLUDED.updated_by,
             updated_at = CURRENT_TIMESTAMP`,
        [OPENAI_KEY, encrypted, key.slice(-4), username]
    );

    clearKeyCache();
};

export const deleteOpenAIKey = async () => {
    await pool.query("DELETE FROM chatbot_settings WHERE setting_key = $1", [OPENAI_KEY]);
    clearKeyCache();
};
