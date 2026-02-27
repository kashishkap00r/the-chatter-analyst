import { describe, expect, it } from 'vitest';
import { ModelType } from '../../../types';
import {
  getDefaultOpenRouterChatterModelForTier,
  getOpenRouterModelOptions,
  inferOpenRouterChatterTierForModel,
  isOpenRouterChatterModelInTier,
} from './modelOptions';

describe('modelOptions chatter tiers', () => {
  it('returns only standard models for standard tier', () => {
    const options = getOpenRouterModelOptions('chatter', 'standard').map((item) => item.value);
    expect(options).toEqual([
      ModelType.OPENROUTER_DEEPSEEK_V32,
      ModelType.OPENROUTER_MINIMAX_M21,
    ]);
  });

  it('returns only premium models for premium tier', () => {
    const options = getOpenRouterModelOptions('chatter', 'premium').map((item) => item.value);
    expect(options).toEqual([
      ModelType.OPENROUTER_CLAUDE_SONNET_4,
      ModelType.OPENROUTER_GPT_41_MINI,
    ]);
  });

  it('infers tier and validates model membership correctly', () => {
    expect(inferOpenRouterChatterTierForModel(ModelType.OPENROUTER_CLAUDE_SONNET_4)).toBe('premium');
    expect(inferOpenRouterChatterTierForModel(ModelType.OPENROUTER_DEEPSEEK_V32)).toBe('standard');

    expect(isOpenRouterChatterModelInTier(ModelType.OPENROUTER_CLAUDE_SONNET_4, 'premium')).toBe(true);
    expect(isOpenRouterChatterModelInTier(ModelType.OPENROUTER_CLAUDE_SONNET_4, 'standard')).toBe(false);
  });

  it('returns tier-specific defaults', () => {
    expect(getDefaultOpenRouterChatterModelForTier('standard')).toBe(ModelType.OPENROUTER_DEEPSEEK_V32);
    expect(getDefaultOpenRouterChatterModelForTier('premium')).toBe(ModelType.OPENROUTER_CLAUDE_SONNET_4);
  });
});
