import type { ThreadQuoteCandidate } from "../types";

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 675;
const MAX_QUOTE_FONT = 48;
const MIN_QUOTE_FONT = 26;

const BRAND_BLUE = "#387ED1";
const BRAND_DARK = "#424242";
const BRAND_YELLOW = "#FFA412";
const CANVAS_WHITE = "#FFFFFF";
const SOFT_BG = "#F5F7FB";
const STROKE = "#D5DDEB";
const MUTED_TEXT = "#5B6472";

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle?: string,
  strokeStyle?: string,
) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();

  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }

  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
};

const wrapText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const candidate = `${currentLine} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  lines.push(currentLine);
  return lines;
};

const fitQuoteLayout = (
  ctx: CanvasRenderingContext2D,
  quoteText: string,
  maxWidth: number,
  maxHeight: number,
): { fontSize: number; lineHeight: number; lines: string[] } => {
  for (let size = MAX_QUOTE_FONT; size >= MIN_QUOTE_FONT; size--) {
    ctx.font = `700 ${size}px Inter, Manrope, sans-serif`;
    const lines = wrapText(ctx, quoteText, maxWidth);
    const lineHeight = Math.round(size * 1.32);
    if (lines.length * lineHeight <= maxHeight) {
      return {
        fontSize: size,
        lineHeight,
        lines,
      };
    }
  }

  ctx.font = `700 ${MIN_QUOTE_FONT}px Inter, Manrope, sans-serif`;
  const lines = wrapText(ctx, quoteText, maxWidth);
  const lineHeight = Math.round(MIN_QUOTE_FONT * 1.32);

  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
  const clippedLines = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    const lastIndex = clippedLines.length - 1;
    clippedLines[lastIndex] = `${clippedLines[lastIndex].replace(/[.,;:!?]+$/, "")}…`;
  }

  return {
    fontSize: MIN_QUOTE_FONT,
    lineHeight,
    lines: clippedLines,
  };
};

const sanitizeFileName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "thread-card";

export const buildThreadQuoteImage = (quote: ThreadQuoteCandidate): string => {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to initialize canvas context for thread card image.");
  }

  context.fillStyle = CANVAS_WHITE;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  drawRoundedRect(context, 28, 28, CARD_WIDTH - 56, CARD_HEIGHT - 56, 24, CANVAS_WHITE, STROKE);
  drawRoundedRect(context, 28, 28, CARD_WIDTH - 56, 14, 7, BRAND_BLUE);

  drawRoundedRect(context, 66, 92, 210, 42, 12, BRAND_BLUE);
  context.fillStyle = CANVAS_WHITE;
  context.font = "700 20px Inter, Manrope, sans-serif";
  context.textBaseline = "middle";
  context.fillText("The Chatter", 92, 113);

  context.fillStyle = BRAND_DARK;
  context.font = "700 30px Inter, Manrope, sans-serif";
  context.textBaseline = "alphabetic";
  const companyLine = `${quote.companyName} | ${quote.marketCapCategory}`;
  context.fillText(companyLine, 66, 188);

  context.fillStyle = MUTED_TEXT;
  context.font = "500 20px Inter, Manrope, sans-serif";
  context.fillText(quote.industry, 66, 220);

  drawRoundedRect(context, 66, 246, CARD_WIDTH - 132, 310, 18, SOFT_BG);

  const renderedQuote = `"${quote.quote}"`;
  const quoteBoxWidth = CARD_WIDTH - 188;
  const quoteBoxHeight = 228;
  const quoteLayout = fitQuoteLayout(context, renderedQuote, quoteBoxWidth, quoteBoxHeight);
  context.fillStyle = BRAND_DARK;
  context.font = `700 ${quoteLayout.fontSize}px Inter, Manrope, sans-serif`;
  let quoteY = 302;
  for (const line of quoteLayout.lines) {
    context.fillText(line, 94, quoteY);
    quoteY += quoteLayout.lineHeight;
  }

  const speakerLine = `- ${quote.speakerName}, ${quote.speakerDesignation}`;
  context.fillStyle = BRAND_BLUE;
  context.font = "600 24px Inter, Manrope, sans-serif";
  context.fillText(speakerLine, 94, 535);

  context.fillStyle = BRAND_YELLOW;
  context.beginPath();
  context.arc(CARD_WIDTH - 86, 100, 8, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = MUTED_TEXT;
  context.font = "500 18px Inter, Manrope, sans-serif";
  context.fillText("Source: The Chatter by Zerodha", 66, CARD_HEIGHT - 62);

  return canvas.toDataURL("image/png");
};

export const buildThreadCardFileName = (quote: ThreadQuoteCandidate, position: number): string => {
  const company = sanitizeFileName(quote.companyName);
  const index = String(position).padStart(2, "0");
  return `chatter-thread-${index}-${company}.png`;
};

const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
  const response = await fetch(dataUrl);
  return response.blob();
};

export const copyDataUrlImageToClipboard = async (dataUrl: string): Promise<void> => {
  const clipboard = navigator?.clipboard;
  if (!clipboard || !(window as any).ClipboardItem || !window.isSecureContext) {
    throw new Error("Image copy requires a secure browser context with Clipboard API support.");
  }

  const blob = await dataUrlToBlob(dataUrl);
  const clipboardItem = new (window as any).ClipboardItem({
    [blob.type || "image/png"]: blob,
  });
  await clipboard.write([clipboardItem]);
};

export const downloadDataUrlImage = (dataUrl: string, fileName: string): void => {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
