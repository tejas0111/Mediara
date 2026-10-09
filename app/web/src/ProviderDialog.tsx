/* Custom provider popup — single home for the ddProvider config form.
   The ddProvider localStorage store (api.ts) stays the single source of
   truth; saves/clears dispatch the ddprovider event the composer listens
   for. Opened from the composer "Custom provider…" entry and from the
   Account page Custom model section. */

import { useEffect, useState } from 'react';
import {
  CustomProvider,
  getProvider,
  saveModel,
  saveProvider,
} from './api';
import { Button, Dialog, TextInput } from './ui';

export default function ProviderDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [provKind, setProvKind] = useState<'openai' | 'anthropic'>('openai');
  const [provBase, setProvBase] = useState('');
  const [provKey, setProvKey] = useState('');
  const [provModel, setProvModel] = useState('');
  const [provNote, setProvNote] = useState('');
  const [provHas, setProvHas] = useState(false);

  const loadProviderForm = () => {
    const p = getProvider();
    setProvKind(p?.kind ?? 'openai');
    setProvBase(p?.baseUrl ?? '');
    setProvKey(p?.apiKey ?? '');
    setProvModel(p?.model ?? '');
    setProvHas(!!p);
    setProvNote('');
  };

  useEffect(() => {
    if (open) loadProviderForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const saveProviderForm = () => {
    const baseUrl = provBase.trim();
    const model = provModel.trim();
    if (!baseUrl || !provKey || !model) {
      setProvNote('Base URL, API key, and model are all required.');
      return;
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      setProvNote('Base URL must start with http:// or https://.');
      return;
    }
    const p: CustomProvider = {
      kind: provKind,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: provKey,
      model,
    };
    saveProvider(p);
    saveModel(model);
    setProvHas(true);
    setProvNote('Saved — your custom model is selected in the composer.');
  };

  const clearProviderForm = () => {
    saveProvider(null);
    setProvBase('');
    setProvKey('');
    setProvModel('');
    setProvHas(false);
    setProvNote('Custom model removed — chats use the default again.');
  };

  return (
    <Dialog open={open} onClose={onClose} title="Custom provider">
      <div className="prov-sec">
        <span className="row-label">Custom model</span>
        <div className="seg" role="group" aria-label="Provider kind">
          <button
            type="button"
            className={`seg-btn ${provKind === 'openai' ? 'on' : ''}`}
            aria-pressed={provKind === 'openai'}
            onClick={() => setProvKind('openai')}
          >
            OpenAI-compatible
          </button>
          <button
            type="button"
            className={`seg-btn ${provKind === 'anthropic' ? 'on' : ''}`}
            aria-pressed={provKind === 'anthropic'}
            onClick={() => setProvKind('anthropic')}
          >
            Anthropic-compatible
          </button>
        </div>
        <TextInput
          value={provBase}
          onChange={(e) => setProvBase(e.target.value)}
          aria-label="Base URL"
          placeholder="Base URL — https://…"
          inputMode="url"
        />
        <input
          type="password"
          className="input"
          value={provKey}
          onChange={(e) => setProvKey(e.target.value)}
          aria-label="API key"
          placeholder="API key"
          autoComplete="off"
        />
        <TextInput
          value={provModel}
          onChange={(e) => setProvModel(e.target.value)}
          aria-label="Model"
          placeholder="Model — e.g. gpt-4o-mini"
        />
        <p className="dlg-note">
          Your key stays in this browser, is sent to this server only, and is
          never stored server-side.
          {provHas && ' A custom model is currently saved.'}
        </p>
        {provNote && (
          <p className="dlg-note" role="status">
            {provNote}
          </p>
        )}
        <div className="row-actions">
          <Button variant="primary" onClick={saveProviderForm}>
            Save
          </Button>
          {provHas && <Button onClick={clearProviderForm}>Clear</Button>}
        </div>
      </div>
    </Dialog>
  );
}
