import { ModelType, type AppMode } from '../../../types';

export interface ModelOption {
  value: ModelType;
  label: string;
}

export const GEMINI_MODEL_OPTIONS: ModelOption[] = [
  { value: ModelType.FLASH_3, label: 'Gemini 3 Flash (Balanced)' },
  { value: ModelType.FLASH, label: 'Gemini 2.5 Flash (Fast)' },
  { value: ModelType.PRO, label: 'Gemini 3 Pro (Deep)' },
];

export const OPENROUTER_CHATTER_MODEL_OPTIONS: ModelOption[] = [
  { value: ModelType.OPENROUTER_DEEPSEEK_V32, label: 'DeepSeek V3.2 (OpenRouter)' },
  { value: ModelType.OPENROUTER_MINIMAX_M21, label: 'MiniMax M2.1 (OpenRouter)' },
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

export const OPENROUTER_POINTS_MODEL_VALUES = new Set<ModelType>(
  OPENROUTER_POINTS_MODEL_OPTIONS.map((option) => option.value),
);

export const OPENROUTER_PLOTLINE_MODEL_VALUES = new Set<ModelType>(
  OPENROUTER_PLOTLINE_MODEL_OPTIONS.map((option) => option.value),
);

export const OPENROUTER_CHATTER_DEFAULT_MODEL = ModelType.OPENROUTER_DEEPSEEK_V32;
export const OPENROUTER_POINTS_DEFAULT_MODEL = ModelType.OPENROUTER_QWEN25_VL_32B;
export const OPENROUTER_PLOTLINE_DEFAULT_MODEL = ModelType.OPENROUTER_MINIMAX_M25;

const OPENROUTER_OPTIONS_BY_MODE: Record<AppMode, ModelOption[]> = {
  chatter: OPENROUTER_CHATTER_MODEL_OPTIONS,
  points: OPENROUTER_POINTS_MODEL_OPTIONS,
  plotline: OPENROUTER_PLOTLINE_MODEL_OPTIONS,
};

export const getOpenRouterModelOptions = (mode: AppMode): ModelOption[] => OPENROUTER_OPTIONS_BY_MODE[mode];
