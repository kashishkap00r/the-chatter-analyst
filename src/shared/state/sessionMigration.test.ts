import { describe, expect, it } from 'vitest';
import { ModelType, ProviderType } from '../../../types';
import { migratePersistedSessionSnapshot } from './sessionMigration';

describe('sessionMigration openrouter chatter tier migration', () => {
  const baseSnapshot = {
    schemaVersion: 2,
    savedAt: Date.now(),
    appMode: 'chatter',
    provider: ProviderType.OPENROUTER,
    chatter: {
      inputMode: 'file',
      textInput: '',
      batchFiles: [],
      chatterSingleState: { status: 'idle' },
    },
    points: { batchFiles: [] },
    plotline: { batchFiles: [], keywords: [], summary: null },
  } as const;

  it('infers premium tier from premium chatter model when tier is missing', () => {
    const migrated = migratePersistedSessionSnapshot({
      ...baseSnapshot,
      models: {
        geminiModel: ModelType.FLASH_3,
        openRouterModel: ModelType.OPENROUTER_CLAUDE_SONNET_4,
        geminiPointsModel: ModelType.FLASH_3,
        openRouterPointsModel: ModelType.OPENROUTER_QWEN25_VL_32B,
        geminiPlotlineModel: ModelType.FLASH_3,
        openRouterPlotlineModel: ModelType.OPENROUTER_MINIMAX_M25,
      },
    });

    expect(migrated).not.toBeNull();
    expect(migrated?.models.openRouterChatterTier).toBe('premium');
    expect(migrated?.models.openRouterModel).toBe(ModelType.OPENROUTER_CLAUDE_SONNET_4);
  });

  it('normalizes incompatible tier/model pair to tier default', () => {
    const migrated = migratePersistedSessionSnapshot({
      ...baseSnapshot,
      models: {
        geminiModel: ModelType.FLASH_3,
        openRouterChatterTier: 'standard',
        openRouterModel: ModelType.OPENROUTER_CLAUDE_SONNET_4,
        geminiPointsModel: ModelType.FLASH_3,
        openRouterPointsModel: ModelType.OPENROUTER_QWEN25_VL_32B,
        geminiPlotlineModel: ModelType.FLASH_3,
        openRouterPlotlineModel: ModelType.OPENROUTER_MINIMAX_M25,
      },
    });

    expect(migrated).not.toBeNull();
    expect(migrated?.models.openRouterChatterTier).toBe('standard');
    expect(migrated?.models.openRouterModel).toBe(ModelType.OPENROUTER_DEEPSEEK_V32);
  });
});
