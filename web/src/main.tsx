import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App.tsx';
import { I18nProvider } from './i18n.tsx';
import { applyTheme, readTheme } from './ui.tsx';
import { captureUiErrors } from './components/Reports.tsx';

// Tema scelto applicato prima del primo disegno, per evitare il lampo del tema sbagliato.
applyTheme(readTheme());
// Errori dell'interfaccia: Regia li invia solo se la persona ha dato il consenso alle segnalazioni.
captureUiErrors();

createRoot(document.getElementById('root')!).render(<I18nProvider><App /></I18nProvider>);
