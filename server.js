const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
app.use(cors());
app.use(rateLimit({ windowMs: 60_000, max: 5 })); // 5 requests/min per IP

const ALLOWED = [
    "youtube.com", "www.youtube.com", "youtu.be",
    "tiktok.com", "www.tiktok.com", "vm.tiktok.com",
    "facebook.com", "www.facebook.com", "fb.watch", "m.facebook.com",
    "instagram.com", "www.instagram.com"
];

app.get("/download", async (req, res) => {
    const { url, format } = req.query; // format = mp3 | mp4
    let host;
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") throw new Error("Unsupported protocol");
        host = parsedUrl.hostname;
    } catch { return res.status(400).send("Bad URL"); }
    if (!ALLOWED.includes(host)) return res.status(400).send("Unsupported site");
    if (format !== "mp3" && format !== "mp4") return res.status(400).send("Format must be mp3 or mp4");

    const isMp3 = format === "mp3";
    let tempDir;
    let proc;
    let clientDisconnected = false;
    res.on("close", () => {
        if (!res.writableEnded) {
            clientDisconnected = true;
            if (proc && !proc.killed) proc.kill();
        }
    });

    try {
        // yt-dlp must write to a file so ffmpeg can merge video/audio or convert to MP3.
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dl-backend-"));
        const output = path.join(tempDir, `download.%(ext)s`);
        const args = isMp3
            ? ["--no-playlist", "-x", "--audio-format", "mp3", "-o", output, url]
            // Prefer a single MP4 stream for speed; fall back to separate MP4 video/audio when needed.
            : ["--no-playlist", "-f", "best[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best", "--merge-output-format", "mp4", "-o", output, url];

        let errorOutput = "";
        await new Promise((resolve, reject) => {
            proc = spawn("yt-dlp", args, { stdio: ["ignore", "ignore", "pipe"] });
            proc.stderr.setEncoding("utf8");
            proc.stderr.on("data", chunk => { errorOutput += chunk; });
            proc.on("error", reject);
            proc.on("close", code => code === 0 ? resolve() : reject(new Error(errorOutput || `yt-dlp exited with code ${code}`)));
        });

        if (clientDisconnected) return;
        const expectedFileName = isMp3 ? "download.mp3" : null;
        const fileName = expectedFileName || (await fs.promises.readdir(tempDir)).find(name => name.startsWith("download."));
        if (!fileName) throw new Error("yt-dlp finished without producing a media file");
        const filePath = path.join(tempDir, fileName);
        await fs.promises.access(filePath);
        const contentType = isMp3 ? "audio/mpeg" : fileName.endsWith(".webm") ? "video/webm" : "video/mp4";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        await new Promise((resolve, reject) => {
            const file = fs.createReadStream(filePath);
            file.on("error", reject);
            res.on("finish", resolve);
            file.pipe(res);
        });
    } catch (err) {
        console.error("Download failed:", err.message);
        if (!res.headersSent && !clientDisconnected) {
            const details = err.message.includes("ENOENT")
                ? "yt-dlp is not installed or is not available on PATH."
                : (err.message.split(/\r?\n/).filter(Boolean).slice(-3).join(" ") || "Unknown download error");
            res.status(500).type("text/plain").send(`Download failed: ${details}`);
        }
        else if (!res.writableEnded) res.destroy(err);
    } finally {
        if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});

app.listen(process.env.PORT || 3001);
