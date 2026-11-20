import express from "express";
import dotenv from "dotenv";
import chatbotRoutes from "./routes/chatbotRoutes.js";
import chatbotSessionMiddleware from "./middleware/chatbotSessionMiddleware.js";
import pool from "./config/chatbotDb.js";

dotenv.config();

const app = express();

// CORS: comma separated list in CORS_ORIGINS (exact match).
// If the frontend calls through a Vercel rewrite, the browser sees same-origin
// and CORS is not needed, but keeping it configured is harmless.
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-id");
    }

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

app.use(express.json({ limit: "5mb" }));

// Health check (no auth) for Docker / load balancer / uptime monitors
app.get("/health", async (_req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ status: "ok" });
    } catch {
        res.status(503).json({ status: "db_unreachable" });
    }
});

// All chatbot endpoints require a valid session (shared `sessions` table)
app.use("/api/chatbot", chatbotSessionMiddleware, chatbotRoutes);

process.on("unhandledRejection", (reason) => {
    console.error("UNHANDLED REJECTION:", reason);
});

const PORT = parseInt(process.env.PORT || "4001");

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Chatbot service listening on port ${PORT}`);
});
