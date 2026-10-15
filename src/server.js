
import express from "express";
import cors from "cors";

const app = express();
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.QUEST_API_KEY || "";
const API_BASE = (process.env.QUEST_API_BASE || "https://api.quest.api.br/v2").replace(/\/+$/, "");

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map(x => x.trim())
    : "*"
}));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Projeto Tribunal 2027 — banco online",
    providerConfigured: Boolean(API_KEY)
  });
});

app.get("/api/stats", (_req, res) => {
  res.json({
    provider: "Quest API",
    providerConfigured: Boolean(API_KEY),
    cachedQuestions: 0
  });
});

app.get("/api/questions", async (req, res) => {
  try {
    const subject = String(req.query.subject || "").trim();
    const topic = String(req.query.topic || "").trim();
    const stage = String(req.query.stage || "Aprendizagem").trim();
    const limit = Math.min(10, Math.max(1, Number(req.query.limit || 10)));

    if (!subject || !topic) {
      return res.status(400).json({
        error: "Informe subject e topic."
      });
    }

    if (!API_KEY) {
      return res.status(503).json({
        error: "Servidor sem QUEST_API_KEY. Configure a chave nas variáveis de ambiente do Render."
      });
    }

    const params = new URLSearchParams({
      materia: subject,
      assunto: topic,
      tem_gabarito: "true",
      anulada: "false",
      include_gabarito: "true",
      per_page: String(limit)
    });

    const response = await fetch(`${API_BASE}/questoes?${params}`, {
      headers: {
        "X-API-Key": API_KEY,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Quest API HTTP", response.status, detail.slice(0, 500));
      return res.status(502).json({
        error: "A Quest API não conseguiu atender à consulta.",
        providerStatus: response.status
      });
    }

    const payload = await response.json();
    const data = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.items)
        ? payload.items
        : [];

    const questions = data
      .filter(item => item && item.anulada !== true && item.gabarito)
      .map(item => {
        const alternatives = Array.isArray(item.alternativas)
          ? item.alternativas
          : [];

        const answer = String(item.gabarito || "").trim().toUpperCase();
        const answerIndex = alternatives.findIndex(
          alternative =>
            String(alternative.letra || "").trim().toUpperCase() === answer
        );

        return {
          id: `QUEST-${item.id}`,
          subject,
          topic,
          stage,
          q: String(item.enunciado || item.questao || "").trim(),
          o: alternatives.map(alternative => ({
            l: String(alternative.letra || ""),
            t: String(alternative.texto || alternative.text || "")
          })),
          a: answerIndex,
          e: String(item.comentario || item.explicacao || ""),
          format: "MC",
          source_type: "external",
          source_verified: false,
          source_name: "Quest API",
          source_year: item.ano || null,
          source_cargo: item.cargo || null
        };
      })
      .filter(item =>
        item.q &&
        item.o.length >= 2 &&
        item.a >= 0 &&
        item.a < item.o.length
      );

    return res.json({
      items: questions,
      totalAvailable: questions.length,
      inserted: questions.length,
      source: "Quest API",
      cached: false,
      stage,
      note: "Questões externas; confira a banca e a prova de origem."
    });
  } catch (error) {
    console.error("Falha na consulta à Quest API:", error);
    return res.status(500).json({
      error: "Falha no banco online.",
      detail: String(error.message || error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Projeto Tribunal 2027 ativo na porta ${PORT}`);
});
