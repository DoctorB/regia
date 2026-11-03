import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Check, ChevronDown, ChevronRight, Copy, FolderInput, FolderMinus, FolderOpen, LayoutList, Pencil, Search, Trash2, TriangleAlert, X,
} from 'lucide-react';
import type { RunSummary, Workflow } from '../../../shared/types.ts';
import { api, fmtTime } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Modal, toast } from '../ui.tsx';

const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/** Gruppo normalizzato: vuoto = senza gruppo. */
export const groupOf = (w: Workflow) => (w.group ?? '').trim();

/** Gruppi esistenti, in ordine alfabetico. */
export function groupNames(workflows: Workflow[]): string[] {
  return [...new Set(workflows.map(groupOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Workflow raggruppati e ordinati (gruppi alfabetici, "senza gruppo" in fondo; dentro ogni gruppo i più recenti prima). */
export function grouped(workflows: Workflow[], query = ''): [string, Workflow[]][] {
  const q = query.trim().toLowerCase();
  // Nome, gruppo e nome della cartella del progetto (non la descrizione né il percorso completo, troppo generici).
  const match = (w: Workflow) => !q || [w.name, groupOf(w), folderName(w.settings.projectDir ?? '')].some((x) => x.toLowerCase().includes(q));
  const map = new Map<string, Workflow[]>();
  for (const w of workflows.filter(match)) {
    const g = groupOf(w);
    (map.get(g) ?? map.set(g, []).get(g)!).push(w);
  }
  for (const list of map.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
}


interface Props {
  workflows: Workflow[];
  currentId?: string;
  onOpen: (id: string) => void;
  /** Ricarica l'elenco dopo una modifica; indica gli id eliminati. */
  onChanged: (deleted?: string[]) => Promise<void> | void;
  onClose: () => void;
}

export function WorkflowManager({ workflows, currentId, onOpen, onChanged, onClose }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<{ from: string; value: string } | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.runs().then(setRuns).catch(() => undefined); }, [workflows]);
  const runCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) m.set(r.workflowId, (m.get(r.workflowId) ?? 0) + 1);
    return m;
  }, [runs]);
  const groups = useMemo(() => grouped(workflows, query), [workflows, query]);
  const names = useMemo(() => groupNames(workflows), [workflows]);
  const visibleIds = groups.flatMap(([, l]) => l.map((w) => w.id));
  const byId = (id: string) => workflows.find((w) => w.id === id)!;

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleGroup = (list: Workflow[]) => setSel((s) => {
    const n = new Set(s);
    const all = list.every((w) => n.has(w.id));
    for (const w of list) if (all) n.delete(w.id); else n.add(w.id);
    return n;
  });

  async function run<T>(fn: () => Promise<T>, done?: string, deleted?: string[]) {
    setBusy(true);
    try { await fn(); await onChanged(deleted); if (done) toast(done, 'good'); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  }

  const saveName = (w: Workflow, name: string) => run(async () => {
    const n = name.trim();
    if (n && n !== w.name) await api.saveWorkflow({ ...w, name: n });
    setRenaming(null);
  });

  const saveGroupName = (from: string, to: string) => run(async () => {
    if (to.trim() !== from) await api.renameGroup(from, to);
    setRenamingGroup(null);
  }, t('manage.toast.groupRenamed'));

  const removeGroup = (g: string) => run(() => api.renameGroup(g, ''), t('manage.toast.groupRemoved', { name: g }));

  const duplicate = (w: Workflow) => run(() => api.duplicateWorkflow(w.id), t('manage.toast.duplicated', { name: w.name }));

  return (
    <Modal title={t('manage.title')} icon={<span className="kind-tile kind-workflow"><LayoutList /></span>} onClose={onClose} wide
      footer={<><span className="muted small grow">{t('manage.count', { count: workflows.length })}</span><button className="btn ghost" onClick={onClose}>{t('common.close')}</button></>}>
      <div className="mgr-bar">
        <label className="search">
          <Search /><input id="mgr-search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('manage.search')} aria-label={t('manage.search')} />
          {query && <button className="icon-btn ghost" onClick={() => setQuery('')} aria-label={t('manage.clearSearch')}><X /></button>}
        </label>
        {sel.size > 0 ? (
          <div className="mgr-sel">
            <span className="small">{t('manage.selected', { count: sel.size })}</span>
            <button className="btn sm ghost" disabled={busy} onClick={() => setMoving([...sel])}><FolderInput />{t('manage.move')}</button>
            <button className="btn sm ghost danger" disabled={busy} onClick={() => setDeleting([...sel])}><Trash2 />{t('manage.delete')}</button>
            <button className="btn sm ghost" onClick={() => setSel(new Set())}>{t('manage.clearSelection')}</button>
          </div>
        ) : (
          <button className="btn sm ghost" disabled={!visibleIds.length} onClick={() => setSel(new Set(visibleIds))}><Check />{t('manage.selectAll')}</button>
        )}
      </div>

      {groups.length === 0 && <p className="muted pad">{t('manage.noResults')}</p>}
      <div className="mgr-list">
        {groups.map(([g, list]) => {
          const open = !collapsed.has(g) || Boolean(query);
          const allSel = list.every((w) => sel.has(w.id));
          return (
            <section key={g || '__none'} className="mgr-group">
              <header className="mgr-ghead">
                <input type="checkbox" checked={allSel} onChange={() => toggleGroup(list)} aria-label={t('manage.selectGroup')} />
                <button className="mgr-gtoggle" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; })} aria-expanded={open}>
                  {open ? <ChevronDown /> : <ChevronRight />}
                  {renamingGroup?.from === g ? null : <span className={g ? 'mgr-gname' : 'mgr-gname muted'}>{g || t('manage.ungrouped')}</span>}
                </button>
                {renamingGroup?.from === g && (
                  <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); void saveGroupName(g, renamingGroup.value); }}>
                    <input autoFocus value={renamingGroup.value} onChange={(e) => setRenamingGroup({ from: g, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenamingGroup(null); } }} aria-label={t('manage.groupName')} />
                    <button className="icon-btn ghost" type="submit" aria-label={t('common.save')}><Check /></button>
                  </form>
                )}
                <span className="count">{list.length}</span>
                <span className="grow" />
                {g && renamingGroup?.from !== g && (
                  <>
                    <button className="icon-btn ghost" title={t('manage.renameGroup')} aria-label={t('manage.renameGroup')} onClick={() => setRenamingGroup({ from: g, value: g })}><Pencil /></button>
                    <button className="icon-btn ghost" title={t('manage.removeGroup')} aria-label={t('manage.removeGroup')} onClick={() => removeGroup(g)}><FolderMinus /></button>
                  </>
                )}
              </header>
              {open && list.map((w) => (
                <div key={w.id} className={`mgr-row ${sel.has(w.id) ? 'sel' : ''} ${w.id === currentId ? 'current' : ''}`}>
                  <input type="checkbox" checked={sel.has(w.id)} onChange={() => toggle(w.id)} aria-label={t('manage.select', { name: w.name })} />
                  <div className="mgr-main">
                    {renaming?.id === w.id ? (
                      <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); void saveName(w, renaming.value); }}>
                        <input autoFocus value={renaming.value} onChange={(e) => setRenaming({ id: w.id, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }} aria-label={t('manage.name')} />
                        <button className="icon-btn ghost" type="submit" aria-label={t('common.save')}><Check /></button>
                      </form>
                    ) : (
                      <button className="mgr-name" onClick={() => onOpen(w.id)} title={t('manage.open')}>{w.name || t('common.untitled')}{w.id === currentId && <span className="tag tag-accent">{t('manage.current')}</span>}</button>
                    )}
                    <span className="mgr-meta">
                      {t('topbar.phases', { count: w.nodes.length })}
                      {w.settings.projectDir && <> · <FolderOpen className="ic-inline" />{folderName(w.settings.projectDir)}</>}
                      {' · '}{t('manage.runs', { count: runCount.get(w.id) ?? 0 })}
                      {' · '}{fmtTime(w.updatedAt)}
                    </span>
                  </div>
                  <div className="mgr-actions">
                    <button className="icon-btn ghost" title={t('manage.rename')} aria-label={t('manage.rename')} onClick={() => setRenaming({ id: w.id, value: w.name })}><Pencil /></button>
                    <button className="icon-btn ghost" title={t('manage.moveOne')} aria-label={t('manage.moveOne')} onClick={() => setMoving([w.id])}><FolderInput /></button>
                    <button className="icon-btn ghost" title={t('manage.duplicate')} aria-label={t('manage.duplicate')} disabled={busy} onClick={() => duplicate(w)}><Copy /></button>
                    <button className="icon-btn ghost danger" title={t('manage.delete')} aria-label={t('manage.delete')} onClick={() => setDeleting([w.id])}><Trash2 /></button>
                    <button className="btn sm soft" onClick={() => onOpen(w.id)}>{t('manage.open')}<ArrowRight /></button>
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>

      {moving && (
        <MoveDialog count={moving.length} groups={names} initial={moving.length === 1 ? groupOf(byId(moving[0])) : ''}
          onCancel={() => setMoving(null)}
          onConfirm={(group) => run(async () => {
            for (const id of moving) { const w = byId(id); if (groupOf(w) !== group) await api.saveWorkflow({ ...w, group: group || undefined }); }
            setMoving(null); setSel(new Set());
          }, group ? t('manage.toast.moved', { count: moving.length, group }) : t('manage.toast.ungrouped', { count: moving.length }))} />
      )}
      {deleting && (
        <DeleteDialog items={deleting.map(byId)} runs={deleting.reduce((s, id) => s + (runCount.get(id) ?? 0), 0)} busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={(withRuns) => run(async () => {
            for (const id of deleting) await api.deleteWorkflow(id, withRuns);
            setSel(new Set()); setDeleting(null);
          }, t('manage.toast.deleted', { count: deleting.length }), deleting)} />
      )}
    </Modal>
  );
}

function MoveDialog({ count, groups, initial, onCancel, onConfirm }: { count: number; groups: string[]; initial: string; onCancel: () => void; onConfirm: (group: string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  return (
    <Modal title={t('manage.moveTitle', { count })} icon={<span className="kind-tile kind-workflow"><FolderInput /></span>} onClose={onCancel}
      footer={<><span className="grow" /><button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button><button className="btn primary" onClick={() => onConfirm(value.trim())}>{t('manage.move')}</button></>}>
      <label className="field">
        <span className="field-label">{t('manage.group')}</span>
        <input id="move-group" autoFocus list="mgr-groups" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('manage.groupPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(value.trim()); }} />
        <datalist id="mgr-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        <span className="field-hint">{t('manage.groupHint')}</span>
      </label>
      {groups.length > 0 && (
        <div className="chips-row">
          {groups.map((g) => <button key={g} className={`chip ${value === g ? 'on' : ''}`} onClick={() => setValue(g)}>{g}</button>)}
          <button className={`chip ${value === '' ? 'on' : ''}`} onClick={() => setValue('')}>{t('manage.ungrouped')}</button>
        </div>
      )}
    </Modal>
  );
}

function DeleteDialog({ items, runs, busy, onCancel, onConfirm }: { items: Workflow[]; runs: number; busy: boolean; onCancel: () => void; onConfirm: (withRuns: boolean) => void }) {
  const { t } = useI18n();
  const [withRuns, setWithRuns] = useState(false);
  return (
    <Modal title={t('manage.deleteTitle', { count: items.length })} icon={<span className="kind-tile kind-danger"><Trash2 /></span>} onClose={onCancel}
      footer={<><span className="grow" /><button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button><button className="btn danger-solid" disabled={busy} onClick={() => onConfirm(withRuns)}><Trash2 />{t('manage.deleteConfirm', { count: items.length })}</button></>}>
      <p className="lead">{t('manage.deleteLead', { count: items.length })}</p>
      <ul className="del-list">{items.slice(0, 8).map((w) => <li key={w.id}>{w.name}</li>)}{items.length > 8 && <li className="muted">{t('manage.andMore', { count: items.length - 8 })}</li>}</ul>
      {runs > 0 && (
        <label className="check">
          <input type="checkbox" checked={withRuns} onChange={(e) => setWithRuns(e.target.checked)} />
          {t('manage.deleteRuns', { count: runs })}
        </label>
      )}
      <div className="callout tone-warn"><TriangleAlert /><span>{withRuns ? t('manage.deleteWarnRuns') : t('manage.deleteWarn')}</span></div>
    </Modal>
  );
}
