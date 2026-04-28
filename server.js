/**
 * Slack /ask → Claude Bot
 * 
 * Flow:
 *   1. User types /ask [question] in Slack
 *   2. Slack POSTs to this server
 *   3. Server immediately acknowledges (within 3s)
 *   4. Server fetches candidate files from Google Drive
 *   5. Server calls Claude API with files + system prompt
 *   6. Answer is posted back to Slack via response_url
 */

import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Clients ───────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccountKey,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth });

// ── Config ────────────────────────────────────────────────────────────────────

const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID;

// ── Google Drive helpers ──────────────────────────────────────────────────────

async function listAllFiles(folderId, maxFiles = 60) {
  const files = [];
  const queue = [folderId];

  while (queue.length > 0 && files.length < maxFiles) {
    const currentFolder = queue.shift();
    const res = await drive.files.list({
      q: `'${currentFolder}' in parents and trashed = false`,
      fields: "files(id, name, mimeType)",
      pageSize: 100,
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

async function getFileText(file) {
  try {
    let content = "";
    if (file.mimeType === "application/vnd.google-apps.document") {
      const res = await drive.files.export(
        { fileId: file.id, mimeType: "text/plain" },
        { responseType: "text" }
      );
      content = res.data;
    } else if (
      file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      file.mimeType === "application/msword"
    ) {
      const res = await drive.files.export(
        { fileId: file.id, mimeType: "text/plain" },
        { responseType: "text" }
      ).catch(async () => {
        const raw = await drive.files.get(
          { fileId: file.id, alt: "media" },
          { responseType: "text" }
        );
        return raw;
      });
      content = res.data;
    } else if (file.mimeType === "text/plain") {
      const res = await drive.files.get(
        { fileId: file.id, alt: "media" },
        { responseType: "text" }
      );
      content = res.data;
    } else {
      return null;
    }
    return {
      name: file.name,
      content: String(content).slice(0, 8000),
    };
  } catch (err) {
    console.error(`Failed to read file ${file.name}:`, err.message);
    return null;
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a recruitment intelligence assistant for a professional executive search firm.

You have access to a set of candidate files including:
- SWO documents (Structured Write-Ups): detailed recruiter assessments of each candidate
- CVs / Resumes: the candidates' own career documents
- Screening notes and transcripts (if available)

Your job is to answer questions from the internal team about these candidates. Questions may be about:
- A specific candidate ("Tell me about Karla Aguilar")
- Role fit ("Who is the best fit for Head of FSSC Americas?")
- Compensation & availability ("Who is available immediately and expects under 150K MXN?")
- Comparisons ("Compare Diana and Angie for the R2R Manager role")
- Anything else related to the candidates in the files

Guidelines:
- Always base your answers on the actual content of the candidate files provided
- Be concise but complete — this is an internal team tool, not a public-facing chatbot
- When comparing candidates, use a structured format
- If you cannot find information to answer the question, say so clearly
- Never fabricate or guess information about candidates
- Compensation figures are in MXN per month unless stated otherwise
- Treat all candidate information as confidential

Respond in a clear, professional tone. Use bullet points and structure when helpful.`;

// ── Background processor ──────────────────────────────────────────────────────

async function processQuestion(text, user_name, response_url) {
  try {
    console.log("Fetching file list from Drive...");
    const files = await listAllFiles(DRIVE_ROOT_FOLDER_ID);
    console.log(`Found ${files.length} files`);

    const CONCURRENCY = 5;
    const fileContents = [];
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(getFileText));
      fileContents.push(...results.filter(Boolean));
    }
    console.log(`Successfully read ${fileContents.length} files`);

    const contextBlock = fileContents
      .map((f) => `=== FILE: ${f.name} ===\n${f.content}`)
      .join("\n\n");

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
    console.error("Error in background processor:", err);
    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        text: `❌ Something went wrong: ${err.message}`,
      }),
    });
  }
}

// ── Route: /slack/ask ─────────────────────────────────────────────────────────

app.post("/slack/ask", (req, res) => {
  const { text, user_name, response_url } = req.body;

  // Step 1: Respond to Slack IMMEDIATELY (must happen within 3 seconds)
  if (!text || text.trim() === "") {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Please provide a question. Usage: `/ask Who is the best candidate for Head of FSSC?`",
    });
  }

  // Send the immediate acknowledgment — this satisfies Slack's 3s requirement
  res.status(200).json({
    response_type: "in_channel",
    text: `🔍 *${user_name}* asked: _${text}_\n⏳ Searching candidate files... (this takes ~30 seconds)`,
  });

  // Step 2: Do all the heavy work AFTER responding, in the background
  processQuestion(text, user_name, response_url);
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Slack Claude Bot running on port ${PORT}`);
});
