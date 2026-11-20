-- Run BEFORE 20261114_create_chatbot_report_confirmations.sql
-- That table has FOREIGN KEY (username) REFERENCES users(user_name), which requires a UNIQUE
-- constraint on users.user_name. Postgres allows many NULLs in a UNIQUE column, so users
-- with NULL user_name are not affected. Fails if duplicate non-NULL usernames exist; check first:
--   SELECT user_name, COUNT(*) FROM users WHERE user_name IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass AND conname = 'users_user_name_key'
    ) THEN
        ALTER TABLE public.users ADD CONSTRAINT users_user_name_key UNIQUE (user_name);
    END IF;
END $$;
