import { useState, useEffect, useRef } from "react";
import mammoth from "mammoth";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

// ─── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_KEY = "job_agent_v3";
const GMAIL_MCP   = "https://gmail.mcp.claude.com/mcp";

const INDUSTRIES = [
  "Technology", "Fintech", "Healthcare / Digital Health", "E-commerce",
  "AI / ML", "Media & Entertainment", "SaaS / Enterprise", "Consumer",
  "Climate Tech", "Other",
];

const COMPANY_STAGES = [
  "Big Tech (FAANG+)",
  "Large Tech (1000+ employees)",
  "Growth Stage (Series C/D)",
  "Early Stage (Seed–Series B)",
  "Startups (any stage)",
  "Consultancies",
  "Financial Services",
];

const INDUSTRY_COLORS = {
  "Technology": "#3b82f6", "Fintech": "#8b5cf6",
  "Healthcare / Digital Health": "#10b981", "E-commerce": "#f59e0b",
  "AI / ML": "#06b6d4", "Media & Entertainment": "#ec4899",
  "SaaS / Enterprise": "#7c3aed", "Consumer": "#f97316",
  "Climate Tech": "#22c55e", "Other": "#6b7280",
};

// ─── Job source config ────────────────────────────────────────────────────────
// ─── Industry → suggested companies (shown as quick-add chips in onboarding) ──
const INDUSTRY_SUGGESTIONS = {
  "Healthcare / Digital Health": ["WHOOP", "Oura Ring", "Maven Clinic", "Spring Health", "Ro Health", "Tempus"],
  "Technology":                  ["Apple", "Google", "Amazon", "Microsoft", "Meta"],
  "AI / ML":                     ["OpenAI", "Anthropic", "Notion", "Figma", "Linear"],
  "Fintech":                     ["Stripe", "Plaid", "Robinhood", "Brex", "Ramp", "Chime"],
  "E-commerce":                  ["Shopify", "DoorDash", "Instacart", "Etsy"],
  "SaaS / Enterprise":           ["Notion", "Figma", "Salesforce", "HubSpot", "Linear"],
  "Consumer":                    ["Spotify", "Netflix", "Pinterest", "Snap", "Reddit"],
  "Media & Entertainment":       ["Spotify", "Netflix", "Pinterest", "Snap"],
  "Climate Tech":                ["Tesla", "Rivian"],
};

const PM_TITLE_RE = /product manager|head of product|director of product|vp.{0,5}product/i;

const SOURCE_META = {
  "Greenhouse": { color: "#1e40af", border: "#bfdbfe", bg: "#dbeafe" },
  "Lever":      { color: "#6b21a8", border: "#e9d5ff", bg: "#f3e8ff" },
  "Google Jobs":{ color: "#dc2626", border: "#fecaca", bg: "#fee2e2" },
};

// ─── SerpApi usage helpers ─────────────────────────────────────────────────────
function serpUsageKey() {
  return `serpapi_usage_${new Date().toISOString().slice(0, 7)}`;
}
function getSerpUsage()      { return parseInt(localStorage.getItem(serpUsageKey()) || "0"); }
function incSerpUsage(n = 4) { localStorage.setItem(serpUsageKey(), String(getSerpUsage() + n)); }
function nextMonthFirst() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
    .toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

// ─── Job-board slug cache ──────────────────────────────────────────────────────
// Stores: { "oura ring": { system: "greenhouse"|"lever"|"serp", slug?, verified: true } }
const SLUG_CACHE_KEY = "job_board_cache_v1";
function getSlugCache() {
  try { return JSON.parse(localStorage.getItem(SLUG_CACHE_KEY) || "{}"); } catch { return {}; }
}
function setSlugCache(cache) {
  localStorage.setItem(SLUG_CACHE_KEY, JSON.stringify(cache));
}

// ─── Automatic job-board detection ────────────────────────────────────────────
function generateSlugs(companyName) {
  const base = companyName.toLowerCase().trim();
  return [
    base.replace(/\s+/g, ""),                                      // "ouraring"
    base.replace(/\s+/g, "-"),                                     // "oura-ring"
    base.replace(/[^a-z0-9]/g, ""),                                // strips & . , etc
    base.split(" ")[0],                                            // first word only
    base.replace(/\s+/g, "").replace(/inc|llc|corp|health|ai$/, ""), // strip suffixes
  ].filter((s, i, arr) => s.length > 2 && arr.indexOf(s) === i);  // dedupe
}

async function autoDetectJobBoard(companyName) {
  const cacheKey = companyName.toLowerCase().trim();
  const cache = getSlugCache();
  if (cache[cacheKey]) return cache[cacheKey];

  const slugs = generateSlugs(companyName);

  // Try Greenhouse
  for (const slug of slugs) {
    try {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
      if (res.ok) {
        const result = { system: "greenhouse", slug, verified: true };
        setSlugCache({ ...getSlugCache(), [cacheKey]: result });
        return result;
      }
    } catch {}
  }

  // Try Lever
  for (const slug of slugs) {
    try {
      const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`);
      if (res.ok) {
        const result = { system: "lever", slug, verified: true };
        setSlugCache({ ...getSlugCache(), [cacheKey]: result });
        return result;
      }
    } catch {}
  }

  // Fall back to SerpApi
  const result = { system: "serp", verified: true };
  setSlugCache({ ...getSlugCache(), [cacheKey]: result });
  return result;
}

// ─── Real-API fetch helpers ────────────────────────────────────────────────────
function stripHtml(html = "") {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchGreenhouse(slug, displayName) {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || [])
      .filter(j => PM_TITLE_RE.test(j.title))
      .map(j => ({
        title:          j.title,
        company:        displayName || slug,
        location:       j.location?.name || "Remote",
        salary:         "",
        jobDescription: stripHtml(j.content || "").slice(0, 300),
        applyUrl:       j.absolute_url || "",
        postedAt:       j.updated_at
          ? new Date(j.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "",
        source:   "Greenhouse",
        industry: "Healthcare / Digital Health",
        hiringManager: "", hiringEmail: "",
      }));
  } catch { return []; }
}

async function fetchLever(slug, displayName) {
  try {
    const res = await fetch(
      `https://api.lever.co/v0/postings/${slug}?mode=json`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .filter(j => PM_TITLE_RE.test(j.text))
      .map(j => {
        const sr = j.salaryRange;
        const salary = sr?.min && sr?.max
          ? `$${Math.round(sr.min / 1000)}k–$${Math.round(sr.max / 1000)}k`
          : "";
        return {
          title:          j.text,
          company:        displayName || slug,
          location:       j.categories?.location || j.categories?.allLocations?.[0] || "Remote",
          salary,
          jobDescription: stripHtml(j.descriptionPlain || j.description || "").slice(0, 300),
          applyUrl:       j.hostedUrl || "",
          postedAt:       j.createdAt
            ? new Date(j.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            : "",
          source:   "Lever",
          industry: "Healthcare / Digital Health",
          hiringManager: "", hiringEmail: "",
        };
      });
  } catch { return []; }
}

async function fetchSerpApi(query, serpKey) {
  try {
    const url = `https://serpapi.com/search.json?engine=google_jobs&q=${encodeURIComponent(query)}&api_key=${serpKey}&num=5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (data.error) return [];
    return (data.jobs_results || []).slice(0, 3).map(j => ({
      title:          j.title,
      company:        j.company_name,
      location:       j.location || "",
      salary:         j.detected_extensions?.salary || "",
      jobDescription: (j.description || "").slice(0, 300),
      applyUrl:       j.apply_options?.[0]?.link || j.share_link || "",
      postedAt:       j.detected_extensions?.posted_at || "",
      source:         "Google Jobs",
      industry:       "Healthcare / Digital Health",
      hiringManager:  "", hiringEmail: "",
      careersUrl:     j.apply_options?.[0]?.link || "",
    }));
  } catch { return []; }
}

// ─── Batch CV-match scoring ────────────────────────────────────────────────────
async function scoreJobsWithClaude(jobs, p) {
  if (!jobs.length || !p.apiKey) return jobs.map(j => ({ ...j, matchScore: 75, matchReason: "" }));
  const summaries = jobs.map((j, i) => ({
    i, title: j.title, company: j.company,
    desc: (j.jobDescription || "").slice(0, 150),
  }));
  const data = await callClaude(
    `Score each job 0–100 for CV fit. Reply ONLY with a JSON array of {i, score, reason} — no other text.`,
    `CV: ${(p.cvText || "").slice(0, 800)}\n\nJobs: ${JSON.stringify(summaries)}`,
    p.apiKey
  );
  const text   = extractText(data);
  const scores = parseJSON(text);
  if (!Array.isArray(scores)) return jobs.map(j => ({ ...j, matchScore: 75, matchReason: "" }));
  return jobs.map((j, idx) => {
    const s = scores.find(x => x.i === idx);
    return { ...j, matchScore: s?.score ?? 75, matchReason: s?.reason ?? "" };
  });
}

// ─── API helpers ───────────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt, apiKey, tools = [], mcpServers = []) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (tools.length)      body.tools       = tools;
  if (mcpServers.length) body.mcp_servers = mcpServers;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

function extractText(data) {
  if (!data?.content) return "";
  return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

function parseJSON(text) {
  try {
    const start = text.indexOf("[");
    const end   = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch { return null; }
}

async function downloadDocx(text, filename) {
  const lines = text.split("\n");
  const children = lines.map(line =>
    new Paragraph({ children: [new TextRun({ text: line || " ", size: 24, font: "Calibri" })] })
  );
  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function getGreeting(name) {
  const h = new Date().getHours();
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return `Good ${part}, ${name?.split(" ")[0] || "there"}`;
}

function formatDate() {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function getWeekOfYear() {
  const now = new Date(), start = new Date(now.getFullYear(), 0, 1);
  return Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
}

function formatLastChecked(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return d.toDateString() === today.toDateString()
    ? `Today ${time}`
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + time;
}

// ─── NL search parsing ────────────────────────────────────────────────────────
function parseSearchBasic(text) {
  const t = text.toLowerCase();
  let role = "Senior Product Manager";
  if (/head of product/i.test(text))       role = "Head of Product";
  else if (/director of product/i.test(text)) role = "Director of Product";
  else if (/vp.{0,5}product/i.test(text))  role = "VP Product";
  else if (/senior pm|senior product/i.test(text)) role = "Senior Product Manager";
  else if (/\bpm\b/i.test(text))           role = "Product Manager";

  const salaryMatch = text.match(/\$[\d,]+k?[\s\u2013\-]+\$?[\d,]+k?|\$[\d,]+k?\+/i);
  const salary = salaryMatch ? salaryMatch[0].trim() : "";

  const cityMap = {
    "boston":"Boston","new york":"New York","nyc":"New York",
    "san francisco":"San Francisco","remote":"Remote","austin":"Austin",
    "seattle":"Seattle","los angeles":"Los Angeles","chicago":"Chicago","miami":"Miami",
  };
  const locations = [...new Set(Object.entries(cityMap).filter(([k]) => t.includes(k)).map(([,v]) => v))];

  const industries = [];
  if (/health|medic|clinic|patient|wellness/i.test(text)) industries.push("Healthcare / Digital Health");
  if (/\bai\b|machine learning|\bml\b/i.test(text)) industries.push("AI / ML");
  if (/fintech|finance|banking|payment/i.test(text)) industries.push("Fintech");
  if (/consumer/i.test(text)) industries.push("Consumer");
  if (/\bsaas\b|enterprise software/i.test(text)) industries.push("SaaS / Enterprise");
  if (/ecommerce|e-commerce/i.test(text)) industries.push("E-commerce");
  if (/climate|green|sustainable/i.test(text)) industries.push("Climate Tech");
  if (industries.length === 0 && /tech|software/i.test(text)) industries.push("Technology");

  const knownCos = ["WHOOP","Oura","Maven Clinic","Spring Health","Ro Health","Tempus",
    "OpenAI","Anthropic","Notion","Figma","Linear","Stripe","Plaid","Robinhood","Brex",
    "Ramp","Chime","Shopify","DoorDash","Instacart","Etsy","Spotify","Netflix","Pinterest",
    "Snap","Reddit","Google","Apple","Amazon","Microsoft","Meta","Tesla","Rivian","Salesforce","HubSpot"];
  const companies = knownCos.filter(c => t.includes(c.toLowerCase()));

  const stages = [];
  if (/series [ab]\b|seed/i.test(text))    stages.push("Early Stage (Seed–Series B)");
  if (/series [cd]\b/i.test(text))         stages.push("Growth Stage (Series C/D)");
  if (/startup/i.test(text) && !stages.length) stages.push("Startups (any stage)");
  if (/big tech|faang/i.test(text))        stages.push("Big Tech (FAANG+)");
  return { role, salary, locations, industries, companies, stages };
}

async function parseSearchIntent(text, apiKey) {
  if (!apiKey) return parseSearchBasic(text);
  try {
    const data = await callClaude(
      `Extract job search preferences from natural language. Return ONLY valid JSON (no markdown, no explanation) with these exact keys: {"role":string,"salary":string,"locations":string[],"industries":string[],"companies":string[],"stages":string[]}. For industries use exactly one of: Technology, Fintech, Healthcare / Digital Health, E-commerce, AI / ML, Media & Entertainment, SaaS / Enterprise, Consumer, Climate Tech. For stages use exactly one of: Big Tech (FAANG+), Large Tech (1000+ employees), Growth Stage (Series C/D), Early Stage (Seed–Series B), Startups (any stage). Leave arrays empty if not mentioned.`,
      text,
      apiKey
    );
    const raw = extractText(data);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return { ...parseSearchBasic(text), ...JSON.parse(match[0]) };
  } catch {}
  return parseSearchBasic(text);
}

// ─── Global CSS ────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=DM+Serif+Display&family=JetBrains+Mono:wght@400;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #ffffff; font-family: 'Inter', 'Segoe UI', sans-serif; }
  input, textarea, button { font-family: inherit; }
  input:focus, textarea:focus { border-color: #7c3aed !important; box-shadow: 0 0 0 3px #7c3aed15 !important; }
  ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 99px; }
  @keyframes pulse    { 0%,100%{opacity:1} 50%{opacity:.35} }
  @keyframes spin     { to{transform:rotate(360deg)} }
  @keyframes fadeUp   { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:none} }
  @keyframes slideIn  { from{opacity:0;transform:translateX(-8px)} to{opacity:1;transform:none} }
  @keyframes slideDown{ from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:none} }
  .fade-up   { animation: fadeUp   0.4s ease both; }
  .slide-in  { animation: slideIn  0.3s ease both; }
  .slide-down{ animation: slideDown 0.25s ease both; }
`;

// ─── Shared styles ─────────────────────────────────────────────────────────────
const field = {
  background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 10,
  padding: "11px 14px", color: "#111111", fontSize: 14, width: "100%",
  outline: "none", transition: "border-color 0.2s, box-shadow 0.2s",
};
const label = {
  fontSize: 11, fontWeight: 600, color: "#6b7280", letterSpacing: "0.07em",
  textTransform: "uppercase", marginBottom: 6, display: "block",
};
const primaryBtn = (disabled = false) => ({
  background: disabled ? "#f3f4f6" : "#000000",
  color: disabled ? "#9ca3af" : "#fff", border: "none", borderRadius: 10,
  padding: "13px 24px", fontWeight: 700, fontSize: 14, cursor: disabled ? "not-allowed" : "pointer",
  display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s",
  opacity: disabled ? 0.6 : 1,
});
const ghostBtn = {
  background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb",
  borderRadius: 10, padding: "12px 20px", fontWeight: 600, fontSize: 13,
  cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
  transition: "all 0.2s",
};

// ─── Reusable atoms ────────────────────────────────────────────────────────────
function TypeWriter({ text, speed = 22 }) {
  const [out, setOut] = useState("");
  useEffect(() => {
    setOut(""); let i = 0;
    const id = setInterval(() => { setOut(text.slice(0, ++i)); if (i >= text.length) clearInterval(id); }, speed);
    return () => clearInterval(id);
  }, [text]);
  return <span>{out}</span>;
}

const STATUS_META = {
  "pending-review":  { color: "#f59e0b", label: "Pending Review" },
  "generating":      { color: "#7c3aed", label: "Generating…" },
  "ready-to-apply":  { color: "#06b6d4", label: "Ready to Apply" },
  "applied":         { color: "#10b981", label: "Applied ✓" },
  "outreach-sent":   { color: "#10b981", label: "Outreach Sent" },
  searching:         { color: "#f59e0b", label: "Searching" },
  rejected:          { color: "#4a5568", label: "Skipped" },
  error:             { color: "#ef4444", label: "Error" },
};

function StatusBadge({ status }) {
  const { color, label: lbl } = STATUS_META[status] || { color: "#6b7280", label: status };
  return (
    <span style={{
      background: color + "20", color, border: `1px solid ${color}40`,
      borderRadius: 99, padding: "3px 11px", fontSize: 11, fontWeight: 600,
      letterSpacing: "0.05em", whiteSpace: "nowrap",
    }}>{lbl}</span>
  );
}

function IndustryTag({ industry }) {
  const color = INDUSTRY_COLORS[industry] || "#6b7280";
  return (
    <span style={{
      background: color + "18", color, border: `1px solid ${color}30`,
      borderRadius: 99, padding: "2px 9px", fontSize: 11, fontWeight: 500,
    }}>{industry}</span>
  );
}

function SourceBadge({ source }) {
  const m = SOURCE_META[source] || { color: "#9ca3af", border: "#6b728030", bg: "#6b728015" };
  return (
    <span style={{
      background: m.bg, color: m.color, border: `1px solid ${m.border}`,
      borderRadius: 99, padding: "2px 9px", fontSize: 10, fontWeight: 700,
      letterSpacing: "0.06em", textTransform: "uppercase",
    }}>{source}</span>
  );
}

function CompanyStatusBadge({ company, serpAvailable }) {
  const detected = getSlugCache()[company.toLowerCase().trim()];
  let source, icon, color;
  if (!detected)                   { source = "Pending";     icon = "⏳"; color = "#92400e"; }
  else if (detected.system === "greenhouse") { source = "Greenhouse"; icon = "✅"; color = "#1e40af"; }
  else if (detected.system === "lever")      { source = "Lever";      icon = "✅"; color = "#6b21a8"; }
  else if (serpAvailable)          { source = "Google Jobs"; icon = "🔍"; color = "#dc2626"; }
  else                             { source = "No API key";  icon = "⚠️"; color = "#92400e"; }
  return (
    <span style={{
      background: color + "15", color, border: `1px solid ${color}30`,
      borderRadius: 99, padding: "2px 10px", fontSize: 10, fontWeight: 700,
      letterSpacing: "0.05em", whiteSpace: "nowrap",
    }}>
      {source} {icon}
    </span>
  );
}

// Tag input (locations, companies)
function TagInput({ tags, onChange, placeholder }) {
  const [val, setVal] = useState("");
  const ref = useRef();

  const add = (v = val) => {
    const t = v.trim().replace(/,$/, "");
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setVal("");
  };

  return (
    <div
      onClick={() => ref.current?.focus()}
      style={{
        background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 10,
        padding: "8px 12px", display: "flex", flexWrap: "wrap", gap: 6,
        cursor: "text", minHeight: 46, alignItems: "center",
        transition: "border-color 0.2s",
      }}
    >
      {tags.map(t => (
        <span key={t} style={{
          background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb",
          borderRadius: 99, padding: "3px 10px 3px 12px", fontSize: 12, fontWeight: 500,
          display: "flex", alignItems: "center", gap: 5,
        }}>
          {t}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onChange(tags.filter(x => x !== t)); }}
            style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", padding: 0, lineHeight: 1, fontSize: 14, display: "flex" }}
          >×</button>
        </span>
      ))}
      <input
        ref={ref}
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          if (e.key === "Backspace" && !val && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={() => val.trim() && add()}
        placeholder={tags.length === 0 ? placeholder : "Add more…"}
        style={{ background: "none", border: "none", outline: "none", color: "#111111", fontSize: 13, flex: 1, minWidth: 80, padding: "2px 0" }}
      />
    </div>
  );
}

// Checkbox grid (industries, stages)
function CheckGrid({ options, selected, onChange, cols = 2 }) {
  const toggle = opt => onChange(selected.includes(opt) ? selected.filter(o => o !== opt) : [...selected, opt]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}>
      {options.map(opt => {
        const on = selected.includes(opt);
        return (
          <label key={opt} onClick={() => toggle(opt)} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 14px", borderRadius: 9, cursor: "pointer",
            background: on ? "#f3f4f6" : "#ffffff",
            border: `1px solid ${on ? "#111111" : "#e5e7eb"}`,
            transition: "all 0.15s", userSelect: "none",
          }}>
            <div style={{
              width: 17, height: 17, borderRadius: 5, flexShrink: 0,
              background: on ? "#111111" : "transparent",
              border: `1.5px solid ${on ? "#111111" : "#d1d5db"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, color: "#fff", transition: "all 0.15s",
            }}>
              {on && "✓"}
            </div>
            <span style={{ fontSize: 13, color: on ? "#111111" : "#6b7280", fontWeight: on ? 600 : 400, lineHeight: 1.3 }}>
              {opt}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function StatCard({ icon, label: lbl, value, color, sub }) {
  return (
    <div style={{
      background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 14,
      padding: "22px 24px", flex: 1, minWidth: 130,
      boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
    }}>
      <div style={{ fontSize: 24, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color, fontFamily: "'JetBrains Mono',monospace", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>{lbl}</div>
      {sub && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function LogPanel({ logs }) {
  const ref = useRef();
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs]);
  return (
    <div ref={ref} style={{
      background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 12,
      padding: "14px 16px", fontFamily: "'JetBrains Mono',monospace",
      fontSize: 12, color: "#111111", height: 230, overflowY: "auto", lineHeight: 1.8,
    }}>
      {!logs.length && <span style={{ color: "#9ca3af" }}>// activity will appear here</span>}
      {logs.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <span style={{ color: "#9ca3af", flexShrink: 0 }}>{l.time}</span>
          <span style={{ color: l.type === "error" ? "#dc2626" : l.type === "success" ? "#16a34a" : "#7c3aed", flexShrink: 0 }}>
            {l.type === "success" ? "✓" : l.type === "error" ? "✗" : "›"}
          </span>
          <span style={{ color: l.type === "error" ? "#dc2626" : l.type === "success" ? "#16a34a" : "#374151" }}>{l.msg}</span>
        </div>
      ))}
    </div>
  );
}

function FunnelChart({ jobs }) {
  const rows = [
    { label: "Applied",   count: jobs.filter(j => ["applied","emailed"].includes(j.status)).length, color: "#7c3aed" },
    { label: "Responded", count: jobs.filter(j => j.status === "emailed").length,                  color: "#06b6d4" },
    { label: "Interview", count: 0,                                                                 color: "#10b981" },
    { label: "Offer",     count: 0,                                                                 color: "#f59e0b" },
  ];
  const max = Math.max(rows[0].count, 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {rows.map(({ label: lbl, count, color }) => (
        <div key={lbl}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}>
            <span style={{ color: "#6b7280" }}>{lbl}</span>
            <span style={{ color, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{count}</span>
          </div>
          <div style={{ background: "#f3f4f6", borderRadius: 99, height: 7, overflow: "hidden" }}>
            <div style={{ width: `${Math.max((count / max) * 100, count > 0 ? 8 : 0)}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.7s ease" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Job Card ──────────────────────────────────────────────────────────────────
function JobCard({ job, onApprove, onReject, onMarkApplied, onGenerateEmail, onSendEmail }) {
  const [open, setOpen]               = useState(["ready-to-apply", "generating"].includes(job.status));
  const [editCL, setEditCL]           = useState(job.coverLetter || "");
  const [editHMEmail, setEditHMEmail] = useState(job.hiringEmail || "");
  const [showOutreach, setShowOutreach] = useState(false);
  const [editEmailDraft, setEditEmailDraft] = useState(job.emailDraft || "");
  const [sending, setSending]         = useState(false);
  const [submitting, setSubmitting]   = useState(false);
  const [urlOpened, setUrlOpened]     = useState(false);
  const [emailSubject, setEmailSubject] = useState(`Re: ${job.title} at ${job.company}`);

  // Animated height — tracks inner content div
  const bodyRef = useRef();
  const [bodyHeight, setBodyHeight] = useState(0);
  useEffect(() => {
    if (!bodyRef.current) return;
    const ro = new ResizeObserver(entries => setBodyHeight(entries[0].contentRect.height));
    ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, []);

  // Sync editable fields from parent
  useEffect(() => { if (job.coverLetter) setEditCL(job.coverLetter); }, [job.coverLetter]);
  useEffect(() => { if (job.emailDraft)  { setEditEmailDraft(job.emailDraft); setShowOutreach(true); } }, [job.emailDraft]);

  // Auto-expand when status transitions to generating / ready-to-apply
  useEffect(() => {
    if (["generating", "ready-to-apply"].includes(job.status)) setOpen(true);
  }, [job.status]);

  const isReady     = job.status === "ready-to-apply";
  const isGenerating = job.status === "generating";
  const isApplied   = job.status === "applied";

  // Big tech = Google Jobs source (no direct API, user must submit manually)
  const isBigTech = job.source === "Google Jobs";

  // CV highlights: split bullet string into array
  const highlights = job.cvHighlights
    ? job.cvHighlights.split("\n").map(l => l.replace(/^[•\-\*\d.]+\s*/, "").trim()).filter(Boolean)
    : [];

  const liSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=hiring+manager+${encodeURIComponent(job.company)}`;

  const handleSubmit = () => {
    setSubmitting(true);
    if (job.applyUrl) window.open(job.applyUrl, "_blank");
    if (!isBigTech) {
      // Greenhouse / Lever: open URL and auto-mark applied after short delay
      setTimeout(() => { onMarkApplied(job.id); setSubmitting(false); }, 1400);
    } else {
      // Big tech: open URL, then show "Mark as Applied"
      setUrlOpened(true);
      setSubmitting(false);
    }
  };

  return (
    <div className="fade-up" style={{
      background: "#ffffff",
      borderTop: "1px solid #e5e7eb",
      borderRight: "1px solid #e5e7eb",
      borderBottom: "1px solid #e5e7eb",
      borderLeft: open ? "3px solid #7c3aed" : "1px solid #e5e7eb",
      borderRadius: 14, marginBottom: 12, overflow: "hidden",
      boxShadow: open ? "0 4px 16px rgba(124,58,237,0.08)" : "0 1px 3px rgba(0,0,0,0.06)",
      transition: "border-left 0.2s, box-shadow 0.25s",
    }}>

      {/* ── Header (always visible, click to expand) ── */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ padding: "18px 20px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: "#0a0a0a" }}>{job.title}</span>
            {job.source && <SourceBadge source={job.source} />}
          </div>
          <div style={{ fontSize: 13, color: "#7c3aed", fontWeight: 600, marginBottom: 5 }}>{job.company}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {job.location && <span style={{ fontSize: 12, color: "#6b7280" }}>{job.location}</span>}
            {job.salary   && <><span style={{ color: "#d1d5db" }}>·</span><span style={{ fontSize: 12, color: "#6b7280" }}>{job.salary}</span></>}
            {job.postedAt && <><span style={{ color: "#d1d5db" }}>·</span><span style={{ fontSize: 11, color: "#9ca3af" }}>Posted {job.postedAt}</span></>}
            {job.industry && <IndustryTag industry={job.industry} />}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
          <StatusBadge status={job.status} />
          {job.matchScore != null && job.matchScore !== 75 && (
            <span style={{ fontSize: 11, fontWeight: 700, color: job.matchScore >= 85 ? "#16a34a" : "#d97706" }}>
              {job.matchScore}% match
            </span>
          )}
          <span style={{ fontSize: 15, color: open ? "#7c3aed" : "#9ca3af", transition: "color 0.2s" }}>{open ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* ── Animated expand/collapse wrapper ── */}
      <div style={{ height: open ? bodyHeight : 0, overflow: "hidden", transition: "height 0.35s cubic-bezier(0.4,0,0.2,1)" }}>
        <div ref={bodyRef} style={{ padding: "4px 22px 24px", borderTop: "1px solid #f3f4f6" }}>

          {/* Role description */}
          {job.jobDescription && (
            <div style={{ marginTop: 14, marginBottom: 10 }}>
              <div style={{ ...label, marginBottom: 5 }}>Role Overview</div>
              <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7 }}>{job.jobDescription}</div>
            </div>
          )}
          {job.whyItFits && (
            <div style={{ marginBottom: 14, background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: 8, padding: "9px 13px", fontSize: 12, color: "#be185d" }}>
              <span style={{ fontWeight: 600 }}>Why relevant: </span>{job.whyItFits}
            </div>
          )}

          {/* ── PENDING: Approve & Apply / Skip ── */}
          {job.status === "pending-review" && onApprove && (
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button
                onClick={e => { e.stopPropagation(); onApprove(job.id); }}
                style={{ ...primaryBtn(), flex: 1, justifyContent: "center", background: "#16a34a" }}
              >
                ✨ Approve & Apply
              </button>
              <button
                onClick={e => { e.stopPropagation(); onReject(job.id); }}
                style={{ ...ghostBtn, background: "#ffffff", color: "#374151", border: "1px solid #e5e7eb" }}
              >
                ✗ Skip
              </button>
            </div>
          )}

          {/* ── GENERATING: Inline spinner ── */}
          {isGenerating && (
            <div className="slide-down" style={{ display: "flex", alignItems: "center", gap: 14, padding: "22px 0 10px" }}>
              <div style={{ width: 24, height: 24, border: "2.5px solid #ede9fe", borderTopColor: "#7c3aed", borderRadius: "50%", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#7c3aed" }}>Generating your cover letter…</div>
                <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>Claude is tailoring your application materials</div>
              </div>
            </div>
          )}

          {/* ── READY TO APPLY: Full review panel ── */}
          {isReady && (
            <div className="slide-down">
              {/* Disclaimer */}
              <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 9, padding: "10px 14px", fontSize: 12, color: "#1e40af", margin: "14px 0 18px", lineHeight: 1.6 }}>
                <strong>We prepare your materials — you submit the application.</strong> Review and edit below, then hit Submit.
              </div>

              {/* Cover letter */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={label}>Cover Letter</label>
                  <button
                    onClick={e => { e.stopPropagation(); downloadDocx(editCL, `cover-letter-${job.company}.docx`); }}
                    style={{ ...ghostBtn, padding: "4px 12px", fontSize: 11 }}
                  >
                    ⬇ Download .docx
                  </button>
                </div>
                <textarea
                  value={editCL}
                  onChange={e => setEditCL(e.target.value)}
                  style={{ ...field, height: 180, resize: "vertical", fontSize: 13, lineHeight: 1.7 }}
                />
              </div>

              {/* CV highlights */}
              {highlights.length > 0 && (
                <div style={{ marginBottom: 18, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px" }}>
                  <label style={{ ...label, marginBottom: 10 }}>Key CV Highlights for This Role</label>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                    {highlights.map((h, i) => (
                      <li key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, color: "#374151", lineHeight: 1.5 }}>
                        <span style={{ color: "#7c3aed", flexShrink: 0, fontWeight: 700, marginTop: 1 }}>•</span>
                        {h}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Hiring manager email */}
              <div style={{ marginBottom: 20 }}>
                <label style={label}>Hiring Manager Email</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    value={editHMEmail}
                    onChange={e => setEditHMEmail(e.target.value)}
                    placeholder="hiring.manager@company.com"
                    style={{ ...field, flex: 1 }}
                    onClick={e => e.stopPropagation()}
                  />
                  {!editHMEmail && (
                    <a
                      href={liSearchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      style={{ ...ghostBtn, textDecoration: "none", whiteSpace: "nowrap", fontSize: 12, padding: "10px 14px" }}
                    >
                      🔍 Find on LinkedIn
                    </a>
                  )}
                </div>
              </div>

              {/* Primary action buttons */}
              <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                {isBigTech ? (
                  // Big tech: open application → then user marks applied
                  <>
                    <button
                      onClick={e => { e.stopPropagation(); handleSubmit(); }}
                      disabled={submitting}
                      style={{ ...primaryBtn(submitting), fontSize: 14, padding: "13px 24px" }}
                    >
                      {submitting ? "Opening…" : "↗ Open Application"}
                    </button>
                    {job.applyUrl && (
                      <a
                        href={job.applyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => { e.stopPropagation(); setUrlOpened(true); }}
                        style={{ ...ghostBtn, textDecoration: "none" }}
                      >
                        ↗ Open Job Posting
                      </a>
                    )}
                    {urlOpened && (
                      <button
                        onClick={e => { e.stopPropagation(); onMarkApplied(job.id); }}
                        style={{ ...ghostBtn, background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}
                      >
                        ✅ Mark as Applied
                      </button>
                    )}
                  </>
                ) : (
                  // Greenhouse / Lever: submit → auto-mark applied
                  <>
                    <button
                      onClick={e => { e.stopPropagation(); handleSubmit(); }}
                      disabled={submitting}
                      style={{ ...primaryBtn(submitting), background: submitting ? "#f3f4f6" : "#16a34a", color: submitting ? "#9ca3af" : "#fff", fontSize: 14, padding: "13px 28px" }}
                    >
                      {submitting
                        ? <><span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>⟳</span> Submitting…</>
                        : "✅ Submit Application"}
                    </button>
                    {job.applyUrl && (
                      <a
                        href={job.applyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        style={{ ...ghostBtn, textDecoration: "none" }}
                      >
                        ↗ Open Job Posting
                      </a>
                    )}
                    {!job.applyUrl && (
                      <button
                        onClick={e => { e.stopPropagation(); onMarkApplied(job.id); }}
                        style={{ ...ghostBtn, background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}
                      >
                        ✅ Mark as Applied
                      </button>
                    )}
                  </>
                )}
              </div>

            </div>
          )}

          {/* ── APPLIED ── */}
          {isApplied && (
            <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "#16a34a", fontWeight: 600 }}>
                ✅ Applied{job.appliedAt ? ` · ${job.appliedAt}` : ""}
              </span>
              {job.applyUrl && (
                <a
                  href={job.applyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...ghostBtn, textDecoration: "none", fontSize: 12, background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0", padding: "6px 14px" }}
                >
                  ↗ View Posting
                </a>
              )}
            </div>
          )}

          {/* ── SKIPPED ── */}
          {job.status === "rejected" && (
            <div style={{ marginTop: 12, fontSize: 12, color: "#9ca3af" }}>This role was skipped.</div>
          )}

          {/* ── EMAIL COMPOSER — available on all active cards ── */}
          {job.status !== "rejected" && !isGenerating && (
            <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 14, marginTop: isReady ? 0 : 14 }}>
              {!showOutreach ? (
                <button
                  onClick={e => { e.stopPropagation(); onGenerateEmail && onGenerateEmail(job.id); }}
                  style={{ ...ghostBtn, fontSize: 12 }}
                >
                  💌 {isApplied ? "Send Follow-up Email" : "Draft Outreach Email to Hiring Manager"}
                </button>
              ) : (
                <div className="slide-down">
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ ...label, marginBottom: 5 }}>Subject</label>
                    <input
                      value={emailSubject}
                      onChange={e => setEmailSubject(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      style={{ ...field }}
                    />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                      <label style={{ ...label, color: "#2563eb" }}>
                        Email Draft
                        {(job.hiringManager || editHMEmail) && (
                          <span style={{ color: "#374151", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                            {" "}— to {job.hiringManager || "Hiring Manager"}{editHMEmail ? ` (${editHMEmail})` : ""}
                          </span>
                        )}
                      </label>
                    </div>
                    <textarea
                      value={editEmailDraft}
                      onChange={e => setEditEmailDraft(e.target.value)}
                      style={{ ...field, height: 130, resize: "vertical", fontSize: 13, lineHeight: 1.7 }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      disabled={sending}
                      onClick={async e => {
                        e.stopPropagation();
                        setSending(true);
                        await onSendEmail(job.id, editEmailDraft);
                        setSending(false);
                      }}
                      style={{ ...primaryBtn(sending), background: sending ? "#f3f4f6" : "#2563eb", color: sending ? "#9ca3af" : "#fff" }}
                    >
                      {sending ? "Sending…" : "📤 Send Email"}
                    </button>
                    <button onClick={e => { e.stopPropagation(); setShowOutreach(false); }} style={ghostBtn}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Landing Screen (new user experience) ─────────────────────────────────────
function LandingScreen({ onComplete }) {
  const [screen, setScreen]           = useState(1);
  const [cv, setCv]                   = useState({ text: "", fileName: "", parsed: false });
  const [cvParsing, setCvParsing]     = useState(false);
  const [dragging, setDragging]       = useState(false);
  const [searchText, setSearchText]   = useState("");
  const [name, setName]               = useState("");
  const [email, setEmail]             = useState("");
  const [analyzing, setAnalyzing]     = useState(false);
  const [prefs, setPrefs]             = useState({ role: "", salary: "", locations: [], industries: [], companies: [], stages: [] });
  const fileRef = useRef();

  const EXAMPLES = [
    "Senior PM roles at consumer health or digital health companies in Boston, paying $200k+, ideally WHOOP, Oura or similar",
    "Director of Product at Series B digital health companies in NYC, $180k–$220k, like Spring Health or Maven Clinic",
    "Head of Product at AI health companies in San Francisco, $250k+",
    "Senior PM consumer health — WHOOP, Oura, Maven Clinic, Boston or remote, $200k+",
  ];

  const handleFile = async file => {
    if (!file) return;
    setCvParsing(true);
    try {
      const ext = file.name.toLowerCase();
      if (ext.endsWith(".docx")) {
        const ab = await file.arrayBuffer();
        const { value } = await mammoth.extractRawText({ arrayBuffer: ab });
        setCv({ text: value, fileName: file.name, parsed: true });
      } else if (ext.endsWith(".pdf")) {
        const reader = new FileReader();
        reader.onload = e => {
          const raw = e.target.result || "";
          const cleaned = raw.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, "  ").trim();
          setCv({ text: cleaned.length > 100 ? cleaned : "", fileName: file.name, parsed: cleaned.length > 100 });
          setCvParsing(false);
        };
        reader.readAsText(file);
        return;
      }
    } catch (e) { console.error("CV parse error:", e); }
    setCvParsing(false);
  };

  const canProceed = cv.fileName && searchText.trim().length > 10 && name.trim() && email.trim();

  const handleAnalyze = async () => {
    setAnalyzing(true);
    const saved = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; } })();
    const parsed = await parseSearchIntent(searchText, saved.apiKey || "");
    setPrefs(parsed);
    setScreen(2);
    setAnalyzing(false);
  };

  const buildProfile = (apiKey = "") => ({
    name, email, apiKey,
    role: prefs.role || "Senior Product Manager",
    salary: prefs.salary || "",
    experience: "",
    locations: prefs.locations,
    industries: prefs.industries,
    stages: prefs.stages,
    targetCompanies: prefs.companies,
    cvText: cv.text,
    cvFileName: cv.fileName,
    searchText,
    onboarded: true,
  });

  const handleFinish = (apiKey = "") => {
    const profile = buildProfile(apiKey);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    onComplete(profile);
  };

  // Screen 2 CTA: skip API key screen if key already saved in localStorage
  const handleConfirmSearch = () => {
    const saved = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; } })();
    if (saved.apiKey) {
      handleFinish(saved.apiKey);
    } else {
      setScreen(3);
    }
  };

  // ── Shared nav bar ──────────────────────────────────────────────────────────
  const Nav = () => (
    <div style={{ padding: "18px 40px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#7c3aed,#06b6d4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>🎯</div>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed", letterSpacing: "0.14em", textTransform: "uppercase" }}>AutoApply</span>
      </div>
    </div>
  );

  // ── Screen 2: Confirmation ──────────────────────────────────────────────────
  if (screen === 2) {
    const prefRows = [
      { icon: "🎯", label: "Role",             key: "role",       type: "text" },
      { icon: "💰", label: "Salary",           key: "salary",     type: "text" },
      { icon: "📍", label: "Locations",        key: "locations",  type: "tags" },
      { icon: "🏥", label: "Industries",       key: "industries", type: "tags" },
      { icon: "🏢", label: "Target Companies", key: "companies",  type: "tags" },
      { icon: "🏗️", label: "Company Stage",    key: "stages",     type: "tags" },
    ];
    return (
      <div style={{ minHeight: "100vh", background: "#ffffff", color: "#0a0a0a" }}>
        <style>{CSS}</style>
        <Nav />
        <div className="fade-up" style={{ maxWidth: 680, margin: "0 auto", padding: "52px 32px 80px" }}>
          <h1 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 34, fontWeight: 400, marginBottom: 8 }}>
            Here's what we found in your search
          </h1>
          <p style={{ fontSize: 14, color: "#64748b", marginBottom: 36, lineHeight: 1.6 }}>
            Review and adjust your preferences before we start searching.
          </p>

          <div style={{ background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 18, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginBottom: 28 }}>
            {prefRows.map(({ icon, label: lbl, key, type }, i) => (
              <div key={key} style={{
                display: "flex", alignItems: "flex-start", gap: 20,
                padding: "14px 24px",
                borderBottom: i < prefRows.length - 1 ? "1px solid #f3f4f6" : "none",
              }}>
                <div style={{ width: 158, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, paddingTop: type === "tags" ? 10 : 11 }}>
                  <span style={{ fontSize: 15 }}>{icon}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>{lbl}</span>
                </div>
                <div style={{ flex: 1, paddingTop: 4 }}>
                  {type === "text"
                    ? <input
                        value={prefs[key] || ""}
                        onChange={e => setPrefs(p => ({ ...p, [key]: e.target.value }))}
                        style={{ ...field, maxWidth: 340 }}
                      />
                    : <TagInput
                        tags={prefs[key] || []}
                        onChange={v => setPrefs(p => ({ ...p, [key]: v }))}
                        placeholder={`Add ${lbl.toLowerCase()}…`}
                      />
                  }
                </div>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 24, textAlign: "center" }}>
            We'll check your target companies' job boards daily and bring you the best matches.
          </p>

          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={() => setScreen(1)} style={{ ...ghostBtn, flex: 1, justifyContent: "center" }}>
              ← Edit Search
            </button>
            <button
              onClick={handleConfirmSearch}
              style={{ ...primaryBtn(), flex: 2, justifyContent: "center", fontSize: 15 }}
            >
              ✅ Start Job Search →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Screen 3: API Key ────────────────────────────────────────────────────────
  if (screen === 3) {
    const ApiKeyScreen = () => {
      const [key, setKey] = useState("");
      return (
        <div style={{ minHeight: "100vh", background: "#ffffff", color: "#0a0a0a", display: "flex", flexDirection: "column" }}>
          <style>{CSS}</style>
          <Nav />
          <div className="fade-up" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: "100%", maxWidth: 480, padding: "0 32px" }}>
              <h1 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 38, fontWeight: 400, marginBottom: 12, color: "#0a0a0a" }}>
                One last thing
              </h1>
              <p style={{ fontSize: 15, color: "#64748b", marginBottom: 36, lineHeight: 1.65 }}>
                Your Anthropic API key powers cover letter generation and job matching. It's stored only on your device.
              </p>

              <div style={{ marginBottom: 8 }}>
                <label style={label}>Anthropic API Key</label>
                <input
                  type="password"
                  placeholder="sk-ant-…"
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && key.trim() && handleFinish(key.trim())}
                  autoFocus
                  style={{ ...field, fontSize: 14 }}
                />
              </div>
              <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 32 }}>
                Get your free key at{" "}
                <span style={{ color: "#7c3aed", fontWeight: 500 }}>console.anthropic.com → API Keys</span>
              </p>

              <button
                onClick={() => key.trim() && handleFinish(key.trim())}
                disabled={!key.trim()}
                style={{ ...primaryBtn(!key.trim()), width: "100%", justifyContent: "center", fontSize: 15, marginBottom: 16 }}
              >
                Start Searching →
              </button>

              <div style={{ textAlign: "center" }}>
                <button
                  onClick={() => handleFinish("")}
                  style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: "#9ca3af", textDecoration: "underline", textUnderlineOffset: 3 }}
                >
                  Skip for now — add later in API Keys settings
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    };
    return <ApiKeyScreen />;
  }

  // ── Screen 1: Landing ────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#ffffff", color: "#0a0a0a" }}>
      <style>{CSS}</style>
      <Nav />

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "60px 40px 80px" }}>
        {/* Hero */}
        <div className="fade-up" style={{ textAlign: "center", marginBottom: 52 }}>
          <h1 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 54, fontWeight: 400, lineHeight: 1.12, marginBottom: 16, color: "#0a0a0a" }}>
            Find your next role
          </h1>
          <p style={{ fontSize: 18, color: "#64748b", maxWidth: 480, margin: "0 auto", lineHeight: 1.65 }}>
            Upload your CV and describe what you're looking for — we'll handle the rest
          </p>
        </div>

        {/* Two panels */}
        <div className="fade-up" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 22 }}>

          {/* LEFT: CV Upload */}
          <div style={{ background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 18, padding: 28 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <span>📄</span> Your CV
            </div>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => !cv.fileName && fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragging ? "#7c3aed" : cv.parsed ? "#16a34a" : cv.fileName ? "#d97706" : "#d1d5db"}`,
                borderRadius: 14,
                padding: cv.fileName ? "32px 20px" : "56px 20px",
                textAlign: "center",
                cursor: cv.fileName ? "default" : "pointer",
                background: dragging ? "#f5f3ff" : cv.parsed ? "#f0fdf4" : cv.fileName ? "#fffbeb" : "#ffffff",
                transition: "all 0.2s",
              }}
            >
              <input ref={fileRef} type="file" accept=".pdf,.docx" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
              {cvParsing ? (
                <div>
                  <div style={{ width: 24, height: 24, border: "2px solid #7c3aed30", borderTopColor: "#7c3aed", borderRadius: "50%", animation: "spin 0.7s linear infinite", margin: "0 auto 12px" }} />
                  <div style={{ color: "#7c3aed", fontSize: 13, fontWeight: 600 }}>Parsing your CV…</div>
                </div>
              ) : cv.fileName ? (
                <div>
                  <div style={{ fontSize: 34, marginBottom: 10 }}>{cv.parsed ? "✅" : "📄"}</div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: cv.parsed ? "#16a34a" : "#d97706", marginBottom: 3 }}>
                    CV indexed ✓
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}>{cv.fileName}</div>
                  <button
                    onClick={e => { e.stopPropagation(); setCv({ text: "", fileName: "", parsed: false }); fileRef.current?.click(); }}
                    style={{ ...ghostBtn, margin: "0 auto", fontSize: 11, padding: "5px 14px" }}
                  >
                    Replace file
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 42, marginBottom: 12 }}>📤</div>
                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 5 }}>Drop your CV here</div>
                  <div style={{ fontSize: 12, color: "#9ca3af" }}>or click to browse · PDF or DOCX</div>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: Natural language search */}
          <div style={{ background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 18, padding: 28 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <span>🔍</span> What are you looking for?
            </div>
            <textarea
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="e.g. Senior PM roles at consumer health or digital health companies in Boston, paying $200k+, ideally WHOOP, Oura or similar"
              style={{ ...field, height: 110, resize: "none", fontSize: 14, lineHeight: 1.65, marginBottom: 14 }}
            />
            <div>
              <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                Try this
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {EXAMPLES.map((ex, i) => (
                  <button
                    key={i}
                    onClick={() => setSearchText(ex)}
                    style={{
                      background: searchText === ex ? "#f5f3ff" : "#ffffff",
                      border: `1px solid ${searchText === ex ? "#c4b5fd" : "#e5e7eb"}`,
                      borderRadius: 8, padding: "8px 12px",
                      textAlign: "left", cursor: "pointer",
                      fontSize: 12, color: searchText === ex ? "#7c3aed" : "#374151",
                      fontFamily: "inherit", lineHeight: 1.4, transition: "all 0.15s",
                    }}
                  >
                    {ex.length > 85 ? ex.slice(0, 85) + "…" : ex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Name + email row */}
        <div className="fade-up" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 28 }}>
          <div>
            <label style={label}>Your Name</label>
            <input style={field} type="text" placeholder="Jane Smith" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label style={label}>Email Address</label>
            <input style={field} type="email" placeholder="jane@example.com" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
        </div>

        {/* CTA */}
        <div className="fade-up" style={{ textAlign: "center" }}>
          <button
            onClick={handleAnalyze}
            disabled={!canProceed || analyzing}
            style={{ ...primaryBtn(!canProceed || analyzing), margin: "0 auto", fontSize: 16, padding: "16px 44px", justifyContent: "center" }}
          >
            {analyzing
              ? <><span style={{ display: "inline-block", animation: "spin 0.7s linear infinite" }}>⟳</span>&nbsp; Analysing…</>
              : "Find My Jobs →"}
          </button>
          {!canProceed && (
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 10 }}>
              {[!cv.fileName && "Upload your CV", !searchText.trim() && "Describe what you're looking for", !name.trim() && "Enter your name", !email.trim() && "Enter your email"].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar({ active, setActive, pendingCount, keysSet, onSignOut }) {
  const main = [
    { id: "dashboard",    icon: "🏠", label: "Dashboard"    },
    { id: "review",       icon: "📋", label: "Review Jobs", badge: pendingCount },
    { id: "applications", icon: "📤", label: "Applications" },
    { id: "outreach",     icon: "💌", label: "Outreach"     },
  ];

  const NavItem = ({ item }) => {
    const on = active === item.id;
    return (
      <button onClick={() => setActive(item.id)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", padding: "10px 12px", borderRadius: 9, cursor: "pointer",
        fontFamily: "inherit", textAlign: "left", transition: "all 0.15s",
        background: on ? "#f3f4f6" : "transparent",
        border: on ? "1px solid #e5e7eb" : "1px solid transparent",
        color: on ? "#000000" : "#374151",
        fontWeight: on ? 600 : 400, fontSize: 13,
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>{item.icon}</span>
          <span>{item.label}</span>
        </span>
        {item.badge > 0 && (
          <span style={{ background: "#7c3aed", color: "#fff", borderRadius: 99, padding: "1px 8px", fontSize: 10, fontWeight: 700, minWidth: 20, textAlign: "center" }}>
            {item.badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div style={{ width: 228, flexShrink: 0, background: "#f8f9fa", borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column", padding: "22px 12px 20px", minHeight: "100vh" }}>
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 8px", marginBottom: 28 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#7c3aed,#06b6d4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>🎯</div>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed", letterSpacing: "0.14em", textTransform: "uppercase" }}>AutoApply</span>
      </div>

      {/* Main nav */}
      <nav style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
        {main.map(item => <NavItem key={item.id} item={item} />)}
      </nav>

      {/* Bottom nav: API Keys + Settings + Sign Out */}
      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 12, marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ position: "relative" }}>
          <NavItem item={{ id: "apikeys", icon: "🔑", label: "API Keys" }} />
          {!keysSet && (
            <div style={{ position: "absolute", top: 8, right: 10, width: 7, height: 7, borderRadius: "50%", background: "#f59e0b" }} />
          )}
        </div>
        <NavItem item={{ id: "settings", icon: "⚙️", label: "Settings" }} />
        <button
          onClick={onSignOut}
          style={{
            display: "flex", alignItems: "center", gap: 10,
            width: "100%", padding: "10px 12px", borderRadius: 9, cursor: "pointer",
            fontFamily: "inherit", textAlign: "left", fontSize: 13, fontWeight: 400,
            background: "transparent", border: "1px solid transparent",
            color: "#9ca3af", transition: "all 0.15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "#fef2f2"; e.currentTarget.style.color = "#dc2626"; e.currentTarget.style.borderColor = "#fecaca"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#9ca3af"; e.currentTarget.style.borderColor = "transparent"; }}
        >
          <span style={{ fontSize: 15, lineHeight: 1 }}>↪</span>
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
}

// ─── Dashboard tab ─────────────────────────────────────────────────────────────
function DashboardTab({ profile, jobs, logs, running, onRun, rateLimitedUntil, dailyEnabled, setDailyEnabled, reportURL }) {
  const isRateLimited = Date.now() < rateLimitedUntil;
  const stats = [
    { icon: "📤", label: "Applications Sent", value: jobs.filter(j => ["applied","emailed"].includes(j.status)).length, color: "#7c3aed" },
    { icon: "🗓",  label: "Interviews",        value: 0,                                                                  color: "#10b981" },
    { icon: "🤝", label: "Warm Intros",        value: jobs.filter(j => j.status === "emailed").length,                   color: "#06b6d4" },
    { icon: "⭐", label: "Offers",             value: 0,                                                                  color: "#f59e0b" },
  ];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "38px 44px" }}>
      {/* Greeting */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: 12, color: "#374151", fontWeight: 600, letterSpacing: "0.06em", marginBottom: 8 }}>
          {formatDate()} · Week {getWeekOfYear()}
        </div>
        <h1 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 36, fontWeight: 400, color: "#0a0a0a", marginBottom: 8, lineHeight: 1.2 }}>
          {running ? <TypeWriter text={getGreeting(profile.name)} /> : getGreeting(profile.name)} 👋
        </h1>
        {/* One-liner search summary */}
        {(profile.role || profile.industries?.length > 0) && (
          <div style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 99, padding: "6px 16px", fontSize: 13, color: "#374151", marginTop: 4 }}>
            <span style={{ color: "#7c3aed", fontSize: 14 }}>🎯</span>
            <span>Searching for</span>
            {profile.role && <strong style={{ color: "#0a0a0a" }}>{profile.role}</strong>}
            {profile.industries?.length > 0 && <><span style={{ color: "#d1d5db" }}>·</span><span>{profile.industries.slice(0, 2).join(", ")}{profile.industries.length > 2 ? ` +${profile.industries.length - 2}` : ""}</span></>}
            {profile.locations?.length > 0 && <><span style={{ color: "#d1d5db" }}>·</span><span>{profile.locations.slice(0, 3).join(", ")}</span></>}
            {profile.salary && <><span style={{ color: "#d1d5db" }}>·</span><span style={{ color: "#16a34a", fontWeight: 600 }}>{profile.salary}</span></>}
          </div>
        )}
      </div>

      {/* Run Agent */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 36, flexWrap: "wrap" }}>
        <button
          onClick={onRun}
          disabled={running || isRateLimited}
          style={{
            ...primaryBtn(running || isRateLimited),
            fontSize: 15, padding: "15px 32px",
            background: running || isRateLimited ? "#f3f4f6" : "#000000",
            color: running || isRateLimited ? "#9ca3af" : "#fff",
          }}
        >
          {running
            ? <><span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span> Agent Running…</>
            : isRateLimited ? <>⏳ Rate Limited…</>
            : <>🚀 Run Agent</>}
        </button>

<label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, color: "#6b7280" }}>
          <div onClick={() => setDailyEnabled(!dailyEnabled)} style={{
            width: 44, height: 24, borderRadius: 12,
            background: dailyEnabled ? "#7c3aed" : "#e5e7eb",
            position: "relative", transition: "background 0.25s", cursor: "pointer", flexShrink: 0,
          }}>
            <div style={{ position: "absolute", top: 3, left: dailyEnabled ? 23 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.25s" }} />
          </div>
          Run daily at 8 am
        </label>

        {reportURL && (
          <a href={reportURL} download="job-search-report.md" style={{ ...ghostBtn, textDecoration: "none", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
            📄 Download Report
          </a>
        )}
      </div>

      {/* SerpApi credit meter */}
      {profile.serpApiKey && (() => {
        const used = getSerpUsage();
        const remaining = 100 - used;
        const pct = (used / 100) * 100;
        return (
          <div style={{ marginBottom: 28, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ flex: 1, maxWidth: 260 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 5 }}>
                <span>Big tech searches remaining this month</span>
                <span style={{ fontWeight: 700, color: remaining > 20 ? "#16a34a" : "#d97706" }}>{remaining}/100</span>
              </div>
              <div style={{ background: "#f3f4f6", borderRadius: 99, height: 5, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: remaining > 20 ? "#16a34a" : "#d97706", borderRadius: 99, transition: "width 0.4s" }} />
              </div>
            </div>
            <span style={{ fontSize: 11, color: "#374151" }}>Resets {nextMonthFirst()}</span>
          </div>
        );
      })()}

      {/* Stats */}
      <div style={{ display: "flex", gap: 14, marginBottom: 36, flexWrap: "wrap" }}>
        {stats.map(s => <StatCard key={s.label} {...s} />)}
      </div>

      {/* Activity + Funnel */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 24 }}>
        <div>
          <div style={{ ...label, marginBottom: 10 }}>Agent Activity</div>
          <LogPanel logs={logs} />
        </div>
        <div>
          <div style={{ ...label, marginBottom: 10 }}>Application Funnel</div>
          <div style={{ background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            <FunnelChart jobs={jobs} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Review Jobs tab ───────────────────────────────────────────────────────────
function ReviewJobsTab({ jobs, onApprove, onReject, onMarkApplied, onGenerateEmail, onSendEmail, profile }) {
  const [filterText, setFilterText] = useState("");
  const [filteredIds, setFilteredIds] = useState(null); // null = show all
  const [filtering, setFiltering]   = useState(false);

  // Debounced NL filter via Claude
  useEffect(() => {
    if (!filterText.trim()) { setFilteredIds(null); setFiltering(false); return; }
    setFiltering(true);
    const timer = setTimeout(async () => {
      if (profile?.apiKey) {
        try {
          const data = await callClaude(
            `Filter job listings based on criteria. Return ONLY a JSON array of matching job IDs (numbers). No text, no explanation.`,
            `Criteria: "${filterText}"\n\nJobs: ${JSON.stringify(jobs.map(j => ({ id: j.id, title: j.title, company: j.company, location: j.location, source: j.source, industry: j.industry, salary: j.salary })))}`,
            profile.apiKey
          );
          const raw = extractText(data);
          const s = raw.indexOf("["), e = raw.lastIndexOf("]");
          if (s !== -1 && e > s) {
            const ids = JSON.parse(raw.slice(s, e + 1));
            if (Array.isArray(ids)) { setFilteredIds(ids); setFiltering(false); return; }
          }
        } catch {}
      }
      // Fallback: keyword match
      const q = filterText.toLowerCase();
      setFilteredIds(jobs.filter(j =>
        [j.title, j.company, j.location, j.industry, j.salary, j.source].some(f => f?.toLowerCase().includes(q))
      ).map(j => j.id));
      setFiltering(false);
    }, 650);
    return () => clearTimeout(timer);
  }, [filterText, jobs, profile?.apiKey]);

  const byScore = (a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0);
  const displayJobs = filteredIds !== null ? jobs.filter(j => filteredIds.includes(j.id)) : jobs;
  const pending     = displayJobs.filter(j => j.status === "pending-review").sort(byScore);
  const reviewed    = displayJobs.filter(j => j.status !== "pending-review").sort(byScore);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "38px 44px" }}>
      <h2 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 30, fontWeight: 400, marginBottom: 6 }}>Review Jobs</h2>
      <p style={{ fontSize: 14, color: "#64748b", marginBottom: 20 }}>Approve roles you want the agent to apply to.</p>

      {/* NL filter bar */}
      <div style={{ position: "relative", marginBottom: 16 }}>
        <input
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          placeholder="Refine results… e.g. 'only Boston roles' or 'only Series B' or 'HealthTech only'"
          style={{ ...field, paddingLeft: 40, paddingRight: filterText ? 36 : 14 }}
        />
        <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#9ca3af", pointerEvents: "none" }}>🔍</span>
        {filtering && (
          <div style={{ position: "absolute", right: 13, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, border: "2px solid #ede9fe", borderTopColor: "#7c3aed", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
        )}
        {filterText && !filtering && (
          <button onClick={() => { setFilterText(""); setFilteredIds(null); }} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        )}
      </div>
      {filterText && filteredIds !== null && !filtering && (
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16 }}>
          {filteredIds.length === 0
            ? "No jobs match this filter"
            : `Showing ${filteredIds.length} of ${jobs.length} jobs`}
        </div>
      )}

      {/* Warning banner */}
      <div style={{
        background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10,
        padding: "11px 16px", marginBottom: 24,
        display: "flex", alignItems: "flex-start", gap: 12,
        color: "#92400e", fontSize: 13, lineHeight: 1.5,
      }}>
        <span style={{ fontSize: 14, flexShrink: 0 }}>⚠️</span>
        <span>
          When you approve a role, we generate tailored materials — you open the application and submit it yourself.
          <strong style={{ fontWeight: 600 }}> We prepare your materials — you submit the application.</strong>
        </span>
      </div>

      {jobs.length === 0 && (
        <div style={{ textAlign: "center", padding: "80px 0" }}>
          <div style={{ fontSize: 60, marginBottom: 20 }}>📋</div>
          <div style={{ fontSize: 17, fontWeight: 600, color: "#374151", marginBottom: 8 }}>No jobs to review yet</div>
          <div style={{ fontSize: 13, color: "#9ca3af" }}>Run the agent from Dashboard to discover roles</div>
        </div>
      )}

      {pending.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ ...label, color: "#b45309", marginBottom: 14 }}>Awaiting Your Approval ({pending.length})</div>
          {pending.map(job => <JobCard key={job.id} job={job} onApprove={onApprove} onReject={onReject} onMarkApplied={onMarkApplied} onGenerateEmail={onGenerateEmail} onSendEmail={onSendEmail} />)}
        </div>
      )}

      {reviewed.length > 0 && (
        <div>
          <div style={{ ...label, marginBottom: 14 }}>Processed ({reviewed.length})</div>
          {reviewed.map(job => <JobCard key={job.id} job={job} onMarkApplied={onMarkApplied} onGenerateEmail={onGenerateEmail} onSendEmail={onSendEmail} />)}
        </div>
      )}
    </div>
  );
}

// ─── Applications tab ──────────────────────────────────────────────────────────
function ApplicationsTab({ jobs }) {
  const sent = jobs.filter(j => ["applied","emailed"].includes(j.status));
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "38px 44px" }}>
      <h2 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 30, fontWeight: 400, marginBottom: 6 }}>Applications</h2>
      <p style={{ fontSize: 14, color: "#64748b", marginBottom: 28 }}>All applications sent by the agent.</p>
      {sent.length === 0
        ? <div style={{ textAlign: "center", padding: "80px 0", color: "#9ca3af" }}>
            <div style={{ fontSize: 60, marginBottom: 20 }}>📤</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#374151" }}>No applications sent yet</div>
          </div>
        : sent.map(job => <JobCard key={job.id} job={job} />)
      }
    </div>
  );
}

// ─── Outreach tab ──────────────────────────────────────────────────────────────
function OutreachTab({ jobs }) {
  const emailed = jobs.filter(j => j.status === "emailed");
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "38px 44px" }}>
      <h2 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 30, fontWeight: 400, marginBottom: 6 }}>Outreach</h2>
      <p style={{ fontSize: 14, color: "#64748b", marginBottom: 28 }}>Hiring managers the agent has emailed on your behalf.</p>
      {emailed.length === 0
        ? <div style={{ textAlign: "center", padding: "80px 0", color: "#9ca3af" }}>
            <div style={{ fontSize: 60, marginBottom: 20 }}>💌</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#374151" }}>No outreach emails sent yet</div>
          </div>
        : emailed.map(job => (
            <div key={job.id} className="fade-up" style={{ background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "18px 22px", marginBottom: 12, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#0a0a0a", marginBottom: 3 }}>{job.title}</div>
                  <div style={{ fontSize: 13, color: "#7c3aed", fontWeight: 600, marginBottom: 6 }}>{job.company}</div>
                  {job.hiringManager && (
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>
                      <span style={{ color: "#64748b" }}>To: </span>{job.hiringManager}
                      {job.hiringEmail && <span style={{ color: "#06b6d4" }}> &lt;{job.hiringEmail}&gt;</span>}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <StatusBadge status="emailed" />
                  <span style={{ fontSize: 11, color: "#374151" }}>{job.date}</span>
                </div>
              </div>
            </div>
          ))
      }
    </div>
  );
}

// ─── Settings tab ──────────────────────────────────────────────────────────────
function SettingsTab({ profile, onUpdate, onReset, onRefreshCompanies }) {
  const [form, setForm]             = useState({ ...profile });
  const [locations, setLocations]   = useState(profile.locations || []);
  const [industries, setIndustries] = useState(profile.industries || []);
  const [stages, setStages]         = useState(profile.stages || []);
  const [companies, setCompanies]   = useState(profile.targetCompanies || []);
  const [saved, setSaved]           = useState(false);

  const companyStatuses = profile.companyStatuses || {};
  const serpAvailable   = !!profile.serpApiKey;

  const save = () => {
    const updated = { ...form, locations, industries, stages, targetCompanies: companies, onboarded: true };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    onUpdate(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Auto-save whenever the companies list changes
  const handleCompaniesChange = (newCompanies) => {
    setCompanies(newCompanies);
    const updated = { ...form, locations, industries, stages, targetCompanies: newCompanies, onboarded: true };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    onUpdate(updated);
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "38px 44px" }}>
      <h2 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 30, fontWeight: 400, marginBottom: 6 }}>Settings</h2>
      <p style={{ fontSize: 14, color: "#64748b", marginBottom: 32 }}>Update your profile, API key, and targeting.</p>

      {/* Profile */}
      <div style={{ background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 16, padding: 28, marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 18, color: "#0a0a0a" }}>👤 Profile</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          {[
            ["name","Full Name","text"], ["email","Email","email"],
            ["role","Target Role","text"], ["salary","Target Salary","text"],
            ["experience","Years of Experience","text"],
          ].map(([key, lbl, type]) => (
            <div key={key} style={key === "role" ? { gridColumn: "1 / -1" } : {}}>
              <label style={label}>{lbl}</label>
              <input style={field} type={type} value={form[key] || ""} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} />
            </div>
          ))}
        </div>
        <div>
          <label style={label}>Preferred Locations</label>
          <TagInput tags={locations} onChange={setLocations} placeholder="Add location…" />
        </div>
      </div>

      {/* Targeting */}
      <div style={{ background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 16, padding: 28, marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 18, color: "#0a0a0a" }}>🎯 Targeting</h3>
        <div style={{ marginBottom: 22 }}>
          <label style={{ ...label, marginBottom: 10 }}>Industries</label>
          <CheckGrid options={INDUSTRIES} selected={industries} onChange={setIndustries} />
        </div>
        <div>
          <label style={{ ...label, marginBottom: 10 }}>Company Stage</label>
          <CheckGrid options={COMPANY_STAGES} selected={stages} onChange={setStages} />
        </div>
      </div>

      {/* Target Companies */}
      <div style={{ background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 16, padding: 28, marginBottom: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#0a0a0a" }}>🏢 Target Companies</h3>
          <button
            onClick={onRefreshCompanies}
            style={{ ...ghostBtn, padding: "6px 14px", fontSize: 11 }}
          >
            🔄 Check for new openings now
          </button>
        </div>
        <p style={{ fontSize: 13, color: "#64748b", marginBottom: 16, lineHeight: 1.5 }}>
          We'll check these companies daily for new Product Manager openings.
        </p>

        <TagInput
          tags={companies}
          onChange={handleCompaniesChange}
          placeholder="Type a company name and press Enter — e.g. WHOOP, Maven Clinic, Oura"
        />
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 6, marginBottom: companies.length > 0 ? 16 : 0 }}>
          We'll automatically find their job boards and check daily for openings
        </div>

        {companies.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {companies.map(company => {
              const st = companyStatuses[company];
              return (
                <div key={company} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "11px 14px", background: "#f9fafb",
                  border: "1px solid #e5e7eb", borderRadius: 10,
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#0a0a0a", marginBottom: 3 }}>{company}</div>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>
                      Last checked: {formatLastChecked(st?.lastChecked)}
                      {st?.jobsFound > 0 && <span style={{ color: "#16a34a", marginLeft: 8 }}>· {st.jobsFound} role{st.jobsFound !== 1 ? "s" : ""} found</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <CompanyStatusBadge company={company} serpAvailable={serpAvailable} />
                    <button
                      onClick={() => handleCompaniesChange(companies.filter(c => c !== company))}
                      style={{ background: "none", border: "1px solid #1e1e2e", borderRadius: 6, color: "#64748b", cursor: "pointer", fontSize: 14, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                      title="Remove company"
                    >×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {companies.length === 0 && (
          <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af", fontSize: 13 }}>
            No companies added yet — type a name above and press Enter
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={save} style={{ ...primaryBtn(), background: saved ? "linear-gradient(135deg,#10b981,#059669)" : undefined }}>
          {saved ? "✓ Saved!" : "Save Changes"}
        </button>
        <button onClick={onReset} style={{ ...ghostBtn, color: "#ef4444", borderColor: "#ef444430" }}>
          Reset & Re-onboard
        </button>
      </div>
    </div>
  );
}

// ─── API Keys tab ──────────────────────────────────────────────────────────────
function ApiKeysTab({ profile, onUpdate }) {
  const [anthropicKey, setAnthropicKey] = useState(profile.apiKey || "");
  const [serpKey, setSerpKey]           = useState(profile.serpApiKey || "");
  const [saved, setSaved]               = useState(false);
  const [serpCredits, setSerpCredits]   = useState(null);   // null = loading/not-fetched
  const [serpFetching, setSerpFetching] = useState(false);
  const [serpFetchErr, setSerpFetchErr] = useState(false);

  // Fetch live SerpApi credits when a key is present (on mount + whenever key is saved)
  const fetchSerpCredits = async (key) => {
    if (!key) { setSerpCredits(null); return; }
    setSerpFetching(true); setSerpFetchErr(false);
    try {
      const res = await fetch(`https://serpapi.com/account?api_key=${encodeURIComponent(key)}`);
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      const n = data.total_searches_left ?? data.plan_searches_left ?? null;
      if (n !== null) setSerpCredits(n);
      else setSerpFetchErr(true);
    } catch { setSerpFetchErr(true); }
    setSerpFetching(false);
  };

  useEffect(() => { fetchSerpCredits(profile.serpApiKey || ""); }, []);

  const save = () => {
    const updated = { ...profile, apiKey: anthropicKey.trim(), serpApiKey: serpKey.trim() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    onUpdate(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    // Refresh live credits after saving
    fetchSerpCredits(serpKey.trim());
  };

  const anthropicOk = !!profile.apiKey;
  const serpOk      = !!profile.serpApiKey;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "38px 44px" }}>
      <h2 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 30, fontWeight: 400, marginBottom: 6 }}>API Keys</h2>
      <p style={{ fontSize: 14, color: "#64748b", marginBottom: 28, lineHeight: 1.6 }}>
        Your keys are encrypted in your browser's localStorage — they never leave your device except when calling the respective APIs directly.
      </p>

      {/* Live status badges */}
      {(anthropicOk || serpOk) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
          {anthropicOk && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#166534" }}>
              <span style={{ fontSize: 16 }}>✅</span>
              <strong>Anthropic connected</strong>
            </div>
          )}
          {serpOk && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#166534" }}>
              <span style={{ fontSize: 16 }}>✅</span>
              <span>
                <strong>SerpApi connected</strong>
                {serpFetching && <span style={{ color: "#9ca3af", fontWeight: 400 }}> · checking credits…</span>}
                {!serpFetching && serpCredits !== null && !serpFetchErr && (
                  <span style={{ fontWeight: 400 }}>
                    {" · "}<span style={{ color: "#16a34a", fontWeight: 700 }}>{serpCredits}</span> credits remaining this month
                  </span>
                )}
                {!serpFetching && serpFetchErr && (
                  <span style={{ color: "#d97706", fontWeight: 400 }}> · couldn't fetch live credits</span>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Key input card */}
      <div style={{ background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 16, padding: 28, marginBottom: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <div style={{ marginBottom: 24 }}>
          <label style={{ ...label, color: "#92400e" }}>Anthropic API Key</label>
          <input
            style={field}
            type="password"
            placeholder="sk-ant-…"
            value={anthropicKey}
            onChange={e => setAnthropicKey(e.target.value)}
          />
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}>Stored locally on your device only</div>
        </div>

        <div>
          <label style={{ ...label, color: "#2563eb" }}>
            SerpApi Key
            <span style={{ color: "#9ca3af", fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>optional — enables big tech company search via Google Jobs</span>
          </label>
          <input
            style={field}
            type="password"
            placeholder="Paste your SerpApi key…"
            value={serpKey}
            onChange={e => setSerpKey(e.target.value)}
          />
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}>Stored locally on your device only</div>
        </div>
      </div>

      <button
        onClick={save}
        style={{ ...primaryBtn(), background: saved ? "#16a34a" : "#7c3aed", minWidth: 160, justifyContent: "center" }}
      >
        {saved ? "✓ Keys saved!" : "Save Keys"}
      </button>
    </div>
  );
}

// ─── Root component ────────────────────────────────────────────────────────────
export default function JobSearchAgent() {
  const [profile, setProfile]           = useState(null);
  const [activeTab, setActiveTab]       = useState("dashboard");
  const [jobs, setJobs]                 = useState([]);
  const [logs, setLogs]                 = useState([]);
  const [running, setRunning]           = useState(false);
  const [reportURL, setReportURL]       = useState("");
  const [dailyEnabled, setDailyEnabled]   = useState(false);
  const [rateLimitedUntil, setRateLimitedUntil] = useState(0);
  const [rateLimitSeen, setRateLimitSeen] = useState(false);
  const cooldownRef = useRef(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const base = saved ? (() => { try { return JSON.parse(saved); } catch { return {}; } })() : {};
    setProfile(base);
  }, []);

  const addLog = (msg, type = "info") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLogs(prev => [...prev, { msg, type, time }]);
  };

  // ── Agent: search jobs ─────────────────────────────────────────────────────
  async function searchJobs(p) {
    const targetCompanies = p.targetCompanies || [];
    if (targetCompanies.length === 0) {
      addLog("No target companies set — add some in Settings → Target Companies", "error");
      return [];
    }

    const allRaw = [];
    const newStatuses = { ...(p.companyStatuses || {}) };
    let serpUsed = 0;
    const serpAvailable = !!(p.serpApiKey && getSerpUsage() < 100);

    for (const company of targetCompanies) {
      let found = [];

      // Auto-detect job board (uses cache after first run)
      const wasCached = !!getSlugCache()[company.toLowerCase().trim()];
      if (!wasCached) addLog(`${company} — detecting job board…`);
      const board = await autoDetectJobBoard(company);
      if (!wasCached) {
        if (board.system === "greenhouse") addLog(`${company} — found on Greenhouse (${board.slug}) ✓`, "success");
        else if (board.system === "lever") addLog(`${company} — found on Lever (${board.slug}) ✓`, "success");
        else addLog(`${company} — not on Greenhouse/Lever, routing to Google Jobs search`);
      }

      if (board.system === "greenhouse") {
        found = await fetchGreenhouse(board.slug, company);
        newStatuses[company] = { source: "Greenhouse", lastChecked: new Date().toISOString(), jobsFound: found.length };
        found.length > 0
          ? addLog(`${company} — ${found.length} PM role${found.length !== 1 ? "s" : ""} found (Greenhouse)`, "success")
          : addLog(`${company} — no openings today`);

      } else if (board.system === "lever") {
        found = await fetchLever(board.slug, company);
        newStatuses[company] = { source: "Lever", lastChecked: new Date().toISOString(), jobsFound: found.length };
        found.length > 0
          ? addLog(`${company} — ${found.length} PM role${found.length !== 1 ? "s" : ""} found (Lever)`, "success")
          : addLog(`${company} — no openings today`);

      } else if (serpAvailable) {
        found = await fetchSerpApi(`Senior Product Manager ${company}`, p.serpApiKey);
        serpUsed++;
        newStatuses[company] = { source: "Google Jobs", lastChecked: new Date().toISOString(), jobsFound: found.length };
        found.length > 0
          ? addLog(`${company} — ${found.length} role${found.length !== 1 ? "s" : ""} found (Google Jobs)`, "success")
          : addLog(`${company} — no openings found`);

      } else {
        const reason = !p.serpApiKey
          ? "add a SerpApi key in Settings to search this company"
          : `monthly SerpApi limit reached — resets ${nextMonthFirst()}`;
        addLog(`${company} — skipped (${reason})`);
      }

      allRaw.push(...found);
    }

    if (serpUsed > 0) {
      incSerpUsage(serpUsed);
      addLog(`SerpApi: ${100 - getSerpUsage()} credits remaining this month`);
    }

    // Persist updated statuses
    const updatedProfile = { ...p, companyStatuses: newStatuses };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedProfile));
    setProfile(updatedProfile);

    if (allRaw.length === 0) {
      addLog(`Checked ${targetCompanies.length} companies — no matching roles today`);
      return [];
    }

    // ── Score against CV with Claude ─────────────────────────────────────────
    addLog(`Scoring ${allRaw.length} roles against your CV…`);
    const scored = await scoreJobsWithClaude(allRaw, p);

    if (scored[0]?.error || scored.every(j => j.matchScore === 75)) {
      const msg = scored[0]?.error?.message;
      if (msg?.toLowerCase().includes("rate")) { handleRateLimit(); return []; }
    }

    const qualified = scored.filter(j => (j.matchScore ?? 0) >= 70);
    addLog(
      `Checked ${targetCompanies.length} companies — found ${qualified.length} matching role${qualified.length !== 1 ? "s" : ""} (70%+ match)`,
      qualified.length > 0 ? "success" : "info"
    );

    return qualified.map((j, i) => ({
      ...j,
      id:          Date.now() + i,
      status:      "pending-review",
      date:        j.postedAt || new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      coverLetter: "",
    }));
  }

  // ── Generate cover letter ──────────────────────────────────────────────────
  async function buildCoverLetter(job, p) {
    const data = await callClaude(
      `You are an expert career coach. Write a compelling cover letter (150–180 words). Be specific to the company and role. Sound human and confident. Return ONLY the letter body — no subject line, no greeting header.`,
      `Candidate: ${p.name}. Role: ${job.title} at ${job.company}. Job: ${job.jobDescription}. CV highlights: ${p.cvText?.slice(0, 800) || "experienced PM"}. Experience: ${p.experience}. Salary target: ${p.salary}.`,
      p.apiKey
    );
    return extractText(data).trim();
  }

  // ── Generate CV highlights (3–5 bullet points) ────────────────────────────
  async function buildCVHighlights(job, p) {
    const data = await callClaude(
      `Write 3–5 key CV highlights as bullet points (start each with "•") that are most relevant to this specific role. Be specific and use numbers/metrics where possible. Return ONLY the bullet points, no preamble or extra text.`,
      `Candidate CV: ${p.cvText?.slice(0, 800) || "experienced product professional"}. Target: ${job.title} at ${job.company}. Job: ${job.jobDescription}. Experience: ${p.experience}.`,
      p.apiKey
    );
    return extractText(data).trim();
  }

  // ── Draft outreach email ───────────────────────────────────────────────────
  async function buildEmailDraft(job, p) {
    const data = await callClaude(
      `Write a brief, warm outreach email (100–130 words) to a hiring manager. Professional but human. Return only the email body — no subject line.`,
      `Sender: ${p.name} (${p.email}). Recipient: ${job.hiringManager || "Hiring Manager"} at ${job.company}. Role: ${job.title}. CV highlights: ${p.cvText?.slice(0, 300) || "experienced PM"}.`,
      p.apiKey
    );
    return extractText(data).trim();
  }

  // ── Send outreach email via Gmail MCP ─────────────────────────────────────
  async function sendOutreachEmail(jobId, emailText) {
    const job = jobs.find(j => j.id === jobId);
    if (!job?.hiringEmail) { addLog("No hiring manager email available", "error"); return; }
    addLog(`Sending outreach to ${job.hiringManager} at ${job.company}…`);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": profile.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 400,
          messages: [{ role: "user", content: `Send an email to ${job.hiringEmail} with subject "Re: ${job.title} – ${profile.name}" and body:\n\n${emailText}\n\nBest,\n${profile.name}` }],
          mcp_servers: [{ type: "url", url: GMAIL_MCP, name: "gmail" }],
        }),
      });
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: "outreach-sent" } : j));
      addLog(`Outreach sent to ${job.hiringManager}`, "success");
    } catch (e) {
      addLog(`Email failed: ${e.message}`, "error");
    }
  }

  // ── Generate report ────────────────────────────────────────────────────────
  async function generateReport(appliedJobs, p) {
    const data = await callClaude(
      `Create a concise markdown job search report. Include a summary and a table: Role | Company | Status | Date.`,
      `Candidate: ${p.name}. Target: ${p.role}. Applications:\n${JSON.stringify(appliedJobs.map(j => ({ title: j.title, company: j.company, status: j.status, date: j.date })))}`,
      p.apiKey
    );
    return extractText(data);
  }

// ── Rate limit handler ─────────────────────────────────────────────────────
  function handleRateLimit() {
    const until = Date.now() + 60000;
    setRateLimitedUntil(until);

    if (!rateLimitSeen) {
      setRateLimitSeen(true);
      addLog("Please wait 2 minutes between searches to avoid rate limits", "error");
    }

    addLog("Rate limited — retrying in 60s", "error");
    clearInterval(cooldownRef.current);
    cooldownRef.current = setTimeout(() => {
      setRateLimitedUntil(0);
      addLog("Cooldown complete — you can search again", "success");
    }, 60000);
  }

  // ── Run agent (search → redirect to review) ────────────────────────────────
  async function runAgent() {
    if (!profile?.apiKey) {
      addLog("No API key found — add it in Settings", "error");
      return;
    }
    if (Date.now() < rateLimitedUntil) return;

    setRunning(true);
    addLog("Agent starting…");
    try {
      const found = await searchJobs(profile);
      if (found.length) {
        setJobs(found);
        setActiveTab("review");
      }
    } catch (e) {
      if (e.message?.includes("rate") || e.status === 429) {
        handleRateLimit();
      } else {
        addLog(`Error: ${e.message}`, "error");
      }
    }
    setRunning(false);
  }

  // ── Approve a job → generate materials ────────────────────────────────────
  async function approveJob(jobId) {
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: "generating" } : j));
    addLog(`Generating materials for ${job.title} @ ${job.company}…`);
    try {
      const [cl, highlights] = await Promise.all([
        buildCoverLetter(job, profile),
        buildCVHighlights(job, profile),
      ]);
      setJobs(prev => prev.map(j => j.id === jobId
        ? { ...j, coverLetter: cl, cvHighlights: highlights, status: "ready-to-apply" }
        : j
      ));
      addLog(`Materials ready for ${job.company} — review and submit`, "success");
    } catch (e) {
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: "error" } : j));
      addLog(`Failed to generate materials: ${e.message}`, "error");
    }
  }

  // ── Mark a job as applied (user clicked Apply) ─────────────────────────────
  function markApplied(jobId) {
    const appliedAt = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    setJobs(prev => {
      const next = prev.map(j => j.id === jobId ? { ...j, status: "applied", appliedAt } : j);
      const applied = next.filter(j => j.status === "applied");
      if (applied.length > 0) {
        generateReport(applied, profile).then(r =>
          setReportURL(`data:text/markdown;charset=utf-8,${encodeURIComponent(r)}`)
        );
      }
      return next;
    });
    const job = jobs.find(j => j.id === jobId);
    addLog(`Marked as applied: ${job?.title} @ ${job?.company}`, "success");
  }

  // ── Generate outreach email draft ──────────────────────────────────────────
  async function generateOutreachEmail(jobId) {
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;
    addLog(`Drafting outreach email for ${job.company}…`);
    try {
      const draft = await buildEmailDraft(job, profile);
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, emailDraft: draft } : j));
    } catch (e) {
      addLog(`Failed to draft email: ${e.message}`, "error");
    }
  }

  function rejectJob(jobId) {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: "rejected" } : j));
    addLog("Job skipped", "info");
  }

  const handleReset = () => {
    localStorage.removeItem(STORAGE_KEY);
    setProfile({}); setJobs([]); setLogs([]); setReportURL("");
  };

  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const handleSignOut = () => setShowSignOutDialog(true);
  const confirmSignOut = () => {
    localStorage.removeItem(STORAGE_KEY);
    setShowSignOutDialog(false);
    setProfile({}); setJobs([]); setLogs([]); setReportURL("");
  };

  // ── Routing ────────────────────────────────────────────────────────────────
  if (profile === null) return null;

  if (!profile.onboarded) {
    return <LandingScreen onComplete={p => setProfile(p)} />;
  }

  const pendingCount = jobs.filter(j => j.status === "pending-review").length;
  const keysSet      = !!profile.apiKey;

  return (
    <div style={{ minHeight: "100vh", background: "#ffffff", color: "#0a0a0a", display: "flex", flexDirection: "column" }}>
      <style>{CSS}</style>

      {/* No-keys banner — shown at top of every tab when API key is missing */}
      {!keysSet && (
        <div style={{
          background: "#fffbeb", borderBottom: "1px solid #fcd34d",
          padding: "11px 24px", display: "flex", alignItems: "center", gap: 12,
          fontSize: 13, color: "#92400e", flexShrink: 0,
        }}>
          <span style={{ fontSize: 15 }}>🔑</span>
          <span>Add your API keys to get started</span>
          <button
            onClick={() => setActiveTab("apikeys")}
            style={{ marginLeft: 4, background: "none", border: "1px solid #fcd34d", borderRadius: 7, padding: "4px 12px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "#92400e" }}
          >
            → API Keys
          </button>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        <Sidebar active={activeTab} setActive={setActiveTab} pendingCount={pendingCount} keysSet={keysSet} onSignOut={handleSignOut} />

        {activeTab === "dashboard"    && <DashboardTab profile={profile} jobs={jobs} logs={logs} running={running} onRun={runAgent} rateLimitedUntil={rateLimitedUntil} dailyEnabled={dailyEnabled} setDailyEnabled={setDailyEnabled} reportURL={reportURL} />}
        {activeTab === "review"       && <ReviewJobsTab jobs={jobs} onApprove={approveJob} onReject={rejectJob} onMarkApplied={markApplied} onGenerateEmail={generateOutreachEmail} onSendEmail={sendOutreachEmail} profile={profile} />}
        {activeTab === "applications" && <ApplicationsTab jobs={jobs} />}
        {activeTab === "outreach"     && <OutreachTab jobs={jobs} />}
        {activeTab === "apikeys"      && <ApiKeysTab profile={profile} onUpdate={setProfile} />}
        {activeTab === "settings"     && <SettingsTab profile={profile} onUpdate={setProfile} onReset={handleReset} onRefreshCompanies={runAgent} />}
      </div>

      {/* Sign-out confirmation dialog */}
      {showSignOutDialog && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={() => setShowSignOutDialog(false)}>
          <div style={{
            background: "#fff", borderRadius: 14, padding: "28px 32px", width: 360,
            boxShadow: "0 20px 60px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", gap: 20,
          }} onClick={e => e.stopPropagation()}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#0a0a0a", marginBottom: 8 }}>Sign out?</div>
              <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>
                This will clear your profile and job history. Are you sure?
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowSignOutDialog(false)}
                style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", color: "#374151" }}
              >
                Cancel
              </button>
              <button
                onClick={confirmSignOut}
                style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
              >
                Yes, sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
