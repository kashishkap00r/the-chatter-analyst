import React, { useCallback, useEffect, useState } from 'react';
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from './services/sessionStore';
import { ModelType, ProviderType, type AppMode } from './types';
import {
  ChatterWorkspace,
  useChatterFeature,
} from './src/features/chatter/chatterFeature';
import {
  PointsWorkspace,
  usePointsFeature,
} from './src/features/points/pointsFeature';
import {
  PlotlineWorkspace,
  usePlotlineFeature,
} from './src/features/plotline/plotlineFeature';
import {
  GEMINI_MODEL_OPTIONS,
  OPENROUTER_CHATTER_DEFAULT_MODEL,
  OPENROUTER_PLOTLINE_DEFAULT_MODEL,
  OPENROUTER_POINTS_DEFAULT_MODEL,
  getOpenRouterModelOptions,
} from './src/shared/config/modelOptions';
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  migratePersistedSessionSnapshot,
} from './src/shared/state/sessionMigration';
import type { PersistedAppSessionV2 } from './src/shared/state/sessionTypes';

const formatSavedTimestamp = (timestamp: number): string => {
  if (!Number.isFinite(timestamp)) return 'a previous session';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return 'a previous session';
  }
};

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>('chatter');
  const [provider, setProvider] = useState<ProviderType>(ProviderType.GEMINI);

  const [geminiModel, setGeminiModel] = useState<ModelType>(ModelType.FLASH_3);
  const [openRouterModel, setOpenRouterModel] = useState<ModelType>(OPENROUTER_CHATTER_DEFAULT_MODEL);
  const [geminiPointsModel, setGeminiPointsModel] = useState<ModelType>(ModelType.FLASH_3);
  const [openRouterPointsModel, setOpenRouterPointsModel] = useState<ModelType>(OPENROUTER_POINTS_DEFAULT_MODEL);
  const [geminiPlotlineModel, setGeminiPlotlineModel] = useState<ModelType>(ModelType.FLASH_3);
  const [openRouterPlotlineModel, setOpenRouterPlotlineModel] = useState<ModelType>(OPENROUTER_PLOTLINE_DEFAULT_MODEL);

  const [pendingResumeSession, setPendingResumeSession] = useState<PersistedAppSessionV2 | null>(null);
  const [isPersistenceReady, setIsPersistenceReady] = useState(false);
  const [isPersistenceBlocked, setIsPersistenceBlocked] = useState(false);
  const [sessionNotice, setSessionNotice] = useState('');
  const [persistenceNotice, setPersistenceNotice] = useState('');

  const selectedChatterModel = provider === ProviderType.GEMINI ? geminiModel : openRouterModel;
  const selectedPointsModel = provider === ProviderType.GEMINI ? geminiPointsModel : openRouterPointsModel;
  const selectedPlotlineModel = provider === ProviderType.GEMINI ? geminiPlotlineModel : openRouterPlotlineModel;

  const chatterFeature = useChatterFeature({
    provider,
    selectedModel: selectedChatterModel,
  });
  const pointsFeature = usePointsFeature({
    provider,
    selectedModel: selectedPointsModel,
  });
  const plotlineFeature = usePlotlineFeature({
    provider,
    selectedModel: selectedPlotlineModel,
  });

  const currentOpenRouterModelOptions = getOpenRouterModelOptions(appMode);
  const currentModelOptions = provider === ProviderType.GEMINI ? GEMINI_MODEL_OPTIONS : currentOpenRouterModelOptions;

  const applyPersistedSession = useCallback(
    (snapshot: PersistedAppSessionV2) => {
      setAppMode(snapshot.appMode);
      setProvider(snapshot.provider);
      setGeminiModel(snapshot.models.geminiModel);
      setOpenRouterModel(snapshot.models.openRouterModel);
      setGeminiPointsModel(snapshot.models.geminiPointsModel);
      setOpenRouterPointsModel(snapshot.models.openRouterPointsModel);
      setGeminiPlotlineModel(snapshot.models.geminiPlotlineModel);
      setOpenRouterPlotlineModel(snapshot.models.openRouterPlotlineModel);

      chatterFeature.restoreFromSessionSlice(snapshot.chatter);
      pointsFeature.restoreFromSessionSlice(snapshot.points);
      plotlineFeature.restoreFromSessionSlice(snapshot.plotline);
    },
    [
      chatterFeature,
      plotlineFeature,
      pointsFeature,
    ],
  );

  const handleResumeSavedSession = useCallback(() => {
    if (!pendingResumeSession) return;
    applyPersistedSession(pendingResumeSession);
    setPendingResumeSession(null);
    setIsPersistenceReady(true);
    setIsPersistenceBlocked(false);
    setSessionNotice(`Resumed session from ${formatSavedTimestamp(pendingResumeSession.savedAt)}.`);
  }, [applyPersistedSession, pendingResumeSession]);

  const handleDiscardSavedSession = useCallback(async () => {
    await clearPersistedSession();
    setPendingResumeSession(null);
    setIsPersistenceReady(true);
    setIsPersistenceBlocked(false);
    setSessionNotice('Discarded previous browser session.');
  }, []);

  const handleClearSavedSessionData = useCallback(async () => {
    await clearPersistedSession();
    setPendingResumeSession(null);
    setIsPersistenceBlocked(false);
    setPersistenceNotice('');
    if (!isPersistenceReady) {
      setIsPersistenceReady(true);
    }
    setSessionNotice('Cleared saved browser session data.');
  }, [isPersistenceReady]);

  useEffect(() => {
    let cancelled = false;

    const initializeSession = async () => {
      const rawSnapshot = await loadPersistedSession<unknown>();
      if (cancelled) return;

      const migratedSnapshot = migratePersistedSessionSnapshot(rawSnapshot);
      if (migratedSnapshot) {
        setPendingResumeSession(migratedSnapshot);
        setSessionNotice('');
        return;
      }

      setIsPersistenceReady(true);
    };

    initializeSession().catch(() => {
      if (!cancelled) {
        setIsPersistenceReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isPersistenceReady || isPersistenceBlocked) return;

    const payload: PersistedAppSessionV2 = {
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      savedAt: Date.now(),
      appMode,
      provider,
      models: {
        geminiModel,
        openRouterModel,
        geminiPointsModel,
        openRouterPointsModel,
        geminiPlotlineModel,
        openRouterPlotlineModel,
      },
      chatter: chatterFeature.sessionSlice,
      points: pointsFeature.sessionSlice,
      plotline: plotlineFeature.sessionSlice,
    };

    const timer = window.setTimeout(async () => {
      const status = await savePersistedSession(payload);
      if (status === 'quota_exceeded') {
        setIsPersistenceBlocked(true);
        setPersistenceNotice('Browser storage is full. Clear saved session data to resume autosave.');
        return;
      }
      if (status === 'unsupported') {
        setPersistenceNotice('Session resume is not supported in this browser.');
        return;
      }
      if (status === 'error') {
        setPersistenceNotice('Unable to save browser session right now.');
        return;
      }

      if (status === 'ok' && !isPersistenceBlocked) {
        setPersistenceNotice('');
      }
    }, 650);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    appMode,
    provider,
    geminiModel,
    openRouterModel,
    geminiPointsModel,
    openRouterPointsModel,
    geminiPlotlineModel,
    openRouterPlotlineModel,
    chatterFeature.sessionSlice,
    pointsFeature.sessionSlice,
    plotlineFeature.sessionSlice,
    isPersistenceReady,
    isPersistenceBlocked,
  ]);

  const isResumePromptVisible = Boolean(pendingResumeSession);
  const isResumeDecisionPending = isResumePromptVisible && !isPersistenceReady;

  return (
    <div className="app-shell min-h-screen text-ink relative overflow-x-hidden">
      <div className="app-atmosphere" />

      <header className="app-header sticky top-0 z-20 border-b border-line">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="brand-mark h-10 w-10 rounded-xl text-white font-serif font-bold text-xl grid place-items-center">C</div>
                <div>
                  <h1 className="font-serif text-2xl leading-none">Chatter Analyst</h1>
                  <p className="text-xs uppercase tracking-[0.15em] text-stone mt-1">Research Workflow Studio</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3">
                <label className="control-label">
                  Provider
                  <select
                    value={provider}
                    onChange={(event) => setProvider(event.target.value as ProviderType)}
                    disabled={isResumeDecisionPending}
                    className="control-select"
                  >
                    <option value={ProviderType.GEMINI}>Gemini</option>
                    <option value={ProviderType.OPENROUTER}>OpenRouter</option>
                  </select>
                </label>

                <label className="control-label">
                  Model
                  <select
                    value={
                      appMode === 'chatter'
                        ? selectedChatterModel
                        : appMode === 'points'
                          ? selectedPointsModel
                          : selectedPlotlineModel
                    }
                    disabled={isResumeDecisionPending}
                    onChange={(event) => {
                      const selectedModel = event.target.value as ModelType;
                      if (provider === ProviderType.GEMINI) {
                        if (appMode === 'chatter') {
                          setGeminiModel(selectedModel);
                        } else if (appMode === 'points') {
                          setGeminiPointsModel(selectedModel);
                        } else {
                          setGeminiPlotlineModel(selectedModel);
                        }
                      } else {
                        if (appMode === 'chatter') {
                          setOpenRouterModel(selectedModel);
                        } else if (appMode === 'points') {
                          setOpenRouterPointsModel(selectedModel);
                        } else {
                          setOpenRouterPlotlineModel(selectedModel);
                        }
                      }
                    }}
                    className="control-select"
                  >
                    {currentModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  onClick={() => {
                    void handleClearSavedSessionData();
                  }}
                  className="ghost-btn px-3 py-1.5 text-sm font-semibold"
                  title="Clear saved browser session"
                >
                  Clear Saved Session
                </button>
              </div>
            </div>

            <div className="mode-tabs inline-flex rounded-xl border border-line p-1 max-w-2xl w-full">
              <button
                onClick={() => {
                  setAppMode('chatter');
                }}
                disabled={isResumeDecisionPending}
                className={`mode-tab-btn flex-1 transition ${
                  appMode === 'chatter' ? 'mode-tab-active' : 'mode-tab-idle'
                } disabled:opacity-50`}
              >
                The Chatter
              </button>
              <button
                onClick={() => {
                  setAppMode('points');
                }}
                disabled={isResumeDecisionPending}
                className={`mode-tab-btn flex-1 transition ${
                  appMode === 'points' ? 'mode-tab-active' : 'mode-tab-idle'
                } disabled:opacity-50`}
              >
                Points & Figures
              </button>
              <button
                onClick={() => {
                  setAppMode('plotline');
                }}
                disabled={isResumeDecisionPending}
                className={`mode-tab-btn flex-1 transition ${
                  appMode === 'plotline' ? 'mode-tab-active' : 'mode-tab-idle'
                } disabled:opacity-50`}
              >
                Plotline
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="app-main relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isResumePromptVisible && pendingResumeSession && (
          <div className="mb-5 rounded-2xl border border-brand/35 bg-brand-soft px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-ink">Previous session found</p>
              <p className="text-sm text-stone mt-1">
                Resume work from {formatSavedTimestamp(pendingResumeSession.savedAt)}.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleResumeSavedSession}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90"
              >
                Resume
              </button>
              <button
                onClick={() => {
                  void handleDiscardSavedSession();
                }}
                className="rounded-lg border border-line bg-white px-4 py-2 text-sm font-semibold text-stone hover:text-ink"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {sessionNotice && (
          <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {sessionNotice}
          </div>
        )}

        {persistenceNotice && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {persistenceNotice}
          </div>
        )}

        <div className="workspace-grid grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {appMode === 'chatter' ? (
            <ChatterWorkspace
              feature={chatterFeature}
              provider={provider}
              selectedModel={selectedChatterModel}
              disabled={isResumeDecisionPending}
            />
          ) : appMode === 'points' ? (
            <PointsWorkspace
              feature={pointsFeature}
              disabled={isResumeDecisionPending}
            />
          ) : (
            <PlotlineWorkspace
              feature={plotlineFeature}
              disabled={isResumeDecisionPending}
            />
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
