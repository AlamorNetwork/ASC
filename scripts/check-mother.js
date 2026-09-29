/** Free check: the mother agent owns planning; ordinary chat creates no intent. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-mother-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
const store = await import('../src/db.js');
const { motherTurn, normalizePlan } = await import('../src/mother.js');
try {
  const pid = 'owner';
  let teamCalls = 0;
  const team = async ({ dossierId, nodeId }) => {
    teamCalls++;
    const nodes = store.dossierResearchNodes(pid, dossierId);
    if (!nodes.some((n) => n.id === nodeId && !n.parent_id) ||
        nodes.filter((n) => n.parent_id === nodeId).length !== 2)
      throw new Error('mother did not create its own root and children');
    return { summary: 'نتیجهٔ مقدماتی', openQuestions: ['منبع دوم؟'], incomplete: [] };
  };
  const plain = await motherTurn({ principalId: pid, userText: 'سلام، چطوری؟', team,
    ask: async () => ({ data: { action: 'respond', reply: 'سلام! آماده‌ام.' }, usage: {} }) });
  if (plain.text !== 'سلام! آماده‌ام.' || teamCalls || store.listDossiers(pid, 5).length)
    throw new Error('ordinary chat created research');
  const planned = await motherTurn({ principalId: pid, userText: 'برو دربارهٔ میترا تحقیق کن', team,
    ask: async () => ({ data: { action: 'research_team', goal: 'خاستگاه میترا',
      subtasks: [{ title: 'شاهد مستقیم', role: 'web' },
        { title: 'دیدگاه مخالف', role: 'web' }] }, usage: {} }) });
  const root = store.dossierResearchNodes(pid, planned.dossierId).find((n) => !n.parent_id);
  if (!root || teamCalls !== 1 || planned.text !== 'نتیجهٔ مقدماتی\n\nپرسش باز: منبع دوم؟')
    throw new Error('explicit research was not delegated');
  const resumed = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: 'ادامه بده', team,
    ask: async () => ({ data: { action: 'research_team', target_root_id: root.id,
      goal: 'خاستگاه میترا', subtasks: [] }, usage: {} }) });
  if (teamCalls !== 2 || resumed.dossierId !== planned.dossierId ||
      store.dossierResearchNodes(pid, planned.dossierId).length !== 3)
    throw new Error('resume duplicated intentions');
  const rejected = normalizePlan({ action: 'crawl_site', url: 'https://other.org/' },
    'این لینک را بخوان: https://example.org/');
  if (rejected.action !== 'respond') throw new Error('model-invented URL was accepted');
  const nonInstruction = normalizePlan({ action: 'research_team', goal: 'سلام' }, 'سلام، نظرت چیه؟');
  if (nonInstruction.action !== 'respond') throw new Error('ordinary chat launched research');
  const settings = await import('../src/settings.js');
  settings.setBudget(0);
  const blocked = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: 'برو دربارهٔ میترا تحقیق کن', team,
    ask: async () => ({ data: { action: 'research_team', goal: 'میترا',
      subtasks: [{ title: 'پرسش تازه', role: 'web' }] }, usage: {} }) });
  if (blocked.action.type !== 'budget_blocked' || teamCalls !== 2 ||
      store.dossierResearchNodes(pid, planned.dossierId).length !== 3)
    throw new Error('zero budget still started agents');
  if (store.dossierResearchNodes('other', planned.dossierId).length)
    throw new Error('other principal sees intentions');
  console.log('mother check passed — conversation, autonomous plan, resume, URL gate, isolation; 0 model calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
