import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Health check — always responds, no dependencies ───────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasDriveFolderId: !!process.env.DRIVE_ROOT_FOLDER_ID,
    hasGoogleJson: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    hasSlackToken: !!process.env.SLACK_BOT_TOKEN,
  });
});

// ── /slack/ask route ──────────────────────────────────────────────────────────
app.post("/slack/ask", async (req, res) => {
  const { text, user_name, response_url } = req.body;

  if (!text || text.trim() === "") {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Please provide a question. Usage: `/ask Who is the best candidate for Head of FSSC?`",
    });
  }

  // Respond immediately to Slack
  res.status(200).json({
    response_type: "in_channel",
    text: `🔍 *${user_name}* asked: _${text}_\n⏳ Searching candidate files... (this takes ~30 seconds)`,
  });

  // Process in background
  processQuestion(text, user_name, response_url).catch((err) => {
    console.error("Unhandled error in processQuestion:", err);
  });
});

// ── Background processor ──────────────────────────────────────────────────────
async function processQuestion(text, user_name, response_url) {
  try {
    // Parse Google credentials safely
    let serviceAccountKey;
    try {
      serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      throw new Error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: " + e.message);
    }

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountKey,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });

    console.log("Fetching file list from Drive...");
    const files = await listAllFiles(drive, process.env.DRIVE_ROOT_FOLDER_ID);
    console.log(`Found ${files.length} files`);

    const CONCURRENCY = 5;
    const fileContents = [];
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((f) => getFileText(drive, f)));
      fileContents.push(...results.filter(Boolean));
    }
    console.log(`Successfully read ${fileContents.length} files`);

    const contextBlock = fileContents
      .map((f) => `=== FILE: ${f.name} ===\n${f.content}`)
      .join("\n\n");

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    console.log("Calling Claude...");
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here are the candidate files from Google Drive:\n\n${contextBlock}\n\n---\n\nQuestion from team member @${user_name}:\n${text}`,
        },
      ],
    });

    const answer = message.content[0].text;

    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel",
        text: `*Q: ${text}*\n\n${answer}`,
        mrkdwn: true,
      }),
    });

    console.log("Response sent to Slack successfully");
  } catch (err) {
    console.error("Error in processQuestion:", err.message);
    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        text: `❌ Error: ${err.message}`,
      }),
    });
  }
}

// ── Google Drive helpers ──────────────────────────────────────────────────────
async function listAllFiles(drive, folderId, maxFiles = 60) {
  const files = [];
  const queue = [folderId];
  while (queue.length > 0 && files.length < maxFiles) {
    const currentFolder = queue.shift();
    const res = await drive.files.list({
      q: `'${currentFolder}' in parents and trashed = false`,
      fields: "files(id, name, mimeType)",
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    for (const file of res.data.files || []) {
      if (file.mimeType === "application/vnd.google-apps.folder") {
        queue.push(file.id);
      } else {
        files.push(file);
      }
    }
  }
  return files;
}

async function getFileText(drive, file) {
  try {
    let content = "";
    if (file.mimeType === "application/vnd.google-apps.document") {
      const res = await drive.files.export(
        { fileId: file.id, mimeType: "text/plain", supportsAllDrives: true },
        { responseType: "text" }
      );
      content = res.data;
    } else if (
      file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      file.mimeType === "application/msword"
    ) {
      const res = await drive.files.export(
        { fileId: file.id, mimeType: "text/plain", supportsAllDrives: true },
        { responseType: "text" }
      ).catch(async () => {
        return await drive.files.get(
          { fileId: file.id, alt: "media", supportsAllDrives: true },
          { responseType: "text" }
        );
      });
      content = res.data;
    } else if (file.mimeType === "text/plain") {
      const res = await drive.files.get(
        { fileId: file.id, alt: "media", supportsAllDrives: true },
        { responseType: "text" }
      );
      content = res.data;
    } else {
      return null;
    }
    return { name: file.name, content: String(content).slice(0, 8000) };
  } catch (err) {
    console.error(`Failed to read file ${file.name}:`, err.message);
    return null;
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a recruitment intelligence assistant for a professional executive search firm.

You have access to candidate files including SWO documents, CVs, screening notes, and transcripts.

Answer questions from the internal team about candidates — specific candidates, role fit, compensation, availability, comparisons, etc.

Guidelines:
- Base answers only on the actual file content provided
- Be concise but complete
- Use structured format for comparisons
- Say clearly if you cannot find the information
- Never fabricate candidate information
- Compensation figures are in MXN per month unless stated otherwise
- Treat all candidate information as confidential

Respond in a clear, professional tone. Use bullet points when helpful.`;

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Slack Claude Bot running on port ${PORT}`);
});
