# AutoApply

An AI-powered job search agent that finds, ranks, and applies to roles on your behalf — so you can focus on interviewing, not hunting.

---

## What it does

- **Parses your CV** — upload a PDF or DOCX and the agent indexes your experience automatically
- **Natural language job search** — describe what you're looking for in plain English; Claude extracts role, salary, locations, industries, target companies, and company stage
- **Automated job discovery** — checks Greenhouse and Lever boards for your target companies daily, with Google Jobs fallback via SerpApi
- **AI match scoring** — every job is scored and ranked by relevance to your profile (90% match surfaces before 70%)
- **Cover letter generation** — Claude writes a tailored cover letter and CV highlights for each role you approve
- **One-click applications** — submit directly to Greenhouse/Lever or open the application page for big tech roles
- **Outreach emails** — draft personalised hiring manager outreach or follow-up emails for any job
- **Application tracker** — tracks every application with timestamps across Review, Applied, and Outreach tabs
- **All data stays local** — profile, API keys, and job history are stored only in your browser's localStorage

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | React 18 + Vite |
| AI | Anthropic Claude API (`claude-sonnet-4-20250514`) |
| Job search | SerpApi (Google Jobs) + Greenhouse API + Lever API |
| CV parsing | mammoth.js (DOCX), FileReader API (PDF) |
| Document export | docx.js |
| Styling | Inline CSS + CSS-in-JS |
| Storage | Browser localStorage (no backend) |
| Deployment | Vercel |

---

## How to run locally

### Prerequisites

- Node.js 18+
- An Anthropic API key — [console.anthropic.com](https://console.anthropic.com) → API Keys
- A SerpApi key (optional) — [serpapi.com](https://serpapi.com)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/ifedj/autoapply.git
cd autoapply

# 2. Install dependencies
npm install

# 3. Create your .env file (see below)
cp .env.example .env

# 4. Start the dev server
npm run dev
```

The app will be running at `http://localhost:5173`.

---

## Environment variables

Create a `.env` file in the project root:

```env
VITE_ANTHROPIC_KEY=sk-ant-...
VITE_SERPAPI_KEY=your_serpapi_key_here
```

> **Note:** These are optional. You can also paste your API keys directly in the app under **API Keys** in the sidebar — they are stored locally in your browser and never sent to any server other than the respective APIs.

| Variable | Required | Description |
|---|---|---|
| `VITE_ANTHROPIC_KEY` | Recommended | Powers cover letter generation, job scoring, and NL search parsing |
| `VITE_SERPAPI_KEY` | Optional | Enables Google Jobs search for big tech and companies without Greenhouse/Lever |

---

## Deploy to Vercel

### One-click deploy

1. Push your code to GitHub (already done)
2. Go to [vercel.com](https://vercel.com) and click **Add New Project**
3. Import the `autoapply` repository
4. Vercel will auto-detect Vite — no build configuration needed
5. Under **Environment Variables**, add `VITE_ANTHROPIC_KEY` and `VITE_SERPAPI_KEY`
6. Click **Deploy**

### Via Vercel CLI

```bash
npm install -g vercel
vercel
```

Follow the prompts. On first deploy, set your environment variables when asked or add them later in the Vercel dashboard under **Project → Settings → Environment Variables**.

### Build settings (auto-detected)

| Setting | Value |
|---|---|
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |

---

## Author

Built by **Ife Dare-Johnson**, MIT Sloan Fellows MBA 2025–2026.
