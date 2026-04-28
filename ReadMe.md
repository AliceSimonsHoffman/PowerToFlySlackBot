# PowerToFly Slack Bot — Ask Claude

A Slack bot that lets your internal team ask questions about candidates directly from Slack — powered by Claude AI and Google Drive.

---

## What it does

Type `/ask [question]` in Slack and the bot:
1. Reads all candidate files from a Google Drive folder (SWOs, CVs, screening notes)
2. Sends them to Claude with a recruiter-specific prompt
3. Posts the answer back to the channel in ~30 seconds

**Example questions:**
```
/ask How many engineers do we have in our database with 5 or more years of experience?
/ask Please share with me a list of candidates that are located in LATAM with Product experience?
/ask Please share the top 5 best fit candidates for the attached job description. 
/ask What is Karla Aguilar's expected compensation?
```

---

## Architecture

```
Slack /ask command
      ↓
Express server (Node.js) hosted on Railway
      ↓
Google Drive API — reads all candidate files recursively
      ↓
Anthropic Claude API — answers the question using file content
      ↓
Response posted back to Slack channel
```

---

## Tech stack

- **Node.js** + **Express** — server and webhook handler
- **Anthropic Claude API** — AI question answering
- **Google Drive API** — candidate file retrieval
- **Railway** — cloud deployment
- **Slack API** — slash command + response

---

## Setup

### Prerequisites
- Node.js 18+
- A Slack workspace (admin access)
- A Google Cloud project with Drive API enabled
- An Anthropic API key

### Installation

```bash
git clone https://github.com/YOUR-USERNAME/PowerToFlySlackBot
cd PowerToFlySlackBot
npm install
cp .env.example .env
# Fill in your credentials in .env
npm start
```

### Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full contents of your Google service account JSON key |
| `DRIVE_ROOT_FOLDER_ID` | ID of your Google Drive root folder |
| `SLACK_BOT_TOKEN` | Bot token from api.slack.com (starts with xoxb-) |

### Deployment

This project is designed to deploy on [Railway](https://railway.app):
1. Push to GitHub
2. Connect repo to Railway
3. Add environment variables in Railway dashboard
4. Railway auto-deploys on every push

---

## How the Drive folder is read

The bot recursively searches all subfolders under the root Drive folder, supporting `.docx`, Google Docs, and `.txt` files. Adding new candidate files to the folder makes them available to the bot automatically — no code changes needed.

---

## Project structure

```
PowerToFlySlackBot/
├── server.js        — Main bot server
├── package.json
├── .env.example     — Environment variable template
└── README.md
```
