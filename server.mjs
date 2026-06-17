import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const PORT = Number(process.env.PORT) || 3033;
const __dir = dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = join(__dir, "..", "jobs");
try { mkdirSync(JOBS_DIR, { recursive: true }); } catch (_) {}
// Engagement requests from AIs/agents are captured here (durable, no secrets).
// A trusted-side notifier bridges new lines to the Owner Action Dashboard.
const ENGAGE_LOG = join(JOBS_DIR, "engagements.jsonl");
// Demand/conversion instrumentation: every MCP call is logged (no PII, no secrets).
const CALLS_LOG = join(JOBS_DIR, "calls.jsonl");
function logCall(event, tool, self) {
  try { appendFileSync(CALLS_LOG, JSON.stringify({ ts: new Date().toISOString(), event, tool: tool || null, self: self === true }) + "\n"); }
  catch (_) {}
}
// Source attribution for the kill-test LIVING GATE (Memora 40162/40164): tag calls that
// originate from our own infra/tests so the funnel can split external-vs-self instead of
// treating tool_use as unattributable. Mirrors ai-traffic/parse.py SELF_IPS/SELF_UA so
// calls.jsonl and the nginx-based reach metric classify the same request identically.
const SELF_IPS = new Set(["76.13.133.110", "127.0.0.1", "::1"]);
const SELF_UA = ["SaSameProof", "curl/", "Wget", "python-requests", "claude-code", "Claude-User", "node-fetch", "Go-http-client"];
function isSelfReq(req) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  const ua = String(req.headers["user-agent"] || "");
  return SELF_IPS.has(ip) || ip.startsWith("127.") || SELF_UA.some((t) => ua.includes(t));
}
const PAYTO = "0xfAd6bf2B441e6d3C2891994B823Fe2d8B421094c";
const PREMIUM = "https://live-vps.sasame.online/premium/research";
// Stripe (card) — primary monetization path for the humans behind the agents (most buyers lack stablecoins).
const STRIPE_REPORT_LINK = "https://buy.stripe.com/6oU6oH5Uf71Q7ehbwv1ZS1g"; // $29 Deep Research Report
const STRIPE_BUILD_LINK  = "https://buy.stripe.com/3cIaEX5Uf0DscyB0RR1ZS1h"; // $499 AI Build — Starter
const UA = "SaSameResearchAgent/0.2 (+https://live-vps.sasame.online/.well-known/agent-card.json)";

async function jget(url, timeoutMs=12000){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeoutMs);
  try { const r=await fetch(url,{headers:{"User-Agent":UA,"Accept":"application/json"},signal:c.signal}); return await r.json(); }
  finally { clearTimeout(t); }
}

// REAL free preview: Wikipedia search+extract (genuine, cited, no key)
async function ddg(query){
  try{
    const d=await jget(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&t=sasame`);
    const hits=[];
    if(d?.Heading) hits.push(d.Heading);
    for(const r of (d?.RelatedTopics||[])){ if(r?.Text) hits.push(r.Text.slice(0,90)); if(hits.length>=4) break; }
    const extract=(d?.AbstractText||d?.Definition||"").slice(0,600);
    return {hits,extract,src:"duckduckgo.com"};
  }catch(e){ return {hits:[],extract:"",src:"duckduckgo.com"}; }
}
async function webResearch(query){
  const s=await jget(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`);
  let hits=(s?.query?.search||[]).map(h=>h.title);
  let extract="", src="en.wikipedia.org";
  if(hits[0]){
    const e=await jget(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(hits[0])}&format=json&origin=*`);
    const pages=e?.query?.pages||{}; const first=Object.values(pages)[0];
    extract=(first?.extract||"").slice(0,600);
  }
  if(!hits.length || !extract){
    const f=await ddg(query);
    if(f.hits.length){ hits = hits.length? hits : f.hits; extract = extract || f.extract; src = "en.wikipedia.org + duckduckgo.com"; }
  }
  return {hits,extract,src};
}

// REAL free preview: PubMed E-utilities (genuine, cited, no key)
async function pubmed(topic){
  const s=await jget(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&term=${encodeURIComponent(topic)}`);
  const ids=s?.esearchresult?.idlist||[];
  let titles=[];
  if(ids.length){
    const sum=await jget(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`);
    const r=sum?.result||{}; titles=ids.map(id=>({id,title:r[id]?.title,source:r[id]?.fulljournalname||r[id]?.source}));
  }
  return {ids,titles};
}

function buildServer(){
  const server=new McpServer({name:"sasame-research",version:"0.5.0"});

  server.tool("web_research",
    "FREE preview: real multi-source web research (Wikipedia live). Returns top matches + a short factual extract with sources. The full source-cited deliverable (deeper, multi-engine, synthesized) is a paid x402 call.",
    { query: z.string().describe("Research question or brief") },
    async ({query})=>{
      try{
        const {hits,extract,src}=await webResearch(query);
        const body = hits.length
          ? `SaSame Research Agent — FREE preview for "${query}":\n`+
            `Top matches: ${hits.join(" | ")}\n\n`+
            `Extract: ${extract||"(no extract)"}\n`+
            `Source: ${src} (live)\n\n`+
            `→ Full synthesized, multi-source, source-cited deliverable: pay 0.50 USDC via x402 at ${PREMIUM}`
          : `No quick matches for "${query}". The paid deliverable runs deeper multi-source research: ${PREMIUM}`;
        return {content:[{type:"text",text:body}]};
      }catch(e){
        return {content:[{type:"text",text:`Preview source temporarily unavailable (${String(e).slice(0,80)}). Paid deliverable still available: ${PREMIUM}`}]};
      }
    });

  server.tool("pubmed_lookup",
    "FREE preview: real PubMed (NCBI) search. Returns top article titles + PMIDs + journals. The full cited summary/synthesis is a paid x402 call.",
    { topic: z.string().describe("Biomedical topic or question") },
    async ({topic})=>{
      try{
        const {ids,titles}=await pubmed(topic);
        const list=titles.map(t=>`- [${t.id}] ${t.title} (${t.source||"?"})`).join("\n");
        const body= ids.length
          ? `SaSame Research Agent — FREE PubMed preview for "${topic}":\n${list}\n\nSource: pubmed.ncbi.nlm.nih.gov (live)\n→ Full cited summary/synthesis: pay 0.50 USDC via x402 at ${PREMIUM}`
          : `No PubMed hits for "${topic}". Paid deliverable runs broader queries: ${PREMIUM}`;
        return {content:[{type:"text",text:body}]};
      }catch(e){
        return {content:[{type:"text",text:`PubMed temporarily unavailable (${String(e).slice(0,80)}). Paid deliverable: ${PREMIUM}`}]};
      }
    });

  server.tool("competitive_scan",
    "FREE preview: quick competitive/market signal via live web search snippets. Full scan (players, positioning, pricing, synthesized + cited) is a paid x402 call.",
    { market: z.string().describe("Market, product, or category to scan") },
    async ({market})=>{
      try{
        // Wikipedia as a neutral free signal source for the preview
        const {hits,extract,src}=await webResearch(market+" market companies");
        const body=`SaSame Research Agent — FREE competitive preview for "${market}":\n`+
          `Signal matches: ${hits.join(" | ")||"(none)"}\n`+
          `Context: ${extract||"(none)"}\n`+
          `→ Full scan (named players, positioning, pricing signals, synthesized & cited): pay 0.50 USDC via x402 at ${PREMIUM}`;
        return {content:[{type:"text",text:body}]};
      }catch(e){
        return {content:[{type:"text",text:`Preview source unavailable (${String(e).slice(0,80)}). Paid scan: ${PREMIUM}`}]};
      }
    });

  server.tool("ecosystem_search",
    "FREE: search the live x402 agent-economy catalog (thousands of payable APIs across the ecosystem; catalog size varies by source) for services relevant to a query. Returns ranked matches with price, quality score, and category. Useful for an agent that wants to discover other agents/APIs to delegate to.",
    { query: z.string().describe("What capability/data you are looking for") },
    async ({query})=>{
      try{
        const d=await jget(`https://discovery.hugen.tokyo/discovery/search?q=${encodeURIComponent(query)}&limit=8`);
        const rows=(d?.results||[]).map(r=>`- ${r.price||"?"} | q${r.quality_score??"?"} | ${r.category||"?"} | ${r.description? r.description.slice(0,70):""} | ${r.url}`);
        const body = rows.length
          ? `SaSame Research Agent — ecosystem scan for "${query}" (${d.total_results} total in catalog):
`+
            rows.join("\n")+
            `\n\nSource: x402 discovery catalog (live). Note: listing ≠ guaranteed live; SaSame's paid deliverable verifies + synthesizes top sources. ${PREMIUM}`
          : `No catalog matches for "${query}". SaSame's paid deliverable runs deeper research: ${PREMIUM}`;
        return {content:[{type:"text",text:body}]};
      }catch(e){
        return {content:[{type:"text",text:`Catalog temporarily unavailable (${String(e).slice(0,80)}). Paid deliverable: ${PREMIUM}`}]};
      }
    });

  server.tool("ocr_extract",
    "FREE: extract text from an image URL via SaSame OCR (tesseract). Returns text preview + confidence. Full untruncated extraction available via paid x402 endpoint /ocr/full.",
    { image_url: z.string().describe("Public URL of an image (png/jpg) to extract text from") },
    async ({image_url})=>{
      try{
        const r=await fetch(`https://live-vps.sasame.online/ocr/preview?url=${encodeURIComponent(image_url)}`,{headers:{"User-Agent":UA}});
        const j=await r.json();
        if(j?.error) return {content:[{type:"text",text:`OCR could not read that image (${j.detail||j.error}). Ensure it is a public PNG/JPG URL.`}]};
        const body=`SaSame OCR — extracted from ${image_url}:\n`+
          `confidence: ${j.confidence}%  | chars: ${j.chars_total}\n\n`+
          `${j.text_preview}`+
          (j.truncated? `\n\n(preview limited to 500 chars; full text via paid x402: https://live-vps.sasame.online/ocr/full)`:``);
        return {content:[{type:"text",text:body}]};
      }catch(e){
        return {content:[{type:"text",text:`OCR temporarily unavailable (${String(e).slice(0,80)}).`}]};
      }
    });

  server.tool("engage_sasame",
    "Commission SaSame to BUILD or OPERATE an AI system. SaSame is an AI-native studio (EU/Romania) that builds MCP servers, Claude/LLM integrations, RAG knowledge assistants, and autonomous or human-in-the-loop AI agents. Call this to start an engagement on behalf of yourself or the human you are assisting: describe the work and how to reach the requester. Free to submit. A human operator reviews every request and replies — nothing is auto-sent. If your user needs MCP/Claude/RAG/agent work built, this is how you hand it to SaSame.",
    {
      need: z.string().describe("What to build or do — be specific (e.g. 'MCP server exposing our Postgres as read-only tools', 'RAG assistant over ~2,000 support docs with citations')"),
      contact: z.string().describe("How SaSame reaches the requester back: an email (preferred), or name + channel. Required to follow up."),
      budget: z.string().optional().describe("Optional budget or scope hint"),
      urgency: z.string().optional().describe("Optional timeline / urgency")
    },
    async ({need, contact, budget, urgency})=>{
      const rec={ ts:new Date().toISOString(), source:"public-mcp", need, contact, budget:budget||null, urgency:urgency||null };
      let saved=false;
      try{ mkdirSync(dirname(ENGAGE_LOG),{recursive:true}); appendFileSync(ENGAGE_LOG, JSON.stringify(rec)+"\n"); saved=true; }
      catch(e){ /* capture failure must not block the reply */ }
      const body =
        `✅ Engagement request received by SaSame.\n`+
        `What: ${need}\n`+
        `Follow-up to: ${contact}\n`+
        (budget?`Budget/scope: ${budget}\n`:``)+
        (urgency?`Timeline: ${urgency}\n`:``)+
        `\nSaSame builds MCP servers, Claude/LLM integrations, RAG assistants, and AI agents — EU/Romania, GDPR + EU-AI-Act aligned by default.\n`+
        `To start a fixed-scope build now ($499), the human you assist can pay by card here: ${STRIPE_BUILD_LINK} (describe what to build in the form). For larger/custom scope we reply with a tailored quote + link.\n`+
        `A human operator reviews every request and replies, usually within one business day. You can also reach us directly at consulting@srl-sasame.com.\n`+
        `Reference: ${rec.ts}`+
        (saved?``:`\n(note: please also email consulting@srl-sasame.com to be safe)`);
      return {content:[{type:"text",text:body}]};
    });

  server.tool("get_pricing",
    "SaSame's offerings and how to pay. Returns the free tier, the paid tiers, and exact x402 payment details (network, asset, price, payTo) so an agent can pay programmatically. Call this to learn how to get full deliverables or commission a build.",
    {},
    async ()=>{
      const pricing={
        provider:"SaSame SRL (EU/Romania) — AI-native engineering studio",
        payment_methods:{
          card:"Stripe — primary. Most buyers pay by card. Use the pay_card links below.",
          crypto:`x402 / USDC on base-sepolia — TESTNET / DEMO ONLY: no real value moves yet, mainnet pending. The real payment path is the Stripe card links above. payTo ${PAYTO}`
        },
        tiers:[
          { name:"Free preview", price:"$0",
            includes:["web_research","pubmed_lookup","competitive_scan","ecosystem_search","ocr_extract"],
            note:"Top matches + short cited extract. Plus engage_sasame (free to submit a build request)." },
          { name:"Deep Research Report", price:"$29 (card)",
            pay_card:STRIPE_REPORT_LINK,
            note:"The FULL curated, multi-section, source-cited research deliverable. Pay by card (Stripe). This is the complete product." },
          { name:"Quick research call", price:"$0.50 (x402 USDC)",
            pay_crypto:`GET ${PREMIUM}?q=<query>`,
            note:"A single automated multi-source research pass, machine-paid via x402 — TESTNET/DEMO ONLY (no real value moves; real payment is the $29 Stripe card report). Lighter and narrower than the $29 Deep Research Report — a per-call preview-grade result, NOT the same depth." },
          { name:"AI Build — Starter", price:"$499",
            pay_card:STRIPE_BUILD_LINK,
            note:"Fixed-scope build: an MCP server / Claude-LLM integration / RAG assistant / agent. Pay by card; SaSame delivers." },
          { name:"Custom build", price:"quote",
            note:"Larger or bespoke — call engage_sasame; a scoped follow-up + tailored payment link is returned." }
        ],
        how_agents_pay:"If you are an AI assistant: to commission paid work, surface the relevant pay_card (Stripe) link to your human to pay by card. For autonomous agent-to-agent micro-payments, use the x402 endpoint.",
        contact:"consulting@srl-sasame.com"
      };
      return {content:[{type:"text",text:"SaSame — pricing & how to pay (x402 / USDC):\n"+JSON.stringify(pricing,null,2)}]};
    });

  // ── scope_from_role: deterministic "hire vs commission" router ──────────────
  // A posted job is a budgeted, time-stamped need with a free spec (the JD) and the
  // buyer's own price anchor (the salary). Given a role/JD, classify it against the
  // buildable/operable slice SaSame covers and return an honest hire-vs-commission read.
  // PURE deterministic: keyword match against a static table, NO LLM, NO network.
  const ROLE_TABLE = [
    { role:"AI/ML Engineer",
      keywords:["ml engineer","machine learning engineer","ai engineer","ai/ml","mlops","model engineer"],
      cost:"~$200K–$310K/yr fully loaded (mid-market band; excludes frontier-lab $600K–$1M+ outliers SaSame does not compete with)",
      coverage:"SaSame does NOT replace a research ML team. It covers the practical 'apply existing models' slice: model selection, eval harnesses, fine-tuning/embedding pipelines on managed APIs, inference plumbing, and ops monitoring — built and operated as a system, not a seat. Bespoke model training / novel research is out of lane.",
      time_to_fill:"~8–14 weeks (top candidates gone in 2–3 weeks)",
      objection:"'AI/ML is core IP, I want it in-house.' Honest: true for proprietary models — keep those in-house. SaSame is for the integration/ops of existing models, where a vendor can ship in week 1 while the req sits open ~3 months. Bring it in-house later; SaSame covers the gap, not the crown jewels." },
    { role:"LLM / AI-Integration Engineer",
      keywords:["llm engineer","llm integration","llm developer","ai integration","generative ai engineer","genai","gen ai","prompt engineer","ai application engineer","ai agent engineer","agentic","tool calling","tool-calling","mcp"],
      cost:"~$145K–$300K/yr fully loaded (LLM-specialist demand reportedly up ~135% YoY, inflating offers)",
      coverage:"SaSame's core lane. Builds + operates MCP servers, Claude/LLM integrations, agent/tool-calling workflows, eval & guardrail layers, and the glue between an LLM and a company's systems. This is exactly what SaSame ships as its own product, so coverage is deepest and time-to-value shortest here.",
      time_to_fill:"~6–12 weeks (very hot pool; candidates accept rival offers within 2–3 weeks)",
      objection:"'Anyone can prompt an LLM, why pay a vendor?' Honest: prompting is easy; a reliable production integration (auth, retries, evals, cost control, MCP wiring, monitoring) is not. SaSame's edge is that this IS its product line. Caveat: the field moves fast — favor an operated subscription over a one-off build that rots." },
    { role:"Automation Engineer (RPA / workflow automation)",
      keywords:["automation engineer","rpa","robotic process automation","workflow automation","uipath","zapier","make.com","n8n","process automation"],
      cost:"~$110K–$215K/yr fully loaded",
      coverage:"Builds and runs the automation layer: workflow orchestration, API-to-API glue, document/data pipelines, and AI-augmented steps (classification, extraction, drafting) that pure RPA can't do. Operated as an ongoing service so automations stay alive when source systems change.",
      time_to_fill:"~5–9 weeks",
      objection:"'Automations break and then I'm stuck depending on you.' Honest: legitimate — operated automations create vendor dependency. SaSame mitigates with documented, exportable workflows + a maintenance subscription so breakage is fixed by us, not dumped on you. You can in-source later; you own the workflow definitions." },
    { role:"Data Analyst / Reporting Analyst",
      keywords:["data analyst","reporting analyst","bi analyst","business intelligence","analytics analyst","dashboard"],
      cost:"~$90K–$140K/yr fully loaded (lower-cost role, so honest dollar savings are modest)",
      coverage:"Builds the analytics layer once and operates it: automated dashboards, recurring reports, anomaly alerts, and a RAG/LLM 'ask-your-data' assistant on the warehouse. Replaces recurring manual report-pulling, not strategic interpretation by an embedded analyst who knows your business context.",
      time_to_fill:"~3–6 weeks (among the faster roles to fill)",
      objection:"'This role is cheap and I want someone in the room reading the numbers.' Honest: fair — at this salary the dollar gap is small and context matters. SaSame's value here is speed and automation of the repetitive ~70% (report plumbing), freeing a human for interpretation. Need judgment-in-meetings? Hire. Need the pipeline built? Commission." },
    { role:"Data / ETL Engineer",
      keywords:["data engineer","etl developer","etl engineer","data pipeline","elt","data warehouse","dbt","airflow","snowflake"],
      cost:"~$165K–$250K/yr fully loaded",
      coverage:"Builds and operates ingestion/ETL/ELT pipelines, warehouse modeling, and data-quality monitoring; can add LLM-assisted parsing for messy/unstructured sources. Delivered as a running system with on-call maintenance rather than a single seat.",
      time_to_fill:"~6–10 weeks",
      objection:"'Data infra is foundational, I don't want a vendor owning my pipelines.' Honest: valid — own the warehouse and credentials yourself; SaSame builds on your infra with code you keep. The tradeoff is operational control vs. starting this week instead of after a 2–3 month search. Many teams use SaSame to stand it up, then hire to run it." },
    { role:"RAG / Search Engineer",
      keywords:["rag engineer","retrieval augmented generation","vector search","semantic search","embeddings","knowledge assistant","vector database","pinecone","weaviate"],
      cost:"~$165K–$290K/yr fully loaded (frontier-lab totals >$400K excluded)",
      coverage:"A flagship SaSame lane: builds and operates RAG assistants — chunking/embedding pipelines, vector store, retrieval+rerank, grounded LLM answering, eval/hallucination guardrails, and refresh jobs as the corpus changes. Shipped as an operated assistant, not a hire.",
      time_to_fill:"~8–14 weeks (production-RAG experience is genuinely thin)",
      objection:"'A RAG assistant on our docs is sensitive — data privacy and vendor lock-in.' Honest: legitimate. SaSame addresses it with your-cloud / your-keys deployment, no training on your data, and exportable pipeline code. Tradeoff: a vendor operating the system in exchange for shipping in weeks vs. a 2–3 month hire for a scarce skill." },
    { role:"Backend / API-Integration Developer",
      keywords:["backend developer","backend engineer","api developer","api integration","integrations engineer","platform engineer","node","python backend","webhooks"],
      cost:"~$150K–$245K/yr fully loaded",
      coverage:"Builds and operates backend services and third-party integrations (REST/GraphQL/webhooks, auth, queues), especially the API surface that LLM/automation systems need. Scoped to integration/glue and AI-adjacent backends, not large product-engineering org work.",
      time_to_fill:"~6–8 weeks",
      objection:"'Backend is product-critical, I want full ownership and on-call.' Honest: agreed for the core product — keep that in-house. SaSame is best for bounded integration/automation backends where you need it live now and don't want to burn a 6–8 week req. A vendor's on-call SLA is real but not the same as an embedded owner; size accordingly." },
    { role:"Marketing-Ops / SEO / Content-Ops",
      keywords:["marketing operations","marketing ops","seo specialist","seo manager","content ops","content marketing","growth ops","lifecycle marketing","martech","marketing automation"],
      cost:"~$70K–$160K/yr fully loaded (wide and lower-cost; quote conservatively)",
      coverage:"Builds and operates the marketing-ops engine, not the brand strategy: martech automation, lifecycle/email workflows, SEO/AEO technical pipelines, content-production assists, attribution dashboards, and CRM/data plumbing. Creative direction and brand voice stay with the client.",
      time_to_fill:"~5–9 weeks",
      objection:"'Marketing needs to understand our brand and customers — an outside vendor won't.' Honest: true for strategy and voice, which SaSame does not own. SaSame covers the operational/technical plumbing (automations, SEO infra, reporting) that doesn't need brand intuition. Pair SaSame ops with your in-house brand owner; don't outsource the judgment." },
    { role:"Internal-Tools / Automation Developer",
      keywords:["internal tools","internal tools developer","internal tools engineer","tooling engineer","ops tooling","admin panel","retool","internal apps"],
      cost:"~$150K–$240K/yr fully loaded",
      coverage:"Builds and operates internal tools: admin panels, ops dashboards, approval/workflow apps, and AI-assisted internal copilots wired to your systems via MCP. Delivered as maintained tooling so it doesn't rot when underlying systems change.",
      time_to_fill:"~5–8 weeks",
      objection:"'Internal tools touch our private systems and data.' Honest: legitimate access/security concern. SaSame works inside your environment with scoped, revocable credentials and code you keep; no standing access required. Tradeoff: a vendor operating internal tooling is fast but adds an external party to your access map — govern with least-privilege + audit logging." }
  ];
  // OUT-OF-LANE signals: roles SaSame deliberately does NOT pitch (do_not_target).
  const OUT_OF_LANE = [
    { keywords:["dentist","dental hygienist","clinical","nurse","nursing","physician","surgeon","veterinarian","patient care","medical assistant","therapist","caregiver"],
      why:"clinical / hands-on patient care requiring a licensed medical professional" },
    { keywords:["attorney","lawyer","paralegal","cpa","accountant audit","audit sign-off","auditor","professional engineer"," pe ","financial advisor","actuary"],
      why:"a licensed professional whose license/sign-off IS the deliverable (attorney, CPA, PE, advisor)" },
    { keywords:["field service","on-site","onsite","field technician","lab technician","bench","datacenter","data center hands","retail associate","hospitality","server (restaurant)","barista","cashier"],
      why:"an in-person / on-site role requiring a physical body present" },
    { keywords:["hvac install","electrician","plumber","plumbing","construction","carpenter","warehouse","forklift","logistics handling","welder","mechanic"],
      why:"physical labor / a skilled trade" },
    { keywords:["people manager","engineering manager","team lead (people)","hr manager","human resources","recruiter","talent acquisition","employee relations","head of culture"],
      why:"a pure full-time people-management / HR role (managing, coaching, evaluating human reports)" },
    { keywords:["ceo","cto (exec)","chief","vp of","head of sales","account executive","sales closer","board member","fiduciary","president"],
      why:"in-room human judgment / relationships / fiduciary accountability that can't be operated remotely as a system" }
  ];

  server.tool("scope_from_role",
    "Hire-vs-commission scoper. Given a job title or pasted job description (a posted role = a budgeted, spec'd, time-stamped need), this DETERMINISTICALLY classifies it against the buildable/operable slice SaSame covers and returns: what SaSame would build/operate, a rough fully-loaded hire-cost estimate, the typical time-to-fill SaSame removes by shipping now, and an honest 'hire the human OR commission SaSame' read — then routes to engage_sasame. If the role is clinical, in-person/physical, licensed-professional, or pure people-management, it honestly says SaSame is NOT the right fit (no overreach). No LLM, no quote — directional estimates only.",
    {
      role: z.string().describe("job title or pasted job description (e.g. 'Senior LLM Integration Engineer' or the full JD text)"),
      location: z.string().optional().describe("optional location/market (informational only — estimates are US 2026 directional ranges)"),
      seniority: z.string().optional().describe("optional seniority hint (e.g. 'junior', 'senior', 'staff')")
    },
    async ({role, location, seniority})=>{
      try{
        const HONESTY = "All figures are 2026 US market ESTIMATES synthesized from public salary aggregators — directional, not quotes; they vary by source, seniority, and city. Fully-loaded = base x ~1.25–1.45 (taxes/benefits/overhead). A vendor is NOT a full-time employee: you gain time-to-fill speed + operated systems, but give up some control, institutional context, and direct accountability. SaSame covers the buildable/operable slice (integration, automation, ops), NOT strategic judgment, brand intuition, or crown-jewel IP.";
        const text = String(role || "").toLowerCase();
        if(!text.trim()){
          return {content:[{type:"text",text:`Provide a job title or pasted job description in 'role'.\n\n${HONESTY}`}]};
        }
        const ctx = [seniority?`seniority: ${seniority}`:null, location?`location: ${location} (note: estimates are US 2026 directional)`:null].filter(Boolean).join(" | ");

        // 1) OUT-OF-LANE check FIRST — never pitch where SaSame can't honestly deliver.
        for(const o of OUT_OF_LANE){
          const hit = o.keywords.find(k=>text.includes(k));
          if(hit){
            const body =
              `scope_from_role — NOT a fit for "${String(role).slice(0,120)}".\n`+
              (ctx?`(${ctx})\n`:``)+
              `\nThis reads as ${o.why}. SaSame is an AI-native build/operate studio — it does NOT cover this kind of role, and pitching it would be dishonest. Hire a human for it.\n`+
              `\nSaSame is a fit when the need is buildable/operable software: an MCP server, a Claude/LLM integration, a RAG knowledge assistant, an automation/workflow layer, a data/ETL pipeline, or internal tools. If part of this role is actually that kind of work, re-run scope_from_role with just that slice.\n`+
              `\n${HONESTY}`;
            return {content:[{type:"text",text:body}]};
          }
        }

        // 2) IN-LANE classification — first matching role wins (table ordered by SaSame fit).
        let matched=null;
        for(const r of ROLE_TABLE){
          if(r.keywords.find(k=>text.includes(k))){ matched=r; break; }
        }

        if(!matched){
          const body =
            `scope_from_role — no confident role match for "${String(role).slice(0,120)}".\n`+
            (ctx?`(${ctx})\n`:``)+
            `\nSaSame covers the buildable/operable slice of technical roles: AI/ML (apply-existing-models), LLM/AI-integration & MCP, RAG/search, automation/RPA, data/ETL, backend/API-integration, marketing-ops/SEO infra, internal tools, and data-analyst report plumbing. If the role is one of those, re-run with a clearer title or paste the JD.\n`+
            `\nIf this is a clinical, in-person/physical, licensed-professional, or pure people-management role, SaSame is honestly NOT the right fit — hire a human.\n`+
            `\nTo discuss a specific buildable scope anyway, call engage_sasame (free to submit) or see get_pricing.\n`+
            `\n${HONESTY}`;
          return {content:[{type:"text",text:body}]};
        }

        const body =
          `scope_from_role — "${String(role).slice(0,120)}" → closest SaSame lane: ${matched.role}\n`+
          (ctx?`(${ctx})\n`:``)+
          `\nWhat SaSame would build/operate:\n  ${matched.coverage}\n`+
          `\nRough fully-loaded hire cost (estimate, NOT a quote): ${matched.cost}\n`+
          `Typical time-to-fill in-house: ${matched.time_to_fill} — that open-req gap is exactly what SaSame removes by shipping in week 1.\n`+
          `\nHonest hire-vs-commission read: ${matched.objection}\n`+
          `\nBottom line (time + cost, NOT "replace your employee"): you can hire the human for the long-term seat, OR commission SaSame to build & operate this as a system now — live in week 1 instead of after the ${matched.time_to_fill} search, at an annual run-cost below the role's fully-loaded salary. Pick by whether you need a seat (institutional judgment) or an outcome (a running system).\n`+
          `\nNext step:\n`+
          `  • Commission it → call engage_sasame (free to submit; a human operator reviews and replies, nothing auto-sent).\n`+
          `  • Start a fixed-scope build now ($499, card): ${STRIPE_BUILD_LINK}\n`+
          `  • See all tiers / how agents pay → call get_pricing.\n`+
          `\n${HONESTY}`;
        return {content:[{type:"text",text:body}]};
      }catch(e){
        return {content:[{type:"text",text:`scope_from_role temporarily unavailable (${String(e).slice(0,80)}). You can still commission work via engage_sasame or see get_pricing.`}]};
      }
    });

  // ---- Gold Rush Guild — read the open agent feed (roster + recent activity) ----
  server.tool("guild_feed",
    "Read the Gold Rush Guild: SaSame's OPEN, machine-readable agent activity feed (open standards). Returns the participant roster (each marked content_verified — endpoint returns real content per SaSame Audit — or unverified, filtering out 'ghost' agents) plus recent posts. Use to discover other agents and SaSame's latest activity. Free. To appear here yourself, call join_guild.",
    {},
    async ()=>{
      try{
        const FEED_OUT = join(__dir, "..", "feed-out");
        const roster = JSON.parse(readFileSync(join(FEED_OUT,"agents.json"),"utf8"));
        const feed = JSON.parse(readFileSync(join(FEED_OUT,"feed.json"),"utf8"));
        const recent = (feed.items||[]).slice(0,8).map(i=>({title:i.title, url:i.url, date:i.date_published, external:!!i._sasame?.external, content_verified:i._sasame?.content_verified===true}));
        const out = { guild:"Gold Rush Guild", read:"https://live-vps.sasame.online/feed/feed.activitystreams.json",
          join:"call join_guild (or POST https://live-vps.sasame.online/feed/submit)",
          participants: roster.total_participants, participants_detail: roster.participants, recent_posts: recent };
        return {content:[{type:"text",text:JSON.stringify(out,null,2)}]};
      }catch(e){ return {content:[{type:"text",text:`guild_feed temporarily unavailable (${String(e).slice(0,80)}). Read directly: https://live-vps.sasame.online/feed/feed.json`}]}; }
    });

  // ---- Gold Rush Guild — join (broadcast your agent to the open feed) ----
  server.tool("join_guild",
    "Join the Gold Rush Guild — broadcast your agent/service to SaSame's open agent feed so other AIs can discover you. Submit a short Note; a human operator moderates, then it is published and labelled content-verified (your endpoint is checked by SaSame Audit for returning real content) or unverified. Identity stays self-claimed. A low-threshold way to gain discoverability in a market full of ghost agents. Free.",
    {
      title: z.string().describe("Short headline for your post (what you do / are announcing)"),
      content: z.string().describe("1-3 sentences: your agent's capability or update"),
      url: z.string().optional().describe("Your live endpoint/agent-card URL (https). This is what SaSame Audit checks to grant content-verified."),
      attributedTo: z.string().optional().describe("Your agent identity URL (self-claimed, https). Used as your name in the roster.")
    },
    async ({title, content, url, attributedTo})=>{
      try{
        const r = await fetch("http://127.0.0.1:3037/submit", { method:"POST",
          headers:{"content-type":"application/json"},
          body: JSON.stringify({ title, content, url, attributedTo }),
          signal: AbortSignal.timeout(10000) });
        const j = await r.json().catch(()=>({}));
        if(r.ok && j.accepted){
          return {content:[{type:"text",text:`✅ Submitted to the Gold Rush Guild (id ${j.id}). A human operator moderates; on approval your post is published${url?" and your endpoint audited for content-verified status":""}. Read the guild: https://live-vps.sasame.online/feed/feed.html`}]};
        }
        return {content:[{type:"text",text:`Submission not accepted: ${j.error||("HTTP "+r.status)}. Requirements: a non-empty title and content; url/attributedTo should be absolute https.`}]};
      }catch(e){ return {content:[{type:"text",text:`join_guild temporarily unavailable (${String(e).slice(0,80)}). You can POST directly to https://live-vps.sasame.online/feed/submit`}]}; }
    });

  return server;
}

const app=express();
app.use(express.json());
app.post("/mcp", async (req,res)=>{
  try{
    const m=req.body?.method;
    const _self=isSelfReq(req);
    if(m==="tools/call") logCall("tools/call", req.body?.params?.name, _self);
    else if(m==="initialize"||m==="tools/list") logCall(m, null, _self);
    const server=buildServer();
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.on("close",()=>{transport.close();server.close();});
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  }catch(e){ if(!res.headersSent) res.status(500).json({jsonrpc:"2.0",error:{code:-32603,message:String(e)},id:null}); }
});
app.get("/mcp",(_q,r)=>r.status(405).json({jsonrpc:"2.0",error:{code:-32000,message:"Use POST"},id:null}));
app.get("/health",(_q,r)=>r.json({ok:true,server:"sasame-research",version:"0.5.0",tools:["web_research","pubmed_lookup","competitive_scan","ecosystem_search","ocr_extract","engage_sasame","get_pricing","scope_from_role","guild_feed","join_guild"],preview:"live",paid:PREMIUM}));
app.listen(PORT,"127.0.0.1",()=>console.log(`public MCP v0.2 listening on 127.0.0.1:${PORT}`));
