import {
    getKeyStatus,
    saveOpenAIKey,
    deleteOpenAIKey
} from "../services/chatbotSettingsService.js";

const fail = (res, error, fallback) => {
    if (error.code === "NO_ENCRYPTION_KEY") {
        console.error(error.message);
        return res.status(500).json({
            success: false,
            message: "Server is not configured to store keys (SETTINGS_ENCRYPTION_KEY missing)."
        });
    }

    if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, message: error.message });
    }

    // Never log request bodies here: they contain the API key.
    console.error(fallback, error.message);
    return res.status(500).json({ success: false, message: fallback });
};

export const getOpenAIKeyStatus = async (_req, res) => {
    try {
        return res.json({ success: true, data: await getKeyStatus() });
    } catch (error) {
        return fail(res, error, "Unable to load AI settings.");
    }
};

export const setOpenAIKey = async (req, res) => {
    try {
        await saveOpenAIKey(req.body?.api_key, req.admin.username);
        return res.json({ success: true, data: await getKeyStatus() });
    } catch (error) {
        return fail(res, error, "Unable to save the key.");
    }
};

export const removeOpenAIKey = async (_req, res) => {
    try {
        await deleteOpenAIKey();
        return res.json({ success: true, data: await getKeyStatus() });
    } catch (error) {
        return fail(res, error, "Unable to remove the key.");
    }
};
