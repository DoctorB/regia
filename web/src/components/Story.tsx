// User story collegata: campo con anteprima nelle impostazioni del workflow e riquadro nell'esecuzione.
import { useState } from 'react';
import { BookOpenText, ExternalLink, Loader2 } from 'lucide-react';
import type { UserStory } from '../../../shared/types.ts';
import { api, fmtTime } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Field } from '../ui.tsx';

const imageUrl = (s: UserStory, file: string) => `/api/stories/file?dir=${encodeURIComponent(s.dir)}&file=${encodeURIComponent(file)}`;

/** Contenuto della user story: intestazione con link, descrizione, criteri di accettazione, commenti e immagini. */
export function StoryView({ story, open = false }: { story: UserStory; open?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="story">
      <div className="story-head">
        <span className="tag">{story.type ?? (story.provider === 'github' ? 'Issue' : 'Work item')} {story.id}</span>
        <a href={story.url} target="_blank" rel="noreferrer" className="story-title">{story.title}<ExternalLink /></a>
        {story.state && <span className="muted small">{story.state}</span>}
      </div>
      {story.description && (
        <details className="story-sec" open={open}>
          <summary>{t('story.description')}</summary>
          <p className="pre">{story.description}</p>
        </details>
      )}
      {story.acceptance && (
        <details className="story-sec" open>
          <summary>{t('story.acceptance')}</summary>
          <p className="pre">{story.acceptance}</p>
        </details>
      )}
      {story.comments?.length ? (
        <details className="story-sec">
          <summary>{t('story.comments', { count: story.comments.length })}</summary>
          <ul className="uat-list">{story.comments.map((c, i) => <li key={i}><strong>{c.author ?? '?'}</strong>{c.at ? ` · ${fmtTime(c.at)}` : ''}: {c.text}</li>)}</ul>
        </details>
      ) : null}
      {story.images.length > 0 && (
        <div className="uat-shots story-shots">
          {story.images.map((i) => (
            <a key={i.file} href={imageUrl(story, i.file)} target="_blank" rel="noreferrer" title={`[${t('story.image')} ${i.n}] ${i.name}`}>
              <img src={imageUrl(story, i.file)} alt={i.name} loading="lazy" />
              <span>{i.n}. {i.name}</span>
            </a>
          ))}
        </div>
      )}
      <p className="muted small">
        {t('story.fetched', { date: fmtTime(story.fetchedAt), count: story.images.length })}
        {story.imagesFound > story.images.length ? ` ${t('story.imagesSkipped', { count: story.imagesFound - story.images.length })}` : ''}
      </p>
    </div>
  );
}

/** Campo delle impostazioni: URL e pulsante Leggi, con l'anteprima di ciò che arriverà agli agenti. */
export function StoryField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [story, setStory] = useState<UserStory | null>(null);
  const [err, setErr] = useState('');
  const read = async () => {
    setBusy(true);
    setErr('');
    setStory(null);
    try { setStory(await api.previewStory(value.trim())); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Field label={t('story.label')} hint={t('story.hint')}>
      <div className="story-field">
        <div className="extra-dir-row">
          <input value={value} onChange={(e) => { onChange(e.target.value); setStory(null); setErr(''); }} placeholder={t('story.placeholder')} />
          <button className="btn sm" disabled={busy || !value.trim()} onClick={() => void read()}>{busy ? <Loader2 className="spin" /> : <BookOpenText />}{t(busy ? 'story.reading' : 'story.read')}</button>
        </div>
        {busy && <p className="muted small">{t('story.readingHint')}</p>}
        {err && <div className="callout tone-warn"><span>{err}</span></div>}
        {story && <StoryView story={story} />}
      </div>
    </Field>
  );
}
