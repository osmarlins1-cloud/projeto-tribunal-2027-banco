import express from "express";
import cors from "cors";

const app = express();
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.QUEST_API_KEY || "";
const API_BASE = (process.env.QUEST_API_BASE || "https://api.quest.api.br/v2").replace(/\/+$/, "");
const TIMEOUT_MS = Math.max(3000, Number(process.env.PROVIDER_TIMEOUT_MS || 15000));

app.disable("x-powered-by");
app.use(cors({ origin: process.env.ALLOWED_ORIGINS || "*" }));
app.use(express.json({ limit: "1mb" }));

const norm = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const strip = value => String(value ?? "").replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();

class ProviderError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function providerGet(route, params = {}) {
  if (!API_KEY) throw new ProviderError(503, "QUEST_API_KEY não está configurada no servidor.");
  const url = new URL(API_BASE + route);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && String(value) !== "") url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, { headers: { "X-API-Key": API_KEY, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new ProviderError(504, error?.name === "TimeoutError" ? "Tempo limite da Quest API excedido." : "Falha de rede ao contactar a Quest API.");
  }
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new ProviderError(response.status === 401 ? 502 : response.status, String(payload.message || payload.error || ("Quest API HTTP " + response.status)).slice(0, 250));
  return payload;
}

function getItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function chooseExactOrClose(requested, candidates) {
  const values = [...new Set(candidates.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))];
  const exact = values.find(value => norm(value) === norm(requested));
  if (exact) return exact;
  const wanted = new Set(norm(requested).split(" ").filter(Boolean));
  let best = null, bestScore = 0;
  for (const value of values) {
    const words = new Set(norm(value).split(" ").filter(Boolean));
    const score = [...wanted].filter(word => words.has(word)).length / Math.max(wanted.size, words.size, 1);
    if (score > bestScore) { best = value; bestScore = score; }
  }
  return bestScore >= 0.3 ? best : null;
}

async function resolveCatalog(subject, topic) {
  const subjectPayload = await providerGet("/filtros/materias", { q: subject, limit: 50 });
  const subjects = getItems(subjectPayload);
  const matchedSubject = chooseExactOrClose(subject, subjects);
  if (!matchedSubject) return { matchedSubject: null, matchedTopic: null, subjectSuggestions: subjects.slice(0, 20), topicSuggestions: [] };
  const searchTerm = topic.trim().split(/\s+/)[0];
const topicPayload = await providerGet("/filtros/assuntos", { materia: matchedSubject, q: searchTerm, page: 1, per_page: 100 });
   const topics = getItems(topicPayload);
  return { matchedSubject, matchedTopic: chooseExactOrClose(topic, topics), subjectSuggestions: [], topicSuggestions: topics.slice(0, 30) };
}

function normalizeQuestion(item, subject, topic, stage) {
  if (!item || item.anulada === true || !item.gabarito) return null;
  const options = (Array.isArray(item.alternativas) ? item.alternativas : []).filter(option => strip(option?.texto));
  if (options.length < 2) return null;
  const answerKey = String(item.gabarito).trim().toUpperCase();
  const letters = options.map(option => String(option.letra || "").trim().toUpperCase());
  let answer = letters.indexOf(answerKey);
  const certoErrado = options.length === 2 && letters.includes("C") && letters.includes("E");
  if (certoErrado) answer = ["C", "CERTO", "A"].includes(answerKey) ? 0 : ["E", "ERRADO", "B"].includes(answerKey) ? 1 : -1;
  if (answer < 0 || answer >= options.length) return null;
  const proof = Array.isArray(item.provas) ? (item.provas[0] || {}) : {};
  const comment = strip(item.comentario || "");
  const provenance = "Fonte: Quest API. Banca: " + (proof.banca || "não informada") + "; ano: " + (proof.ano || "não informado") + "; cargo: " + (proof.cargo || "não informado") + ". Questão externa, não verificada oficialmente pelo Projeto Tribunal 2027.";
  return {
    id: "EXT-" + String(item.id ?? ""),
    subject, topic, stage,
    q: strip(item.enunciado || ""),
    o: options.map(option => strip(option.texto || "")),
    a: answer,
    e: [comment, provenance].filter(Boolean).join(" "),
    format: certoErrado ? "CE" : "MC",
    sourceType: "external",
    sourceVerified: false,
    sourceName: proof.banca || "",
    sourceYear: String(proof.ano || ""),
    sourceCargo: proof.cargo || "",
    providerId: String(item.id ?? "")
  };
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "Projeto Tribunal 2027 — banco online", cachedQuestions: 0, providerConfigured: Boolean(API_KEY), persistence: "disabled" }));
app.get("/api/stats", (_req, res) => res.json({ cachedQuestions: 0, providerConfigured: Boolean(API_KEY), provider: "Quest API", persistence: "disabled" }));

// Consulta somente filtros do catálogo; não baixa conteúdo de questões.
app.get("/api/catalog", async (req, res) => {
  const subject = String(req.query.subject || "").trim(), topic = String(req.query.topic || "").trim();
  if (!subject || !topic) return res.status(400).json({ error: "Informe subject e topic." });
  try {
    const result = await resolveCatalog(subject, topic);
    return res.json({ ok: Boolean(result.matchedSubject && result.matchedTopic), requestedSubject: subject, requestedTopic: topic, ...result, questionCreditsUsed: 0 });
  } catch (error) {
    return res.status(error instanceof ProviderError ? error.status : 500).json({ error: error.message || "Falha ao consultar catálogo." });
  }
});

app.get("/api/questions", async (req, res) => {
  const subject = String(req.query.subject || "").trim(), topic = String(req.query.topic || "").trim();
  const stage = String(req.query.stage || "Aprendizagem").trim() || "Aprendizagem";
  const limit = Math.max(1, Math.min(10, Number.parseInt(String(req.query.limit || "10"), 10) || 10));
  if (!subject || !topic) return res.status(400).json({ error: "Informe subject e topic." });
  try {
    const catalog = await resolveCatalog(subject, topic);
    if (!catalog.matchedSubject || !catalog.matchedTopic) return res.status(422).json({
      error: "Matéria ou assunto não encontrado com segurança no catálogo da Quest API.",
      requestedSubject: subject, requestedTopic: topic, ...catalog,
      hint: "Nenhuma questão foi consultada. Use as sugestões para ajustar os nomes."
    });
    const payload = await providerGet("/questoes", {
      materia: catalog.matchedSubject, assunto: catalog.matchedTopic,
      tem_gabarito: "true", anulada: "false", include_gabarito: "true",
      include_total: "false", per_page: limit, page: 1
    });
    const raw = getItems(payload);
    const questions = raw.map(item => normalizeQuestion(item, subject, topic, stage)).filter(Boolean).slice(0, limit);
    return res.json({
      items: questions, totalAvailable: questions.length, inserted: questions.length, returned: questions.length,
      source: "Quest API (ao vivo)", cached: false, persistence: "none",
      exhausted: raw.length === 0, requestedTopic: topic, matchedCatalogTopic: catalog.matchedTopic,
      warning: questions.length < limit ? "O provedor retornou menos questões válidas que o solicitado; o conteúdo não foi armazenado." : undefined
    });
  } catch (error) {
    console.error("Quest API request failed:", error?.message || error);
    return res.status(error instanceof ProviderError ? error.status : 500).json({ error: error.message || "Falha ao consultar questões da Quest API." });
  }
});

app.listen(PORT, () => console.log("Listening " + PORT + "; provider key " + (API_KEY ? "configured" : "missing")));
