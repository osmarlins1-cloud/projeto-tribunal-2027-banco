import assert from 'node:assert/strict';
import fs from 'node:fs';
const s=fs.readFileSync(new URL('./server.js',import.meta.url),'utf8');
for(const x of ['app.get("/health"','app.get("/api/questions"','topic.toLocaleLowerCase("pt-BR")!==wantedTopic.toLocaleLowerCase("pt-BR")','sourceVerified:false','QUEST_API_KEY','CREATE TABLE IF NOT EXISTS cursors']) assert(s.includes(x),`missing ${x}`);
console.log('6 backend static checks passed');
