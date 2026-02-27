import { ModelType, type AppMode } from '../../../types';

export interface ModelOption {
  value: ModelType;
  label: string;
}

export type OpenRouterChatterTier = 'standard' | 'premium';

export const GEMINI_MODEL_OPTIONS: ModelOption[] = [
  { value: ModelType.FLASH_3, label: 'Gemini 3 Flash (Balanced)' },
  { value: ModelType.FLASH, label: 'Gemini 2.5 Flash (Fast)' },
  { value: ModelType.PRO, label: 'Gemini 3 Pro (Deep)' },
];

export const OPENROUTER_CHATTER_TIER_OPTIONS: Array<{
  value: OpenRouterChatterTier;
  label: string;
}> = [
  { value: 'standard', label: 'Standard' },
  { value: 'premium', label: 'Premium' },
];

export const OPENROUTER_CHATTER_STANDARD_MODEL_OPTIONS: ModelOption[] = [
  { value: ModelType.OPENROUTER_DEEPSEEK_V32, label: 'DeepSeek V3.2 (OpenRouter)' },
  { value: ModelType.OPENROUTER_MINIMAX_M21, label: 'MiniMax M2.1 (OpenRouter)' },
];

export const OPENROUTER_CHATTER_PREMIUM_MODEL_OPTIONS: ModelOption[] = [
  { value: ModelType.OPENROUTER_CLAUDE_SONNET_4, label: 'Claude Sonnet 4 (OpenRouter)' },
  { value: ModelType.OPENROUTER_GPT_41_MINI, label: 'GPT 4.1 Mini (OpenRouter)' },
];

export const OPENROUTER_CHATTER_MODEL_OPTIONS: ModelOption[] = [
  ...OPENROUTER_CHATTER_STANDARD_MODEL_OPTIONS,
  ...OPENROUTER_CHATTER_PREMIUM_MODEL_OPTIONS,
];

export const OPENROUTER_POINTS_MODEL_OPTIONS: ModelOption[] = [
  { value: ModelType.OPENROUTER_QWEN25_VL_32B, label: 'Qwen2.5 VL 32B (OpenRouter)' },
  { value: ModelType.OPENROUTER_MINIMAX, label: 'MiniMax-01 (OpenRouter)' },
];

export const OPENROUTER_PLOTLINE_MODEL_OPTIONS: ModelOption[] = [
  { value: ModelType.OPENROUTER_MINIMAX_M25, label: 'MiniMax M2.5 (OpenRouter)' },
  { value: ModelType.OPENROUTER_MISTRAL_LARGE_2512, label: 'Mistral Large 2512 (OpenRouter)' },
];

export const OPENROUTER_CHATTER_MODEL_VALUES = new Set<ModelType>(
  OPENROUTER_CHATTER_MODEL_OPTIONS.map((option) => option.value),
);
export const OPENROUTER_CHATTER_STANDARD_MODEL_VALUES = new Set<ModelType>(
  OPENROUTER_CHATTER_STANDARD_MODEL_OPTIONS.map((option) => option.value),
);
export const OPENROUTER_CHATTER_PREMIUM_MODEL_VALUES = new Set<ModelType>(
  OPENROUTER_CHATTER_PREMIUM_MODEL_OPTIONS.map((option) => option.value),
);

export const OPENROUTER_POINTS_MODEL_VALUES = new Set<ModelType>(
  OPENROUTER_POINTS_MODEL_OPTIONS.map((option) => option.value),
);

export const OPENROUTER_PLOTLINE_MODEL_VALUES = new Set<ModelType>(
  OPENROUTER_PLOTLINE_MODEL_OPTIONS.map((option) => option.value),
);

export const OPENROUTER_CHATTER_DEFAULT_TIER: OpenRouterChatterTier = 'standard';
export const OPENROUTER_CHATTER_STANDARD_DEFAULT_MODEL = ModelType.OPENROUTER_DEEPSEEK_V32;
export const OPENROUTER_CHATTER_PREMIUM_DEFAULT_MODEL = ModelType.OPENROUTER_CLAUDE_SONNET_4;
export const OPENROUTER_CHATTER_DEFAULT_MODEL = OPENROUTER_CHATTER_STANDARD_DEFAULT_MODEL;
export const OPENROUTER_POINTS_DEFAULT_MODEL = ModelType.OPENROUTER_QWEN25_VL_32B;
export const OPENROUTER_PLOTLINE_DEFAULT_MODEL = ModelType.OPENROUTER_MINIMAX_M25;

const OPENROUTER_OPTIONS_BY_MODE: Record<Exclude<AppMode, 'chatter'>, ModelOption[]> = {
  points: OPENROUTER_POINTS_MODEL_OPTIONS,
  plotline: OPENROUTER_PLOTLINE_MODEL_OPTIONS,
};

export const isOpenRouterChatterModelInTier = (
  model: ModelType,
  tier: OpenRouterChatterTier,
): boolean =>
  tier === 'premium'
    ? OPENROUTER_CHATTER_PREMIUM_MODEL_VALUES.has(model)
    : OPENROUTER_CHATTER_STANDARD_MODEL_VALUES.has(model);

export const getDefaultOpenRouterChatterModelForTier = (
  tier: OpenRouterChatterTier,
): ModelType => (tier === 'premium' ? OPENROUTER_CHATTER_PREMIUM_DEFAULT_MODEL : OPENROUTER_CHATTER_STANDARD_DEFAULT_MODEL);

export const inferOpenRouterChatterTierForModel = (model: ModelType): OpenRouterChatterTier =>
  OPENROUTER_CHATTER_PREMIUM_MODEL_VALUES.has(model) ? 'premium' : 'standard';

export const getOpenRouterModelOptions = (
  mode: AppMode,
  chatterTier: OpenRouterChatterTier = OPENROUTER_CHATTER_DEFAULT_TIER,
): ModelOption[] => {
  if (mode === 'chatter') {
    return chatterTier === 'premium'
      ? OPENROUTER_CHATTER_PREMIUM_MODEL_OPTIONS
      : OPENROUTER_CHATTER_STANDARD_MODEL_OPTIONS;
  }
  return OPENROUTER_OPTIONS_BY_MODE[mode];
};
