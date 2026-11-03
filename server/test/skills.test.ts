import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PhaseConfig, Workflow } from '../../shared/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-skills-'));
const projectDir = path.join(tmp, 'progetto');
const personal = path.join(tmp, 'personali');
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');
process.env.REGIA_SKILLS_DIR = personal;
process.env.REGIA_GLOBAL_RULES = path.join(tmp, 'CLAUDE.md');
process.env.REGIA_MOCK_SPEED = '2';

const writeSkill = (dir: string, front: string, body = 'Passi della procedura.') => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${front}\n\n${body}\n`);
};
writeSkill(path.join(projectDir, '.claude', 'skills', 'pubblica-articolo'), '---\nname: pubblica-articolo\ndescription: "Pubblica un articolo del blog: immagine, metadati, sitemap."\n---');
fs.writeFileSync(path.join(projectDir, '.claude', 'skills', 'pubblica-articolo', 'checklist.md'), '- immagine\n');
writeSkill(path.join(personal, 'synced', 'org_123', 'Revisione Testi'), '---\nname: Revisione Testi\ndescription: Tono di voce aziendale\n---');
writeSkill(path.join(personal, 'senza-frontmatter'), '# Solo testo');
// Stesso nome nel progetto e tra le personali: entrambe disponibili, con nomi distinti nel plugin.
writeSkill(path.join(personal, 'pubblica-articolo'), '---\nname: pubblica-articolo\ndescription: Versione personale\n---');

const store = await import('../store.ts');
const skills = await import('../skills.ts');
const { startRun } = await import('../engine.ts');
const { validateWorkflow } = await import('../validate.ts');
store.initStore();

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const phase = (p: Partial<PhaseConfig>): PhaseConfig => ({
  label: 'Fase', kind: 'implementazione', role: '', instructions: 'Fai.', model: 'sonnet', allowedTools: ['Read'],
  maxTurns: 10, contextMode: 'sintesi', reuseResult: false, ...p,
});

test('ricerca: progetto di serie, personali solo se attivate, anche in sottocartelle', () => {
  const onlyProject = skills.discoverSkills(projectDir, { project: true, personal: false });
  assert.deepEqual(onlyProject.map((s) => s.id), ['progetto:pubblica-articolo']);
  assert.equal(onlyProject[0].description, 'Pubblica un articolo del blog: immagine, metadati, sitemap.');

  const all = skills.discoverSkills(projectDir, { project: true, personal: true });
  assert.deepEqual(all.map((s) => s.id), ['progetto:pubblica-articolo', 'personale:pubblica-articolo', 'personale:Revisione Testi', 'personale:senza-frontmatter']);
  assert.equal(all.find((s) => s.name === 'senza-frontmatter')?.description, '');

  assert.deepEqual(skills.discoverSkills(projectDir, { project: false, personal: false }), []);
  assert.deepEqual(skills.skillSources({ projectDir, goal: '', maxParallel: 1, loadProjectSettings: false }), { project: true, personal: false });
});

test('plugin della fase: solo le skill scelte, copiate, nomi univoci; originali intatti', () => {
  const all = skills.discoverSkills(projectDir, { project: true, personal: true });
  const chosen = all.filter((s) => s.name !== 'senza-frontmatter');
  const before = fs.readFileSync(path.join(personal, 'synced', 'org_123', 'Revisione Testi', 'SKILL.md'), 'utf8');
  const b = skills.buildSkillBundle('run_x_a#1', chosen);
  assert.deepEqual(b.names, ['regia-skills:pubblica-articolo', 'regia-skills:pubblica-articolo-personale', 'regia-skills:revisione-testi']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.path, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'regia-skills');
  assert.ok(fs.existsSync(path.join(b.path, 'skills', 'pubblica-articolo', 'checklist.md')), 'i file di supporto sono copiati');
  assert.match(fs.readFileSync(path.join(b.path, 'skills', 'revisione-testi', 'SKILL.md'), 'utf8'), /^---\nname: revisione-testi\ndescription: Tono di voce aziendale/);
  assert.equal(fs.readFileSync(path.join(personal, 'synced', 'org_123', 'Revisione Testi', 'SKILL.md'), 'utf8'), before);
  // Una skill senza frontmatter riceve nome e descrizione.
  const nf = skills.buildSkillBundle('run_x_a#2', all.filter((s) => s.name === 'senza-frontmatter'));
  assert.match(fs.readFileSync(path.join(nf.path, 'skills', 'senza-frontmatter', 'SKILL.md'), 'utf8'), /^---\nname: senza-frontmatter\ndescription: \n---\n\n# Solo testo/);
  skills.removeSkillBundles('run_x');
  assert.ok(!fs.existsSync(b.path) && !fs.existsSync(nf.path));
});

test('scelta per fase e avvisi di validazione per skill mancanti', () => {
  const all = skills.discoverSkills(projectDir, { project: true, personal: false });
  assert.deepEqual(skills.phaseSkills(phase({}), all), { selected: [], missing: [] });
  assert.equal(skills.phaseSkills(phase({ skills: 'all' }), all).selected.length, 1);
  assert.deepEqual(skills.phaseSkills(phase({ skills: ['progetto:pubblica-articolo', 'personale:sparita'] }), all).missing, ['personale:sparita']);

  const wf: Workflow = {
    id: 'wf_v', name: 'V', description: '', updatedAt: '',
    settings: { projectDir, goal: '', maxParallel: 1, loadProjectSettings: false },
    nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: phase({ label: 'A', skills: ['personale:Revisione Testi'] }) }], edges: [],
  };
  const issues = validateWorkflow(wf, 'prova', 'it');
  assert.ok(issues.some((i) => i.msg?.key === 'validate.skillsMissing' && i.message.includes('Revisione Testi') && i.level === 'avviso'), JSON.stringify(issues));
  wf.settings.skillSources = { personal: true };
  assert.ok(!validateWorkflow(wf, 'prova', 'it').some((i) => i.msg?.key.startsWith('validate.skills')));
});

test('esecuzione di prova: skill annunciate, usate e registrate come decisione; plugin rimosso a fine fase', async () => {
  const wf: Workflow = {
    id: 'wf_skill', name: 'Skill', description: '', updatedAt: '',
    settings: { projectDir, goal: 'Prova', maxParallel: 1, loadProjectSettings: false, applyGeneralRules: false },
    nodes: [
      { id: 'pub', position: { x: 0, y: 0 }, data: phase({ label: 'Pubblicazione', skills: ['progetto:pubblica-articolo', 'progetto:sparita'] }) },
      { id: 'test', position: { x: 0, y: 1 }, data: phase({ label: 'Test', kind: 'test', allowedTools: ['Bash'] }) },
    ],
    edges: [{ id: 'e', source: 'pub', target: 'test' }],
  };
  const eng = startRun(wf, 'prova', 5);
  const run = eng.run;
  await waitFor(() => run.status === 'completata');
  const pub = run.events.filter((e) => e.nodeId === 'pub');
  assert.ok(pub.some((e) => e.msg?.key === 'events.skillsAvailable' && e.text === 'Pubblicazione: skill disponibili (1): pubblica-articolo.'));
  assert.ok(pub.some((e) => e.msg?.key === 'events.skillsMissing' && e.text.includes('sparita')));
  assert.ok(pub.some((e) => e.kind === 'strumento' && e.text === 'Skill: pubblica-articolo'));
  assert.ok(pub.some((e) => e.kind === 'decisione' && e.source === 'osservata' && e.text === 'Ha usato la skill pubblica-articolo'));
  // Le fasi senza skill non le vedono.
  assert.ok(!run.events.some((e) => e.nodeId === 'test' && /skill/i.test(e.text)));
  const bundles = path.join(tmp, 'data', 'skill-bundles');
  assert.deepEqual(fs.existsSync(bundles) ? fs.readdirSync(bundles) : [], []);
});
