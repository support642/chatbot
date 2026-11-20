import crypto from "crypto";

// AES-256-GCM. Master key comes from SETTINGS_ENCRYPTION_KEY (min 32 chars) and is
// stretched to 32 bytes with SHA-256. Stored format: v1:<iv>:<tag>:<ciphertext> (base64).

const getKey = () => {
    const secret = process.env.SETTINGS_ENCRYPTION_KEY?.trim();

    if (!secret || secret.length < 32) {
        const err = new Error(
            "SETTINGS_ENCRYPTION_KEY is missing or shorter than 32 characters."
        );
        err.code = "NO_ENCRYPTION_KEY";
        throw err;
    }

    return crypto.createHash("sha256").update(secret).digest();
};

export const encryptSecret = (plain) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
};

export const decryptSecret = (stored) => {
    const [version, iv, tag, data] = String(stored).split(":");

    if (version !== "v1" || !iv || !tag || !data) {
        throw new Error("Unsupported secret format.");
    }

    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        getKey(),
        Buffer.from(iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));

    return Buffer.concat([
        decipher.update(Buffer.from(data, "base64")),
        decipher.final()
    ]).toString("utf8");
};
