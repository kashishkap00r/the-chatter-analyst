/** Trigger a browser download for an already-built href (data URL or blob URL). */
const triggerDownload = (href: string, fileName: string): void => {
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

/** Save a Blob to the user's machine under fileName. */
export const downloadBlob = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  try {
    triggerDownload(url, fileName);
  } finally {
    // Revoke on the next tick so the click has committed the navigation.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};

/** Save a data-URL (e.g. a canvas PNG) to the user's machine under fileName. */
export const downloadDataUrl = (dataUrl: string, fileName: string): void => {
  triggerDownload(dataUrl, fileName);
};
