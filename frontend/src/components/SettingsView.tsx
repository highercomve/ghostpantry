import React, { useState, useEffect } from 'react';
import { AppSettings } from '../types';
import { invoke } from '../oriel';

interface SettingsViewProps {
  onSettingsSaved: () => void;
  onResetData: () => void;
}

const PROVIDER_PRESETS: {
  id: string;
  name: string;
  desc: string;
  baseUrl: string;
  defaultModel: string;
  requiresKey: boolean;
  helpLink?: string;
}[] = [
  {
    id: 'openai',
    name: 'OpenAI API (GPT-4o / GPT-4o-mini)',
    desc: 'Direct OpenAI developer API key with official multimodal models.',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
  },
  {
    id: 'chatgpt_plan',
    name: 'ChatGPT Plan Token Allowance (New OpenAI Feature)',
    desc: 'Use your ChatGPT Plus/Pro plan token allowance without pay-per-token API credit.',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
    helpLink: 'https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites',
  },
  {
    id: 'ollama_local',
    name: 'Local Ollama Vision (llama3.2-vision / qwen2.5-vl)',
    desc: 'Runs completely locally or offline on your machine with small vision models.',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2-vision',
    requiresKey: false,
  },
  {
    id: 'ollama_network',
    name: 'Local Network Ollama (LAN Server)',
    desc: 'Ollama running on a local home server or PC on the same Wi-Fi.',
    baseUrl: 'http://192.168.1.100:11434/v1',
    defaultModel: 'llama3.2-vision',
    requiresKey: false,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio / Local Vision Runner',
    desc: 'Local model served via LM Studio local server.',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    requiresKey: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter / Custom OpenAI-Compatible',
    desc: 'Use OpenRouter or any custom OpenAI-compatible multimodal endpoint.',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'qwen/qwen-2.5-vl-72b-instruct:free',
    requiresKey: true,
  },
];

export const SettingsView: React.FC<SettingsViewProps> = ({ onSettingsSaved, onResetData }) => {
  const [settings, setSettings] = useState<AppSettings>({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    defaultLocation: 'fridge',
  });

  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [appInfo, setAppInfo] = useState<{ zig: string; mode: string; dev: boolean } | null>(null);

  useEffect(() => {
    loadSettings();
    invoke('app_info').then((info) => setAppInfo(info as any)).catch(() => {});
  }, []);

  const loadSettings = async () => {
    try {
      const res = await invoke('get_settings');
      if (res) {
        setSettings({
          provider: res.provider || 'openai',
          baseUrl: res.baseUrl || 'https://api.openai.com/v1',
          apiKey: res.apiKey || '',
          model: res.model || 'gpt-4o-mini',
          defaultLocation: res.defaultLocation || 'fridge',
        });
      }
    } catch (err: any) {
      console.error('Failed to load settings:', err);
    }
  };

  const handleProviderChange = (presetId: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    setSettings((prev) => ({
      ...prev,
      provider: presetId,
      baseUrl: preset.baseUrl,
      model: preset.defaultModel,
    }));
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSaving(true);
    setSavedSuccess(false);

    try {
      await invoke('save_settings', { settings: settings as any });
      setSavedSuccess(true);
      onSettingsSaved();
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (err: any) {
      alert('Error saving settings: ' + (err?.message || err));
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    // Save first to ensure backend uses current input
    await invoke('save_settings', { settings: settings as any });

    // Send a 1x1 transparent png test image to verify connection
    const test1x1Png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    try {
      const res = await invoke('analyze_image', {
        location: 'Test Shelf',
        image: test1x1Png,
      });

      setTestResult({
        success: true,
        message: `Connection successful! Model "${settings.model}" responded. (${res.summary || 'Ready for scanning'})`,
      });
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'Connection failed.';
      setTestResult({
        success: false,
        message: `Connection failed: ${msg}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleResetSampleData = async () => {
    if (!confirm('Reset inventory database to sample items (Harina Pan, Milk, Eggs, etc.)?')) return;
    try {
      await invoke('reset_sample_data');
      onResetData();
      alert('Sample inventory loaded into SQLite!');
    } catch (err: any) {
      alert('Failed to reset sample data: ' + err);
    }
  };

  const activePreset = PROVIDER_PRESETS.find((p) => p.id === settings.provider);

  return (
    <div className="settings-page">
      <div className="view-header">
        <div>
          <h2>AI & Storage Settings</h2>
          <p className="text-muted">
            Configure your AI vision endpoint (OpenAI, ChatGPT Plan allowance token, or Local Ollama vision).
          </p>
        </div>
      </div>

      {savedSuccess && (
        <div className="alert alert-success">
          <span>✓ Settings saved successfully to SQLite database!</span>
        </div>
      )}

      {testResult && (
        <div className={`alert ${testResult.success ? 'alert-success' : 'alert-error'}`}>
          <div className="alert-content">
            <strong>{testResult.success ? '✓ Endpoint Connected' : '✕ Connection Error'}</strong>
            <p>{testResult.message}</p>
          </div>
          <button className="btn-close" onClick={() => setTestResult(null)}>✕</button>
        </div>
      )}

      <form onSubmit={handleSave} className="settings-form">
        {/* Provider Preset Picker */}
        <div className="settings-section">
          <h3>1. Choose AI Vision Provider</h3>
          <div className="provider-grid">
            {PROVIDER_PRESETS.map((p) => (
              <div
                key={p.id}
                className={`provider-card ${settings.provider === p.id ? 'active' : ''}`}
                onClick={() => handleProviderChange(p.id)}
              >
                <div className="provider-card-header">
                  <strong>{p.name}</strong>
                  {settings.provider === p.id && <span className="check-badge">✓ Selected</span>}
                </div>
                <p className="provider-desc">{p.desc}</p>
                {p.helpLink && (
                  <a
                    href={p.helpLink}
                    target="_blank"
                    rel="noreferrer"
                    className="provider-link"
                    onClick={(e) => e.stopPropagation()}
                  >
                    🔗 Learn about ChatGPT Plan token allowance
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Endpoint & Authentication */}
        <div className="settings-section">
          <h3>2. Endpoint & Authentication</h3>

          <div className="form-group">
            <label>API Base URL</label>
            <input
              type="text"
              required
              value={settings.baseUrl || ''}
              onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
            <small className="text-muted">
              Use <code>https://api.openai.com/v1</code> for OpenAI, or <code>http://localhost:11434/v1</code> for local Ollama.
            </small>
          </div>

          <div className="form-group">
            <label>API Key / Token Allowance</label>
            <div className="input-with-button">
              <input
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey || ''}
                onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                placeholder={
                  settings.provider?.includes('ollama')
                    ? 'Optional for local Ollama'
                    : 'Paste your OpenAI key or ChatGPT Plan token'
                }
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            {settings.provider === 'chatgpt_plan' && (
              <small className="help-box">
                💡 <strong>Using ChatGPT Plan Allowance:</strong> OpenAI now lets ChatGPT Plus and Pro subscribers use their plan token allowance in third-party applications. Generate your personal app token from your ChatGPT settings and paste it above!
              </small>
            )}
            {settings.provider === 'ollama_local' && (
              <small className="help-box info">
                💡 <strong>Local Vision Models:</strong> For free offline vision recognition, install Ollama and run:
                <br />
                <code>ollama run llama3.2-vision</code> or <code>ollama run qwen2.5-vl</code>
              </small>
            )}
          </div>

          <div className="form-group">
            <label>Model Name</label>
            <input
              type="text"
              required
              value={settings.model || ''}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              placeholder="gpt-4o-mini, llama3.2-vision, qwen2.5-vl"
            />
            <small className="text-muted">
              Recommended: <code>gpt-4o-mini</code> (OpenAI fast & accurate) or <code>llama3.2-vision</code> (local Ollama).
            </small>
          </div>
        </div>

        {/* Preferences */}
        <div className="settings-section">
          <h3>3. Defaults</h3>
          <div className="form-group">
            <label>Default Camera Target Area</label>
            <select
              value={settings.defaultLocation || 'fridge'}
              onChange={(e) => setSettings({ ...settings, defaultLocation: e.target.value })}
            >
              <option value="fridge">❄️ Fridge</option>
              <option value="pantry">🥫 Food Pantry</option>
              <option value="freezer">🧊 Freezer</option>
            </select>
          </div>
        </div>

        {/* Actions */}
        <div className="settings-actions-footer">
          <div className="left-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestConnection}
              disabled={testing || saving}
            >
              {testing ? (
                <>
                  <span className="spinner"></span>
                  Testing Model...
                </>
              ) : (
                '🔌 Test AI Connection'
              )}
            </button>

            <button
              type="button"
              className="btn btn-subtle"
              onClick={handleResetSampleData}
            >
              ↺ Reset Sample Items
            </button>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={saving}
          >
            {saving ? 'Saving...' : '💾 Save Settings'}
          </button>
        </div>
      </form>

      {/* App & Storage Info */}
      <div className="app-info-card">
        <h4>About GhostPantry</h4>
        <div className="info-grid">
          <div>
            <span className="info-label">Database:</span>
            <span className="info-value">SQLite (Built-in amalgamation via Oriel)</span>
          </div>
          <div>
            <span className="info-label">Target Platforms:</span>
            <span className="info-value">Desktop (Linux/macOS/Windows) & Android</span>
          </div>
          <div>
            <span className="info-label">Zig Version:</span>
            <span className="info-value">{appInfo?.zig || '0.16.0'}</span>
          </div>
          <div>
            <span className="info-label">Camera Access:</span>
            <span className="info-value">HTML5 MediaDevices + Android Camera Native</span>
          </div>
        </div>
      </div>
    </div>
  );
};
