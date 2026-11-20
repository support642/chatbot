import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

// Read/write pool (sessions, admin lookup, report confirmations).
// Own pool, so this service does not depend on the main backend's db.js.
const pool = new Pool({
    host: process.env.DB_HOST?.trim(),
    user: process.env.DB_USER?.trim(),
    password: process.env.DB_PASSWORD?.trim(),
    database: process.env.DB_NAME?.trim(),
    port: parseInt(process.env.DB_PORT?.trim() || "5432"),
    ssl: { rejectUnauthorized: false }, // required for AWS RDS
    max: 10
});

pool.on("error", (err) => {
    console.error("Chatbot pool error:", err.message);
});

export default pool;
