import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SHEET_ID = "16g8VQySG3JNNbqb3vGtAJiWOvQnOz8Safb3sI8lYOn0";

// ── Health check ──────────────────────────────────────────────────────────────
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
    text: `🔍 *${user_name}* asked: _${text}_\n⏳ Searching candidate database... (this takes ~15 seconds)`,
  });

  // Process in background
  processQuestion(text, user_name, response_url).catch((err) => {
    console.error("Unhandled error in processQuestion:", err);
  });
});

// ── Background processor — TWO-TIER ROUTING ───────────────────────────────────
async function processQuestion(text, user_name, response_url) {
  try {
    // Parse Google credentials
    let serviceAccountKey;
    try {
      serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      throw new Error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: " + e.message);
    }

    // Set up Google auth with both Drive and Sheets access
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountKey,
      scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ],
    });

    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });

    // ── TIER 1: Read the Master Sheet (always, cheap) ─────────────────────────
    console.log("Tier 1: Reading Master Sheet...");
    const sheetData = await readMasterSheet(sheets);
    console.log(`Sheet loaded: ${sheetData.split('\n').length} rows`);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Ask Claude if the Sheet is enough to answer, or if it needs candidate files
    const tier1Result = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: TIER1_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the candidate index (Master Sheet):\n\n${sheetData}\n\n---\n\nQuestion from @${user_name}:\n${text}`,
        },
      ],
    });

    const tier1Answer = tier1Result.content[0].text;

    // Check if Claude flagged that it needs specific candidate files
    if (!tier1Answer.includes("[NEED_FILES:")) {
      // ── TIER 1 COMPLETE — answer from Sheet alone ─────────────────────────
      console.log("Tier 1 complete — answered from Sheet alone");
      const cleanAnswer = tier1Answer.replace("[COMPLETE]", "").trim();

      await postToSlack(response_url, text, cleanAnswer);
      return;
    }

    // ── TIER 2: Extract candidate names and fetch their files ─────────────────
    console.log("Tier 2 needed — fetching specific candidate files...");

    // Pull out the names Claude identified (format: [NEED_FILES: Name1, Name2])
    const needFilesMatch = tier1Answer.match(/\[NEED_FILES:\s*([^\]]+)\]/);
    const candidateNames = needFilesMatch
      ? needFilesMatch[1].split(",").map((n) => n.trim())
      : [];

    console.log(`Fetching files for: ${candidateNames.join(", ")}`);

    // Search Drive for files matching those candidate names
    const targetFiles = await findFilesForCandidates(
      drive,
      process.env.DRIVE_ROOT_FOLDER_ID,
      candidateNames
    );
    console.log(`Found ${targetFiles.length} relevant files`);

    // Read those files
    const CONCURRENCY = 5;
    const fileContents = [];
    for (let i = 0; i < targetFiles.length; i += CONCURRENCY) {
      const batch = targetFiles.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((f) => getFileText(drive, f)));
      fileContents.push(...results.filter(Boolean));
    }

    const contextBlock = fileContents
      .map((f) => `=== FILE: ${f.name} ===\n${f.content}`)
      .join("\n\n");

    // Final Claude call with Sheet + specific files
    console.log("Calling Claude with Sheet + candidate files...");
    const tier2Result = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Candidate index (Master Sheet):\n\n${sheetData}\n\n---\n\nDetailed candidate files:\n\n${contextBlock}\n\n---\n\nQuestion from @${user_name}:\n${text}`,
        },
      ],
    });

    const finalAnswer = tier2Result.content[0].text;
    await postToSlack(response_url, text, finalAnswer);
    console.log("Tier 2 response sent to Slack successfully");

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

// ── Read Master Google Sheet ──────────────────────────────────────────────────
async function readMasterSheet(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "A:Z", // reads all columns
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return "No data found in sheet.";

  // Convert rows to readable text (header row + data rows)
  const headers = rows[0];
  const dataRows = rows.slice(1);

  return dataRows
    .map((row) =>
      headers
        .map((header, i) => `${header}: ${row[i] || ""}`)
        .join(" | ")
    )
    .join("\n");
}

// ── Find Drive files matching candidate names ─────────────────────────────────
async function findFilesForCandidates(drive, folderId, candidateNames) {
  // Get all files first (same as before), then filter by name match
  const allFiles = await listAllFiles(drive, folderId, 500); // higher limit since we're filtering

  if (candidateNames.length === 0) return allFiles.slice(0, 10); // fallback

  // Filter files where the filename contains any of the candidate names
  return allFiles.filter((file) => {
    const fileName = file.name.toLowerCase();
    return candidateNames.some((name) =>
      name
        .toLowerCase()
        .split(" ")
        .some((part) => part.length > 2 && fileName.includes(part))
    );
  });
}

// ── Google Drive helpers ──────────────────────────────────────────────────────
async function listAllFiles(drive, folderId, maxFiles = 500) {
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
      const res = await drive.files
        .export(
          { fileId: file.id, mimeType: "text/plain", supportsAllDrives: true },
          { responseType: "text" }
        )
        .catch(async () => {
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

// ── Post answer back to Slack ─────────────────────────────────────────────────
async function postToSlack(response_url, question, answer) {
  await fetch(response_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "in_channel",
      text: `*Q: ${question}*\n\n${answer}`,
      mrkdwn: true,
    }),
  });
}

// ── System prompts ────────────────────────────────────────────────────────────

// Used in Tier 1 — Sheet only
const TIER1_SYSTEM_PROMPT = `You are a recruitment intelligence assistant for a professional executive search firm.

You have access to a candidate index (Master Sheet) with one row per candidate and key fields like name, role, skills, availability, compensation, and location.

Your job is to answer the question using ONLY the sheet data if possible.

RULES:
- If you can fully answer the question from the sheet alone, do so and end your response with [COMPLETE]
- If the question requires detailed information about a specific candidate (full background, fit assessment, detailed comparison, personality, transcript details), end your response with [NEED_FILES: First Last, First Last] listing only the candidates you need files for
- Never fabricate information
- Compensation figures are in USD per month unless stated otherwise
- Keep answers concise and professional

Examples of questions you CAN answer from the sheet alone:
- "How many candidates do we have available immediately?"
- "List everyone with FP&A experience"
- "Who has the highest compensation expectation?"
- "How many candidates speak Portuguese?"

Examples of questions that NEED files:
- "Tell me about Karla Aguilar"
- "Is Jessica a good fit for the Head of Finance role?"
- "Compare Diana and Angie in detail"
- "What did the candidate say about their leadership style?"`;

// Used in Tier 2 — Sheet + files
const SYSTEM_PROMPT = `You are a recruitment intelligence assistant for a professional executive search firm.

You have access to both a candidate index (Master Sheet) and detailed candidate files including SWO documents, CVs, screening notes, and transcripts.

Answer questions from the internal team about candidates — specific candidates, role fit, compensation, availability, comparisons, etc.

Guidelines:
- Base answers only on the actual content provided
- Be concise but complete
- Use structured format for comparisons
- Say clearly if you cannot find the information
- Never fabricate candidate information
- Compensation figures are in USD per month unless stated otherwise
- Treat all candidate information as confidential

Respond in a clear, professional tone. Use bullet points when helpful.`;

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Slack Claude Bot running on port ${PORT}`);
});
