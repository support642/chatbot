-- Stores secrets/settings editable from the frontend (e.g. the OpenAI API key).
-- Values are AES-256-GCM encrypted by the service; the master key lives only in the
-- SETTINGS_ENCRYPTION_KEY env var on the server, never in this database.
CREATE TABLE IF NOT EXISTS public.chatbot_settings (
    setting_key     text PRIMARY KEY,
    encrypted_value text NOT NULL,
    last4           varchar(8),
    updated_by      text,
    updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
