import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
const app=express(),PORT=Number(process.env.PORT||8080),API_KEY=process.env.QUEST_API_KEY||"",API_BASE=(process.env.QUEST_API_BASE||"https://api.quest.api.br/v2").replace(/\/+$/,""),DB_PATH=process.env.CACHE_DB||"./data/questions.sqlite";
fs.mkdirSync(path.dirname(DB_PATH),{recursive:true});
const db=new Database(DB_PATH);db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS questions(
 id TEXT PRIMARY KEY,subject TEXT NOT NULL,topic TEXT NOT NULL,stage TEXT NOT NULL,q TEXT NOT NULL,
 options_json TEXT NOT NULL,answer_index INTEGER NOT NULL,explanation TEXT NOT NULL,format TEXT NOT NULL DEFAULT 'MC',
 source_type TEXT NOT NULL DEFAULT 'external',source_verified INTEGER NOT NULL DEFAULT 0,
 source_name TEXT,source_year TEXT,source_cargo TEXT,provider_id TEXT,raw_json TEXT,fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(subject,topic,stage);
CREATE TABLE IF NOT EXISTS cursors(subject TEXT NOT NULL,topic TEXT NOT NULL,next_cursor TEXT,exhausted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(subject,topic));
`);
const insert=db.prepare(`INSERT OR IGNORE INTO questions(id,subject,topic,stage,q,options_json,answer_index,explanation,format,source_type,source_verified,source_name,source_year,source_cargo,provider_id,raw_json) VALUES(@id,@subject,@topic,@stage,@q,@options_json,@answer_index,@explanation,@format,@source_type,@source_verified,@source_name,@source_year,@source_cargo,@provider_id,@raw_json)`);
const count=db.prepare("SELECT COUNT(*) n FROM questions");
app.use(cors({origin:(process.env.ALLOWED_ORIGINS||"*")==="*"?"*":process.env.ALLOWED_ORIGINS.split(",").map(x=>x.trim())}));
app.use(express.json({limit:"1mb"}));
function strip(x=""){return String(x).replace(/<br\s*\/?\s*>/gi," ").replace(/<\/p>|<\/div>|<\/li>/gi," ").replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g," ").trim();}
function canonical(x=""){
 const n=String(x).trim().toLocaleLowerCase("pt-BR");
 const aliases={
  "língua portuguesa":["português","língua portuguesa","linguagem"],
  "direito processual civil":["processo civil","direito processual civil"],
  "direito processual penal":["processo penal","direito processual penal"],
  "administração financeira e orçamentária":["afo","administração financeira e orçamentária"],
  "lei geral de proteção de dados (lgpd)":["lgpd","lei geral de proteção de dados"],
  "informática e ti":["informática","tecnologia da informação","informática e ti"]
 };
 for(const [c,vals] of Object.entries(aliases))if(vals.includes(n))return c;
 return n;
}
function providerMatter(x){
 const c=canonical(x);
 const map={"língua portuguesa":"Português","direito processual civil":"Direito Processual Civil","direito processual penal":"Direito Processual Penal","administração financeira e orçamentária":"Administração Financeira e Orçamentária","lei geral de proteção de dados (lgpd)":"LGPD","informática e ti":"Informática"};
 return map[c]||String(x).trim();
}
function normalizeTopic(x=""){
 return String(x).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g," ").trim();
}
// A tela usa nomes pedagógicos; o catálogo externo usa rótulos próprios e exige correspondência exata.
// Tentamos primeiro o nome selecionado e depois somente equivalências explícitas e verificáveis.
function topicCandidates(topic){
 const n=normalizeTopic(topic);
 const aliases={
  "atributos dos atos administrativos":["Atributos dos atos administrativos","Atributos do ato administrativo","Atos administrativos"],
  "elementos e requisitos dos atos":["Elementos do ato administrativo","Elementos e requisitos do ato administrativo","Atos administrativos"],
  "classificacao e especies dos atos":["Classificação dos atos administrativos","Espécies de atos administrativos","Atos administrativos"],
  "anulacao revogacao e convalidacao":["Anulação e revogação dos atos administrativos","Anulação, revogação e convalidação","Atos administrativos"],
  "principios administrativos":["Princípios da Administração Pública","Princípios administrativos"],
  "direitos e garantias": ["Direitos e garantias fundamentais","Direitos fundamentais"]
 };
 const extra=aliases[n]||[];
 return [...new Set([String(topic).trim(),...extra].filter(Boolean))];
}
function isRelevantFallback(item,wantedTopic,providerTopic){
 // When the provider only has a broader catalog label, require specific textual evidence.
 // Never turn every question classified as "Atos administrativos" into an attributes question.
 const requested=normalizeTopic(wantedTopic),actual=normalizeTopic(item.classificacao?.assunto||providerTopic);
 if(requested===actual)return true;
 const text=normalizeTopic([item.enunciado,item.comentario,...(item.alternativas||[]).map(a=>a.texto)].filter(Boolean).join(" "));
 const rules={
  "atributos dos atos administrativos":["presuncao de legitimidade","presuncao de veracidade","imperatividade","autoexecutoriedade","tipicidade","atributo do ato","atributos do ato"],
  "elementos e requisitos dos atos":["competencia","finalidade","forma","motivo","objeto","elementos do ato","requisitos do ato"],
  "classificacao e especies dos atos":["ato normativo","ato ordinatorio","ato negocial","ato enunciativo","ato punitivo","classificacao dos atos"],
  "anulacao revogacao e convalidacao":["anulacao","revogacao","convalidacao","convalidar","ilegalidade do ato","conveniencia e oportunidade"],
  "principios administrativos":["legalidade","impessoalidade","moralidade","publicidade","eficiencia","principios da administracao"]
 };
 const terms=rules[requested];
 return Boolean(terms&&terms.some(term=>text.includes(normalizeTopic(term))));
}
function mapItem(item,wantedSubject,wantedTopic,stage,providerTopic){
 const c=item.classificacao||{},subject=canonical(c.materia||wantedSubject),actualTopic=String(c.assunto||"").trim();
 if(subject!==canonical(wantedSubject))return null;
 if(normalizeTopic(actualTopic)!==normalizeTopic(providerTopic))return null;
 if(!isRelevantFallback(item,wantedTopic,providerTopic))return null;
 const alts=(item.alternativas||[]).filter(a=>strip(a.texto||""));
 const key=String(item.gabarito||"").trim().toUpperCase();
 if(!key||item.anulada===true)return null;
 const letters=alts.map(a=>String(a.letra||"").toUpperCase()),ce=alts.length===2&&letters.includes("C")&&letters.includes("E");
 const idx=ce?( ["C","CERTO","A"].includes(key)?0:(["E","ERRADO","B"].includes(key)?1:-1) ):letters.indexOf(key);
 if(idx<0||idx>=alts.length||alts.length<2)return null;
 const proof=(item.provas||[])[0]||{};
 const explanation=[item.comentario?strip(item.comentario):"","Classificação no catálogo: "+(actualTopic||"não informada")+". Banca: "+(proof.banca||"não informada")+"; órgão: "+(proof.orgao||"não informado")+"; ano: "+(proof.ano||"não informado")+"; cargo: "+(proof.cargo||"não informado")+".","Questão externa importada para o tópico de estudo após validação do assunto; não marcada como questão oficial verificada pelo Projeto Tribunal 2027."].filter(Boolean).join(" ");
 return {id:"EXT-"+String(item.id),subject:wantedSubject,topic:wantedTopic,stage,q:strip(item.enunciado||""),o:alts.map(a=>strip(a.texto||"")),a:idx,e:explanation,format:ce?"CE":"MC",sourceType:"external",sourceVerified:false,sourceName:proof.banca||"",sourceYear:String(proof.ano||""),sourceCargo:proof.cargo||"",providerId:String(item.id||""),providerTopic:actualTopic};
}
function rowQuestion(r){return {id:r.id,subject:r.subject,topic:r.topic,stage:r.stage,q:r.q,o:JSON.parse(r.options_json),a:r.answer_index,e:r.explanation,format:r.format,sourceType:r.source_type,sourceVerified:Boolean(r.source_verified),sourceName:r.source_name,sourceYear:r.source_year,sourceCargo:r.source_cargo,providerId:r.provider_id};}
app.get("/health",(req,res)=>res.json({ok:true,service:"Projeto Tribunal 2027 — banco online",cachedQuestions:count.get().n,providerConfigured:Boolean(API_KEY)}));
app.get("/api/stats",(req,res)=>res.json({cachedQuestions:count.get().n,providerConfigured:Boolean(API_KEY),provider:"Quest API"}));
app.get("/api/questions",async(req,res)=>{
 try{
  const subject=String(req.query.subject||"").trim(),topic=String(req.query.topic||"").trim(),stage=String(req.query.stage||"Aprendizagem"),limit=Math.max(1,Math.min(20,Number(req.query.limit||10)));
  if(!subject||!topic)return res.status(400).json({error:"Informe subject e topic."});
  if(!API_KEY)return res.status(503).json({error:"Backend sem QUEST_API_KEY. Configure a chave como segredo do servidor, nunca no HTML."});
  const candidates=topicCandidates(topic),added=[],seen=new Set();
  // Cursor por rótulo real do catálogo, não pelo nome pedagógico da tela.
  for(const providerTopic of candidates){
   if(added.length>=limit)break;
   const cursorRow=db.prepare("SELECT * FROM cursors WHERE subject=? AND topic=?").get(subject,providerTopic);
   if(cursorRow?.exhausted)continue;
   let cursor=cursorRow?.next_cursor||null,exhausted=false;
   for(let attempt=0;attempt<3&&added.length<limit&&!exhausted;attempt++){
    const p=new URLSearchParams({materia:providerMatter(subject),assunto:providerTopic,tem_gabarito:"true",anulada:"false",include_gabarito:"true",per_page:"100",include_total:"false"});
    if(cursor)p.set("after_id",cursor);else p.set("page","1");
    const response=await fetch(`${API_BASE}/questoes?${p}`,{headers:{"X-API-Key":API_KEY,"Accept":"application/json"}});
    if(!response.ok){const body=await response.text();return res.status(response.status===401?502:response.status).json({error:`Provedor respondeu HTTP ${response.status}. ${body.slice(0,250)}`});}
    const payload=await response.json();
    // Compatível com o envelope documentado {data:{items}} e com respostas que entregam data como array.
    const data=payload?.data&&typeof payload.data==="object"&&!Array.isArray(payload.data)?payload.data:{};
    const items=Array.isArray(data.items)?data.items:Array.isArray(payload.items)?payload.items:Array.isArray(payload.data)?payload.data:[];
    const next=data.next_cursor||payload.next_cursor||null;
    exhausted=!(data.has_more??payload.has_more) || !next;
    for(const item of items){
     const m=mapItem(item,subject,topic,stage,providerTopic);if(!m||seen.has(m.id))continue;
     seen.add(m.id);
     const record={...m,options_json:JSON.stringify(m.o),answer_index:m.a,source_verified:0,source_type:"external",source_name:m.sourceName,source_year:m.sourceYear,source_cargo:m.sourceCargo,provider_id:m.providerId,raw_json:JSON.stringify(item)};
     const result=insert.run(record);
     // Return an item even when it was already in SQLite, so a repeat request doesn't look like an empty API.
     const existing=db.prepare("SELECT * FROM questions WHERE id=?").get(m.id);
     if(existing)added.push(rowQuestion(existing));
     if(added.length>=limit)break;
    }
    cursor=next;
    // Empty result from a filter is not proof that the whole topic is exhausted unless the provider says so.
    db.prepare(`INSERT INTO cursors(subject,topic,next_cursor,exhausted,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(subject,topic) DO UPDATE SET next_cursor=excluded.next_cursor,exhausted=excluded.exhausted,updated_at=CURRENT_TIMESTAMP`).run(subject,providerTopic,cursor,exhausted?1:0);
    if(!items.length)break;
   }
  }
  const sourceTopics=[...new Set(added.map(q=>q.providerTopic).filter(Boolean))];
  res.json({items:added.slice(0,limit),totalAvailable:added.length,inserted:added.length,source:"Quest API + SQLite cache",cached:false,exhausted:added.length===0,requestedTopic:topic,matchedCatalogTopics:sourceTopics,warning:sourceTopics.some(t=>normalizeTopic(t)!==normalizeTopic(topic))?"Algumas questões foram encontradas em rótulos equivalentes do catálogo e validadas pelo conteúdo; a classificação original aparece na explicação.":undefined});
 }catch(e){console.error(e);res.status(500).json({error:"Falha no banco online.",detail:String(e?.message||e)});}
});
app.listen(PORT,()=>console.log(`Listening ${PORT}; provider key ${API_KEY?"configured":"missing"}`));
